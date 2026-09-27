import type { EngineRuntime, ExecutionContext } from "../types/index.ts";
import { markViewDirty, pushEvent } from "./events.ts";

/**
 * State, inventory and location mutations.
 *
 * Authored directives (`set:`, `inc:`, `give:`, `goto:`) and Lua's `GameState`
 * both funnel through here rather than assigning to `runtime` directly, so the
 * dirty mark is stated once per kind of change instead of at each call site.
 * That is what lets a bound meter follow a Lua timer with nothing else asking
 * for a repaint.
 */

export function setState(runtime: EngineRuntime, path: string, value: unknown): void {
  runtime.state[path] = value;
  markViewDirty(runtime);
}

/** Resolve an item-local name into the runtime's flat state namespace. */
export function itemStatePath(context: ExecutionContext | undefined, path: string): string | null {
  const itemId = context?.item?.id;
  return itemId ? `item.${itemId}.${path}` : null;
}

/** Add to a numeric state value, treating an absent one as zero. */
export function adjustState(runtime: EngineRuntime, path: string, by: number): void {
  runtime.state[path] = (Number(runtime.state[path]) || 0) + by;
  markViewDirty(runtime);
}

export function addItem(runtime: EngineRuntime, id: string): void {
  if (runtime.inventory.includes(id)) return;
  runtime.inventory.push(id);
  pushEvent(runtime, { type: "inventory:add", itemId: id });
  markViewDirty(runtime);
}

export function removeItem(runtime: EngineRuntime, id: string): void {
  runtime.inventory = runtime.inventory.filter((value) => value !== id);
  pushEvent(runtime, { type: "inventory:remove", itemId: id });
  markViewDirty(runtime);
}

export function setLocation(runtime: EngineRuntime, id: string): void {
  runtime.location = id;
  runtime.conversation = null;
  pushEvent(runtime, { type: "location:enter", locationId: id });
  markViewDirty(runtime);
}
