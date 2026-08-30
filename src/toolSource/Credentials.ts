import { Config, Context, Effect, Layer, Option, Redacted, Schema } from "effect"
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
    reauthRequired: Schema.Boolean
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
  "@doeixd/effect-agent/tool-source/Credentials/Provider"
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
