import type { AppContext } from "../app/context.ts";
import type { ResolvedUiElement, ToolEntry } from "../types/index.ts";
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
    return;
  }
  if (action.type === "command") {
    // `dispatch` flushes the view itself, once for the whole command.
    app.engine?.dispatch(action.command ?? "");
    return;
  }
  if (action.type === "instructions") {
    app.engine?.execute(action.then);
    app.flushView();
    return;
  }
  if (action.callback && app.runtime?.lua) {
    // `GetFunction` resolves the name at call time, so a missing handler throws
    // (LUA_CALL_ERROR) instead of silently doing nothing.
    await app.runtime.lua.GetFunction<() => unknown>(action.callback)();
    app.flushView();
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
    try {
      await lua.GetFunction<() => unknown>(action)();
      app.flushView();
      return;
    } catch (error) {
      // Report the bridge's own message (e.g. a missing function) rather than a
      // generic one, so the author can see what actually failed.
      app.output?.(error instanceof Error ? error.message : `Unknown tool action: ${action}`, "warning");
      return;
    }
  }
  if (action) app.output?.(`Unknown tool action: ${action}`, "warning");
}
