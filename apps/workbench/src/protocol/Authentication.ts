/**
 * Who is asking, on the product protocol (plan-workbench.md, "Auth and tenancy").
 *
 * One bearer credential, resolved once per request into the `CurrentUser`
 * every product handler acts as. A local deployment is the same code path
 * with a constant token, not a second one.
 */
import { Context, Redacted, Schema } from "effect"
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

/** No such person, or not their password: one answer, so a login cannot enumerate accounts. */
export class InvalidCredentialsError extends Schema.TaggedError<InvalidCredentialsError>()(
  "InvalidCredentialsError",
  { userId: UserId },
  { httpApiStatus: 401 }
) {}

export class UserExistsError extends Schema.TaggedError<UserExistsError>()(
  "UserExistsError",
  { userId: UserId },
  { httpApiStatus: 409 }
) {}

/** Redacted on the wire and in every log; at least eight characters, checked before any account is looked up. */
export const Password = Schema.Redacted(Schema.String.check(Schema.isMinLength(8)))
export type Password = Redacted.Redacted

export const Login = Schema.Struct({ userId: UserId, password: Password })
export type Login = typeof Login.Type

/** What a login answers: the token to carry, and when it stops working. */
export const Issued = Schema.Struct({ token: Schema.String, expiresAt: Schema.DateTimeUtc })
export type Issued = typeof Issued.Type

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
