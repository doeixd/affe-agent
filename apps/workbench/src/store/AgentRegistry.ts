/**
 * Named agents and their revisions (plan-agent-product-control-plane.md §6).
 */
import { Context, DateTime, Effect, Layer, Option, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { AgentRevision, AgentSpec, RevisionInput as RevisionInputSchema } from "../domain/AgentRevision.js"
import type { RevisionInput } from "../domain/AgentRevision.js"
import { AgentId, AgentRevisionId, OrganizationId, UserId as UserIdSchema } from "../domain/WorkbenchIds.js"
import type { UserId } from "../domain/WorkbenchIds.js"
import { failedAs, WorkbenchStorageError } from "./WorkbenchStorageError.js"

export class AgentNotFoundError extends Schema.TaggedError<AgentNotFoundError>()("AgentNotFoundError", {
  agentId: AgentId
}, { httpApiStatus: 404 }) {}

export const NewAgent = Schema.Struct({
  ownerId: UserIdSchema,
  /** Shared with an organization's members from the start, or the owner's alone. */
  organizationId: Schema.optional(OrganizationId),
  name: Schema.String,
  description: Schema.optional(Schema.String),
  revision: RevisionInputSchema
})
export type NewAgent = typeof NewAgent.Type

export const Created = Schema.Struct({ spec: AgentSpec, revision: AgentRevision })

export interface Created {
  readonly spec: AgentSpec
  readonly revision: AgentRevision
}

export interface Service {
  readonly get: (id: AgentId) => Effect.Effect<Option.Option<AgentSpec>, WorkbenchStorageError>
  readonly revision: (id: AgentRevisionId) => Effect.Effect<Option.Option<AgentRevision>, WorkbenchStorageError>
  /** Oldest first. */
  readonly revisions: (id: AgentId) => Effect.Effect<ReadonlyArray<AgentRevision>, WorkbenchStorageError>
  readonly list: (owner: UserId) => Effect.Effect<ReadonlyArray<AgentSpec>, WorkbenchStorageError>
  /** Every agent belonging to any of these organizations, by id. Empty for no organizations. */
  readonly listShared: (organizations: ReadonlyArray<OrganizationId>) => Effect.Effect<ReadonlyArray<AgentSpec>, WorkbenchStorageError>
  readonly create: (input: NewAgent) => Effect.Effect<Created, WorkbenchStorageError>
  /** Write the next revision and make it the active one. Earlier revisions are untouched. */
  readonly revise: (
    id: AgentId,
    input: RevisionInput,
    by: UserId
  ) => Effect.Effect<AgentRevision, AgentNotFoundError | WorkbenchStorageError>
  readonly archive: (id: AgentId) => Effect.Effect<void, AgentNotFoundError | WorkbenchStorageError>
}

export class AgentRegistry extends Context.Service<AgentRegistry, Service>()("workbench/AgentRegistry") {}

/** Readable and ordered: an agent's third revision is `<agent>@3`. */
const revisionIdOf = (agentId: AgentId, revision: number) => AgentRevisionId.make(`${agentId}@${revision}`)

const firstRevision = Effect.fn("AgentRegistry.firstRevision")(function*(input: NewAgent) {
  const now = yield* DateTime.now
  const agentId = AgentId.make(globalThis.crypto.randomUUID())
  const revision: AgentRevision = {
    id: revisionIdOf(agentId, 1),
    agentId,
    revision: 1,
    ...input.revision,
    createdBy: input.ownerId,
    createdAt: now
  }
  const spec: AgentSpec = {
    id: agentId,
    ownerId: input.ownerId,
    organizationId: Option.fromNullishOr(input.organizationId),
    name: input.name,
    description: Option.fromNullishOr(input.description),
    activeRevisionId: revision.id,
    createdAt: now,
    archivedAt: Option.none()
  }
  return { spec, revision }
})

const nextRevision = (spec: AgentSpec, latest: number, input: RevisionInput, by: UserId, now: DateTime.Utc) => {
  const revision: AgentRevision = {
    id: revisionIdOf(spec.id, latest + 1),
    agentId: spec.id,
    revision: latest + 1,
    ...input,
    createdBy: by,
    createdAt: now
  }
  return { revision, spec: { ...spec, activeRevisionId: revision.id } }
}

// -- Memory -----------------------------------------------------------------------------

interface State {
  readonly specs: ReadonlyMap<AgentId, AgentSpec>
  readonly revisions: ReadonlyMap<AgentRevisionId, AgentRevision>
}

export const memory: Layer.Layer<AgentRegistry> = Layer.effect(
  AgentRegistry,
  Effect.gen(function*() {
    const state = yield* Ref.make<State>({ specs: new Map(), revisions: new Map() })

    const create = Effect.fn("AgentRegistry.create")(function*(input: NewAgent) {
      const created = yield* firstRevision(input)
      yield* Ref.update(state, (current) => ({
        specs: new Map(current.specs).set(created.spec.id, created.spec),
        revisions: new Map(current.revisions).set(created.revision.id, created.revision)
      }))
      return created
    })

    const revise = Effect.fn("AgentRegistry.revise")(function*(id: AgentId, input: RevisionInput, by: UserId) {
      const now = yield* DateTime.now
      // One modify: the number is read and the revision written together, so
      // two concurrent edits cannot both become revision N+1.
      const written = yield* Ref.modify(state, (current): [Option.Option<AgentRevision>, State] => {
        const spec = current.specs.get(id)
        if (spec === undefined) return [Option.none(), current]
        const latest = [...current.revisions.values()].filter((entry) => entry.agentId === id).length
        const next = nextRevision(spec, latest, input, by, now)
        return [Option.some(next.revision), {
          specs: new Map(current.specs).set(id, next.spec),
          revisions: new Map(current.revisions).set(next.revision.id, next.revision)
        }]
      })
      return yield* Option.match(written, {
        onNone: () => Effect.fail(new AgentNotFoundError({ agentId: id })),
        onSome: Effect.succeed
      })
    })

    const archive = Effect.fn("AgentRegistry.archive")(function*(id: AgentId) {
      const now = yield* DateTime.now
      const found = yield* Ref.modify(state, (current): [boolean, State] => {
        const spec = current.specs.get(id)
        if (spec === undefined) return [false, current]
        if (Option.isSome(spec.archivedAt)) return [true, current]
        return [true, { ...current, specs: new Map(current.specs).set(id, { ...spec, archivedAt: Option.some(now) }) }]
      })
      if (!found) {
        return yield* new AgentNotFoundError({ agentId: id })
      }
    })

    return AgentRegistry.of({
      get: (id) => Effect.map(Ref.get(state), (current) => Option.fromNullishOr(current.specs.get(id))),
      revision: (id) => Effect.map(Ref.get(state), (current) => Option.fromNullishOr(current.revisions.get(id))),
      revisions: (id) =>
        Effect.map(Ref.get(state), (current) =>
          [...current.revisions.values()]
            .filter((entry) => entry.agentId === id)
            .sort((a, b) => a.revision - b.revision)),
      list: (owner) =>
        Effect.map(Ref.get(state), (current) => [...current.specs.values()].filter((spec) => spec.ownerId === owner)),
      listShared: (organizations) =>
        Effect.map(Ref.get(state), (current) =>
          [...current.specs.values()]
            .filter((spec) => Option.isSome(spec.organizationId) && organizations.includes(spec.organizationId.value))
            .sort((a, b) => a.id.localeCompare(b.id))),
      create,
      revise,
      archive
    })
  })
)

// -- SQL --------------------------------------------------------------------------------

const SpecJson = Schema.toCodecJson(AgentSpec)
const RevisionJson = Schema.toCodecJson(AgentRevision)

/** Encoding is a defect: the value was built by this module. */
const encodeSpec = (spec: AgentSpec) =>
  Effect.orDie(Effect.map(Schema.encodeEffect(SpecJson)(spec), (encoded) => JSON.stringify(encoded)))
const encodeRevision = (revision: AgentRevision) =>
  Effect.orDie(Effect.map(Schema.encodeEffect(RevisionJson)(revision), (encoded) => JSON.stringify(encoded)))

const parse = (operation: string, text: string) =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: failedAs(operation) })

/** A body this module wrote no longer decodes: corruption or a schema change, named as storage. */
const decodeSpec = (text: string) =>
  Effect.flatMap(parse("decodeSpec", text), (json) =>
    Effect.mapError(Schema.decodeUnknownEffect(SpecJson)(json), failedAs("decodeSpec")))
const decodeRevision = (text: string) =>
  Effect.flatMap(parse("decodeRevision", text), (json) =>
    Effect.mapError(Schema.decodeUnknownEffect(RevisionJson)(json), failedAs("decodeRevision")))

interface BodyRow {
  readonly body: string
}

/**
 * A registry over existing tables (`sqlWithTables` creates them).
 *
 * Bodies are the schemas' JSON encoding; the columns beside them exist to be
 * queried. `(agent_id, revision)` is unique, so two edits racing to the same
 * number cannot both commit: the loser's transaction fails instead of
 * silently producing two revision N+1s.
 */
export const sql: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient

  const getSpec = (id: AgentId) =>
    client<BodyRow>`SELECT body FROM workbench_agents WHERE id = ${id}`.pipe(
      Effect.mapError(failedAs("AgentRegistry.get")),
      Effect.flatMap((rows) =>
        rows[0] === undefined ? Effect.succeed(Option.none<AgentSpec>()) : Effect.map(decodeSpec(rows[0].body), Option.some)
      )
    )

  const writeSpec = (spec: AgentSpec) =>
    Effect.flatMap(encodeSpec(spec), (body) =>
      client`UPDATE workbench_agents SET body = ${body} WHERE id = ${spec.id}`)

  const insertRevision = (revision: AgentRevision) =>
    Effect.flatMap(encodeRevision(revision), (body) =>
      client`INSERT INTO workbench_agent_revisions (id, agent_id, revision, body) VALUES (${revision.id}, ${revision.agentId}, ${revision.revision}, ${body})`)

  const create = Effect.fn("AgentRegistry.create")(function*(input: NewAgent) {
    const created = yield* firstRevision(input)
    const body = yield* encodeSpec(created.spec)
    yield* client.withTransaction(
      client`INSERT INTO workbench_agents (id, owner_id, organization_id, body) VALUES (${created.spec.id}, ${created.spec.ownerId}, ${Option.getOrNull(created.spec.organizationId)}, ${body})`.pipe(
        Effect.andThen(insertRevision(created.revision))
      )
    ).pipe(Effect.mapError(failedAs("AgentRegistry.create")))
    return created
  })

  const revise = Effect.fn("AgentRegistry.revise")(function*(id: AgentId, input: RevisionInput, by: UserId) {
    const now = yield* DateTime.now
    return yield* client.withTransaction(Effect.gen(function*() {
      const spec = yield* getSpec(id)
      if (Option.isNone(spec)) {
        return yield* new AgentNotFoundError({ agentId: id })
      }
      const [row] = yield* client<{ readonly latest: number | bigint }>`SELECT COALESCE(MAX(revision), 0) AS latest FROM workbench_agent_revisions WHERE agent_id = ${id}`
      const next = nextRevision(spec.value, Number(row?.latest ?? 0), input, by, now)
      yield* insertRevision(next.revision)
      yield* writeSpec(next.spec)
      return next.revision
    })).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(failedAs("AgentRegistry.revise")(cause))))
  })

  const archive = Effect.fn("AgentRegistry.archive")(function*(id: AgentId) {
    const now = yield* DateTime.now
    yield* client.withTransaction(Effect.gen(function*() {
      const spec = yield* getSpec(id)
      if (Option.isNone(spec)) {
        return yield* new AgentNotFoundError({ agentId: id })
      }
      if (Option.isNone(spec.value.archivedAt)) {
        yield* writeSpec({ ...spec.value, archivedAt: Option.some(now) })
      }
    })).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(failedAs("AgentRegistry.archive")(cause))))
  })

  const revisionsWhere = (operation: string, rows: Effect.Effect<ReadonlyArray<BodyRow>, unknown>) =>
    rows.pipe(
      Effect.mapError(failedAs(operation)),
      Effect.flatMap((found) => Effect.forEach(found, (row) => decodeRevision(row.body)))
    )

  return AgentRegistry.of({
    get: getSpec,
    revision: (id) =>
      Effect.map(
        revisionsWhere("AgentRegistry.revision", client<BodyRow>`SELECT body FROM workbench_agent_revisions WHERE id = ${id}`),
        (found) => Option.fromNullishOr(found[0])
      ),
    revisions: (id) =>
      revisionsWhere(
        "AgentRegistry.revisions",
        client<BodyRow>`SELECT body FROM workbench_agent_revisions WHERE agent_id = ${id} ORDER BY revision`
      ),
    list: (owner) =>
      client<BodyRow>`SELECT body FROM workbench_agents WHERE owner_id = ${owner} ORDER BY id`.pipe(
        Effect.mapError(failedAs("AgentRegistry.list")),
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeSpec(row.body)))
      ),
    listShared: (organizations) =>
      organizations.length === 0
        ? Effect.succeed([])
        : client<BodyRow>`SELECT body FROM workbench_agents WHERE organization_id IN ${client.in(organizations)} ORDER BY id`.pipe(
          Effect.mapError(failedAs("AgentRegistry.listShared")),
          Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeSpec(row.body)))
        ),
    create,
    revise,
    archive
  })
})

/** As `sql`, creating the tables first if absent. */
export const sqlWithTables: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient
  yield* client`CREATE TABLE IF NOT EXISTS workbench_agents (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    organization_id TEXT,
    body TEXT NOT NULL
  )`.pipe(Effect.orDie)
  // A table from before organizations lacks the column; add it once.
  const columns = yield* client<{ readonly name: string }>`PRAGMA table_info(workbench_agents)`.pipe(Effect.orDie)
  if (!columns.some((column) => column.name === "organization_id")) {
    yield* client`ALTER TABLE workbench_agents ADD COLUMN organization_id TEXT`.pipe(Effect.orDie)
  }
  yield* client`CREATE INDEX IF NOT EXISTS workbench_agents_by_organization ON workbench_agents (organization_id)`.pipe(Effect.orDie)
  yield* client`CREATE TABLE IF NOT EXISTS workbench_agent_revisions (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (agent_id, revision)
  )`.pipe(Effect.orDie)
  return yield* sql
})

export const layerSql: Layer.Layer<AgentRegistry, never, SqlClient.SqlClient> = Layer.effect(AgentRegistry, sqlWithTables)
