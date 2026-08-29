/**
 * SD2 — break each durability guarantee once, and record which tests bite.
 *
 * `plan-durability-hardening.md` SD2 asks that every guarantee have a test that
 * fails when the guarantee is removed, "demonstrated by actually removing it".
 * H2 did that on 2026-08-24 against nine files and 121 tests. The suite is an
 * order of magnitude larger now and the mechanisms underneath — conditional
 * writes, resumable SSE, multi-node takeover — have been rewritten since, so
 * those verdicts are evidence about code that no longer exists.
 *
 * This runs the procedure mechanically so it can be repeated whenever the
 * durability surface moves, rather than being a one-off someone has to
 * remember. Three properties matter:
 *
 * - **A missed break is an error, not a pass.** If the substitution no longer
 *   matches, the run says SITE MOVED. A break that silently failed to apply
 *   looks exactly like a guarantee nothing enforces, and that is the one
 *   mistake this script must never make.
 * - **An unreadable run is an error, not a pass.** Same reason.
 * - **The file is always restored**, including when the run throws.
 *
 * Breaks use plain `false`, not `false as boolean`: the assertion form trips
 * the esbuild transform and the suite fails to load, which is indistinguishable
 * from a break that bit everything.
 *
 * Deliberately **not** part of `npm run check`: it runs the durability suite
 * once per break, which is minutes, not seconds. It belongs on the same
 * trigger as its subject — run `npm run verify:durability` when the durability
 * surface changes, and record the table in the plan. The previous table went
 * stale precisely because re-running it depended on somebody remembering to.
 *
 * Usage: npm run verify:durability -- --only D1,D5
 */
import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"

const STORE = "src/durable/DurableSessionStore.ts"
const LOG = "src/durable/DeliveryLog.ts"
const ACTIVITY = "src/internal/toolActivity.ts"
const CLIENT = "src/durable/DurableAgentClient.ts"
const AGENT = "src/durable/DurableAgent.ts"

/**
 * Each break names the guarantee, the file, and one exact substitution.
 *
 * `from` strings are deliberately long. A short pattern matching in more than
 * one place would break more than the guarantee under test, and the verdict
 * would then say nothing about which invariant the tests actually hold.
 *
 * `also` exists because `DurableSessionStore` has two implementations of the
 * same contract — memory and SQL — and breaking only one leaves the other
 * enforcing the invariant, which understates the bite.
 */
const breaks = [
  {
    id: "D1",
    guarantee: "Admission is a promise",
    applied: "admit even when already claimed",
    file: STORE,
    from: "            if (Option.isSome(found.claim)) {",
    to: "            if (false) {",
    also: {
      from: "                if (Option.isSome(record.claim)) {",
      to: "                if (false) {"
    }
  },
  {
    id: "D2",
    guarantee: "Resumption never repeats completed work",
    applied: "randomise the tool activity name",
    file: ACTIVITY,
    from: "): string => `tool-${occurrence}-${name}-${id}`",
    to: "): string => `tool-${occurrence}-${name}-${id}-${Math.random()}`"
  },
  {
    id: "D2b",
    guarantee: "Resumption never repeats completed work",
    applied: "make every occurrence look like the first",
    file: ACTIVITY,
    from: "    const index = seen.get(key) ?? 0",
    to: "    const index = 0"
  },
  {
    id: "D3",
    guarantee: "Resumption never skips accepted work",
    applied: "leave an accepted-but-undispatched claim alone",
    file: CLIENT,
    from: `      if (claim.executionId === undefined) {
        const history = yield* DurableSessionStore.decodeHistory(record.history)
        yield* dispatch(record.sessionId, claim, history)
      } else if`,
    to: `      if (claim.executionId === undefined) {
        return
      } else if`
  },
  {
    id: "D4",
    guarantee: "Interruption is terminal, crash is not",
    applied: "record an interrupted result as completed",
    file: "src/durable/DurableSubmission.ts",
    from: `  status: result.status === "interrupted" ? "interrupted" : "completed",`,
    to: `  status: "completed" as const,`
  },
  {
    /**
     * The same guarantee, one layer down — and a row that can never bite.
     *
     * D4 above breaks the *recorded status*, which four tests catch. This
     * removes two disjuncts at once, and they are not the same kind of thing:
     *
     * - `instance.interrupted` is **dead by construction**. The engine sets it
     *   inside an `Effect.onExit` wrapped *around* the body, so it cannot be
     *   true while `catchCause` is still running. Instrumented across 67
     *   durable tests including two-runner failover: never true, at any site.
     * - `Cause.hasInterruptsOnly(cause)` is live but **unobservable**: an
     *   interrupt reaching the body from outside is the same event that tears
     *   down whatever would have recorded the difference, and
     *   `WorkflowEngine.resume` never interrupts a running fiber.
     *
     * So "survives" here is a property of the code, not a coverage gap. Kept so
     * the next run does not rediscover it; `instance.suspended` alone is what
     * makes the guard correct today. Full evidence in
     * `plan-durability-hardening.md`'s SD2 section.
     */
    id: "D4b",
    guarantee: "Interruption is terminal, crash is not",
    applied: "convert an interrupted run into a typed durable failure",
    file: AGENT,
    // Re-pointed after the recorded-intent interrupt landed (#77): the branch
    // now checks the intent first, and these two disjuncts are what remains
    // of the old guard. The property is unchanged -- `instance.suspended`
    // still carries the correctness, and removing the defence changes nothing.
    from: "                  : instance.interrupted || Cause.hasInterruptsOnly(cause)",
    to: "                  : false"
  },
  {
    id: "D5",
    guarantee: "Observation is at-least-once with a stable cursor",
    applied: "ignore the caller's `after` offset",
    file: LOG,
    from: "            .filter((envelope) => envelope.sequence > after)",
    to: "            .filter(() => true)"
  },
  {
    id: "D6",
    guarantee: "A recorded event is replay-stable",
    applied: "never notice a duplicate key",
    file: LOG,
    from: "              if (existing !== undefined) {",
    to: "              if (false) {"
  },
  {
    id: "D7",
    guarantee: "Storage failure degrades, it does not corrupt",
    applied: "remove the idempotency key from `claim`",
    file: STORE,
    from: `              return submission.key !== undefined &&
                  found.claim.value.key === submission.key`,
    to: "              return false",
    also: {
      from: `                  return submission.key !== undefined &&
                      record.claim.value.key === submission.key`,
      to: "                  return false"
    }
  }
]

/**
 * The durability surface, verified green before any break is applied.
 *
 * Deliberately not the whole suite: a baseline that is red for an unrelated
 * reason makes every break report "bites" and the exercise proves nothing.
 */
const suite = [
  "test/ActivityBoundaries.test.ts",
  "test/Cluster.test.ts",
  "test/Durable.test.ts",
  "test/DurableAdmission.test.ts",
  "test/DurableAgentClient.test.ts",
  "test/DurableAudit.test.ts",
  "test/DurableSessionStore.test.ts",
  "test/DurableStreams.test.ts",
  "test/ToolActivity.test.ts",
  "test/AgentSession.test.ts",
  "test/DurableHttpIntegration.test.ts"
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

const run = () => {
  try {
    return parse(
      execFileSync("npx", ["vitest", "run", ...suite], {
        encoding: "utf8",
        stdio: "pipe",
        shell: true,
        timeout: 1_800_000,
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

const only = (() => {
  const at = process.argv.indexOf("--only")
  if (at === -1) return undefined
  return new Set(String(process.argv[at + 1]).split(","))
})()

console.log("baseline...")
const baseline = run()
if (baseline.failed !== 0) {
  console.error(
    `baseline is not green (${baseline.failed} failing). ` +
      `Every break would report "bites" and prove nothing. Fix the tree first.`
  )
  process.exit(1)
}
console.log(`baseline green: ${baseline.passed} tests\n`)

/**
 * Match against LF-normalised text.
 *
 * The working tree is CRLF on Windows, and the multi-line patterns here are
 * written with LF. Without this the three multi-line breaks report SITE MOVED
 * — which the script is right to refuse to call a pass, and which says nothing
 * about the guarantee. Normalising is what makes the verdict about the code.
 */
const lf = (text) => text.replaceAll("\r\n", "\n")

const rows = []
for (const brk of breaks) {
  if (only !== undefined && !only.has(brk.id)) continue
  const original = lf(readFileSync(brk.file, "utf8"))
  if (!original.includes(brk.from)) {
    rows.push({ ...brk, verdict: "SITE MOVED", failed: -1, names: [] })
    console.log(`${brk.id.padEnd(4)} SITE MOVED — the break no longer applies`)
    continue
  }
  let broken = original.replace(brk.from, brk.to)
  if (brk.also !== undefined) {
    if (!broken.includes(brk.also.from)) {
      rows.push({ ...brk, verdict: "SITE MOVED (second)", failed: -1, names: [] })
      console.log(`${brk.id.padEnd(4)} SITE MOVED — second site no longer applies`)
      continue
    }
    broken = broken.replace(brk.also.from, brk.also.to)
  }
  writeFileSync(brk.file, broken)
  try {
    const { failed, out, passed } = run()
    const names = namesOf(out)
    rows.push({
      id: brk.id,
      guarantee: brk.guarantee,
      applied: brk.applied,
      verdict: failed > 0 ? "bites" : "SURVIVES",
      failed,
      passed,
      names: names.slice(0, 6)
    })
    console.log(
      `${brk.id.padEnd(4)} ${
        failed > 0 ? `bites (${failed} fail)` : "!!! SURVIVES !!!"
      }`
    )
    for (const name of names.slice(0, 3)) console.log(`       ${name}`)
  } finally {
    writeFileSync(brk.file, original)
  }
}

writeFileSync("falsification.json", JSON.stringify(rows, null, 2))
console.log("\nwrote falsification.json")
