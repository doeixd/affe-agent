import { Effect, Option } from "effect"
import * as SkillsBattery from "../../skills/Skills.js"
import * as Sandbox from "../../sandbox/Sandbox.js"
import { warn } from "./types.js"
import type { Warning } from "./types.js"
import * as Frontmatter from "./frontmatter.js"

/** Agent Skills name: 1–64, `[a-z0-9-]`, no leading/trailing or consecutive hyphen. */
const SKILL_NAME_PATTERN = /^(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

const basename = (path: string): string => path.split("/").filter((s) => s.length > 0).pop() ?? path

type Outcome =
  | { readonly _tag: "skill"; readonly skill: SkillsBattery.Skill }
  | { readonly _tag: "skip" }
  | { readonly _tag: "warn"; readonly warning: Warning }

/** Read a skill's `references/*` files into the Skill `resources` map (best-effort). */
const readResources = (
  sandbox: Sandbox.Sandbox,
  dirPath: string
): Effect.Effect<Record<string, string>> =>
  Effect.gen(function* () {
    const refsPathOption = yield* Effect.option(Sandbox.path(`${dirPath}/references`))
    if (Option.isNone(refsPathOption)) return {}
    const refsPath = refsPathOption.value
    const stat = yield* Effect.option(sandbox.stat(refsPath))
    if (Option.isNone(stat) || stat.value.type !== "directory") return {}
    const entries = yield* Effect.orElseSucceed(sandbox.list(refsPath), () => [])
    const resources: Record<string, string> = {}
    for (const entry of entries) {
      if (entry.type !== "file") continue
      const text = yield* Effect.option(Sandbox.readText(sandbox)(entry.path))
      if (Option.isSome(text)) resources[basename(entry.path)] = text.value
    }
    return resources
  })

const processSkill = (
  sandbox: Sandbox.Sandbox,
  dirPath: string
): Effect.Effect<Outcome> =>
  Effect.gen(function* () {
    const dirName = basename(dirPath)
    const skillMdOption = yield* Effect.option(Sandbox.path(`${dirPath}/SKILL.md`))
    // An unrepresentable path (e.g. an adversarial `..` directory name) is not a
    // skill — skip it rather than turning it into a defect.
    if (Option.isNone(skillMdOption)) return { _tag: "skip" }
    const skillMd = skillMdOption.value
    const stat = yield* Effect.option(sandbox.stat(skillMd))
    // A directory without a SKILL.md file is simply not a skill — silent, per spec.
    if (Option.isNone(stat) || stat.value.type !== "file") return { _tag: "skip" }

    const text = yield* Effect.option(Sandbox.readText(sandbox)(skillMd))
    if (Option.isNone(text)) return { _tag: "warn", warning: warn("skill", `${dirName}: could not read SKILL.md`) }

    const parsed = Frontmatter.parse(text.value)
    if (Option.isNone(parsed)) {
      return { _tag: "warn", warning: warn("skill", `${dirName}: SKILL.md has no frontmatter`) }
    }
    const { fields, body } = parsed.value

    const name = fields.name
    if (name === undefined || name === "") return { _tag: "warn", warning: warn("skill", `${dirName}: missing "name"`) }
    if (name !== dirName) {
      return { _tag: "warn", warning: warn("skill", `${dirName}: "name" (${name}) must match the directory name`) }
    }
    if (name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
      return { _tag: "warn", warning: warn("skill", `${dirName}: "name" is invalid`) }
    }
    const description = fields.description
    if (description === undefined || description === "") {
      return { _tag: "warn", warning: warn("skill", `${dirName}: missing "description"`) }
    }
    if (description.length > 1024) {
      return { _tag: "warn", warning: warn("skill", `${dirName}: "description" exceeds 1024 characters`) }
    }

    const resources = yield* readResources(sandbox, dirPath)
    return {
      _tag: "skill",
      skill: SkillsBattery.skill({ id: name, name, description, body, resources })
    }
  })

/**
 * Discover the plugin's skills under `skills/`.
 *
 * Each immediate child directory of `skills/` that holds a `SKILL.md` becomes
 * one skill — no deeper recursion. Bodies are read *eagerly* here, so a loaded
 * skill is a self-contained value that no longer needs the sandbox; the sandbox
 * is a load-time dependency only. Failure is isolated per the spec: a missing
 * `skills/` is not an error, a `skills` that is a file makes the component
 * unavailable (warn), and any single invalid `SKILL.md` is skipped with a
 * warning while its siblings load.
 */
export const discoverSkills = (
  sandbox: Sandbox.Sandbox
): Effect.Effect<{ readonly skills: ReadonlyArray<SkillsBattery.Skill>; readonly warnings: ReadonlyArray<Warning> }> =>
  Effect.gen(function* () {
    const warnings: Array<Warning> = []
    const skills: Array<SkillsBattery.Skill> = []

    const skillsPath = yield* Effect.orDie(Sandbox.path("skills"))
    const stat = yield* Effect.option(sandbox.stat(skillsPath))
    if (Option.isNone(stat)) return { skills, warnings } // no skills/ -> not an error
    if (stat.value.type !== "directory") {
      warnings.push(warn("skill", "\"skills\" is not a directory; no skills loaded"))
      return { skills, warnings }
    }

    const entries = yield* Effect.orElseSucceed(sandbox.list(skillsPath), () => [])
    for (const entry of entries) {
      if (entry.type !== "directory") continue
      const outcome = yield* processSkill(sandbox, entry.path)
      if (outcome._tag === "skill") skills.push(outcome.skill)
      else if (outcome._tag === "warn") warnings.push(outcome.warning)
    }
    return { skills, warnings }
  })
