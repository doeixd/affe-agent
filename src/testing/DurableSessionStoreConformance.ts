import { Effect, Fiber, Option, Schema } from "effect"
import type { Scope } from "effect"
import { Prompt } from "effect/unstable/ai"
import * as DurableSessionStore from "../durable/DurableSessionStore.js"
import type { StorageError } from "../Errors.js"
import type * as Elicitation from "../Elicitation.js"
import { checks, report, type Report } from "./internal/conformance.js"
import * as TestLanguageModel from "./TestLanguageModel.js"

/**
 * The conformance suite every `DurableSessionStore` must pass.
 *
 * The store is the durable counterpart of the local session's runtime
 * state, and its transitions are the correctness of the client that sits
 * on top: atomicity under concurrency, and persistence of intent at the
 * crash boundaries it exists for. The memory and SQL stores run this; a
 * store over your own backing is held to the same transitions.
 *
 * What this suite cannot show is the interleaving a read-committed database
 * permits between a transition's read and its write -- SQLite serialises
 * writers, and so does a `Ref`. A store over such a database owes itself
 * the injected-statement test `test/DurableSessionStore.test.ts` keeps for
 * the SQL store.
 *
 * Framework-agnostic, as `SandboxConformance` is: a case is a named Effect,
 * a runner wires them with one line each, and `run` reports.
 */

export class Failure extends Schema.TaggedError<Failure>()(
  "DurableSessionStoreConformanceFailure",
  { case: Schema.String, detail: Schema.String }
) {
  override get message() {
    return `durable session store conformance: ${this.case}: ${this.detail}`
  }
}

export interface Options<E> {
  /** A fresh store, per case. Scoped, so a store over a connection can close it. */
  readonly store: Effect.Effect<DurableSessionStore.DurableSessionStore, E, Scope.Scope>
}

export interface Case<E> {
  readonly name: string
  readonly run: Effect.Effect<void, Failure | StorageError | E>
}

const { equal, that } = checks((name, detail) => new Failure({ case: name, detail }))

const historyWith = (text: string): Prompt.Prompt =>
  Prompt.make([{ role: "user", content: [{ type: "text", text }] }])

/** The stored record, or a failure naming the case. */
const recordOf = (name: string, store: DurableSessionStore.DurableSessionStore, sessionId: string) =>
  Effect.flatMap(store.get(sessionId), (found) =>
    Option.isSome(found)
      ? Effect.succeed(found.value)
      : Effect.fail(new Failure({ case: name, detail: `session ${sessionId} is missing` }))
  )

const userTexts = (encoded: string) =>
  Effect.map(DurableSessionStore.decodeHistory(encoded), TestLanguageModel.userTexts)

export const cases = <E>(options: Options<E>): ReadonlyArray<Case<E>> => {
  type Store = DurableSessionStore.DurableSessionStore
  const make = (
    name: string,
    body: (store: Store) => Effect.Effect<void, Failure | StorageError | E>
  ): Case<E> => ({ name, run: Effect.scoped(Effect.flatMap(options.store, body)) })

  return [
    make("creates once and returns the same record afterwards", (store) =>
      Effect.gen(function* () {
        const name = "creates once and returns the same record afterwards"
        const created = yield* store.getOrCreate("s1", historyWith("hello"))
        yield* equal(name)(created.status, "idle", "status at creation")
        yield* equal(name)(created.submissionCount, 0, "submission count at creation")
        // The initial history is not reapplied: a session that already
        // exists keeps whatever its conversations committed.
        const again = yield* store.getOrCreate("s1", historyWith("ignored"))
        yield* equal(name)(again, created, "the record on a second getOrCreate")
        yield* that(name)(Option.isNone(yield* store.get("missing")), "an unknown session should be None")
      })),

    /**
     * All three file-data variants, not just bytes. `PromptWire` exists
     * because the three are ambiguous once serialised, and the URL case is
     * the one whose failure is silent: a URL that failed to encode comes
     * back as a *string*, which is a legal `FilePart.data`, so nothing
     * downstream notices.
     */
    make("preserves every file-data variant in persisted history", (store) =>
      Effect.gen(function* () {
        const name = "preserves every file-data variant in persisted history"
        const bytes = new Uint8Array([51, 52, 53])
        const url = new URL("https://cdn.example.com/asset.png")
        const inline = "inline string payload"
        const created = yield* store.getOrCreate(
          "multimodal",
          Prompt.make([{
            role: "user",
            content: [
              { type: "file", mediaType: "application/octet-stream", data: bytes },
              { type: "file", mediaType: "image/png", data: url },
              { type: "file", mediaType: "text/plain", data: inline }
            ]
          }])
        )
        const history = yield* DurableSessionStore.decodeHistory(created.history)
        const message = history.content[0]
        yield* that(name)(message?.role === "user", "expected the user message back")
        if (message?.role !== "user") return
        const data = message.content.flatMap((part) => (part.type === "file" ? [part.data] : []))
        yield* equal(name)(data.length, 3, "file parts")
        yield* that(name)(data[0] instanceof Uint8Array, "bytes must stay bytes")
        if (data[0] instanceof Uint8Array) {
          yield* equal(name)(Array.from(data[0]), Array.from(bytes), "bytes")
        }
        yield* that(name)(data[1] instanceof URL, "a URL must stay a URL, not decay to a string")
        if (data[1] instanceof URL) {
          yield* equal(name)(data[1].href, url.href, "the URL")
        }
        yield* equal(name)(data[2], inline, "a string must stay that exact string")
      })),

    make("claim on a missing session reports Missing", (store) =>
      Effect.gen(function* () {
        const name = "claim on a missing session reports Missing"
        const outcome = yield* store.claim("ghost", { prompt: Prompt.make("go"), stream: false })
        yield* equal(name)(outcome._tag, "Missing", "the outcome")
      })),

    make("claims atomically and persists the request", (store) =>
      Effect.gen(function* () {
        const name = "claims atomically and persists the request"
        yield* store.getOrCreate("s1", historyWith("system"))
        const outcome = yield* store.claim("s1", { prompt: historyWith("do the thing"), stream: true })
        yield* that(name)(outcome._tag === "Claimed", `expected Claimed, got ${outcome._tag}`)
        if (outcome._tag !== "Claimed") return
        // The id derives from the session-local ordinal.
        yield* that(name)(outcome.claim.submissionId.includes("s1"), `submission id ${outcome.claim.submissionId} does not name the session`)
        yield* equal(name)(outcome.claim.stream, true, "stream on the claim")
        // The claim is on the record: a later process can see what was
        // asked even if this one died before dispatching the workflow.
        const record = yield* recordOf(name, store, "s1")
        yield* equal(name)(record.status, "running", "status")
        yield* that(name)(Option.isSome(record.claim), "expected a live claim on the record")
        if (Option.isNone(record.claim)) return
        yield* equal(name)(yield* userTexts(record.claim.value.prompt), ["do the thing"], "the persisted prompt")
      })),

    /**
     * A typed input (`AgentInput`) is claimed as its encoded value with an
     * empty prompt: the rendering is the workflow's to produce. The value
     * has to survive the store as it was given, because the workflow
     * decodes it with the agent's schema and a replay renders the same one.
     */
    make("persists a typed input's value on the claim, and no value when there is none", (store) =>
      Effect.gen(function* () {
        const name = "persists a typed input's value on the claim, and no value when there is none"
        yield* store.getOrCreate("typed", historyWith("system"))
        const value = { customerId: "c-42", tags: ["late", "refund"], nested: { count: 2 } }
        const outcome = yield* store.claim("typed", { prompt: Prompt.empty, input: value, stream: false })
        yield* that(name)(outcome._tag === "Claimed", `expected Claimed, got ${outcome._tag}`)
        if (outcome._tag !== "Claimed") return
        yield* equal(name)(outcome.claim.input, value, "the value on the returned claim")
        const record = yield* recordOf(name, store, "typed")
        yield* that(name)(Option.isSome(record.claim), "expected a live claim on the record")
        if (Option.isNone(record.claim)) return
        yield* equal(name)(record.claim.value.input, value, "the value as a later process reads it")
        yield* equal(name)(yield* userTexts(record.claim.value.prompt), [], "no rendering on the claim")

        yield* store.getOrCreate("plain", historyWith("system"))
        const plain = yield* store.claim("plain", { prompt: historyWith("go"), stream: false })
        yield* that(name)(plain._tag === "Claimed", `expected Claimed, got ${plain._tag}`)
        if (plain._tag !== "Claimed") return
        yield* that(name)(!("input" in plain.claim) || plain.claim.input === undefined, "a prompt claim carries no value")
      })),

    /**
     * A `StorageError` from `claim` means "unknown", not "did not happen".
     * The key makes a retry recognisable as the same request, which is what
     * turns an indeterminate failure into a safe one.
     */
    make("a retry under the same key is the same claim, not a busy session", (store) =>
      Effect.gen(function* () {
        const name = "a retry under the same key is the same claim, not a busy session"
        yield* store.getOrCreate("s1", historyWith("system"))
        const request = { prompt: Prompt.make("do the thing"), stream: false, key: "request-7" }
        const first = yield* store.claim("s1", request)
        yield* equal(name)(first._tag, "Claimed", "the first claim")
        // The caller never learned that. It asks again, naming the same request.
        const retry = yield* store.claim("s1", request)
        yield* that(name)(retry._tag === "Claimed", "the retry was treated as a second request")
        if (retry._tag === "Claimed" && first._tag === "Claimed") {
          // The *same* claim, so the caller resumes rather than starting a
          // second submission.
          yield* equal(name)(retry.claim, first.claim, "the retried claim")
        }
        // And the ordinal did not move: a retry is not a submission.
        const record = yield* recordOf(name, store, "s1")
        yield* equal(name)(record.submissionCount, 1, "submission count")
      })),

    make("a different key on a claimed session is still Busy", (store) =>
      Effect.gen(function* () {
        const name = "a different key on a claimed session is still Busy"
        yield* store.getOrCreate("s1", historyWith("system"))
        yield* store.claim("s1", { prompt: Prompt.make("mine"), stream: false, key: "request-7" })
        // Somebody else's request, which must not be coalesced into the first.
        const other = yield* store.claim("s1", { prompt: Prompt.make("theirs"), stream: false, key: "request-8" })
        yield* equal(name)(other._tag, "Busy", "a different key")
        // A caller with no key at all gets the old answer, which is the
        // documented behaviour rather than an oversight.
        const keyless = yield* store.claim("s1", { prompt: Prompt.make("anon"), stream: false })
        yield* equal(name)(keyless._tag, "Busy", "no key")
      })),

    /**
     * The key's window is the claim's lifetime: `finish` takes the key with
     * the claim it belonged to, so a key reused long afterwards cannot
     * coalesce into a submission that has ended.
     */
    make("a key reused after its submission finished starts a new one", (store) =>
      Effect.gen(function* () {
        const name = "a key reused after its submission finished starts a new one"
        yield* store.getOrCreate("s1", historyWith("system"))
        const request = { prompt: Prompt.make("go"), stream: false, key: "k1" }
        const first = yield* store.claim("s1", request)
        yield* equal(name)(first._tag, "Claimed", "the first claim")
        if (first._tag !== "Claimed") return
        yield* store.finish("s1", first.claim.submissionId, historyWith("system"))
        const again = yield* store.claim("s1", request)
        yield* equal(name)(again._tag, "Claimed", "the claim after finish")
        if (again._tag !== "Claimed") return
        yield* that(name)(again.claim.submissionId !== first.claim.submissionId, "the reused key coalesced into the finished submission")
      })),

    make("two concurrent claims produce one Claimed and one Busy", (store) =>
      Effect.gen(function* () {
        const name = "two concurrent claims produce one Claimed and one Busy"
        yield* store.getOrCreate("s1", historyWith("system"))
        // Forked together on purpose: whichever order they run in, exactly
        // one may take an idle session. That is the whole point of claim
        // being one transition rather than read-then-write.
        const first = yield* Effect.forkChild(store.claim("s1", { prompt: Prompt.make("one"), stream: false }))
        const second = yield* Effect.forkChild(store.claim("s1", { prompt: Prompt.make("two"), stream: false }))
        const outcomes = [yield* Fiber.join(first), yield* Fiber.join(second)]
        const claimed = outcomes.filter((o) => o._tag === "Claimed")
        const busy = outcomes.filter((o) => o._tag === "Busy")
        yield* equal(name)(claimed.length, 1, "claimed outcomes")
        yield* equal(name)(busy.length, 1, "busy outcomes")
        // The loser is told who holds the session, not just refused.
        if (busy[0]?._tag === "Busy" && claimed[0]?._tag === "Claimed") {
          yield* equal(name)(busy[0].claim, claimed[0].claim, "the claim the loser was told about")
        }
        // And exactly one submission was consumed from the ordinal.
        const record = yield* recordOf(name, store, "s1")
        yield* equal(name)(record.submissionCount, 1, "submission count")
      })),

    make("attachExecution records the workflow behind a live claim", (store) =>
      Effect.gen(function* () {
        const name = "attachExecution records the workflow behind a live claim"
        yield* store.getOrCreate("s1", historyWith("system"))
        const outcome = yield* store.claim("s1", { prompt: Prompt.make("go"), stream: false })
        yield* that(name)(outcome._tag === "Claimed", "expected Claimed")
        if (outcome._tag !== "Claimed") return
        const executionIdOf = (record: DurableSessionStore.SessionRecord) =>
          Option.isSome(record.claim) ? record.claim.value.executionId : undefined
        yield* store.attachExecution("s1", outcome.claim.submissionId, "execution-7")
        yield* equal(name)(executionIdOf(yield* recordOf(name, store, "s1")), "execution-7", "the attached execution")
        // A stale submission id must not touch the live claim.
        yield* store.attachExecution("s1", "someone-else", "wrong")
        yield* equal(name)(executionIdOf(yield* recordOf(name, store, "s1")), "execution-7", "the execution after a stale attach")
      })),

    make("finish restores idle, advances history, and refuses a replay", (store) =>
      Effect.gen(function* () {
        const name = "finish restores idle, advances history, and refuses a replay"
        yield* store.getOrCreate("s1", historyWith("system"))
        const claimed = yield* store.claim("s1", { prompt: Prompt.make("go"), stream: false })
        yield* that(name)(claimed._tag === "Claimed", "expected Claimed")
        if (claimed._tag !== "Claimed") return
        const done = yield* store.finish("s1", claimed.claim.submissionId, historyWith("committed turn"))
        yield* that(name)(done, "finish reported no active claim")
        const record = yield* recordOf(name, store, "s1")
        yield* equal(name)(record.status, "idle", "status after finish")
        yield* equal(name)(record.submissionCount, 1, "submission count")
        yield* equal(name)(yield* userTexts(record.history), ["committed turn"], "the advanced history")
        // A second terminal event for the same submission finds no active
        // claim and changes nothing.
        const replayed = yield* store.finish("s1", claimed.claim.submissionId, historyWith("should not land"))
        yield* that(name)(!replayed, "a replayed finish was accepted")
        yield* equal(name)(yield* userTexts((yield* recordOf(name, store, "s1")).history), ["committed turn"], "history after the replay")
      })),

    make("the pending projection moves waiting -> answered atomically", (store) =>
      Effect.gen(function* () {
        const name = "the pending projection moves waiting -> answered atomically"
        const request: Elicitation.Request = { id: "elicit-1", kind: "tool-approval", detail: "wipe the database" }
        const response: Elicitation.Response = { id: "elicit-1", granted: true }
        // Answering before anything was asked is a false, not a failure --
        // the same contract `Elicitation.respond` keeps.
        yield* that(name)(!(yield* store.answerRequest("s1", response)), "an answer to nothing was accepted")
        yield* store.addPendingRequest("s1", request)
        yield* equal(name)(yield* store.pendingRequests("s1"), [request], "pending after add")
        // One answer lands; a retry finds nothing waiting and reports false.
        yield* that(name)(yield* store.answerRequest("s1", response), "the answer was not accepted")
        yield* that(name)(!(yield* store.answerRequest("s1", response)), "a second answer was accepted")
        yield* equal(name)(yield* store.pendingRequests("s1"), [], "pending after answer")
        // The recorded answer survives until the run takes it, then it is gone.
        yield* equal(name)(yield* store.takeAnswer("s1", "elicit-1"), Option.some(response), "the taken answer")
        yield* that(name)(Option.isNone(yield* store.takeAnswer("s1", "elicit-1")), "the answer was taken twice")
      })),

    make("claim and finish both clear the elicitation projection", (store) =>
      Effect.gen(function* () {
        const name = "claim and finish both clear the elicitation projection"
        yield* store.getOrCreate("s1", historyWith("system"))
        // Leftovers from a submission whose process died between delivering
        // an answer and taking it. Request ids restart per execution, so if
        // these survived into the next claim they would be mistaken for its
        // own `elicit-1`.
        yield* store.addPendingRequest("s1", { id: "elicit-1", kind: "input", detail: undefined })
        yield* that(name)(yield* store.answerRequest("s1", { id: "elicit-1", granted: true }), "the leftover answer was not accepted")
        yield* store.addPendingRequest("s1", { id: "elicit-2", kind: "input", detail: undefined })
        const claimed = yield* store.claim("s1", { prompt: Prompt.make("go"), stream: false })
        yield* equal(name)(claimed._tag, "Claimed", "the claim")
        yield* equal(name)(yield* store.pendingRequests("s1"), [], "pending after claim")
        yield* equal(name)(yield* store.recordedAnswers("s1"), [], "recorded after claim")
        yield* that(name)(Option.isNone(yield* store.takeAnswer("s1", "elicit-1")), "an answer survived the claim")
        // And the same at the other end of the submission.
        if (claimed._tag !== "Claimed") return
        yield* store.addPendingRequest("s1", { id: "elicit-1", kind: "input", detail: undefined })
        yield* store.answerRequest("s1", { id: "elicit-1", granted: false })
        yield* that(name)(yield* store.finish("s1", claimed.claim.submissionId, historyWith("done")), "finish reported no active claim")
        yield* equal(name)(yield* store.recordedAnswers("s1"), [], "recorded after finish")
        yield* equal(name)(yield* store.pendingRequests("s1"), [], "pending after finish")
      })),

    make("an answered request is not re-registered as pending by a replay", (store) =>
      Effect.gen(function* () {
        const name = "an answered request is not re-registered as pending by a replay"
        const request: Elicitation.Request = { id: "elicit-1", kind: "input", detail: undefined }
        yield* store.addPendingRequest("s1", request)
        yield* store.answerRequest("s1", { id: "elicit-1", granted: true })
        // The resumed run asks again under the same id on its way to
        // finding the answer already there.
        yield* store.addPendingRequest("s1", request)
        yield* equal(name)(yield* store.pendingRequests("s1"), [], "pending after the replayed add")
        yield* equal(name)((yield* store.recordedAnswers("s1")).length, 1, "recorded answers")
      })),

    make("an id that is already pending keeps the request it was created with", (store) =>
      Effect.gen(function* () {
        const name = "an id that is already pending keeps the request it was created with"
        yield* store.addPendingRequest("s1", { id: "elicit-1", kind: "input", detail: "first" })
        // A replay asking under the same id with a different payload. First
        // write wins, as everywhere else in the store.
        yield* store.addPendingRequest("s1", { id: "elicit-1", kind: "input", detail: "second" })
        const pending = yield* store.pendingRequests("s1")
        yield* equal(name)(pending.length, 1, "pending requests")
        yield* equal(name)(pending[0]?.detail, "first", "the kept detail")
      })),

    make("removing a request forgets it without recording an answer", (store) =>
      Effect.gen(function* () {
        const name = "removing a request forgets it without recording an answer"
        yield* store.addPendingRequest("s1", { id: "elicit-2", kind: "input", detail: undefined })
        // The run consumed the request itself (for instance because the
        // turn was interrupted); no answer ever existed.
        yield* store.removeRequest("s1", "elicit-2")
        yield* equal(name)(yield* store.pendingRequests("s1"), [], "pending after remove")
        yield* that(name)(Option.isNone(yield* store.takeAnswer("s1", "elicit-2")), "an answer was recorded")
      }))
  ]
}

/** Every case against a store constructor, reported. Never fails. */
export const run = <E>(options: Options<E>): Effect.Effect<Report> => report(cases(options))
