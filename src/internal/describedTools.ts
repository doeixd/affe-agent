import { Option } from "effect"
import type { Tool } from "effect/unstable/ai"
import type * as AgentOutput from "../AgentOutput.js"

/**
 * Every tool a response from this agent can mention.
 *
 * Not the same set as the agent's toolkit, and the difference is what made a
 * durable agent with a declared output *fatally* broken: an agent that declares
 * an `AgentOutput` has its output tool injected per turn by `AgentTurn`, and it
 * deliberately never enters the agent's tool record. Anything that builds a
 * schema, a listing or a projection from `toolkit.tools` alone is therefore
 * describing a set the model can step outside of -- which the journal did, and
 * died with a `SchemaError` naming a union that omits exactly the call the
 * model had just made.
 *
 * Internal, and it exists to have a *name* rather than because the set is hard
 * to compute. The audit that followed that bug found only two places that
 * enumerate an agent's tools -- `AgentTurn`, which is where the injection
 * happens and is correct by construction, and `DurableModel` -- so this is not
 * a fix applied in many places. It is the concept written down once, so the
 * third caller does not have to rediscover it the way the second did.
 */
export const describedTools = (
  tools: Readonly<Record<string, Tool.Any>>,
  agent: { readonly output: Option.Option<AgentOutput.AgentOutput<any, any>> }
): ReadonlyArray<Tool.Any> =>
  Option.match(agent.output, {
    onNone: () => Object.values(tools),
    onSome: (output) => [...Object.values(tools), output.tool]
  })
