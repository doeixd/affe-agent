/**
 * Who is asking, on the product protocol (plan-workbench.md, "Auth and tenancy").
 *
 * One bearer credential, resolved once per request into the `CurrentUser`
 * every product handler acts as. A local deployment is the same code path
 * with a constant token, not a second one.
 */
import { Context, Schema } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { HttpApiMiddleware, HttpApiSecurity } from "effect/unstable/httpapi"
import { OrganizationId, UserId } from "../domain/WorkbenchIds.js"

export class CurrentUser extends Context.Service<CurrentUser, UserId>()("workbench/CurrentUser") {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  "Unauthorized",
  { detail: Schema.String },
  { httpApiStatus: 401 }
) {}

/** A request that names an owner other than the person making it. */
export class ForeignOwnerError extends Schema.TaggedError<ForeignOwnerError>()(
  "ForeignOwnerError",
  { ownerId: UserId },
  { httpApiStatus: 403 }
) {}

/** A membership change the caller's role in the organization does not allow. */
export class InsufficientRoleError extends Schema.TaggedError<InsufficientRoleError>()(
  "InsufficientRoleError",
  { organizationId: OrganizationId, detail: Schema.String },
  { httpApiStatus: 403 }
) {}

export class Authenticated extends HttpApiMiddleware.Service<Authenticated, {
  provides: CurrentUser
  requires: never
}>()("workbench/Authenticated", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}

/** The client half: every request carries this token. */
export const bearer = (token: string) =>
  HttpApiMiddleware.layerClient(Authenticated, ({ next, request }) =>
    next(HttpClientRequest.bearerToken(request, token)))
