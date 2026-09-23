import { loadWasmoon } from "./loader.ts";
import { CANVAS_LUA_API } from "./lua-api.ts";
import type { CanvasCommand, CanvasHost, TimerCommand } from "../types/canvas.ts";
import type { ApplyUiFn, EngineRuntime, OutputFn } from "../types/engine.ts";
import type { LuaCallback, LuaEngine } from "../types/lua.ts";
import type { UiCommand } from "../types/ui.ts";
import type { Vfs } from "../types/vfs.ts";
import type { AudioManagerLike } from "../types/audio.ts";
import { registerTool, removeTool, setToolDisabled, setToolHidden } from "../engine/tool-state.ts";

/** Injected dependencies for {@link createLuaEngine}. */
export interface LuaBridgeOptions {
  runtime: EngineRuntime;
  vfs: Vfs;
  scriptPath: string;
  canvasHost: CanvasHost;
  applyUi: ApplyUiFn;
  output: OutputFn;
  audio: AudioManagerLike;
}

/** The live Lua engine plus the callbacks read back from its globals. */
export interface LuaBridgeResult {
  engine: LuaEngine;
  /** `lua.global.get('__canvas_event')` when it is a function. */
  canvasEvent: LuaCallback | undefined;
  /** `lua.global.get('__timer_event')` when it is a function. */
  timerEvent: LuaCallback | undefined;
  /** `lua.global.get('update')` when it is a function, else `null`. */
  update: ((dt: number) => void) | null;
}

/**
 * Boot a wasmoon Lua engine for a scenario script.
 *
 * Faithful port of the live `bootLua` body, minus canvas-runtime construction,
 * DOM host lookup, `engine.setUpdate(...)`, and `runtime.*` assignment.
 *
 * Mutation contract: this function does NOT mutate any `runtime.*` field. The
 * caller is responsible for assigning `runtime.lua`, `runtime.canvasEvent`,
 * `runtime.timerEvent`, `runtime.canvasViewDirty`, and for wiring
 * `canvasHost.setUpdate(result.update)`.
 *
 * An empty script is not special-cased here (the caller decides); a script path
 * that is absent from `vfs` throws `Script not found: <path>` before any work.
 */
export async function createLuaEngine(options: LuaBridgeOptions): Promise<LuaBridgeResult> {
  const { runtime, vfs, scriptPath, canvasHost, applyUi, output, audio } = options;

  if (vfs[scriptPath] === undefined) throw new Error(`Script not found: ${scriptPath}`);

  const { LuaFactory } = await loadWasmoon();
  const factory = new LuaFactory();
  for (const [path, content] of Object.entries(vfs)) {
    if (path.endsWith(".lua")) await factory.mountFile(path, content);
  }

  const engine = await factory.createEngine({ injectObjects: true });

  engine.global.set(
    "__ui_create",
    (payload: unknown) => applyUi({ create: JSON.parse(String(payload)) as UiCommand["create"] }),
  );
  engine.global.set(
    "__ui_set",
    (id: unknown, payload: unknown) => applyUi({ set: { [String(id)]: JSON.parse(String(payload)) } }),
  );
  engine.global.set("__ui_show", (id: unknown) => applyUi({ show: String(id) }));
  engine.global.set("__ui_hide", (id: unknown) => applyUi({ hide: String(id) }));
  engine.global.set("__ui_remove", (id: unknown) => applyUi({ remove: String(id) }));
  engine.global.set("__tool_register", (payload: unknown) => {
    registerTool(runtime.tools, JSON.parse(String(payload)), "lua");
    runtime.canvasViewDirty = true;
  });
  engine.global.set("__tool_remove", (id: unknown) => {
    removeTool(runtime.tools, String(id));
    runtime.canvasViewDirty = true;
  });
  engine.global.set("__tool_show", (id: unknown) => {
    setToolHidden(runtime.tools, String(id), false);
    runtime.canvasViewDirty = true;
  });
  engine.global.set("__tool_hide", (id: unknown) => {
    setToolHidden(runtime.tools, String(id), true);
    runtime.canvasViewDirty = true;
  });
  engine.global.set("__tool_enable", (id: unknown) => {
    setToolDisabled(runtime.tools, String(id), false);
    runtime.canvasViewDirty = true;
  });
  engine.global.set("__tool_disable", (id: unknown) => {
    setToolDisabled(runtime.tools, String(id), true);
    runtime.canvasViewDirty = true;
  });
  engine.global.set("__output", (text: unknown) => output(text));
  engine.global.set("__audio_play", (path: unknown, optionsJson: unknown) => {
    const options = JSON.parse(String(optionsJson || "{}")) as { id?: string; loop?: boolean; volume?: number };
    return audio.play(String(path), options);
  });
  engine.global.set("__audio_stop", (id: unknown) => audio.stop(String(id)));
  engine.global.set("__audio_pause", (id: unknown) => audio.pause(String(id)));
  engine.global.set("__audio_resume", (id: unknown) => audio.resume(String(id)));
  engine.global.set("__audio_set_volume", (id: unknown, value: unknown) => audio.setVolume(String(id), Number(value)));
  engine.global.set("__audio_set_loop", (id: unknown, value: unknown) => audio.setLoop(String(id), Boolean(value)));
  engine.global.set("__audio_stop_all", () => audio.stopAll());
  engine.global.set("__state_get", (path: unknown) => runtime.state[String(path)]);
  engine.global.set("__state_set", (path: unknown, value: unknown) => {
    runtime.state[String(path)] = value;
  });
  engine.global.set(
    "__canvas_command",
    (payload: unknown) => canvasHost.command(JSON.parse(String(payload)) as CanvasCommand),
  );
  engine.global.set(
    "__timer_command",
    (payload: unknown) => canvasHost.timer(JSON.parse(String(payload)) as TimerCommand),
  );
  engine.global.set("__timer_remaining", (id: unknown) => canvasHost.timerRemaining(String(id)));
  engine.global.set("__timer_active", (id: unknown) => canvasHost.timerActive(String(id)));

  await engine.doString(CANVAS_LUA_API);
  await engine.doFile(scriptPath);

  const canvasEvent = engine.global.get("__canvas_event");
  const timerEvent = engine.global.get("__timer_event");
  const update = engine.global.get("update");

  return {
    engine,
    canvasEvent: typeof canvasEvent === "function" ? (canvasEvent as LuaCallback) : undefined,
    timerEvent: typeof timerEvent === "function" ? (timerEvent as LuaCallback) : undefined,
    update: typeof update === "function" ? (update as (dt: number) => void) : null,
  };
}
