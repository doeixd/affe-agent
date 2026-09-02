import { Context, Effect, Layer, Schema } from "effect"
import * as WebFetch from "./WebFetch.js"

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
 * capability with its own lifetime and its own uncertainty after a crash;
 * it is parked in `docs/plan-effect-agent-comparison.md` §3.6 until a host
 * can carry it.
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
    "@doeixd/effect-agent/web/WebCaptureInvalidUrlError",
    { url: Schema.String, reason: Schema.String }
  ) {
  override get message() {
    return `Web capture rejected URL ${this.url}: ${this.reason}`
  }
}

export class WebCaptureDeniedTargetError extends
  Schema.TaggedError<WebCaptureDeniedTargetError>()(
    "@doeixd/effect-agent/web/WebCaptureDeniedTargetError",
    { url: Schema.String, reason: Schema.String }
  ) {
  override get message() {
    return `Web capture denied target ${this.url}: ${this.reason}`
  }
}

/** The provider could not be reached or its response stream failed. */
export class WebCaptureTransportError extends
  Schema.TaggedError<WebCaptureTransportError>()(
    "@doeixd/effect-agent/web/WebCaptureTransportError",
    { url: Schema.String, detail: Schema.String }
  ) {
  override get message() {
    return `Web capture transport failed for ${this.url}: ${this.detail}`
  }
}

/** The provider credential was absent, invalid or unauthorized. */
export class WebCaptureAuthenticationError extends
  Schema.TaggedError<WebCaptureAuthenticationError>()(
    "@doeixd/effect-agent/web/WebCaptureAuthenticationError",
    { status: Schema.Number }
  ) {
  override get message() {
    return `Web capture authentication failed with HTTP ${this.status}`
  }
}

export class WebCaptureRateLimitedError extends
  Schema.TaggedError<WebCaptureRateLimitedError>()(
    "@doeixd/effect-agent/web/WebCaptureRateLimitedError",
    { url: Schema.String }
  ) {
  override get message() {
    return `Web capture of ${this.url} was rate limited`
  }
}

/** The provider answered with a status that has no capture-domain meaning, or reported failure. */
export class WebCaptureResponseError extends
  Schema.TaggedError<WebCaptureResponseError>()(
    "@doeixd/effect-agent/web/WebCaptureResponseError",
    { url: Schema.String, status: Schema.Number, detail: Schema.String }
  ) {
  override get message() {
    return `Web capture of ${this.url} failed with HTTP ${this.status}: ${this.detail}`
  }
}

export class WebCaptureDecodeError extends
  Schema.TaggedError<WebCaptureDecodeError>()(
    "@doeixd/effect-agent/web/WebCaptureDecodeError",
    { url: Schema.String, detail: Schema.String }
  ) {
  override get message() {
    return `Web capture of ${this.url} returned an unreadable response: ${this.detail}`
  }
}

export class WebCaptureResponseTooLargeError extends
  Schema.TaggedError<WebCaptureResponseTooLargeError>()(
    "@doeixd/effect-agent/web/WebCaptureResponseTooLargeError",
    { url: Schema.String, maxBytes: Schema.Number, observedBytes: Schema.Number }
  ) {
  override get message() {
    return `Web capture of ${this.url} exceeded ${this.maxBytes} bytes (observed ${this.observedBytes})`
  }
}

export class WebCaptureTimeoutError extends
  Schema.TaggedError<WebCaptureTimeoutError>()(
    "@doeixd/effect-agent/web/WebCaptureTimeoutError",
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
  "@doeixd/effect-agent/web/WebCapture"
) {}

/** Provide an already-constructed capture service. */
export const layer = (service: Service): Layer.Layer<WebCapture> =>
  Layer.succeed(WebCapture)(service)
