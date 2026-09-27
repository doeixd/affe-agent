import { Option } from "effect"

/**
 * Session admission as one pure transition (item 128).
 *
 * Three places decide whether a submission may take a session: the local
 * `AgentSession`, and `DurableSessionStore`'s memory and SQL stores. Each runs
 * the decision inside its own atomic section — a `SubscriptionRef.modify`, a
 * `Ref.modify`, a transaction — and each used to restate it. This is the one
 * statement of it, so the rules are tested once and cannot drift apart:
 *
 * - a closed or missing session refuses;
 * - an idle one opens submission `submissionCount + 1`;
 * - a held one is busy, **unless** the caller presents the key the holder was
 *   opened with. That is the same request again after a lost acknowledgement,
 *   and it rejoins the holder rather than being refused (see
 *   `DurableSessionStore.claim`'s contract). No key never matches, not even no
 *   key: two unkeyed requests are two requests.
 *
 * The decision carries no effects and builds nothing store-specific: `Open`
 * hands back the ordinal, and the caller builds its own holder from it inside
 * the same atomic section.
 */
export type Slot<Holder> =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Idle"; readonly submissionCount: number }
  | { readonly _tag: "Held"; readonly holder: Holder; readonly key: Option.Option<string> }

export type Decision<Holder> =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Closed" }
  | { readonly _tag: "Busy"; readonly holder: Holder }
  | { readonly _tag: "Rejoin"; readonly holder: Holder }
  /** The session is the caller's; `ordinal` is the new `submissionCount`. */
  | { readonly _tag: "Open"; readonly ordinal: number }

export const admit = <Holder>(slot: Slot<Holder>, key: Option.Option<string>): Decision<Holder> => {
  switch (slot._tag) {
    case "Missing":
    case "Closed":
      return slot
    case "Idle":
      return { _tag: "Open", ordinal: slot.submissionCount + 1 }
    case "Held":
      return Option.isSome(key) && Option.isSome(slot.key) && key.value === slot.key.value
        ? { _tag: "Rejoin", holder: slot.holder }
        : { _tag: "Busy", holder: slot.holder }
  }
}
