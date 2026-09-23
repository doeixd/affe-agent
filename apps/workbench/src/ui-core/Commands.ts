/**
 * Slash commands (plan-workbench.md W2, `CommandRegistry`): what a person
 * can type in the composer instead of a message.
 *
 * Pure: a line of text becomes an action or a message, and each adapter
 * performs the actions it can. The same line means the same thing in the
 * plain page and in assistant-ui. A line that does not start with \`/\` is a
 * message; \`//\` sends a message that starts with one.
 */

export interface Command {
  readonly name: string
  /** How it is typed, for help and for the suggestion list. */
  readonly usage: string
  readonly description: string
}

export const commands: ReadonlyArray<Command> = [
  { name: "help", usage: "/help", description: "List the commands." },
  { name: "retry", usage: "/retry", description: "Send your last message again." },
  { name: "stop", usage: "/stop", description: "Stop the reply that is running." },
  { name: "model", usage: "/model <name>", description: "Continue this conversation on another model, as a new branch." }
]

export type Action =
  | { readonly _tag: "Send"; readonly text: string }
  | { readonly _tag: "Help" }
  | { readonly _tag: "Retry" }
  | { readonly _tag: "Stop" }
  | { readonly _tag: "ContinueOn"; readonly model: string }
  | { readonly _tag: "Refused"; readonly reason: string }

/** What a line of the composer asks for. Blank is nothing to send. */
export const parse = (line: string): Action | undefined => {
  const text = line.trim()
  if (text === "") return undefined
  if (text.startsWith("//")) return { _tag: "Send", text: text.slice(1) }
  if (!text.startsWith("/")) return { _tag: "Send", text }
  const [head = "", ...rest] = text.slice(1).split(/\s+/)
  const argument = rest.join(" ").trim()
  switch (head.toLowerCase()) {
    case "help":
      return { _tag: "Help" }
    case "retry":
      return { _tag: "Retry" }
    case "stop":
      return { _tag: "Stop" }
    case "model":
      return argument === ""
        ? { _tag: "Refused", reason: "Name a model: /model <name>." }
        : { _tag: "ContinueOn", model: argument }
    default:
      return { _tag: "Refused", reason: `There is no /${head} command. Type /help for the list, or // to send a message starting with /.` }
  }
}

/** The commands a partly typed line could become, for a suggestion list. Empty once it is a message. */
export const matching = (line: string): ReadonlyArray<Command> => {
  if (!line.startsWith("/") || line.startsWith("//") || /\s/.test(line)) return []
  const typed = line.slice(1).toLowerCase()
  return commands.filter((command) => command.name.startsWith(typed))
}
