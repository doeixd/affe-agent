import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
import * as Elicitation from "../Elicitation.js"
import { CurrentPrincipal } from "../Principal.js"
import { Headers } from "effect/unstable/http"

/**
 * Credentials for tool sources: the method, the binding and the provider,
 * kept apart because their lifetimes differ. See
 * `docs/plan-tool-credentials.md` for the contract; this is its single-user
 * slice, on a seam built for more than one.
 *
 * A method says *how* a credential is applied (header or query, name,
 * prefix, which variable). A binding says *which* method and, per variable,
 * an opaque handle. A provider resolves a handle to a `Redacted` value, per
 * call. The value exists in the clear only inside `render`, on its way into
 * a header -- never in a tool's parameters, a prompt or an event.
 */

// ---------------------------------------------------------------------------
// Method: declarative, derived, holds no secret

export const Placement = Schema.Struct({
  carrier: Schema.Literals(["header", "query"]),
  /** `Authorization`, `X-Api-Key`, `token`. */
  name: Schema.String,
  /** Rendered before the value: `"Bearer "`. */
  prefix: Schema.optional(Schema.String),
  /** Which credential input this reads; absent means `token`. */
  variable: Schema.optional(Schema.String),
  /** Render this verbatim and reference no credential. */
  literal: Schema.optional(Schema.String)
})
export type Placement = typeof Placement.Type

export const Method = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("apikey"), placements: Schema.Array(Placement) }),
  Schema.Struct({ kind: Schema.Literal("none") })
])
export type Method = typeof Method.Type

/** `Authorization: Bearer <token>`. */
export const bearer = (variable = "token"): Method => ({
  kind: "apikey",
  placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer ", variable }]
})

/** A credential in a named header, optionally prefixed. */
export const header = (name: string, options?: { readonly prefix?: string; readonly variable?: string }): Method => ({
  kind: "apikey",
  placements: [{
    carrier: "header",
    name,
    ...(options?.prefix === undefined ? {} : { prefix: options.prefix }),
    ...(options?.variable === undefined ? {} : { variable: options.variable })
  }]
})

/** A credential as a query parameter. */
export const query = (name: string, options?: { readonly variable?: string }): Method => ({
  kind: "apikey",
  placements: [{ carrier: "query", name, ...(options?.variable === undefined ? {} : { variable: options.variable }) }]
})

export const none: Method = { kind: "none" }

const variableOf = (placement: Placement): string | undefined =>
  placement.literal !== undefined ? undefined : placement.variable ?? "token"

/**
 * The inputs a binding must supply for this method: one per distinct
 * variable, literals excluded. Two placements naming one variable share it.
 */
export const requiredVariables = (method: Method): ReadonlyArray<string> => {
  if (method.kind === "none") return []
  const seen = new Set<string>()
  for (const placement of method.placements) {
    const variable = variableOf(placement)
    if (variable !== undefined) seen.add(variable)
  }
  return [...seen]
}

export interface Rendered {
  readonly headers: Readonly<Record<string, string>>
  readonly query: Readonly<Record<string, string>>
}

/**
 * Apply a method to resolved values: a total function. A placement whose
 * variable resolved to nothing is skipped -- `requiredVariables` is how a
 * caller decides whether that is an error. This is the only place a value
 * is read out of its `Redacted`.
 */
export const render = (method: Method, values: Readonly<Record<string, Redacted.Redacted<string>>>): Rendered => {
  const headers: Record<string, string> = {}
  const queryParams: Record<string, string> = {}
  if (method.kind === "none") return { headers, query: queryParams }
  for (const placement of method.placements) {
    let rendered: string | undefined
    if (placement.literal !== undefined) {
      rendered = placement.literal
    } else {
      const value = values[placement.variable ?? "token"]
      if (value === undefined) continue
      rendered = `${placement.prefix ?? ""}${Redacted.value(value)}`
    }
    if (placement.carrier === "header") headers[placement.name] = rendered
    else queryParams[placement.name] = rendered
  }
  return { headers, query: queryParams }
}

// ---------------------------------------------------------------------------
// Binding: which method, and a handle per variable -- no secret

export interface Binding {
  /** The integration this binding is for: `github`, `datadog`. Model-facing text. */
  readonly integration: string
  /** A role, never an identity: identity lives in the binding's partition. */
  readonly owner: "org" | "user"
  readonly method: Method
  /** Per variable, a handle the provider interprets. Never a value. */
  readonly values: Readonly<Record<string, string>>
}

export const binding = (options: {
  readonly integration: string
  readonly method: Method
  readonly values?: Readonly<Record<string, string>> | undefined
  readonly owner?: "org" | "user" | undefined
}): Binding => ({
  integration: options.integration,
  owner: options.owner ?? "org",
  method: options.method,
  values: options.values ?? {}
})

// ---------------------------------------------------------------------------
// Provider: resolves a handle to a value, per call

export class CredentialError extends Schema.TaggedError<CredentialError>()(
  "CredentialError",
  {
    handle: Schema.String,
    reason: Schema.Literals(["missing", "unreadable", "readOnly", "expired"]),
    detail: Schema.String,
    /** The model can say "reconnect GitHub" instead of "internal error". */
    reauthRequired: Schema.Boolean,
    /**
     * Where a human reconnects, when the provider knows.
     *
     * Only meaningful with `reauthRequired`, and optional even then: a
     * config-backed credential has no URL to offer, and inventing one
     * would be worse than saying nothing.
     */
    authorizationUrl: Schema.optional(Schema.String)
  }
) {
  override get message() {
    return `Credential ${this.handle} ${this.reason}: ${this.detail}`
  }
}

export interface ProviderService {
  /** `default`, `1password`, `config`. */
  readonly key: string
  readonly writable: boolean
  /** `None` when the handle resolves to nothing; a failure when it cannot be read. */
  readonly get: (handle: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, CredentialError>
  readonly set?: ((handle: string, value: Redacted.Redacted<string>) => Effect.Effect<void, CredentialError>) | undefined
  readonly delete?: ((handle: string) => Effect.Effect<void, CredentialError>) | undefined
}

export class Provider extends Context.Service<Provider, ProviderService>()(
  "affe-agent/tool-source/Credentials/Provider"
) {}

/** In memory, from pasted values. Writable. */
export const fromValues = (
  initial: Readonly<Record<string, string>> = {}
): Layer.Layer<Provider> =>
  Layer.sync(Provider, () => {
    const values = new Map<string, Redacted.Redacted<string>>(
      Object.entries(initial).map(([handle, value]) => [handle, Redacted.make(value)])
    )
    return {
      key: "default",
      writable: true,
      get: (handle) => Effect.sync(() => Option.fromNullishOr(values.get(handle))),
      set: (handle, value) => Effect.sync(() => void values.set(handle, value)),
      delete: (handle) => Effect.sync(() => void values.delete(handle))
    }
  })

/**
 * Handles are `Config` keys (`GITHUB_TOKEN`), read from wherever the
 * application's `ConfigProvider` reads: the environment, a file, a vault
 * adapter. Read-only by construction: nobody writes to an environment.
 */
export const fromConfig: Layer.Layer<Provider> = Layer.succeed(Provider, {
  key: "config",
  writable: false,
  get: (handle) =>
    // `option` turns an absent key into `None`; anything else -- a source
    // that cannot be read, a value that fails its schema -- stays a failure.
    Config.option(Config.redacted(handle)).pipe(
      Effect.mapError((error) =>
        new CredentialError({ handle, reason: "unreadable", detail: error.message, reauthRequired: false }))
    )
})

/** The same provider with its writes refused: a vault mounted read-only. */
export const readOnly = (provider: ProviderService): ProviderService => ({
  key: provider.key,
  writable: false,
  get: provider.get,
  set: (handle) => Effect.fail(new CredentialError({ handle, reason: "readOnly", detail: `provider ${provider.key} is read-only`, reauthRequired: false })),
  delete: (handle) => Effect.fail(new CredentialError({ handle, reason: "readOnly", detail: `provider ${provider.key} is read-only`, reauthRequired: false }))
})

// ---------------------------------------------------------------------------
// Resolution: per call, at invoke time

/**
 * Resolve every variable the binding's method requires and render. A
 * required variable with no handle in the binding, or a handle the provider
 * resolves to nothing, is `CredentialError` `missing` -- the binding is
 * misconfigured or the credential is gone, and either is actionable. Never
 * baked into a tool definition: call it from the source's per-invocation
 * `headers` hook.
 */
export const resolve = (binding: Binding): Effect.Effect<Rendered, CredentialError, Provider> =>
  Effect.gen(function* () {
    const provider = yield* Provider
    const values: Record<string, Redacted.Redacted<string>> = {}
    for (const variable of requiredVariables(binding.method)) {
      const handle = binding.values[variable]
      if (handle === undefined) {
        return yield* new CredentialError({
          handle: `${binding.integration}:${variable}`,
          reason: "missing",
          detail: `binding for ${binding.integration} names no handle for variable ${JSON.stringify(variable)}`,
          reauthRequired: false
        })
      }
      const value = yield* provider.get(handle)
      if (Option.isNone(value)) {
        return yield* new CredentialError({
          handle,
          reason: "missing",
          detail: `provider ${provider.key} holds nothing for ${JSON.stringify(handle)}`,
          reauthRequired: true
        })
      }
      values[variable] = value.value
    }
    return render(binding.method, values)
  })

/** The headers half of `resolve`, in the shape the sources' `headers` hook takes. */
export const headers = (binding: Binding): Effect.Effect<Headers.Headers, CredentialError, Provider> =>
  Effect.map(resolve(binding), (rendered) => Headers.fromInput(rendered.headers))

// ---------------------------------------------------------------------------
// Per-principal bindings: the multi-user half, unblocked by CurrentPrincipal

/**
 * Which bindings exist, per integration and per subject.
 *
 * The store the contract promised once the principal could reach the tool
 * fibre (plan-tool-credentials.md, section 6). Selection is by
 * `(integration, subject)`: a user-owned binding matches only its subject,
 * an org-owned binding matches everyone, and the user binding wins when
 * both exist -- identity lives in the partition, never in a model-facing
 * name.
 */
export interface BindingEntry {
  readonly binding: Binding
  /**
   * The subject a user-owned binding belongs to. Required exactly when
   * `binding.owner` is `"user"`; meaningless -- and refused at
   * construction -- on an org binding, which belongs to everyone.
   */
  readonly subject?: string | undefined
}

export interface BindingsService {
  readonly find: (
    integration: string,
    subject: Option.Option<string>
  ) => Effect.Effect<Option.Option<Binding>, CredentialError>
}

export class Bindings extends Context.Service<Bindings, BindingsService>()(
  "affe-agent/tool-source/Credentials/Bindings"
) {}

/**
 * An in-memory bindings store from entries.
 *
 * The user binding for the asking subject wins over the org binding; a
 * subject with no user binding falls back to org, which is what "the org
 * connected GitHub, Alice connected her own" should mean.
 */
export const bindings = (
  entries: ReadonlyArray<BindingEntry>
): Layer.Layer<Bindings> =>
  Layer.sync(Bindings, () => {
    const org = new Map<string, Binding>()
    const user = new Map<string, Binding>()
    for (const entry of entries) {
      if (entry.binding.owner === "user") {
        if (entry.subject === undefined) {
          throw new RangeError(
            `Credentials.bindings: a user-owned binding for ${entry.binding.integration} names no subject`
          )
        }
        user.set(`${entry.binding.integration} ${entry.subject}`, entry.binding)
      } else {
        if (entry.subject !== undefined) {
          throw new RangeError(
            `Credentials.bindings: an org-owned binding for ${entry.binding.integration} must not name a subject`
          )
        }
        org.set(entry.binding.integration, entry.binding)
      }
    }
    return {
      find: (integration, subject) =>
        Effect.sync(() => {
          if (Option.isSome(subject)) {
            const own = user.get(`${integration} ${subject.value}`)
            if (own !== undefined) return Option.some(own)
          }
          return Option.fromNullishOr(org.get(integration))
        })
    }
  })

/**
 * Resolve the binding for the *caller* -- `CurrentPrincipal` on this fibre
 * -- then the credentials. The per-principal `resolve`: same rendering,
 * same provider, the binding chosen per subject per call. No binding at
 * all is a configuration gap (`reauthRequired: false`); a subject present
 * and served by nothing is what "connect your GitHub" looks like, so that
 * refusal says `reauthRequired: true`.
 */
export const resolveFor = (
  integration: string
): Effect.Effect<Rendered, CredentialError, Bindings | Provider> =>
  Effect.gen(function* () {
    const store = yield* Bindings
    const subject = yield* CurrentPrincipal
    const found = yield* store.find(integration, subject)
    if (Option.isNone(found)) {
      return yield* new CredentialError({
        handle: integration,
        reason: "missing",
        detail: Option.isSome(subject)
          ? `no binding for ${integration} for subject ${JSON.stringify(subject.value)} and no org fallback`
          : `no binding for ${integration}`,
        reauthRequired: Option.isSome(subject)
      })
    }
    return yield* resolve(found.value)
  })

/** The headers half of `resolveFor`, for the sources' `headers` hook. */
export const headersFor = (
  integration: string
): Effect.Effect<Headers.Headers, CredentialError, Bindings | Provider> =>
  Effect.map(resolveFor(integration), (rendered) => Headers.fromInput(rendered.headers))

// ---------------------------------------------------------------------------
// Methods derived from OpenAPI securitySchemes (invariant 5: one derivation
// for every entry path)

export interface DerivedMethod {
  readonly method: Method
  /** Schemes the derivation cannot express, with the reason, never silently. */
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Derive the method from a parsed OpenAPI document's security machinery.
 *
 * The first requirement object in root `security` is used, and every scheme
 * it names is required *together* (the spec's AND semantics -- Datadog's
 * two keys), each becoming a placement whose variable is the scheme name.
 * With no root `security`, every declared scheme is offered as one method
 * for the caller to trim.
 *
 * Expressible: `apiKey` in header or query; `http bearer`. Refused with a
 * reason: `http basic` (needs an encoding, not a placement), `oauth2` and
 * `openIdConnect` (a flow, not a placement -- the contract's escape
 * hatch), `apiKey` in cookie. A spec with no schemes derives `none`.
 */
export const methodFromOpenApi = (spec: unknown): DerivedMethod => {
  const skipped: Array<{ name: string; reason: string }> = []
  const root = isRecord(spec) ? spec : undefined
  const components = root !== undefined && isRecord(root["components"]) ? root["components"] : undefined
  const schemes = components !== undefined && isRecord(components["securitySchemes"])
    ? components["securitySchemes"]
    : undefined
  if (schemes === undefined) return { method: none, skipped }

  const security = root !== undefined && Array.isArray(root["security"]) ? root["security"] : undefined
  const firstRequirement = security?.find(isRecord)
  const wanted = firstRequirement !== undefined
    ? Object.keys(firstRequirement)
    : Object.keys(schemes)

  const placements: Array<Placement> = []
  for (const name of wanted) {
    const scheme = isRecord(schemes[name]) ? schemes[name] : undefined
    if (scheme === undefined) {
      skipped.push({ name, reason: "security names a scheme the components do not declare" })
      continue
    }
    const type = scheme["type"]
    if (type === "apiKey") {
      const where = scheme["in"]
      const carrierName = typeof scheme["name"] === "string" ? scheme["name"] : undefined
      if (carrierName === undefined) {
        skipped.push({ name, reason: "apiKey scheme declares no name" })
      } else if (where === "header") {
        placements.push({ carrier: "header", name: carrierName, variable: name })
      } else if (where === "query") {
        placements.push({ carrier: "query", name: carrierName, variable: name })
      } else {
        skipped.push({ name, reason: `apiKey in ${JSON.stringify(where)} is not expressible as a placement` })
      }
    } else if (type === "http") {
      const httpScheme = typeof scheme["scheme"] === "string" ? scheme["scheme"].toLowerCase() : undefined
      if (httpScheme === "bearer") {
        placements.push({ carrier: "header", name: "Authorization", prefix: "Bearer ", variable: name })
      } else {
        skipped.push({ name, reason: `http ${JSON.stringify(httpScheme)} needs an encoding or a flow, not a placement` })
      }
    } else if (type === "oauth2" || type === "openIdConnect") {
      skipped.push({ name, reason: `${String(type)} is a flow, not a placement -- handle it as a per-source escape hatch` })
    } else {
      skipped.push({ name, reason: `unknown security scheme type ${JSON.stringify(type)}` })
    }
  }
  return {
    method: placements.length === 0 ? none : { kind: "apikey", placements },
    skipped
  }
}

// ---------------------------------------------------------------------------
// Stateful tokens: the per-source escape hatch, and asking a human to reconnect

/**
 * A provider whose tokens expire and can be refreshed -- OAuth, or
 * anything else stateful.
 *
 * This is the escape hatch `research-tool-sources.md` §7.4 argues for, and
 * the shape of it is the argument: **static credentials are declarative,
 * OAuth is stateful and protocol-specific, and pretending otherwise
 * produces an abstraction that fits neither.** So OAuth never enters the
 * *method* vocabulary -- there is no `oauth` placement, and there will not
 * be one. It resolves the conventional token input like any other
 * credential, and everything specific to it (discovery, registration,
 * scopes, callbacks, refresh, garbage collection) lives behind this one
 * function, where it belongs to the application.
 *
 * `token` returning `None` means *reconnection is required*, not "no
 * value": that is the state a dead refresh token is in, and it becomes a
 * `CredentialError` carrying `reauthRequired` and, when the caller knows
 * one, the URL a human goes to. `withReauth` is what turns that into a
 * question.
 */
export const fromRefreshing = (options: {
  /** Names the provider in errors: `oauth`, `1password`. */
  readonly key: string
  /** The current token, refreshed if the caller needs to. */
  readonly token: (handle: string) => Effect.Effect<Option.Option<Redacted.Redacted<string>>, CredentialError>
  /** Where a human reconnects this handle, when that is known. */
  readonly authorizationUrl?: ((handle: string) => string | undefined) | undefined
}): Layer.Layer<Provider> =>
  Layer.succeed(Provider, {
    key: options.key,
    // Refreshing is not writing: the application owns the connection, and
    // nothing here should be able to overwrite it.
    writable: false,
    get: (handle) =>
      Effect.flatMap(options.token(handle), (found) =>
        Option.isSome(found)
          ? Effect.succeed(found)
          : Effect.fail(
            new CredentialError({
              handle,
              reason: "expired",
              detail: `${options.key} needs ${JSON.stringify(handle)} reconnected`,
              reauthRequired: true,
              ...(() => {
                const url = options.authorizationUrl?.(handle)
                return url === undefined ? {} : { authorizationUrl: url }
              })()
            })
          ))
  })

/** What a reauthorization question carries. */
export const ReauthDetail = Schema.Struct({
  handle: Schema.String,
  reason: Schema.String,
  /** Where the human goes, when the provider knew. */
  authorizationUrl: Schema.optional(Schema.String)
})
export type ReauthDetail = typeof ReauthDetail.Type

const encodeReauth = Schema.encodeSync(Schema.toCodecJson(ReauthDetail))

/**
 * Ask a human to reconnect, then try once more.
 *
 * The §5 promise, and the shape is the same one code mode's in-program
 * approvals use, for the same reason: the elicitor is the *host's* to
 * supply, so an application passes the very one its session was built
 * with and the question lands in `session.pending` beside every other.
 *
 * Only `reauthRequired` failures ask -- a missing handle is a
 * misconfiguration a human cannot fix by clicking a link, and asking
 * about it would train people to click through questions that never
 * help. Exactly one retry: a loop would re-ask forever against a
 * connection that is not coming back, and the second failure is the
 * honest answer.
 *
 * Under `/durable` the elicitor is a `DurableDeferred`, so the wait
 * survives the process -- which is the thing this design is *for*, and
 * the one thing a live-context sandbox cannot do.
 */
export const withReauth = <A, E, R>(
  resolve: Effect.Effect<A, E | CredentialError, R>,
  options: {
    readonly elicitor: Elicitation.Elicitor
    /** Namespaces the question's id. Defaults to the handle. */
    readonly id?: ((error: CredentialError) => string) | undefined
    /** Run when the question is asked, before the wait. */
    readonly onAsk?: ((detail: ReauthDetail) => Effect.Effect<void>) | undefined
  }
): Effect.Effect<A, E | CredentialError, R> =>
  Effect.catchIf(
    resolve,
    (error): error is CredentialError =>
      error instanceof CredentialError && error.reauthRequired,
    (error) =>
      Effect.gen(function* () {
        const detail: ReauthDetail = {
          handle: error.handle,
          reason: error.detail,
          ...(error.authorizationUrl === undefined
            ? {}
            : { authorizationUrl: error.authorizationUrl })
        }
        const answer = yield* options.elicitor.elicit(
          {
            id: options.id?.(error) ?? `reauth:${error.handle}`,
            kind: "credential-reauth",
            detail: encodeReauth(detail)
          },
          options.onAsk === undefined ? Effect.void : options.onAsk(detail)
        )
        // Refused, or reconnected and still broken: the original failure
        // is what the caller gets, unchanged.
        return yield* answer.granted ? resolve : Effect.fail(error)
      })
  )
