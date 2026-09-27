import type LuaBridge from "WebLuaBridge";
import type { AppContext } from "./context.ts";
import type { OutputFn, Scenario, UiCommand } from "../types/index.ts";
import { InkforgeCanvasRuntime } from "../canvas/runtime.ts";
import { createLuaEngine } from "../lua/bridge.ts";
import { markViewDirty } from "../engine/events.ts";
import { collectReferencedLuaNames, mainScriptPath, type ValidationIssue } from "../yaml/compose.ts";
import type { AudioManagerLike } from "../types/audio.ts";

/**
 * Cross-check authored Lua references against the loaded script.
 *
 * Runs after the entry file has executed so every function definition exists.
 * A dot-delimited name is resolved segment by segment, matching how
 * `bridge.call` looks the function up.
 */
async function collectUnresolvedLuaNames(lua: LuaBridge, scenario: Scenario): Promise<ValidationIssue[]> {
  const references = collectReferencedLuaNames(scenario);
  if (!references.length) return [];

  const unresolved: ValidationIssue[] = [];
  for (const reference of references) {
    const segments = reference.message.split(".");
    const owner = segments.length > 1 ? segments.slice(0, -1).join(".") : null;
    const name = segments[segments.length - 1];
    try {
      if (owner === null) {
        // A global function is reported as the right kind of value, not just a
        // non-nil one, so a name shadowed by a table is caught too.
        const kind = await lua.execute<string>(`return type(_G[${JSON.stringify(name)}])`);
        if (kind !== "function") unresolved.push(reference);
        continue;
      }
      const kind = await lua.execute<string>(
        `local t = _G[${JSON.stringify(owner.split(".")[0])}]` +
          `${segments.slice(1, -1).map((part) => `.${part}`).join("")}` +
          `\nif t == nil then return 'nil' end` +
          `\nreturn type(t[${JSON.stringify(name)}])`,
      );
      if (kind !== "function") unresolved.push(reference);
    } catch {
      unresolved.push(reference);
    }
  }
  return unresolved;
}

export interface BootHooks {
  /** Repaint if a mutation marked the view dirty; the frame hook's repaint path. */
  flushView(): void;
  applyUi(command: UiCommand): void;
  output: OutputFn;
  onError(message: string): void;
  audio: AudioManagerLike;
}

/**
 * Boot the canvas runtime and Lua engine for a composed scenario.
 *
 * Port of the live `bootLua` body minus DOM lookup and runtime construction:
 * the runtime already exists on `app.runtime`, and `app.canvas`/`app.lua` are
 * torn down and replaced here.
 */
export async function bootRuntime(app: AppContext, scenario: Scenario, hooks: BootHooks): Promise<void> {
  const scriptPath = mainScriptPath(scenario);
  const source = app.project.vfs[scriptPath];
  if (source === undefined) throw new Error(`Script not found: ${scriptPath}`);
  if (!String(source).trim()) return;

  app.canvas?.destroy();
  app.canvas = null;
  if (app.lua) {
    try {
      await app.lua.shutdown();
    } catch {
      /* teardown must not mask the boot that follows it */
    }
  }
  app.lua = null;

  const runtime = app.runtime!;
  const canvas = new InkforgeCanvasRuntime(app.dom.gameSurface, {
    ensureSurface: (id, label) => {
      if (!runtime.ui.elements.some((element) => element.id === id)) {
        runtime.ui.elements.push({
          id,
          type: "canvas",
          location: "canvas",
          fields: [{ id: "label", type: "text", value: label }],
        });
      }
      // A scene's surface is a UI element like any other, so creating it is a
      // view change: the element is what `mountSurfaces` turns into a canvas.
      markViewDirty(runtime);
    },
    removeSurface: (id) => {
      runtime.ui.elements = runtime.ui.elements.filter((element) => element.id !== id);
      markViewDirty(runtime);
    },
    asset: (path) => {
      return app.assetResolver.url(path);
    },
    canvasEvent: (event) => {
      // Lua routes this to the bound per-node callback. Whatever it mutates marks
      // the view dirty, so this flush is the only repaint path it needs — no
      // separate "was anything listening" check, because a callback that changed
      // nothing leaves the view clean and the flush a no-op.
      app.lua?.emit("canvas:event", event);
      hooks.flushView();
    },
    afterFrame: () => hooks.flushView(),
  });
  app.canvas = canvas;
  runtime.canvasEngine = canvas;

  const lua = await createLuaEngine({
    runtime,
    scenario,
    vfs: app.project.vfs,
    scriptPath,
    canvasHost: canvas,
    applyUi: hooks.applyUi,
    output: hooks.output,
    audio: hooks.audio,
    onError: hooks.onError,
  });
  app.lua = lua;
  runtime.lua = lua;

  // The script has now loaded, so authored references to Lua functions can
  // finally be resolved by name. `emit:` targets cannot be checked this way —
  // `Events:On` exposes no listener enumeration.
  const missing = await collectUnresolvedLuaNames(lua, scenario);
  if (missing.length) {
    hooks.onError(
      `Missing Lua functions: ${missing.map((issue) => `${issue.message} (${issue.path})`).join(", ")}`,
    );
  }
}
