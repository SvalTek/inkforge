import { LuaClass } from "WebLuaBridge";
import type { ApplyUiFn, EngineRuntime, OutputFn } from "../types/engine.ts";
import type { AudioManagerLike } from "../types/audio.ts";
import type { UiCommand } from "../types/ui.ts";
import { registerTool, removeTool, setToolDisabled, setToolHidden } from "../engine/tool-state.ts";
import { setState } from "../engine/state.ts";
import { markViewDirty } from "../engine/events.ts";

/** Host capabilities the Lua-facing namespaces are built from. */
export interface LuaHostBindings {
  runtime: EngineRuntime;
  applyUi: ApplyUiFn;
  output: OutputFn;
  audio: AudioManagerLike;
}

/**
 * Build the Lua-facing host namespaces.
 *
 * Each is a `LuaClass`, which the bridge installs directly when it is passed in
 * the globals map — no `bindings:` factories, no `BindingContext`, and no Lua
 * shim to reshape the API. All are `readonly` so authored Lua cannot clobber
 * them, and method names follow the bridge's own bindings (`setVolume`, not
 * `set_volume`) so the whole Lua surface is consistent.
 *
 * `GameCanvas` is deliberately absent: its handles are created per node with
 * closures, so it stays Lua (see `facades/canvas.ts`).
 */
export function createHostNamespaces(host: LuaHostBindings): Record<string, LuaClass> {
  const { runtime, applyUi, output, audio } = host;

  return {
    GameOutput: new LuaClass({ name: "GameOutput" })
      .method("add", (text: unknown) => output(text))
      .readonly(),

    GameState: new LuaClass({ name: "GameState" })
      .method("get", (path: unknown) => runtime.state[String(path)])
      .method("set", (path: unknown, value: unknown) => setState(runtime, String(path), value))
      .readonly(),

    GameUI: new LuaClass({ name: "GameUI" })
      .method("create", (element: unknown) => applyUi({ create: element as UiCommand["create"] }))
      .method(
        "set",
        (id: unknown, properties: unknown) => applyUi({ set: { [String(id)]: properties as UiCommand["set"] } }),
      )
      .method("show", (id: unknown) => applyUi({ show: String(id) }))
      .method("hide", (id: unknown) => applyUi({ hide: String(id) }))
      .method("remove", (id: unknown) => applyUi({ remove: String(id) }))
      .readonly(),

    GameTools: new LuaClass({ name: "GameTools" })
      .method("register", (definition: unknown) => {
        registerTool(runtime.tools, definition, "lua");
        markViewDirty(runtime);
      })
      .method("remove", (id: unknown) => {
        removeTool(runtime.tools, String(id));
        markViewDirty(runtime);
      })
      .method("show", (id: unknown) => {
        setToolHidden(runtime.tools, String(id), false);
        markViewDirty(runtime);
      })
      .method("hide", (id: unknown) => {
        setToolHidden(runtime.tools, String(id), true);
        markViewDirty(runtime);
      })
      .method("enable", (id: unknown) => {
        setToolDisabled(runtime.tools, String(id), false);
        markViewDirty(runtime);
      })
      .method("disable", (id: unknown) => {
        setToolDisabled(runtime.tools, String(id), true);
        markViewDirty(runtime);
      })
      .readonly(),

    GameAudio: new LuaClass({ name: "GameAudio" })
      .method("play", (path: unknown, options: unknown) => {
        const settings = (options || {}) as { id?: string; loop?: boolean; volume?: number };
        return audio.play(String(path), settings);
      })
      .method("stop", (id: unknown) => audio.stop(String(id)))
      .method("pause", (id: unknown) => audio.pause(String(id)))
      .method("resume", (id: unknown) => audio.resume(String(id)))
      .method("setVolume", (id: unknown, value: unknown) => audio.setVolume(String(id), Number(value)))
      .method("setLoop", (id: unknown, value: unknown) => audio.setLoop(String(id), Boolean(value)))
      .method("stopAll", () => audio.stopAll())
      .readonly(),
  };
}
