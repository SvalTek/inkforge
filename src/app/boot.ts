import type { AppContext } from "./context.ts";
import type { OutputFn, Scenario, UiCommand } from "../types/index.ts";
import { InkforgeCanvasRuntime } from "../canvas/runtime.ts";
import { createLuaEngine } from "../lua/bridge.ts";

export interface BootHooks {
  render(): void;
  applyUi(command: UiCommand): void;
  output: OutputFn;
  onError(message: string): void;
}

/**
 * Boot the canvas runtime and Lua engine for a composed scenario.
 *
 * Port of the live `bootLua` body minus DOM lookup and runtime construction:
 * the runtime already exists on `app.runtime`, and `app.canvas`/`app.lua` are
 * torn down and replaced here.
 */
export async function bootRuntime(app: AppContext, scenario: Scenario, hooks: BootHooks): Promise<void> {
  const scriptPath = scenario.scripts?.main ?? "scripts/main.lua";
  const source = app.project.vfs[scriptPath];
  if (source === undefined) throw new Error(`Script not found: ${scriptPath}`);
  if (!String(source).trim()) return;

  app.canvas?.destroy();
  app.canvas = null;
  if (app.lua) {
    try {
      app.lua.global.close();
    } catch {
      /* ignore */
    }
  }
  app.lua = null;

  const runtime = app.runtime!;
  const canvas = new InkforgeCanvasRuntime(app.dom.gameSurface, {
    callLua: (callback, dt) => {
      if (typeof callback !== "function") return;
      try {
        return callback(dt);
      } catch (error) {
        hooks.onError((error as Error).message);
      }
    },
    ensureSurface: (id, label) => {
      if (!runtime.ui.elements.some((element) => element.id === id)) {
        runtime.ui.elements.push({
          id,
          type: "canvas",
          location: "canvas",
          fields: [{ id: "label", type: "text", value: label }],
        });
      }
    },
    removeSurface: (id) => {
      runtime.ui.elements = runtime.ui.elements.filter((element) => element.id !== id);
    },
    asset: (path) => {
      const value = app.project.vfs[path];
      return typeof value === "string" && /^(data:|blob:)/.test(value) ? value : path;
    },
    event: (reference, event) => {
      if (typeof runtime.canvasEvent === "function") {
        runtime.canvasEvent(
          reference,
          event.sceneId,
          event.nodeId,
          event.type,
          event.x,
          event.y,
          event.worldX,
          event.worldY,
          event.worldZ,
          event.localX,
          event.localY,
          event.button,
          event.pointerType,
          event.altKey,
          event.ctrlKey,
          event.shiftKey,
        );
        if (runtime.canvasViewDirty) {
          runtime.canvasViewDirty = false;
          hooks.render();
        }
      }
    },
    timer: (reference, id, iteration) => {
      if (typeof runtime.timerEvent === "function") {
        runtime.timerEvent(reference, id, iteration);
        if (runtime.canvasViewDirty) {
          runtime.canvasViewDirty = false;
          hooks.render();
        }
      }
    },
    afterFrame: () => {
      if (runtime.canvasViewDirty) {
        runtime.canvasViewDirty = false;
        hooks.render();
      }
    },
  });
  app.canvas = canvas;
  runtime.canvasEngine = canvas;
  runtime.canvasViewDirty = false;

  const result = await createLuaEngine({
    runtime,
    vfs: app.project.vfs,
    scriptPath,
    canvasHost: canvas,
    applyUi: hooks.applyUi,
    output: hooks.output,
  });
  app.lua = result.engine;
  runtime.lua = result.engine;
  runtime.canvasEvent = result.canvasEvent;
  runtime.timerEvent = result.timerEvent;
  canvas.setUpdate(result.update);
}
