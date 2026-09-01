/**
 * Break-once, as a command rather than a ritual.
 *
 * `AGENTS.md` states the rule: a mechanism is not done until its test has been
 * broken once and seen to fail. It has been applied by hand, and by hand it
 * fails. Over three days in 2026-09 ten tests were found to assert an outcome
 * their mechanism did not produce -- every one caught by review, none by the
 * suite. The pattern is always the same: the test checks a settled end state,
 * and the end state is reachable with the mechanism removed.
 *
 * The three that make the case, all of which passed against a broken
 * implementation:
 *
 * - `WorkspaceManager` -- every one of its eight tests passed against an
 *   `acquire` that took no reference at all, because none of them held a
 *   workspace across the idle window. The module was indistinguishable from
 *   the expiring cache reference counting exists to improve on.
 * - `hostEvents` -- the parked-subscriber test, sole justification for an
 *   unbounded `PubSub`, passed against `PubSub.bounded(1)`, because obtaining
 *   a `Stream.unwrap` and holding it subscribes to nothing.
 * - `SessionProjection` -- the repair test compared seven hand-picked fields,
 *   all of which happened to match; the ones that would have disagreed were
 *   the ones not named.
 *
 * ## How this differs from `falsify.mjs`
 *
 * `scripts/falsify.mjs` is the same idea aimed at one subject, and its runner
 * is the proven part borrowed here. Two differences:
 *
 * - **It asks "did anything fail?"** A mutation that breaks something
 *   unrelated scores as `bites` there. This names the tests that must fail, so
 *   a mutation which fails the *wrong* tests is `WRONG TESTS` -- an error, not
 *   a pass. That precision is the point: it is what catches a test whose name
 *   claims a mechanism it does not exercise.
 * - **It runs one fixed suite per break**, which is minutes, so it is
 *   deliberately outside `check`. This runs only the files a mutation claims
 *   coverage from, which is seconds, so it can be a gate.
 *
 * ## What counts as a failure of this script
 *
 * Every one of these is an error exit, and the reasons matter:
 *
 * - `SURVIVES` -- the mutation changed nothing observable. Either the
 *   mechanism is untested or the mutation is not a mutation.
 * - `WRONG TESTS` -- something failed, but not what claimed to cover this. The
 *   named test does not test what its name says.
 * - `SITE MOVED` -- the pattern no longer matches. A break that silently fails
 *   to apply looks exactly like a guarantee nothing enforces, which is the one
 *   mistake this must never make.
 * - a red baseline -- every mutation would report `bites` and prove nothing.
 *
 * Usage: npm run verify:mutations -- --only SP-gap,WM-hold
 */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const PROJECTION = "src/sessions/SessionProjection.ts"
const HOST = "src/client/internal/sessionHost.ts"
const WORKSPACE = "src/sandbox/WorkspaceManager.ts"

const PROJECTION_TEST = "test/SessionProjection.test.ts"
const HOST_TEST = "test/AgentSessionHostEvents.test.ts"
const WORKSPACE_TEST = "test/WorkspaceManager.test.ts"

/**
 * Each mutation names the mechanism, one exact substitution, and the tests
 * that must fail because of it.
 *
 * `from` strings are long on purpose. A short pattern matching in two places
 * breaks more than the mechanism under test, and the verdict then says nothing
 * about which invariant the tests actually hold.
 *
 * `mustFail` entries are matched as substrings of the reported test name, so
 * they can be short and readable -- but they must be specific enough to name
 * one test, or a mutation that fails a *different* test in the same file would
 * be scored as covered.
 */
const mutations = [
  // -- SessionProjection ---------------------------------------------------
  {
    id: "SP-gap",
    mechanism: "a discontinuity in the sequence is recorded",
    file: PROJECTION,
    tests: [PROJECTION_TEST],
    from: "    if (sequence > last + 1) {",
    to: "    if (false) {",
    mustFail: ["records a gap and still applies"]
  },
  {
    id: "SP-duplicate",
    mechanism: "a replayed sequence is ignored rather than folded twice",
    file: PROJECTION,
    tests: [PROJECTION_TEST],
    from: "    if (sequence <= last) return { ...self, duplicates: self.duplicates + 1 }",
    to: "    if (sequence < -1) return self",
    mustFail: ["ignores a replayed sequence"]
  },
  {
    id: "SP-foreign",
    mechanism: "another session's envelope is counted, not folded in",
    file: PROJECTION,
    tests: [PROJECTION_TEST],
    from: "  if (envelope.sessionId !== self.sessionId) {",
    to: "  if (false) {",
    mustFail: ["counts an envelope for another session"]
  },
  {
    id: "SP-malformed",
    mechanism: "an unorderable sequence cannot disable the ordering guards",
    file: PROJECTION,
    tests: [PROJECTION_TEST],
    from: "  if (!Number.isSafeInteger(sequence)) {",
    to: "  if (false) {",
    mustFail: ["refuses a sequence it cannot order"]
  },
  {
    id: "SP-settle",
    mechanism: "a settled submission holds nothing open",
    file: PROJECTION,
    tests: [PROJECTION_TEST],
    from: "  activeSubmission: Option.none(),\n  activeToolCalls: [],\n  pendingElicitations: []",
    to: "  activeSubmission: Option.none()",
    mustFail: ["does not leak its unanswered question"]
  },
  {
    id: "SP-recovered",
    mechanism: "a tool failure handed back to the model is not why a run stopped",
    file: PROJECTION,
    tests: [PROJECTION_TEST],
    from: "        lastFailure: event.returnedToModel\n          ? self.lastFailure\n          : Option.some(event.failure)",
    to: "        lastFailure: Option.some(event.failure)",
    mustFail: ["handed back to the model is not why"]
  },

  // -- host-wide events ----------------------------------------------------
  {
    id: "HE-order",
    mechanism: "no event for a session precedes its SessionHosted",
    file: HOST,
    tests: [HOST_TEST],
    from:
      '        yield* PubSub.publish(hostBus, { _tag: "SessionHosted", sessionId })\n        // Forked into',
    to: "        // Forked into",
    mustFail: ["announces a session before any of its events"]
  },
  {
    id: "HE-inventory",
    mechanism: "a late subscriber is told what is already hosted",
    file: HOST,
    tests: [HOST_TEST],
    from: "                ...(yield* Ref.get(sessions)).keys(),",
    to: "                ...[],",
    mustFail: ["delivers the inventory first"]
  },
  {
    id: "HE-unhosted",
    mechanism: "a session's tail cannot trail its own SessionUnhosted",
    file: HOST,
    tests: [HOST_TEST],
    from: "            Effect.onExit(announce),",
    to: "",
    mustFail: ["reports a closed session as unhosted"]
  },
  {
    id: "HE-released",
    mechanism: "a host shutting down is not a session closing",
    file: HOST,
    tests: [HOST_TEST],
    from: "          ({ reason }) => Ref.set(reason, releasedReason),",
    to: "          () => Effect.void,",
    mustFail: ["a host shutting down says so"]
  },
  {
    id: "HE-unbounded",
    mechanism: "publication never blocks on a subscriber that stopped reading",
    file: HOST,
    tests: [HOST_TEST],
    from: "PubSub.unbounded<AgentProtocol.HostEvent>()",
    to: "PubSub.bounded<AgentProtocol.HostEvent>(1)",
    mustFail: ["a parked subscriber blocks neither"]
  },
  {
    id: "HE-pumps",
    mechanism: "the live-pump count can see a leak",
    file: HOST,
    tests: [HOST_TEST],
    from: "      pumps: FiberMap.size(pumpFibers),",
    to: "      pumps: Effect.succeed(0),",
    mustFail: ["no pump outlives its session"]
  },

  // -- workspace lifetime --------------------------------------------------
  {
    id: "WM-hold",
    mechanism: "a live holder keeps the workspace regardless of the idle window",
    file: WORKSPACE,
    tests: [WORKSPACE_TEST],
    from:
      "      acquire: (workspace) =>\n        Effect.map(workspaces.contextEffect(workspace), (context) =>\n          Context.get(context, Current)),",
    to:
      "      acquire: (workspace) =>\n        Effect.scoped(\n          Effect.map(workspaces.contextEffect(workspace), (context) =>\n            Context.get(context, Current))\n        ),",
    mustFail: ["a live holder keeps it past the idle window"]
  },
  {
    id: "WM-ttl-option",
    mechanism: "the configured idle window is the one used",
    file: WORKSPACE,
    tests: [WORKSPACE_TEST],
    from: "idleTimeToLive: options?.idleTimeToLive ?? defaultIdleTimeToLive",
    to: "idleTimeToLive: defaultIdleTimeToLive",
    mustFail: ["is released once the window passes"]
  },
  {
    id: "WM-ttl-default",
    mechanism: "the documented default idle window",
    file: WORKSPACE,
    tests: [WORKSPACE_TEST],
    from: "export const defaultIdleTimeToLive = Duration.seconds(30)",
    to: "export const defaultIdleTimeToLive = Duration.minutes(5)",
    mustFail: ["the default idle window is the documented one"]
  },
  {
    id: "WM-invalidate",
    mechanism: "invalidate forces a rebuild",
    file: WORKSPACE,
    tests: [WORKSPACE_TEST],
    from: "      invalidate: (workspace) => workspaces.invalidate(workspace)",
    to: "      invalidate: () => Effect.void",
    mustFail: ["rebuilds without revoking"]
  }
]

const parse = (out) => {
  const summary = /Tests\s+(?:(\d+) failed \|\s*)?(\d+) passed/.exec(out)
  if (summary === null) {
    throw new Error(`no test summary in the run:\n${out.slice(-2000)}`)
  }
  return {
    out,
    failed: summary[1] === undefined ? 0 : Number(summary[1]),
    passed: Number(summary[2])
  }
}

const run = (files) => {
  try {
    return parse(
      execFileSync("npx", ["vitest", "run", ...files], {
        encoding: "utf8",
        stdio: "pipe",
        shell: true,
        timeout: 600_000,
        maxBuffer: 64 * 1024 * 1024
      })
    )
  } catch (error) {
    if (error.stdout === undefined && error.stderr === undefined) throw error
    return parse(`${error.stdout ?? ""}${error.stderr ?? ""}`)
  }
}

const namesOf = (out) => {
  const seen = new Set()
  for (const line of out.split("\n")) {
    const m = /FAIL\s+(test\/\S+)\s*>\s*(.+)$/.exec(line)
    if (m !== null) seen.add(`${m[1]} > ${m[2].trim()}`)
  }
  return [...seen]
}

/**
 * Match against LF-normalised text.
 *
 * The working tree is CRLF on Windows and these patterns are written with LF.
 * Without this every multi-line mutation reports SITE MOVED -- which the
 * script is right to refuse to call a pass, and which says nothing about the
 * mechanism.
 */
const lf = (text) => text.replaceAll("\r\n", "\n")

const only = (() => {
  const at = process.argv.indexOf("--only")
  if (at === -1) return undefined
  return new Set(String(process.argv[at + 1]).split(","))
})()

const selected = mutations.filter((m) => only === undefined || only.has(m.id))
if (selected.length === 0) {
  console.error("no mutations selected")
  process.exit(1)
}

const files = [...new Set(selected.flatMap((m) => m.tests))]

console.log(`baseline over ${files.length} file(s)...`)
const baseline = run(files)
if (baseline.failed !== 0) {
  console.error(
    `baseline is not green (${baseline.failed} failing). Every mutation would ` +
      `report "bites" and prove nothing. Fix the tree first.`
  )
  process.exit(1)
}
console.log(`baseline green: ${baseline.passed} tests\n`)

const rows = []
for (const mutation of selected) {
  const original = lf(readFileSync(mutation.file, "utf8"))
  if (!original.includes(mutation.from)) {
    rows.push({ ...mutation, verdict: "SITE MOVED", failed: -1, names: [] })
    console.log(`${mutation.id.padEnd(16)} SITE MOVED — the pattern no longer applies`)
    continue
  }
  writeFileSync(mutation.file, original.replace(mutation.from, mutation.to))
  try {
    const { failed, out } = run(mutation.tests)
    const names = namesOf(out)
    const missing = mutation.mustFail.filter(
      (want) => !names.some((name) => name.includes(want))
    )
    const verdict = failed === 0
      ? "SURVIVES"
      : missing.length > 0
      ? "WRONG TESTS"
      : "bites"
    rows.push({
      id: mutation.id,
      mechanism: mutation.mechanism,
      verdict,
      failed,
      missing,
      names: names.slice(0, 6)
    })
    console.log(
      `${mutation.id.padEnd(16)} ${
        verdict === "bites"
          ? `bites (${failed} fail)`
          : verdict === "SURVIVES"
          ? "!!! SURVIVES !!!"
          : `!!! WRONG TESTS !!! (expected: ${missing.join(", ")})`
      }`
    )
  } finally {
    writeFileSync(mutation.file, original)
  }
}

writeFileSync("mutations.json", JSON.stringify(rows, null, 2))

const bad = rows.filter((row) => row.verdict !== "bites")
console.log(
  `\n${rows.length - bad.length}/${rows.length} mutations bite; wrote mutations.json`
)
if (bad.length > 0) {
  console.error(`\n${bad.length} did not:`)
  for (const row of bad) console.error(`  ${row.id.padEnd(16)} ${row.verdict}`)
  console.error(
    "\nA mechanism whose mutation survives is untested; one that fails the " +
      "wrong tests is covered by a test that does not mean what its name says."
  )
  process.exit(1)
}
