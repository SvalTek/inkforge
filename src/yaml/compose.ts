import { resolveProjectPath } from "../vfs/vfs.ts";
import type { Scenario, ScenarioMeta, Vfs } from "../types/index.ts";
import { loadYaml } from "./loader.ts";

export { collectReferencedLuaNames, validateScenario } from "./validate.ts";
export type { ValidationIssue } from "./validate.ts";

interface CompositionNode {
  $import?: string;
  $mixin?: string;
  [key: string]: unknown;
}

/** The one place `!import`/`!mixin`/`<<` are understood, shared by every reader. */
interface Composer {
  /** Read a project file and resolve everything it pulls in. */
  load(path: string): Promise<unknown>;
  /** Parse one file's text, with the composition tags registered. */
  parse(source: string): unknown;
  /** Resolve the tags in an already-parsed value, relative to `from`. */
  resolve(value: unknown, from: string): Promise<unknown>;
}

async function openComposer(vfs: Vfs): Promise<Composer> {
  const yaml = await loadYaml();
  const visiting: string[] = [];

  function parse(source: string): unknown {
    const document = yaml.parseDocument(source, {
      customTags: [
        { tag: "!import", resolve: (value: string) => ({ $import: String(value) }) },
        { tag: "!mixin", resolve: (value: string) => ({ $mixin: String(value) }) },
      ],
    });
    if (document.errors.length) throw document.errors[0];
    return document.toJS();
  }

  async function load(path: string): Promise<unknown> {
    if (visiting.includes(path)) {
      throw Error(`Circular import: ${[...visiting, path].join(" → ")}`);
    }
    const source = vfs[path];
    if (source === undefined) throw Error(`Imported file not found: ${path}`);
    visiting.push(path);
    try {
      return await resolve(parse(source), path);
    } finally {
      visiting.pop();
    }
  }

  async function resolve(value: unknown, from: string): Promise<unknown> {
    if (Array.isArray(value)) return Promise.all(value.map((item) => resolve(item, from)));
    if (!value || typeof value !== "object") return value;
    const node = value as CompositionNode;
    if (node.$import) return load(resolveProjectPath(node.$import, from));
    const result: Record<string, unknown> = {};
    const mixins = [node.$mixin, node["<<"]].filter(Boolean);
    for (const mixin of mixins) {
      const base = await load(
        resolveProjectPath(typeof mixin === "string" ? mixin : ((mixin as CompositionNode).$mixin as string), from),
      );
      if (!base || Array.isArray(base) || typeof base !== "object") {
        throw Error(`Mixin must resolve to a mapping: ${mixin}`);
      }
      Object.assign(result, base as Record<string, unknown>);
    }
    for (const [key, item] of Object.entries(node)) {
      if (key === "$mixin" || key === "<<") continue;
      result[key] = await resolve(item, from);
    }
    return result;
  }

  return { load, parse, resolve };
}

export async function composeScenario(vfs: Vfs): Promise<Scenario> {
  return (await (await openComposer(vfs)).load("scenario.yaml")) as Scenario;
}

/** The script booted for this scenario; the conventional path is only a default. */
export function mainScriptPath(scenario: Scenario): string {
  const path = scenario.scripts?.main ?? "scripts/main.lua";
  if (
    typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") ||
    path.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) throw new Error(`Invalid Lua entry script path: ${String(path)}`);
  return path;
}

/**
 * The front matter alone, for describing a project without running it.
 *
 * The library draws a card per stored project, and a card must not cost a boot:
 * `composeScenario` parses every imported file, while the front matter is one
 * file's worth of work. The tags are still resolved, so `meta: !import meta.yml`
 * reads here exactly as it does at boot.
 *
 * A project whose entry file will not parse reports nothing — this is a
 * description, and loading the project is where a broken file surfaces.
 */
export async function readScenarioMeta(vfs: Vfs): Promise<ScenarioMeta | undefined> {
  try {
    const source = vfs["scenario.yaml"];
    if (source === undefined) return undefined;
    const composer = await openComposer(vfs);
    const document = composer.parse(source) as { meta?: unknown } | undefined;
    if (!document || typeof document !== "object" || document.meta === undefined) return undefined;
    const meta = await composer.resolve(document.meta, "scenario.yaml");
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return undefined;
    return meta as ScenarioMeta;
  } catch {
    return undefined;
  }
}
