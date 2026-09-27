import { LuaClass } from "WebLuaBridge";
import type { ApplyUiFn, EngineRuntime, OutputFn } from "../types/engine.ts";
import type { AudioManagerLike } from "../types/audio.ts";
import type { UiCommand } from "../types/ui.ts";
import type { Scenario } from "../types/scenario.ts";
import { registerTool, removeTool, setToolDisabled, setToolHidden } from "../engine/tool-state.ts";
import { setItemActionHidden } from "../engine/item-action-state.ts";
import type { DirectiveDeps } from "../engine/directives.ts";
import { endConversation, startConversation } from "../engine/conversation.ts";
import { setState } from "../engine/state.ts";
import { markViewDirty } from "../engine/events.ts";

/** Host capabilities the Lua-facing namespaces are built from. */
export interface LuaHostBindings {
  runtime: EngineRuntime;
  scenario: Scenario;
  applyUi: ApplyUiFn;
  output: OutputFn;
  audio: AudioManagerLike;
  /**
   * The seam authored directives run through, for the host operations that are not
   * plain data — starting and ending a conversation, say.
   *
   * Passed in rather than reaching for the engine, per the same rule every other
   * namespace here follows: the Lua side gets what the host supplies, not a handle on
   * the app. It is the same object `execute()` uses, so a conversation started from
   * Lua is indistinguishable from one started by a `talk:`.
   */
  directives: DirectiveDeps;
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
  const { runtime, scenario, applyUi, output, audio, directives } = host;

  return {
    GameOutput: new LuaClass({ name: "GameOutput" })
      .method("add", (text: unknown) => output(text))
      .readonly(),

    GameState: new LuaClass({ name: "GameState" })
      .method("get", (path: unknown) => runtime.state[String(path)])
      .method("set", (path: unknown, value: unknown) => setState(runtime, String(path), value))
      .readonly(),

    GameItems: new LuaClass({ name: "GameItems" })
      .method("get", (id: unknown) => {
        const itemId = String(id);
        const instance = scenario.instances?.item?.[itemId];
        const definitionId = instance?.def;
        const definition = definitionId === undefined ? undefined : scenario.definitions?.item?.[definitionId];
        if (definitionId === undefined || definition === undefined) return undefined;
        return {
          id: itemId,
          def: definitionId,
          definition: structuredClone(definition),
        };
      })
      .method("definition", (id: unknown) => {
        const definition = scenario.definitions?.item?.[String(id)];
        return definition === undefined ? undefined : structuredClone(definition);
      })
      .readonly(),

    // A ref, like `GameItems`: it resolves the live composed scenario, and the
    // clone is what stops authored data being mutated through a returned object.
    // Only the authored half lives here — an NPC's current values are state, so
    // `GameState.get("npc.<instance>.<path>")` is where those are read.
    GameNPCs: new LuaClass({ name: "GameNPCs" })
      .method("get", (id: unknown) => {
        const npcId = String(id);
        const instance = scenario.instances?.npc?.[npcId];
        const definitionId = instance?.def;
        const definition = definitionId === undefined ? undefined : scenario.npcs?.[definitionId];
        if (definitionId === undefined || definition === undefined) return undefined;
        return {
          id: npcId,
          def: definitionId,
          definition: structuredClone(definition),
        };
      })
      .method("definition", (id: unknown) => {
        const definition = scenario.npcs?.[String(id)];
        return definition === undefined ? undefined : structuredClone(definition);
      })
      .readonly(),

    // A wrapper, and the second thing here that is one: these trigger a host
    // operation rather than reading data. `start` is the same call a `talk:`
    // directive makes, so a conversation opened from a timer or a canvas callback
    // is indistinguishable from one an action opened.
    //
    // `finish` rather than `end`, because `end` is a Lua keyword: `GameConversations.end()`
    // is a syntax error, while `GameNPCs["end"]` is not — so the name could pass
    // every host-side check and only fail once an author wrote the obvious call.
    GameConversations: new LuaClass({ name: "GameConversations" })
      .method("start", (id: unknown) => {
        startConversation(String(id), directives);
      })
      .method("finish", () => {
        endConversation(runtime);
      })
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

    // The third player-facing trigger surface. It needed a class of its own rather than
    // a pair of methods on `GameItems`, which is readonly and about reading authored
    // item data — mutation is a different concern, and hiding an action is not a read.
    GameItemActions: new LuaClass({ name: "GameItemActions" })
      .method("hide", (id: unknown) => {
        setItemActionHidden(runtime.items, String(id), true);
        markViewDirty(runtime);
      })
      .method("show", (id: unknown) => {
        setItemActionHidden(runtime.items, String(id), false);
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
