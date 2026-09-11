import { assert, describe, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const reader = pathToFileURL(resolve("scripts/lib/behavior-changes.mjs")).href
const generator = resolve("scripts/changelog-behavior-changes.mjs")

const fixture = (use: (repo: string, git: (...args: string[]) => string) => void) => {
  const repo = mkdtempSync(join(tmpdir(), "affe-behavior-test-"))
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd: repo, encoding: "utf8", stdio: "pipe"
  }).trim()
  try {
    git("init", "-b", "main")
    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.invalid")
    git("config", "commit.gpgsign", "false")
    writeFileSync(join(repo, "README.md"), "baseline\n")
    git("add", "README.md")
    git("commit", "-m", "baseline")
    git("tag", "v0.0.1")
    use(repo, git)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

const read = (repo: string) => JSON.parse(execFileSync(process.execPath, [
  "--input-type=module", "--eval",
  `import { readBehaviorChanges } from ${JSON.stringify(reader)};
   console.log(JSON.stringify(readBehaviorChanges("v0.0.1..HEAD", (message) => { throw new Error(message) })))`
], { cwd: repo, encoding: "utf8" }))

// Each row spawns a dozen git processes in a scratch repository: seconds
// under a loaded full-suite run, so each has its own budget.
describe("behavior-change Git records", () => {
  it("keeps zero, one, repeated and folded trailers separate from paths", () => {
    fixture((repo, git) => {
      const commits = [
        { subject: "ordinary", trailers: [], body: "" },
        { subject: "one", trailers: ["first change"], body: "Behavior-Change: first change" },
        {
          subject: "two", trailers: ["first change", "second change continued here"],
          body: "Behavior-Change: first change\nBehavior-Change: second change\n continued here"
        }
      ]
      mkdirSync(join(repo, "test/fixtures"), { recursive: true })
      const expected = commits.map(({ subject, trailers, body }) => {
        const file = `test/fixtures/${subject}.json`
        writeFileSync(join(repo, file), "{}\n")
        git("add", file)
        git("commit", "-m", body === "" ? subject : `${subject}\n\n${body}`)
        return { hash: git("rev-parse", "--short", "HEAD"), subject, trailers, measures: [], files: [file] }
      })
      assert.deepEqual(read(repo), expected)
    })
  }, 30_000)

  it("reads a later measurement, and the changelog names the commit that made it", () => {
    fixture((repo, git) => {
      // A change whose fixture came a commit later, linked back by hash.
      writeFileSync(join(repo, "src.ts"), "changed\n")
      git("add", "src.ts")
      git("commit", "-m", "change\n\nBehavior-Change: a caller sees this")
      const changed = git("rev-parse", "--short", "HEAD")
      mkdirSync(join(repo, "test/fixtures"), { recursive: true })
      writeFileSync(join(repo, "test/fixtures/later.json"), "{}\n")
      git("add", "test/fixtures/later.json")
      git("commit", "-m", `measure\n\nBehavior-Change: recorded\nBehavior-Change-Measures: ${changed} the change above`)
      const measuring = git("rev-parse", "--short", "HEAD")
      const records: ReadonlyArray<{ readonly measures: ReadonlyArray<string> }> = read(repo)
      assert.deepEqual(records.map((record) => record.measures), [[], [changed]])
      const block = execFileSync(process.execPath, [generator], {
        cwd: repo, encoding: "utf8", env: { ...process.env, BEHAVIOR_CHANGE_RANGE: "v0.0.1..HEAD" }
      })
      assert.include(block, `- a caller sees this (\`${changed}\`; measured later, in \`${measuring}\`)`)
    })
  }, 30_000)

  it("publishes both changes and checks the regenerated block", () => {
    fixture((repo, git) => {
      mkdirSync(join(repo, "test/fixtures"), { recursive: true })
      writeFileSync(join(repo, "test/fixtures/wire.json"), "{}\n")
      git("add", "test/fixtures/wire.json")
      git("commit", "-m", "wire\n\nBehavior-Change: first change\nBehavior-Change: second change")
      const hash = git("rev-parse", "--short", "HEAD")
      const run = (...args: string[]) => execFileSync(process.execPath, [generator, ...args], {
        cwd: repo, encoding: "utf8", env: { ...process.env, BEHAVIOR_CHANGE_RANGE: "v0.0.1..HEAD" }
      })
      assert.equal(run(), [
        "<!-- behavior-changes:start -->", "### Behaviour changes", "",
        `- first change (\`${hash}\`; measured by \`test/fixtures/wire.json\`)`,
        `- second change (\`${hash}\`; measured by \`test/fixtures/wire.json\`)`,
        "<!-- behavior-changes:end -->", ""
      ].join("\n"))
      writeFileSync(join(repo, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n")
      run("--write")
      assert.include(run("--check"), "(2)")
    })
  }, 30_000)
})
