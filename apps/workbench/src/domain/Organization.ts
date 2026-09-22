/**
 * Organizations and membership (plan-agent-product-control-plane.md §5).
 *
 * An organization is the product's tenant: what an agent can belong to
 * besides one person, and what a role is held in. Membership is one row per
 * person per organization, with the role that decides what they may do
 * there (`Access`). Conversations stay personal: a member runs an
 * organization's agent in a conversation of their own.
 */
import { Schema } from "effect"
import { OrganizationId, UserId } from "./WorkbenchIds.js"

/**
 * `owner` administers and can hand ownership on; `admin` manages agents and
 * members; `member` uses the organization's agents. An organization always
 * has at least one owner.
 */
export const Role = Schema.Literals(["owner", "admin", "member"])
export type Role = typeof Role.Type

export const Organization = Schema.Struct({
  id: OrganizationId,
  name: Schema.String,
  createdAt: Schema.DateTimeUtc
})
export type Organization = typeof Organization.Type

export const Membership = Schema.Struct({
  organizationId: OrganizationId,
  userId: UserId,
  role: Role,
  since: Schema.DateTimeUtc
})
export type Membership = typeof Membership.Type

/** What `listFor` answers: an organization and the caller's role in it. */
export const Joined = Schema.Struct({ organization: Organization, role: Role })
export type Joined = typeof Joined.Type

export const New = Schema.Struct({ name: Schema.String })
export type New = typeof New.Type
