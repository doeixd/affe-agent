/**
 * The prompt wire's encoding of a plain-text prompt, built directly.
 *
 * Every submission to an agent with the default input puts its encoded
 * prompt on the fibre (`AgentInput.Current`). Through the schema that is a
 * full `PromptWire` encode -- about 20µs a prompt, which the benchmark
 * measured as roughly a tenth of a forty-prompt conversation's time (item
 * 100). A string is almost every prompt, and its encoding is one fixed
 * shape, so it is written here instead.
 *
 * `test/PromptText.test.ts` holds this equal to the schema's own encoding
 * for awkward strings; if `PromptWire` or Effect's `Prompt` changes the
 * shape, that test fails rather than the fibre quietly holding a different
 * value than a decode would accept.
 */
export const encodedText = (text: string): unknown => ({
  content: [{ options: {}, role: "user", content: text }]
})
