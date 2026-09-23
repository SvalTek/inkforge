import { resolveProjectPath } from "../vfs/vfs.ts";
import type { Scenario, Vfs } from "../types/index.ts";
import { loadYaml } from "./loader.ts";

interface CompositionNode {
  $import?: string;
  $mixin?: string;
  [key: string]: unknown;
}

export async function composeScenario(vfs: Vfs): Promise<Scenario> {
  const yaml = await loadYaml();
  const visiting: string[] = [];

  async function load(path: string): Promise<unknown> {
    if (visiting.includes(path)) {
      throw Error(`Circular import: ${[...visiting, path].join(" → ")}`);
    }
    const source = vfs[path];
    if (source === undefined) throw Error(`Imported file not found: ${path}`);
    const document = yaml.parseDocument(source, {
      customTags: [
        { tag: "!import", resolve: (value: string) => ({ $import: String(value) }) },
        { tag: "!mixin", resolve: (value: string) => ({ $mixin: String(value) }) },
      ],
    });
    if (document.errors.length) throw document.errors[0];
    visiting.push(path);
    try {
      return await resolve(document.toJS(), path);
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

  return (await load("scenario.yaml")) as Scenario;
}
