import { access, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import ts from "typescript"

export const resolve = async (specifier, context, nextResolve) => {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (
      context.parentURL?.startsWith("file:") === true &&
      specifier.startsWith(".") &&
      specifier.endsWith(".js")
    ) {
      const url = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL)
      try {
        await access(fileURLToPath(url))
        return { url: url.href, shortCircuit: true }
      } catch {
        // Preserve the original resolver failure below.
      }
    }
    throw error
  }
}

export const load = async (url, context, nextLoad) => {
  if (!url.endsWith(".ts")) return nextLoad(url, context)
  const source = await readFile(fileURLToPath(url), "utf8")
  return {
    format: "module",
    source: ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        verbatimModuleSyntax: true
      },
      fileName: fileURLToPath(url)
    }).outputText,
    shortCircuit: true
  }
}
