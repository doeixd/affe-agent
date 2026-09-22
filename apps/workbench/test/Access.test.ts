/**
 * The product's access rules, as pure decisions (control plane §5, §45):
 * every combination of who, what and which role, without a server.
 */
import { assert, describe, it } from "@effect/vitest"
import { DateTime, Option } from "effect"
import * as Access from "../src/domain/Access.js"
import type { AgentSpec } from "../src/domain/AgentRevision.js"
import type { Role } from "../src/domain/Organization.js"
import { AgentId, AgentRevisionId, OrganizationId, UserId } from "../src/domain/WorkbenchIds.js"

const ada = UserId.make("ada")
const grace = UserId.make("grace")
const lab = OrganizationId.make("lab")
const other = OrganizationId.make("other")

const agent = (organizationId: Option.Option<OrganizationId>): AgentSpec => ({
  id: AgentId.make("a"),
  ownerId: ada,
  organizationId,
  name: "A",
  description: Option.none(),
  activeRevisionId: AgentRevisionId.make("a@1"),
  createdAt: DateTime.makeUnsafe(0),
  archivedAt: Option.none()
})

const roles = (entries: ReadonlyArray<readonly [OrganizationId, Role]>): Access.Roles => new Map(entries)
const none = roles([])

describe("access", () => {
  it("the owner may use and manage their agent, shared or not", () => {
    for (const spec of [agent(Option.none()), agent(Option.some(lab))]) {
      assert.isTrue(Access.canUse(spec, ada, none))
      assert.isTrue(Access.canManage(spec, ada, none))
    }
  })

  it("an agent not shared is nobody else's, whatever they hold elsewhere", () => {
    const spec = agent(Option.none())
    assert.isFalse(Access.canUse(spec, grace, roles([[lab, "owner"]])))
    assert.isFalse(Access.canManage(spec, grace, roles([[lab, "owner"]])))
  })

  it("a member uses a shared agent; an admin or owner also manages it; another organization's role counts for nothing", () => {
    const spec = agent(Option.some(lab))
    assert.isTrue(Access.canUse(spec, grace, roles([[lab, "member"]])))
    assert.isFalse(Access.canManage(spec, grace, roles([[lab, "member"]])))
    for (const role of ["admin", "owner"] as const) {
      assert.isTrue(Access.canUse(spec, grace, roles([[lab, role]])), role)
      assert.isTrue(Access.canManage(spec, grace, roles([[lab, role]])), role)
    }
    assert.isFalse(Access.canUse(spec, grace, roles([[other, "owner"]])))
    assert.isFalse(Access.canUse(spec, grace, none))
  })

  it("creating in an organization takes admin or owner", () => {
    assert.isFalse(Access.canCreateIn(lab, none))
    assert.isFalse(Access.canCreateIn(lab, roles([[lab, "member"]])))
    assert.isTrue(Access.canCreateIn(lab, roles([[lab, "admin"]])))
    assert.isTrue(Access.canCreateIn(lab, roles([[lab, "owner"]])))
  })

  it("ownership is granted and taken away only by an owner", () => {
    const owner = Option.some<Role>("owner")
    const admin = Option.some<Role>("admin")
    const member = Option.some<Role>("member")
    // An owner does anything.
    for (const current of [Option.none<Role>(), member, admin, owner]) {
      for (const granting of ["member", "admin", "owner"] as const) {
        assert.isTrue(Access.canSetRole(owner, current, granting))
      }
    }
    // An admin adds and changes non-owners, to non-owner roles.
    assert.isTrue(Access.canSetRole(admin, Option.none(), "member"))
    assert.isTrue(Access.canSetRole(admin, member, "admin"))
    assert.isFalse(Access.canSetRole(admin, Option.none(), "owner"))
    assert.isFalse(Access.canSetRole(admin, owner, "member"))
    assert.isFalse(Access.canSetRole(admin, owner, "owner"))
    // A member changes nothing; nor does someone who is not in the organization.
    assert.isFalse(Access.canSetRole(member, Option.none(), "member"))
    assert.isFalse(Access.canSetRole(Option.none(), Option.none(), "member"))
    // Removal follows the same line.
    assert.isTrue(Access.canRemove(owner, "owner"))
    assert.isTrue(Access.canRemove(admin, "admin"))
    assert.isFalse(Access.canRemove(admin, "owner"))
    assert.isFalse(Access.canRemove(member, "member"))
  })
})
