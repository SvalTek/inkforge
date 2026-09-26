/**
 * Every name the Lua editor offers must exist in the runtime.
 *
 * `src/editor/lua-assist.ts` completes and documents the API table in
 * `src/lua/api-manifest.ts`. Nothing stops that table from drifting from the
 * code that actually installs the API — a renamed method would leave the editor
 * cheerfully offering a name that fails at play time, which is the exact failure
 * this project's posture is built to avoid.
 *
 * So this check boots a real bridge, headless and in Deno: the same
 * `createHostNamespaces` the app uses, the same `INKFORGE_LUA_API` Lua source,
 * and the same binding modules. It then resolves every manifest entry with
 * `type()`, which is the same test `src/app/boot.ts` uses to catch a `call:` to
 * a function that does not exist.
 *
 * The canvas handles are covered too, by instantiating one scene, node and
 * animation through a stubbed transport — the methods only need to be *present*,
 * not to draw anything.
 *
 * Not covered, and not coverable: the lifecycle functions and the event names.
 * `OnInit`/`Update`/`OnShutdown` are the author's to define, and an `emit:`
 * target is a name the author invented, so neither is a name this runtime can be
 * asked about.
 *
 * Usage: deno task check:manifest
 */

import { createLuaBridge, globalBindings, jsonBindings, regexBindings, timersBindings } from "WebLuaBridge";
import { createHostNamespaces, type LuaHostBindings } from "../src/lua/bindings.ts";
import { INKFORGE_LUA_API } from "../src/lua/lua-api.ts";
import {
  LUA_API_MANIFEST,
  LUA_CANVAS_HANDLES,
  LUA_GLOBAL_FUNCTIONS,
  type LuaHandleApi,
} from "../src/lua/api-manifest.ts";

/** The Lua local each handle kind is probed through, created by {@link checkScript}. */
const PROBE_VARIABLE: Record<LuaHandleApi["kind"], string> = {
  scene: "probe_scene",
  node: "probe_node",
  animation: "probe_animation",
};

/**
 * The probe, as Lua.
 *
 * Built from the manifest so a name cannot be checked without also being one the
 * editor offers. `record` guards the absent-namespace case: indexing `nil` would
 * raise, and a raised error is not the report this check wants to produce.
 */
function checkScript(): string {
  const lines = [
    "local out = {}",
    "local function record(label, owner, name)",
    "  if owner == nil then out[#out + 1] = label .. '=nil' return end",
    "  out[#out + 1] = label .. '=' .. type(owner[name])",
    "end",
  ];

  for (const namespace of LUA_API_MANIFEST) {
    for (const member of namespace.members) {
      const label = `${namespace.name}.${member.name}`;
      lines.push(
        `record(${JSON.stringify(label)}, _G[${JSON.stringify(namespace.name)}], ${JSON.stringify(member.name)})`,
      );
    }
  }

  for (const entry of LUA_GLOBAL_FUNCTIONS) {
    lines.push(`record(${JSON.stringify(entry.name)}, _G, ${JSON.stringify(entry.name)})`);
  }

  lines.push(
    'local probe_scene = GameCanvas.create({ id = "__manifest_probe", nodes = { { id = "node", type = "rect" } } })',
    'local probe_node = probe_scene:node("node")',
    "local probe_animation = probe_node:tween({ x = 1 }, { duration = 0 })",
  );

  for (const handle of LUA_CANVAS_HANDLES) {
    for (const member of handle.members) {
      const label = `${handle.kind}.${member.name}`;
      lines.push(`record(${JSON.stringify(label)}, ${PROBE_VARIABLE[handle.kind]}, ${JSON.stringify(member.name)})`);
    }
  }

  lines.push("probe_scene:remove()", 'return table.concat(out, "\\n")');
  return lines.join("\n");
}

/** The labels this check expects to resolve, in the order the probe reports them. */
function expectedLabels(): string[] {
  return [
    ...LUA_API_MANIFEST.flatMap((namespace) => namespace.members.map((member) => `${namespace.name}.${member.name}`)),
    ...LUA_GLOBAL_FUNCTIONS.map((entry) => entry.name),
    ...LUA_CANVAS_HANDLES.flatMap((handle) => handle.members.map((member) => `${handle.kind}.${member.name}`)),
  ];
}

async function main(): Promise<void> {
  console.log("== Inkforge Lua API manifest check ==");

  // The host is never called: only `type()` reads these, and the one thing that
  // does need the host — `GameCanvas`, whose handles talk to the canvas — is
  // served by the stubbed transport below, which accepts and discards.
  const namespaces = createHostNamespaces({} as LuaHostBindings);
  const bridge = await createLuaBridge(
    { ...namespaces, __canvas_command: (_payload: unknown) => undefined },
    {
      injectObjects: true,
      enableProxy: true,
      bindings: [globalBindings, jsonBindings, regexBindings, timersBindings],
    },
  );

  await bridge.execute(INKFORGE_LUA_API);
  const report = await bridge.execute<string>(checkScript());
  await bridge.shutdown();

  const kinds = new Map<string, string>();
  for (const line of report.split("\n")) {
    const separator = line.lastIndexOf("=");
    kinds.set(line.slice(0, separator), line.slice(separator + 1));
  }

  const labels = expectedLabels();
  const unresolved = labels.filter((label) => kinds.get(label) !== "function");
  if (unresolved.length) {
    for (const label of unresolved) {
      const kind = kinds.get(label);
      const message = kind === undefined ? "was not probed" : `resolves to ${kind}, not a function`;
      console.log(`FAIL  ${label} ${message}`);
    }
    throw new Error(`${unresolved.length} of ${labels.length} manifest entries are not callable in the API`);
  }

  console.log(`PASS  ${labels.length} manifest entries resolved against the live bridge`);
}

await main();
