/**
 * Who may do what with an agent (plan-agent-product-control-plane.md §5, §45).
 *
 * Pure rules over an agent, a person and the roles they hold, so the same
 * decision is made wherever it is asked -- the product handlers today, a
 * store filter or the host's policy tomorrow -- and can be tested without a
 * server. This is the product-resource boundary only; session operations
 * stay with `AgentSessionHost`'s authorization, tool calls with `Permission`.
 *
 * The rules:
 *
 * - the owner may do everything with their own agent, in or out of an
 *   organization;
 * - a member of the agent's organization may *use* it: see it, its
 *   revisions, and start conversations on it;
 * - an admin or owner of that organization may also *manage* it: revise and
 *   archive it, and create agents in the organization;
 * - nobody else learns it exists.
 */
import { Option } from "effect"
import type { AgentSpec } from "./AgentRevision.js"
import type { Role } from "./Organization.js"
import type { OrganizationId, UserId } from "./WorkbenchIds.js"

/** The roles one person holds, by organization. */
export type Roles = ReadonlyMap<OrganizationId, Role>

export const manages = (role: Role): boolean => role === "owner" || role === "admin"

const roleIn = (roles: Roles, organization: Option.Option<OrganizationId>): Option.Option<Role> =>
  Option.flatMap(organization, (id) => Option.fromNullishOr(roles.get(id)))

/** See the agent and run it. */
export const canUse = (agent: AgentSpec, user: UserId, roles: Roles): boolean =>
  agent.ownerId === user || Option.isSome(roleIn(roles, agent.organizationId))

/** Revise or archive the agent. */
export const canManage = (agent: AgentSpec, user: UserId, roles: Roles): boolean =>
  agent.ownerId === user || Option.exists(roleIn(roles, agent.organizationId), manages)

/** Create an agent shared with this organization. */
export const canCreateIn = (organization: OrganizationId, roles: Roles): boolean =>
  Option.exists(Option.fromNullishOr(roles.get(organization)), manages)

/**
 * Change a membership: an owner may set anyone to any role; an admin may
 * add or change a non-owner to a non-owner role. Ownership is granted and
 * taken away only by an owner.
 */
export const canSetRole = (actor: Option.Option<Role>, current: Option.Option<Role>, granting: Role): boolean =>
  Option.exists(actor, (role) =>
    role === "owner" ||
    (role === "admin" && granting !== "owner" && !Option.exists(current, (held) => held === "owner")))

/** Remove a member: an owner may remove anyone, an admin anyone but an owner. */
export const canRemove = (actor: Option.Option<Role>, target: Role): boolean =>
  Option.exists(actor, (role) => role === "owner" || (role === "admin" && target !== "owner"))
