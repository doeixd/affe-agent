/**
 * A named agent and its revisions, as data (plan-agent-product-control-plane.md §6).
 *
 * Edits are revisions: a revision never changes once written, so a run can
 * say exactly which configuration it used, and creating the next one cannot
 * reach into a run already going. Every capability is a reference resolved at
 * run time by `AgentResolver`, never code stored in a row.
 */
import { Effect, Option, Schema } from "effect"
import { AgentId, AgentRevisionId, OrganizationId, UserId } from "./WorkbenchIds.js"

/** Which model profile a revision runs on; the resolver binds the name. */
export const ModelPolicy = Schema.Struct({ profile: Schema.String })
export type ModelPolicy = typeof ModelPolicy.Type

/** A registered set of tools, by id. */
export const CapabilityRef = Schema.Struct({ id: Schema.String })
export type CapabilityRef = typeof CapabilityRef.Type

/** A registered skill, by id. */
export const SkillRef = Schema.Struct({ id: Schema.String })
export type SkillRef = typeof SkillRef.Type

/**
 * A permission policy in its recorded form: the JSON of
 * `Permission.describe(policy)`, which `Permission.fromRecorded` re-creates.
 * A policy with no data form (a function) cannot be stored, by construction.
 */
export const PermissionPolicy = Schema.Struct({ recorded: Schema.String })
export type PermissionPolicy = typeof PermissionPolicy.Type

const revisionFields = {
  instructions: Schema.String,
  modelPolicy: ModelPolicy,
  capabilities: Schema.Array(CapabilityRef),
  skills: Schema.Array(SkillRef),
  permission: PermissionPolicy,
  /** The run's turn ceiling; the one budget W0 stores. */
  maxTurns: Schema.Int
}

/** What an edit supplies. */
export const RevisionInput = Schema.Struct(revisionFields)
export type RevisionInput = typeof RevisionInput.Type

export const AgentRevision = Schema.Struct({
  id: AgentRevisionId,
  agentId: AgentId,
  /** 1 for the first, then one more per edit. */
  revision: Schema.Int,
  ...revisionFields,
  createdBy: UserId,
  createdAt: Schema.DateTimeUtc
})
export type AgentRevision = typeof AgentRevision.Type

export const AgentSpec = Schema.Struct({
  id: AgentId,
  ownerId: UserId,
  /**
   * The organization whose members may use it, if it is not the owner's
   * alone (control plane §5; who may do what is `Access`). Decoded as
   * `None` when the key is absent: agents were written before it existed.
   */
  organizationId: Schema.Option(OrganizationId).pipe(Schema.withDecodingDefaultKey(Effect.succeed(Option.none()))),
  name: Schema.String,
  description: Schema.Option(Schema.String),
  /** What a new session runs. A session already running keeps its own. */
  activeRevisionId: AgentRevisionId,
  createdAt: Schema.DateTimeUtc,
  archivedAt: Schema.Option(Schema.DateTimeUtc)
})
export type AgentSpec = typeof AgentSpec.Type
