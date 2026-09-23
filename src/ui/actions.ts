import type { AppContext } from "../app/context.ts";
import type { LuaCallback, ResolvedUiElement } from "../types/index.ts";
import { openInventory } from "./render.ts";

/** Run a UI element's activation binding (inventory/command/instructions/Lua). */
export async function runUiAction(app: AppContext, element: ResolvedUiElement): Promise<void> {
  const action = element.events?.activate || element.actions?.activate;
  if (!action) return;
  if (action.type === "inventory.open") {
    openInventory(app, element, action);
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
