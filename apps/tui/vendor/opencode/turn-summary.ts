/**
 * VENDORED -- REFERENCE COPY, NOT COMPILED.
 *
 * Vendored from opencode: `packages/opencode/src/cli/cmd/run/turn-summary.ts`
 * Upstream: https://github.com/sst/opencode
 * Commit:   2a6be0a03b93a6734070e10a6c3b56863475f214
 * Licence:  MIT -- see ./LICENSE.opencode for the full text and
 *           copyright notice, retained as the licence requires.
 *
 * This file is unmodified upstream source, kept outside `src/` so it is
 * never built. It is the reference we port *from*; the adapted code lives
 * in `src/` and records its divergences there. See ./README.md.
 */

import * as Locale from "@/util/locale"
import type { SessionMessages } from "./session.shared"
import type { RunProvider, StreamCommit } from "./types"

export function turnSummaryCommit(input: {
  agent: string
  model: string
  duration: string
  messageID?: string
}): StreamCommit {
  return {
    kind: "system",
    text: `▣ ${input.agent} · ${input.model} · ${input.duration}`,
    phase: "final",
    source: "system",
    summary: {
      agent: input.agent,
      model: input.model,
      duration: input.duration,
    },
    messageID: input.messageID,
  }
}

export function messageTurnSummaryCommit(
  message: SessionMessages[number],
  providers?: RunProvider[],
): StreamCommit | undefined {
  const info = message.info
  if (info.role !== "assistant") {
    return
  }

  const completed = info.time.completed
  if (typeof completed !== "number" || completed <= info.time.created) {
    return
  }

  const model = providers?.find((item) => item.id === info.providerID)?.models[info.modelID]?.name

  return turnSummaryCommit({
    agent: Locale.titlecase(info.agent),
    model: model ?? info.modelID,
    duration: Locale.duration(completed - info.time.created),
    messageID: info.id,
  })
}
