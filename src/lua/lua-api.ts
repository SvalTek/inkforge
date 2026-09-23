import { LUA_CANVAS_FACADE, LUA_CANVAS_IMPLEMENTATION, LUA_CANVAS_SUPPORT } from "./facades/canvas.ts";
import { LUA_EVENTS } from "./facades/events.ts";
import { LUA_OUTPUT_FACADE } from "./facades/output.ts";
import { LUA_STATE_FACADE } from "./facades/state.ts";
import { LUA_TIMER_FACADE, LUA_TIMER_IMPLEMENTATION, LUA_TIMER_SUPPORT } from "./facades/timer.ts";
import { LUA_UI_FACADE } from "./facades/ui.ts";
import { LUA_SHARED } from "./shared.ts";

/**
 * The live canvas Lua API source (`CANVAS_LUA_API` in the original runtime).
 *
 * The Lua source is split by facade, then assembled in its original dependency
 * order. Keeping this composition explicit makes the shared Lua bootstrap
 * contract visible without putting every facade in one TypeScript string.
 */
export const CANVAS_LUA_API = [
  LUA_SHARED,
  LUA_CANVAS_SUPPORT,
  LUA_TIMER_SUPPORT,
  "game={\n",
  LUA_OUTPUT_FACADE,
  LUA_STATE_FACADE,
  LUA_UI_FACADE,
  LUA_CANVAS_FACADE,
  LUA_TIMER_FACADE,
  "}\n",
  LUA_CANVAS_IMPLEMENTATION,
  LUA_TIMER_IMPLEMENTATION,
  LUA_EVENTS,
].join("");
