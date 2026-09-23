import type { AppContext } from "../app/context.ts";
import type { LuaCallback, ResolvedUiElement, ToolEntry } from "../types/index.ts";
import { openInventory } from "./render.ts";
import { closeModal, openModal, setModalPage } from "./modals.ts";

/** Run a UI element's activation binding (inventory/command/instructions/Lua). */
export async function runUiAction(app: AppContext, element: ResolvedUiElement): Promise<void> {
  const action = element.events?.activate || element.actions?.activate;
  if (!action) return;
  if (action.type === "inventory.open") {
    openInventory(app, element, action);
    return;
  }
  if (action.type === "modal.close") {
    closeModal(app);
    return;
  }
  if (action.type === "modal.page") {
    setModalPage(app, action.page ?? "");
    return;
  }
  if (action.type === "audio.play") {
    app.audio.play(action.asset ?? "", { id: action.id, loop: action.loop, volume: action.volume });
    app.render();
    return;
  }
  if (action.type === "command") {
    app.engine?.dispatch(action.command ?? "");
    return;
  }
  if (action.type === "instructions") {
    app.engine?.execute(action.then);
    app.render();
    return;
  }
  if (action.callback && app.runtime!.lua) {
    const callback = app.runtime!.lua!.global.get(action.callback);
    if (typeof callback === "function") {
      await (callback as LuaCallback)();
      app.render();
    }
  }
}

/** Run a shell-level tool entry from the shared YAML/Lua registry. */
export async function runToolAction(app: AppContext, entry: ToolEntry): Promise<void> {
  if (entry.disabled) return;
  const { modal, action } = entry.definition;
  if (modal) {
    openModal(app, modal);
    return;
  }
  const lua = app.runtime?.lua;
  if (action && lua) {
    const callback = lua.global.get(action);
    if (typeof callback === "function") {
      await (callback as LuaCallback)();
      app.render();
      return;
    }
  }
  if (action) app.output?.(`Unknown tool action: ${action}`, "warning");
}
