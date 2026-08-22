/**
 * A module-resolution hook that refuses Node built-ins.
 *
 * Registered with `node --import` around a probe that imports one package
 * entry: if importing that entry resolves any `node:*` module -- directly or
 * through a dependency -- the probe fails. That is the package-level version
 * of the source guardrail: not "the source does not mention Node" but "the
 * artifact a consumer installs does not need Node to be imported".
 *
 * The probe script itself is allowed to run; only what the entry pulls in is
 * judged, which is why the hook activates on the first resolution that comes
 * from inside `node_modules`. Resolution drops the "node" export condition
 * so that packages offering a portable build under "browser"/"default" are
 * judged by that build, as a Bun, Deno or edge runtime would select it.
 */
import { register } from "node:module"

register(
  "data:text/javascript," +
    encodeURIComponent(`
      import { isBuiltin } from "node:module"
      export async function resolve(specifier, context, next) {
        const parent = context.parentURL ?? ""
        const fromPackage = parent.includes("/node_modules/")
        if (fromPackage && isBuiltin(specifier)) {
          throw new Error(
            "portable entry resolved Node built-in " + JSON.stringify(specifier) +
              " from " + parent
          )
        }
        // Resolve the way a non-Node runtime would: without the "node"
        // export condition, which Node always asserts and which packages
        // such as uuid and msgpackr use to select their Node-only builds.
        const conditions = [
          ...context.conditions.filter((condition) => condition !== "node"),
          "browser"
        ]
        return next(specifier, { ...context, conditions })
      }
    `),
  import.meta.url
)
