import { LUA_CANVAS_IMPLEMENTATION, LUA_CANVAS_SUPPORT } from "./facades/canvas.ts";
import { LUA_EVENTS } from "./facades/events.ts";

/**
 * The Lua source Inkforge installs into the runtime.
 *
 * Only two things are still written in Lua: `GameCanvas`, whose handles are
 * created per node with closures and carry fluent chaining, and the
 * `canvas:event` router, which holds the per-node callbacks. Every other host
 * namespace is bound from JS as a `LuaClass` (see `bindings.ts`), and timers
 * come from the bridge's own binding.
 *
 * The fragments are concatenated into a single chunk, so `local` declarations
 * in an earlier fragment are visible to later ones.
 */
export const INKFORGE_LUA_API = [
  LUA_CANVAS_SUPPORT,
  LUA_CANVAS_IMPLEMENTATION,
  LUA_EVENTS,
].join("");
