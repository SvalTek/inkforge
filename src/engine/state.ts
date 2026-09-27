import type { EngineRuntime, ExecutionContext, Scenario } from "../types/index.ts";
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

/** Resolve an NPC-local name into the runtime's flat state namespace. */
export function npcStatePath(instanceId: string, path: string): string {
  return `npc.${instanceId}.${path}`;
}

/**
 * Split an `npcVar`/`npcSet` subject into its instance id and local path.
 *
 * The instance is named rather than inferred, so the split is all that stands
 * between a subject and a state key. A spec with no dot, an empty side, or a
 * leading dot is rejected here rather than resolving to a key that would read as
 * absent and fail closed with no explanation of why.
 */
export function parseNpcPath(spec: string): { instanceId: string; path: string } | null {
  const dot = spec.indexOf(".");
  if (dot < 1 || dot === spec.length - 1) return null;
  return { instanceId: spec.slice(0, dot), path: spec.slice(dot + 1) };
}

/**
 * The default values every NPC instance starts from, flattened into state keys.
 *
 * Built once at boot and merged *under* the authored `state` and a resumed save,
 * so a default is a starting point an author or a save can still override.
 */
export function npcInstanceDefaults(scenario: Scenario | null): Record<string, unknown> {
  const defaults: Record<string, unknown> = {};
  for (const [instanceId, instance] of Object.entries(scenario?.instances?.npc || {})) {
    const definition = scenario?.npcs?.[instance?.def as string];
    if (!definition?.state || typeof definition.state !== "object" || Array.isArray(definition.state)) continue;
    for (const [path, value] of Object.entries(definition.state)) {
      // Cloned per instance. A list or mapping stored by reference would be shared
      // by every instance of the definition *and* by the authored definition itself,
      // so one write through `GameState.get("npc.a.<path>")` would reach instance `b`
      // and leave mutated authored data behind for `GameNPCs` to clone. Primitives
      // are copied as they are, so a seeded number is the same number it always was.
      defaults[npcStatePath(instanceId, path)] = value !== null && typeof value === "object"
        ? structuredClone(value)
        : value;
    }
  }
  return defaults;
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
  // A conversation does not survive *moving*, but it does survive a move that changes
  // nothing. The distinction is not academic: boot enters the starting location with a
  // `move` to the id the runtime already holds, so clearing unconditionally meant a
  // `GameConversations.start()` in OnInit was wiped by the next line of boot. A
  // conversation could not otherwise reach here — the command boxes are hidden and
  // `dispatch` refuses for its whole duration — so the guard only ever affects that
  // no-op, and the player's own `goto` still ends the exchange.
  if (runtime.location !== id) runtime.conversation = null;
  runtime.location = id;
  pushEvent(runtime, { type: "location:enter", locationId: id });
  markViewDirty(runtime);
}

/**
 * End the run.
 *
 * Clearing the conversation here rather than leaving it to each caller is the point of
 * this existing: a conversation cannot outlive the run that was holding it, and the
 * caller that has to remember that is `directives.ts`, which cannot reach
 * `endConversation` without importing the module that already imports it.
 *
 * Leaving it out was a real defect. `available()` consults the conversation before it
 * consults `over`, so an option whose `then` ended the run kept rendering its
 * remaining options as live buttons — choices that look answerable, accept a click, and
 * do nothing, on a screen the player has been told is finished.
 *
 * Assigning the field needs no import of its own, which is what keeps this in `state`.
 */
export function endRun(runtime: EngineRuntime): void {
  runtime.over = true;
  runtime.conversation = null;
  pushEvent(runtime, { type: "game:over" });
  markViewDirty(runtime);
}
