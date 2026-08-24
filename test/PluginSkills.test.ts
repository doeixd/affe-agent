import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as Sandbox from "../src/sandbox/Sandbox.js"
import { MemorySandbox } from "../src/sandbox/index.js"
import { discoverSkills } from "../src/plugins/internal/skills.js"

/**
 * Skills discovery over a seeded in-memory sandbox (no disk). Pins the spec's
 * rules: immediate children of skills/ only (no deep recursion), a missing
 * skills/ is not an error, a skills-that-is-a-file makes the component
 * unavailable, and any single invalid SKILL.md is skipped while siblings load.
 */

const skillMd = (name: string, description: string, body = "instructions") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`

// Run discoverSkills over a memory sandbox seeded with the given files.
const discover = (seed: Record<string, string>) =>
  Effect.gen(function* () {
    const sandbox = yield* Sandbox.acquire(Sandbox.workspace("plugin"))
    return yield* discoverSkills(sandbox)
  }).pipe(Effect.scoped, Effect.provide(MemorySandbox.layer({ seed })))

describe("plugin skills discovery", () => {
  it.effect("discovers each immediate skills/<dir>/SKILL.md and no deeper", () =>
    Effect.gen(function* () {
      const { skills, warnings } = yield* discover({
        "skills/alpha/SKILL.md": skillMd("alpha", "The alpha skill."),
        "skills/beta/SKILL.md": skillMd("beta", "The beta skill."),
        "skills/alpha/nested/SKILL.md": skillMd("nested", "Should be ignored.")
      })
      assert.deepStrictEqual(warnings, [])
      assert.deepStrictEqual(skills.map((s) => s.id).sort(), ["alpha", "beta"])
    })
  )

  it.effect("carries the description and the markdown body", () =>
    Effect.gen(function* () {
      const { skills } = yield* discover({
        "skills/alpha/SKILL.md": skillMd("alpha", "Does alpha.", "# Alpha\n\nStep 1.")
      })
      const alpha = skills[0]!
      assert.strictEqual(alpha.description, "Does alpha.")
      assert.strictEqual(yield* alpha.body, "# Alpha\n\nStep 1.")
    })
  )

  it.effect("a missing skills/ is not an error", () =>
    Effect.gen(function* () {
      const { skills, warnings } = yield* discover({ "plugin.json": "{}" })
      assert.deepStrictEqual(skills, [])
      assert.deepStrictEqual(warnings, [])
    })
  )

  it.effect("a skills path that is a file makes the component unavailable, with a warning", () =>
    Effect.gen(function* () {
      const { skills, warnings } = yield* discover({ "skills": "i am a file" })
      assert.deepStrictEqual(skills, [])
      assert.strictEqual(warnings.length, 1)
      assert.include(warnings[0]?.detail ?? "", "not a directory")
    })
  )

  it.effect("a directory without a SKILL.md is silently not a skill", () =>
    Effect.gen(function* () {
      const { skills, warnings } = yield* discover({
        "skills/empty/README.md": "no skill here",
        "skills/real/SKILL.md": skillMd("real", "A real skill.")
      })
      assert.deepStrictEqual(skills.map((s) => s.id), ["real"])
      assert.deepStrictEqual(warnings, [])
    })
  )

  it.effect("skips invalid skills and keeps valid siblings, one warning each", () =>
    Effect.gen(function* () {
      const { skills, warnings } = yield* discover({
        "skills/good/SKILL.md": skillMd("good", "A good skill."),
        "skills/nofm/SKILL.md": "no frontmatter here",
        "skills/noname/SKILL.md": "---\ndescription: has no name\n---\nx",
        "skills/nodesc/SKILL.md": "---\nname: nodesc\n---\nx",
        "skills/mismatch/SKILL.md": skillMd("different", "Name does not match dir."),
        "skills/Bad-Caps/SKILL.md": skillMd("Bad-Caps", "Uppercase name.")
      })
      assert.deepStrictEqual(skills.map((s) => s.id), ["good"])
      assert.strictEqual(warnings.length, 5)
      assert.isTrue(warnings.every((w) => w.component === "skill"))
    })
  )

  it.effect("exposes references/* as skill resources", () =>
    Effect.gen(function* () {
      const { skills } = yield* discover({
        "skills/alpha/SKILL.md": skillMd("alpha", "Has references."),
        "skills/alpha/references/REFERENCE.md": "detailed reference",
        "skills/alpha/references/forms.md": "form templates"
      })
      const alpha = skills[0]!
      const list = yield* Effect.map(
        Effect.forEach(["REFERENCE.md", "forms.md"], (r) => alpha.resources[r] ?? Effect.succeed("")),
        (xs) => xs
      )
      assert.deepStrictEqual(list, ["detailed reference", "form templates"])
    })
  )
})
