import { Context, Effect, Layer, Option, Schema } from "effect"
import * as WebFetch from "./WebFetch.js"
import * as Namespace from "../internal/namespace.js"

/**
 * A rendered page: what a browser would show, as text a model can read.
 *
 * `WebFetch` returns bytes as the server sent them, which for a page that
 * builds itself in JavaScript is a shell and a script tag. Capture renders
 * the page and returns its content as Markdown and the links it carries --
 * the shape a research agent actually wants. Provider-neutral: rendering
 * happens wherever the provider does it (`/web/cloudflare` is Browser
 * Rendering's REST API, which is HTTP and therefore portable), and the
 * output is untrusted external text either way.
 *
 * Deliberately not a browser session. Navigate-click-fill is a different
 * capability with its own lifetime and its own uncertainty after a crash,
 * and is not implemented here.
 */

/** One rendered page. `markdown` and `links` are untrusted external input. */
export const CaptureResult = Schema.Struct({
  /** The URL as the provider reports having rendered it. */
  url: Schema.String,
  markdown: Schema.String,
  /** Absolute URLs found on the page, in document order, deduplicated. */
  links: Schema.Array(Schema.String)
})
export type CaptureResult = typeof CaptureResult.Type

/** What a failure may say about a target: the origin, as `WebFetch` does. */
export const diagnosticTarget = WebFetch.diagnosticTarget

export class WebCaptureInvalidUrlError extends
  Schema.TaggedError<WebCaptureInvalidUrlError>()(
    Namespace.tag("web/WebCaptureInvalidUrlError"),
    { url: Schema.String, reason: Schema.String }
  ) {
  override get message() {
    return `Web capture rejected URL ${this.url}: ${this.reason}`
  }
}

export class WebCaptureDeniedTargetError extends
  Schema.TaggedError<WebCaptureDeniedTargetError>()(
    Namespace.tag("web/WebCaptureDeniedTargetError"),
    { url: Schema.String, reason: Schema.String }
  ) {
  override get message() {
    return `Web capture denied target ${this.url}: ${this.reason}`
  }
}

/** The provider could not be reached or its response stream failed. */
export class WebCaptureTransportError extends
  Schema.TaggedError<WebCaptureTransportError>()(
    Namespace.tag("web/WebCaptureTransportError"),
    { url: Schema.String, detail: Schema.String }
  ) {
  override get message() {
    return `Web capture transport failed for ${this.url}: ${this.detail}`
  }
}

/** The provider credential was absent, invalid or unauthorized. */
export class WebCaptureAuthenticationError extends
  Schema.TaggedError<WebCaptureAuthenticationError>()(
    Namespace.tag("web/WebCaptureAuthenticationError"),
    { status: Schema.Number }
  ) {
  override get message() {
    return `Web capture authentication failed with HTTP ${this.status}`
  }
}

export class WebCaptureRateLimitedError extends
  Schema.TaggedError<WebCaptureRateLimitedError>()(
    Namespace.tag("web/WebCaptureRateLimitedError"),
    {
      url: Schema.String,
      /** How long the provider asked to wait (`retry-after`), when it said. */
      retryAfterMillis: Schema.Option(Schema.Number),
      /** The provider's request id (`cf-ray`), for its support; never shown to a model. */
      rayId: Schema.Option(Schema.String)
    }
  ) {
  override get message() {
    const wait = Option.match(this.retryAfterMillis, {
      onNone: () => "",
      onSome: (millis) => `; retry after ${millis}ms`
    })
    return `Web capture of ${this.url} was rate limited${wait}${rayNote(this.rayId)}`
  }
}

/**
 * The provider answered with a status that has no capture-domain meaning, or
 * reported failure.
 *
 * `status` is the provider API's status, not the destination page's. `detail`
 * is this library's wording, never the provider's error text: that text can
 * quote the model-selected page, so it is recognised against an exact grammar
 * or dropped, and only the provider's numeric error codes are kept.
 */
export class WebCaptureResponseError extends
  Schema.TaggedError<WebCaptureResponseError>()(
    Namespace.tag("web/WebCaptureResponseError"),
    {
      url: Schema.String,
      status: Schema.Number,
      detail: Schema.String,
      /** The renderer's own navigation limit, when the provider reported hitting it. */
      navigationTimeoutMillis: Schema.Option(Schema.Number),
      /** The provider's request id (`cf-ray`), for its support; never shown to a model. */
      rayId: Schema.Option(Schema.String)
    }
  ) {
  override get message() {
    return `Web capture of ${this.url} failed with HTTP ${this.status}: ${this.detail}${rayNote(this.rayId)}`
  }
}

const rayNote = (rayId: Option.Option<string>): string =>
  Option.match(rayId, { onNone: () => "", onSome: (id) => ` (cf-ray ${id})` })

export class WebCaptureDecodeError extends
  Schema.TaggedError<WebCaptureDecodeError>()(
    Namespace.tag("web/WebCaptureDecodeError"),
    { url: Schema.String, detail: Schema.String }
  ) {
  override get message() {
    return `Web capture of ${this.url} returned an unreadable response: ${this.detail}`
  }
}

export class WebCaptureResponseTooLargeError extends
  Schema.TaggedError<WebCaptureResponseTooLargeError>()(
    Namespace.tag("web/WebCaptureResponseTooLargeError"),
    { url: Schema.String, maxBytes: Schema.Number, observedBytes: Schema.Number }
  ) {
  override get message() {
    return `Web capture of ${this.url} exceeded ${this.maxBytes} bytes (observed ${this.observedBytes})`
  }
}

export class WebCaptureTimeoutError extends
  Schema.TaggedError<WebCaptureTimeoutError>()(
    Namespace.tag("web/WebCaptureTimeoutError"),
    { url: Schema.String, timeoutMillis: Schema.Number }
  ) {
  override get message() {
    return `Web capture of ${this.url} exceeded ${this.timeoutMillis}ms`
  }
}

export type WebCaptureError =
  | WebCaptureInvalidUrlError
  | WebCaptureDeniedTargetError
  | WebCaptureTransportError
  | WebCaptureAuthenticationError
  | WebCaptureRateLimitedError
  | WebCaptureResponseError
  | WebCaptureDecodeError
  | WebCaptureResponseTooLargeError
  | WebCaptureTimeoutError

/** Provider-neutral rendered-page capture. */
export interface Service {
  readonly capture: (url: URL) => Effect.Effect<CaptureResult, WebCaptureError>
}

export class WebCapture extends Context.Service<WebCapture, Service>()(
  Namespace.tag("web/WebCapture")
) {}

/** Provide an already-constructed capture service. */
export const layer = (service: Service): Layer.Layer<WebCapture> =>
  Layer.succeed(WebCapture)(service)
