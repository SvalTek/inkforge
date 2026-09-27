import { normalizeTool } from "./tool-state.ts";
import type {
  ConversationState,
  EngineEvent,
  EngineRuntime,
  ModalRuntimeState,
  ResumedRuntime,
  SaveSnapshot,
  ToolDefinition,
  ToolEntry,
  ToolRegistry,
  UiElement,
  UiField,
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
 * Narrow a saved conversation position, or report that there is nothing usable.
 *
 * Narrowed field by field like the rest of a snapshot, because a snapshot can arrive
 * from a hand-edited or older file as well as from this app's own storage. A position
 * naming a conversation or node that no longer exists is deliberately **kept** here:
 * this function has no way to report anything, and the boot path checks the position
 * against the composed scenario where it can both say so and drop it.
 */
function readConversation(value: unknown): ConversationState | null {
  const entry = asObject(value);
  if (!entry) return null;
  const { id, nodeId } = entry;
  if (typeof id !== "string" || !id) return null;
  if (typeof nodeId !== "string" || !nodeId) return null;
  return { id, nodeId };
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
 * Narrow a saved field list, or report that there is nothing usable in it.
 *
 * `uiFields` dereferences `f.id` on every entry, so one `null` in an imported
 * `fields` list would fail the render and with it the whole resume. Each field
 * needs the id the value map is keyed on; `type`, `value` and `path` are
 * optional in practice, since an untyped field simply resolves to its value.
 */
function readFieldList(value: unknown): UiField[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const fields = value.filter((item): item is UiField => {
    const entry = asObject(item);
    return entry !== null && typeof entry.id === "string" && entry.id.length > 0;
  });
  return fields.length ? fields : undefined;
}

/**
 * Narrow one saved UI element, and everything nested inside it.
 *
 * An element is kept only if it has the one field the renderer and the dedupe
 * both dispatch on: a non-empty string `id`. Anything else is dropped rather
 * than cast, so a malformed entry in a hand-edited file costs that entry and
 * not the panel around it. Children and fields are narrowed the same way and in
 * turn, because `uiElement` reads `child.id` while resolving nested elements
 * and `uiFields` reads `f.id` — a malformed one in either list would take the
 * resume down with it.
 */
function readElement(value: unknown): UiElement | null {
  const entry = asObject(value);
  if (entry === null || typeof entry.id !== "string" || !entry.id) return null;
  const element = { ...entry, type: typeof entry.type === "string" ? entry.type : "" } as unknown as UiElement;
  const fields = readFieldList(entry.fields);
  if (fields) element.fields = fields;
  else delete element.fields;
  if (Array.isArray(entry.elements)) {
    const children = entry.elements.map(readElement).filter((child): child is UiElement => child !== null);
    if (children.length) element.elements = children;
    else delete element.elements;
  }
  return element;
}

function readElements(value: unknown): UiElement[] {
  if (!Array.isArray(value)) return [];
  return value.map(readElement).filter((element): element is UiElement => element !== null);
}

function readOverrides(value: unknown): UiOverrideMap {
  const source = asObject(value);
  if (!source) return {};
  const out: UiOverrideMap = {};
  for (const [id, override] of Object.entries(source)) {
    const entry = asObject(override);
    if (!entry) continue;
    // An override may carry a replacement field list, which `uiFields` walks
    // with the same `f.id` dereference as a declared one.
    const narrowed: Record<string, unknown> = { ...entry };
    const fields = readFieldList(entry.fields);
    if (fields) narrowed.fields = fields;
    // A list that yielded nothing usable is removed, not kept: the malformed
    // array is exactly what `uiFields` would walk. The id-to-value map form is
    // a different thing and survives, because it is not iterated as fields.
    else if (Array.isArray(entry.fields)) delete narrowed.fields;
    out[id] = narrowed as UiOverride;
  }
  return out;
}

function readTools(value: unknown): ToolRegistry {
  const entries = new Map<string, ToolEntry>();
  if (!Array.isArray(value)) return { entries };
  for (const item of value) {
    const entry = asObject(item);
    if (!entry) continue;
    // Checked the same way a live registration is, because `renderTools` slices
    // `definition.label` while painting: a definition that kept an id but lost
    // its label would fail the very resume this narrowing exists to protect. A
    // tool the player no longer has an authored definition for costs that tool.
    let definition: ToolDefinition;
    try {
      definition = normalizeTool(entry.definition);
    } catch {
      continue;
    }
    // Keyed off the definition's own id rather than the array position, so a
    // reordered export still restores the same registry.
    entries.set(definition.id, {
      definition,
      hidden: entry.hidden === true,
      disabled: entry.disabled === true,
      source: entry.source === "lua" ? "lua" : "yaml",
    });
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
    conversation: readConversation(source.conversation),
  };
}
