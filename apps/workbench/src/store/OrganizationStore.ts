/**
 * Organizations and their members (plan-agent-product-control-plane.md §5, §42).
 *
 * One store for both, because a membership without its organization is
 * meaningless and creating an organization writes its first owner in the
 * same step. Two invariants are the store's, not the caller's: an
 * organization always keeps at least one owner, and the only member an
 * organization can have is one it was given -- there is no membership row
 * without an organization row.
 */
import { Context, DateTime, Effect, Layer, Option, Ref, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql"
import { Membership, Organization, Role } from "../domain/Organization.js"
import type { Joined } from "../domain/Organization.js"
import { OrganizationId, UserId } from "../domain/WorkbenchIds.js"
import { failedAs, WorkbenchStorageError } from "./WorkbenchStorageError.js"

export class OrganizationNotFoundError extends Schema.TaggedError<OrganizationNotFoundError>()(
  "OrganizationNotFoundError",
  { organizationId: OrganizationId },
  { httpApiStatus: 404 }
) {}

/** Removing or demoting this person would leave the organization without an owner. */
export class LastOwnerError extends Schema.TaggedError<LastOwnerError>()(
  "LastOwnerError",
  { organizationId: OrganizationId, userId: UserId },
  { httpApiStatus: 409 }
) {}

export interface Service {
  /** A new organization with `by` as its owner. */
  readonly create: (name: string, by: UserId) => Effect.Effect<Organization, WorkbenchStorageError>
  readonly get: (id: OrganizationId) => Effect.Effect<Option.Option<Organization>, WorkbenchStorageError>
  /** Every organization this person is in, with their role, by name. */
  readonly listFor: (user: UserId) => Effect.Effect<ReadonlyArray<Joined>, WorkbenchStorageError>
  /** Every member, by user id. Empty for an unknown organization: the caller decides what that means. */
  readonly members: (id: OrganizationId) => Effect.Effect<ReadonlyArray<Membership>, WorkbenchStorageError>
  readonly role: (id: OrganizationId, user: UserId) => Effect.Effect<Option.Option<Role>, WorkbenchStorageError>
  /** Add a member, or change an existing one's role. Refused when it would demote the last owner. */
  readonly setMember: (
    id: OrganizationId,
    user: UserId,
    role: Role
  ) => Effect.Effect<Membership, OrganizationNotFoundError | LastOwnerError | WorkbenchStorageError>
  /** Refused when it would remove the last owner. Removing a non-member changes nothing. */
  readonly removeMember: (
    id: OrganizationId,
    user: UserId
  ) => Effect.Effect<void, OrganizationNotFoundError | LastOwnerError | WorkbenchStorageError>
}

export class OrganizationStore extends Context.Service<OrganizationStore, Service>()("workbench/OrganizationStore") {}

const byName = (a: Joined, b: Joined) =>
  a.organization.name.localeCompare(b.organization.name) || a.organization.id.localeCompare(b.organization.id)
const byUser = (a: Membership, b: Membership) => a.userId.localeCompare(b.userId)

/** Whether `members` keeps an owner other than `user` -- what a demotion or removal of `user` needs. */
const anotherOwner = (members: ReadonlyArray<Membership>, user: UserId): boolean =>
  members.some((member) => member.role === "owner" && member.userId !== user)

// -- Memory -----------------------------------------------------------------------------

interface State {
  readonly organizations: ReadonlyMap<OrganizationId, Organization>
  /** Keyed by organization, then user. */
  readonly members: ReadonlyMap<OrganizationId, ReadonlyMap<UserId, Membership>>
}

export const memory: Layer.Layer<OrganizationStore> = Layer.effect(
  OrganizationStore,
  Effect.gen(function*() {
    const state = yield* Ref.make<State>({ organizations: new Map(), members: new Map() })

    const membersOf = (current: State, id: OrganizationId): ReadonlyMap<UserId, Membership> =>
      current.members.get(id) ?? new Map()

    const withMembers = (current: State, id: OrganizationId, members: ReadonlyMap<UserId, Membership>): State => ({
      ...current,
      members: new Map(current.members).set(id, members)
    })

    const create = Effect.fn("OrganizationStore.create")(function*(name: string, by: UserId) {
      const now = yield* DateTime.now
      const organization: Organization = { id: OrganizationId.make(globalThis.crypto.randomUUID()), name, createdAt: now }
      const owner: Membership = { organizationId: organization.id, userId: by, role: "owner", since: now }
      yield* Ref.update(state, (current) =>
        withMembers(
          { ...current, organizations: new Map(current.organizations).set(organization.id, organization) },
          organization.id,
          new Map([[by, owner]])
        ))
      return organization
    })

    const setMember = Effect.fn("OrganizationStore.setMember")(function*(id: OrganizationId, user: UserId, role: Role) {
      const now = yield* DateTime.now
      const outcome = yield* Ref.modify(
        state,
        (current): [Effect.Effect<Membership, OrganizationNotFoundError | LastOwnerError>, State] => {
          if (!current.organizations.has(id)) {
            return [Effect.fail(new OrganizationNotFoundError({ organizationId: id })), current]
          }
          const members = membersOf(current, id)
          const existing = members.get(user)
          if (existing?.role === "owner" && role !== "owner" && !anotherOwner([...members.values()], user)) {
            return [Effect.fail(new LastOwnerError({ organizationId: id, userId: user })), current]
          }
          const membership: Membership = { organizationId: id, userId: user, role, since: existing?.since ?? now }
          return [Effect.succeed(membership), withMembers(current, id, new Map(members).set(user, membership))]
        }
      )
      return yield* outcome
    })

    const removeMember = Effect.fn("OrganizationStore.removeMember")(function*(id: OrganizationId, user: UserId) {
      const outcome = yield* Ref.modify(
        state,
        (current): [Effect.Effect<void, OrganizationNotFoundError | LastOwnerError>, State] => {
          if (!current.organizations.has(id)) {
            return [Effect.fail(new OrganizationNotFoundError({ organizationId: id })), current]
          }
          const members = membersOf(current, id)
          const existing = members.get(user)
          if (existing === undefined) return [Effect.void, current]
          if (existing.role === "owner" && !anotherOwner([...members.values()], user)) {
            return [Effect.fail(new LastOwnerError({ organizationId: id, userId: user })), current]
          }
          const next = new Map(members)
          next.delete(user)
          return [Effect.void, withMembers(current, id, next)]
        }
      )
      return yield* outcome
    })

    return OrganizationStore.of({
      create,
      get: (id) => Effect.map(Ref.get(state), (current) => Option.fromNullishOr(current.organizations.get(id))),
      listFor: (user) =>
        Effect.map(Ref.get(state), (current) =>
          [...current.members.entries()].flatMap(([id, members]): ReadonlyArray<Joined> => {
            const membership = members.get(user)
            const organization = current.organizations.get(id)
            return membership === undefined || organization === undefined ? [] : [{ organization, role: membership.role }]
          }).sort(byName)),
      members: (id) => Effect.map(Ref.get(state), (current) => [...membersOf(current, id).values()].sort(byUser)),
      role: (id, user) =>
        Effect.map(Ref.get(state), (current) => Option.map(Option.fromNullishOr(membersOf(current, id).get(user)), (m) => m.role)),
      setMember,
      removeMember
    })
  })
)

// -- SQL ----------------------------------------------------------------------------------

const OrganizationJson = Schema.toCodecJson(Organization)
const MembershipJson = Schema.toCodecJson(Membership)

const encodeOrganization = (organization: Organization) =>
  Effect.orDie(Effect.map(Schema.encodeEffect(OrganizationJson)(organization), (encoded) => JSON.stringify(encoded)))
const encodeMembership = (membership: Membership) =>
  Effect.orDie(Effect.map(Schema.encodeEffect(MembershipJson)(membership), (encoded) => JSON.stringify(encoded)))

const parse = (operation: string, text: string) =>
  Effect.try({ try: (): unknown => JSON.parse(text), catch: failedAs(operation) })

const decodeOrganization = (text: string) =>
  Effect.flatMap(parse("decodeOrganization", text), (json) =>
    Effect.mapError(Schema.decodeUnknownEffect(OrganizationJson)(json), failedAs("decodeOrganization")))
const decodeMembership = (text: string) =>
  Effect.flatMap(parse("decodeMembership", text), (json) =>
    Effect.mapError(Schema.decodeUnknownEffect(MembershipJson)(json), failedAs("decodeMembership")))

interface BodyRow {
  readonly body: string
}

/**
 * Over existing tables (`sqlWithTables` creates them). Bodies are the
 * schemas' JSON; the columns beside them are what is queried. Every
 * multi-step write is one transaction, so the last-owner rule is checked
 * against the rows it then changes.
 */
export const sql: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient

  const getOrganization = (id: OrganizationId) =>
    client<BodyRow>`SELECT body FROM workbench_organizations WHERE id = ${id}`.pipe(
      Effect.mapError(failedAs("OrganizationStore.get")),
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? Effect.succeed(Option.none<Organization>())
          : Effect.map(decodeOrganization(rows[0].body), Option.some)
      )
    )

  const membersOf = (id: OrganizationId) =>
    client<BodyRow>`SELECT body FROM workbench_memberships WHERE organization_id = ${id} ORDER BY user_id`.pipe(
      Effect.mapError(failedAs("OrganizationStore.members")),
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => decodeMembership(row.body)))
    )

  const writeMembership = (membership: Membership) =>
    Effect.flatMap(encodeMembership(membership), (body) =>
      client`INSERT INTO workbench_memberships (organization_id, user_id, role, body) VALUES (${membership.organizationId}, ${membership.userId}, ${membership.role}, ${body})
        ON CONFLICT (organization_id, user_id) DO UPDATE SET role = excluded.role, body = excluded.body`)

  const create = Effect.fn("OrganizationStore.create")(function*(name: string, by: UserId) {
    const now = yield* DateTime.now
    const organization: Organization = { id: OrganizationId.make(globalThis.crypto.randomUUID()), name, createdAt: now }
    const body = yield* encodeOrganization(organization)
    yield* client.withTransaction(
      client`INSERT INTO workbench_organizations (id, name, body) VALUES (${organization.id}, ${name}, ${body})`.pipe(
        Effect.andThen(writeMembership({ organizationId: organization.id, userId: by, role: "owner", since: now }))
      )
    ).pipe(Effect.mapError(failedAs("OrganizationStore.create")))
    return organization
  })

  const setMember = Effect.fn("OrganizationStore.setMember")(function*(id: OrganizationId, user: UserId, role: Role) {
    const now = yield* DateTime.now
    return yield* client.withTransaction(Effect.gen(function*() {
      if (Option.isNone(yield* getOrganization(id))) {
        return yield* new OrganizationNotFoundError({ organizationId: id })
      }
      const members = yield* membersOf(id)
      const existing = members.find((member) => member.userId === user)
      if (existing?.role === "owner" && role !== "owner" && !anotherOwner(members, user)) {
        return yield* new LastOwnerError({ organizationId: id, userId: user })
      }
      const membership: Membership = { organizationId: id, userId: user, role, since: existing?.since ?? now }
      yield* writeMembership(membership)
      return membership
    })).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(failedAs("OrganizationStore.setMember")(cause))))
  })

  const removeMember = Effect.fn("OrganizationStore.removeMember")(function*(id: OrganizationId, user: UserId) {
    yield* client.withTransaction(Effect.gen(function*() {
      if (Option.isNone(yield* getOrganization(id))) {
        return yield* new OrganizationNotFoundError({ organizationId: id })
      }
      const members = yield* membersOf(id)
      const existing = members.find((member) => member.userId === user)
      if (existing === undefined) return
      if (existing.role === "owner" && !anotherOwner(members, user)) {
        return yield* new LastOwnerError({ organizationId: id, userId: user })
      }
      yield* client`DELETE FROM workbench_memberships WHERE organization_id = ${id} AND user_id = ${user}`
    })).pipe(Effect.catchTag("SqlError", (cause) => Effect.fail(failedAs("OrganizationStore.removeMember")(cause))))
  })

  return OrganizationStore.of({
    create,
    get: getOrganization,
    listFor: (user) =>
      client<{ readonly organization: string; readonly role: string }>`SELECT o.body AS organization, m.role AS role FROM workbench_memberships m JOIN workbench_organizations o ON o.id = m.organization_id WHERE m.user_id = ${user} ORDER BY o.name, o.id`
        .pipe(
          Effect.mapError(failedAs("OrganizationStore.listFor")),
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) =>
              Effect.all({
                organization: decodeOrganization(row.organization),
                role: Effect.mapError(Schema.decodeUnknownEffect(Role)(row.role), failedAs("OrganizationStore.listFor"))
              })))
        ),
    members: membersOf,
    role: (id, user) =>
      client<{ readonly role: string }>`SELECT role FROM workbench_memberships WHERE organization_id = ${id} AND user_id = ${user}`.pipe(
        Effect.mapError(failedAs("OrganizationStore.role")),
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(Option.none<Role>())
            : Effect.map(
              Effect.mapError(Schema.decodeUnknownEffect(Role)(rows[0].role), failedAs("OrganizationStore.role")),
              Option.some
            ))
      ),
    setMember,
    removeMember
  })
})

/** As `sql`, creating the tables first if absent. */
export const sqlWithTables: Effect.Effect<Service, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const client = yield* SqlClient.SqlClient
  yield* client`CREATE TABLE IF NOT EXISTS workbench_organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    body TEXT NOT NULL
  )`.pipe(Effect.orDie)
  yield* client`CREATE TABLE IF NOT EXISTS workbench_memberships (
    organization_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (organization_id, user_id)
  )`.pipe(Effect.orDie)
  yield* client`CREATE INDEX IF NOT EXISTS workbench_memberships_by_user ON workbench_memberships (user_id)`.pipe(Effect.orDie)
  return yield* sql
})

export const layerSql: Layer.Layer<OrganizationStore, never, SqlClient.SqlClient> = Layer.effect(
  OrganizationStore,
  sqlWithTables
)
