import type {
  EngineEvent,
  EngineRuntime,
  ModalRuntimeState,
  ResumedRuntime,
  SaveSnapshot,
  ToolEntry,
  ToolRegistry,
  UiElement,
  UiOverride,
  UiOverrideMap,
  Vfs,
} from "../types/index.ts";

/**
 * Snapshot and restore for play state.
 *
 * The Lua VM, canvas scenes, timers and animation handles are deliberately not
 * part of a snapshot: none of them survive a reload anyway, and a fresh boot
 * rebuilds all of them from the authored scenario and script. What a snapshot
 * carries is the part a boot cannot reconstruct — where the player is, what they
 * carry, and what the story has already said.
 */

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value ? value : fallback;
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * Drop anything that cannot survive a save round trip.
 *
 * `conversation` is opaque by design — the engine never reads it, the terminal
 * only renders it — so it cannot be narrowed field by field the way the rest of
 * a snapshot can. What can be checked is whether it is representable: a hand-
 * edited file carrying a cycle or a BigInt would otherwise make the save
 * unwritable, and the player would find their only copy of a run had become
 * unsaveable because of it. Costing the dialogue log is the right trade.
 */
function asJsonSafe(value: unknown): unknown {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? null : value;
  } catch {
    return null;
  }
}

/**
 * A stable identity for the authored content a save was made against.
 *
 * FNV-1a over text sources. The path participates in the hash so renames and
 * additions matter as well as content changes.
 */
export function hashScenario(...parts: string[]): string {
  let hash = 0x811c9dc5;
  for (const part of parts) {
    for (let i = 0; i < part.length; i += 1) {
      hash ^= part.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    // A separator that cannot appear in the parts keeps `["ab","c"]` from
    // hashing the same as `["a","bc"]`.
    hash ^= 0x1f;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Hash every project text file in path order, including imported YAML and Lua. */
export function hashProjectSources(vfs: Vfs): string {
  const paths = Object.keys(vfs).sort();
  return `v2:${hashScenario(...paths.flatMap((path) => [path, vfs[path]]))}`;
}

/**
 * Project a live runtime into its storable form.
 *
 * The copies are shallow on purpose. IndexedDB structured-clones on write and
 * `JSON.stringify` copies on export, so a deep clone here would duplicate that
 * work — and would have to keep up with whatever shape Lua can put into state.
 */
export function toSnapshot(runtime: EngineRuntime): SaveSnapshot {
  return {
    location: runtime.location,
    state: { ...runtime.state },
    inventory: [...runtime.inventory],
    events: [...runtime.events],
    droppedEvents: runtime.droppedEvents,
    over: runtime.over,
    ui: {
      hidden: [...runtime.ui.hidden],
      overrides: { ...runtime.ui.overrides },
      elements: [...runtime.ui.elements],
    },
    tools: [...runtime.tools.entries.values()],
    modals: { open: runtime.modals.open, activePages: { ...runtime.modals.activePages } },
    conversation: runtime.conversation,
  };
}

function readEvents(value: unknown): EngineEvent[] {
  if (!Array.isArray(value)) return [];
  const events: EngineEvent[] = [];
  for (const item of value) {
    const entry = asObject(item);
    if (!entry) continue;
    switch (entry.type) {
      case "output":
        if (typeof entry.text === "string") {
          events.push({
            type: "output",
            text: entry.text,
            kind: typeof entry.kind === "string" ? entry.kind : "normal",
          });
        }
        break;
      case "location:enter":
        if (typeof entry.locationId === "string") events.push({ type: "location:enter", locationId: entry.locationId });
        break;
      case "ui:update":
        if (typeof entry.elementId === "string") events.push({ type: "ui:update", elementId: entry.elementId });
        break;
      case "inventory:add":
      case "inventory:remove":
        if (typeof entry.itemId === "string") events.push({ type: entry.type, itemId: entry.itemId });
        break;
      case "game:over":
        events.push({ type: "game:over" });
        break;
    }
  }
  return events;
}

/**
 * Narrow a saved UI element list.
 *
 * An element is kept only if it has the one field the renderer and the dedupe
 * both dispatch on: a non-empty string `id`. Anything else is dropped rather
 * than cast, so a malformed entry in a hand-edited file costs that entry and
 * not the panel around it.
 */
function readElements(value: unknown): UiElement[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is UiElement => {
    const entry = asObject(item);
    return entry !== null && typeof entry.id === "string" && entry.id.length > 0;
  });
}

function readOverrides(value: unknown): UiOverrideMap {
  const source = asObject(value);
  if (!source) return {};
  const out: UiOverrideMap = {};
  for (const [id, override] of Object.entries(source)) {
    const entry = asObject(override);
    if (entry) out[id] = entry as UiOverride;
  }
  return out;
}

function readTools(value: unknown): ToolRegistry {
  const entries = new Map<string, ToolEntry>();
  if (!Array.isArray(value)) return { entries };
  for (const item of value) {
    const entry = asObject(item);
    const definition = asObject(entry?.definition);
    const id = typeof definition?.id === "string" ? definition.id : "";
    // Keyed off the definition's own id rather than the array position, so a
    // reordered export still restores the same registry.
    if (id) {
      entries.set(id, {
        definition: definition as unknown as ToolEntry["definition"],
        hidden: entry?.hidden === true,
        disabled: entry?.disabled === true,
        source: entry?.source === "lua" ? "lua" : "yaml",
      });
    }
  }
  return { entries };
}

function readModals(value: unknown): ModalRuntimeState {
  const source = asObject(value);
  const activePages = asObject(source?.activePages);
  const pages: Record<string, string> = {};
  for (const [id, page] of Object.entries(activePages || {})) {
    if (typeof page === "string") pages[id] = page;
  }
  return {
    open: typeof source?.open === "string" ? source.open : null,
    activePages: pages,
  };
}

/**
 * Rebuild live runtime pieces from a stored snapshot.
 *
 * Every field is narrowed rather than trusted, because a snapshot can arrive
 * from a hand-edited or older file as well as from this app's own storage, and a
 * bad field should cost the player one value rather than the whole save. The
 * caller supplies scenario defaults for anything missing, so `null` here means
 * only "not a snapshot at all".
 */
export function fromSnapshot(value: unknown): ResumedRuntime | null {
  const source = asObject(value);
  if (!source) return null;
  const ui = asObject(source.ui);
  return {
    location: asString(source.location, ""),
    state: asObject(source.state) || {},
    inventory: asStringArray(source.inventory),
    events: readEvents(source.events),
    droppedEvents: asCount(source.droppedEvents),
    over: asBoolean(source.over),
    ui: {
      hidden: new Set(asStringArray(ui?.hidden)),
      overrides: readOverrides(ui?.overrides),
      elements: readElements(ui?.elements),
    },
    tools: readTools(source.tools),
    modals: readModals(source.modals),
    conversation: source.conversation === undefined ? null : asJsonSafe(source.conversation),
  };
}
