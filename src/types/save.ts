import type { EngineEvent } from "./events.ts";
import type { ConversationState } from "./engine.ts";
import type { ModalRuntimeState, ToolEntry, ToolRegistry } from "./tools.ts";
import type { UiElement, UiOverrideMap, UiRuntimeState } from "./ui.ts";

/** Discriminator and version for an exported save file, mirroring the pack envelope. */
export const SAVE_FORMAT = "inkforge-save" as const;
export const SAVE_VERSION = 1 as const;

/**
 * The single manual slot a project starts with.
 *
 * One slot per project, keyed `${projectId}:${slot}` — so a save belongs to the
 * scenario it was made in and another scenario's save is never in the way. The
 * slot stays part of the key rather than being assumed so a future autosave or
 * per-chapter slot is additive instead of a migration.
 */
export const DEFAULT_SAVE_SLOT = "manual";

/**
 * Ceilings for an imported file.
 *
 * An imported save is untrusted input from a file the player chose, so it is
 * bounded before it is parsed. Two mebibytes is far above a real snapshot — the
 * transcript is capped, and 200 entries of authored prose is tens of kilobytes
 * — while still refusing a file that would be read into memory wholesale.
 */
export const SAVE_LIMITS = { maxFileBytes: 2 * 1024 * 1024 } as const;

/**
 * The serializable projection of an engine runtime.
 *
 * Everything a resume needs and nothing it cannot rebuild: the Lua VM, canvas
 * scenes, timers and animation handles are absent by design, because a fresh
 * boot reconstructs them from the authored scenario and script.
 */
export interface SaveSnapshot {
  location: string;
  state: Record<string, unknown>;
  inventory: string[];
  events: EngineEvent[];
  droppedEvents: number;
  over: boolean;
  ui: { hidden: string[]; overrides: UiOverrideMap; elements: UiElement[] };
  tools: ToolEntry[];
  modals: ModalRuntimeState;
  conversation: ConversationState | null;
}

/**
 * A snapshot brought back to live form.
 *
 * Deliberately distinct from {@link SaveSnapshot}: the two differ exactly where
 * the engine cares — a `Set` rather than an array, a registry rather than a
 * list — so a conversion mistake cannot hide behind a shared type.
 */
export interface ResumedRuntime {
  location: string;
  state: Record<string, unknown>;
  inventory: string[];
  events: EngineEvent[];
  droppedEvents: number;
  over: boolean;
  ui: UiRuntimeState;
  tools: ToolRegistry;
  modals: ModalRuntimeState;
  conversation: ConversationState | null;
}

/** One stored save. The library holds at most one of these per project and slot. */
export interface SaveRecord {
  projectId: string;
  slot: string;
  savedAt: number;
  /** Denormalized for the save manager list, so it need not read the snapshot. */
  location: string;
  /** Scenario identity at save time, used to warn when the scenario has moved on. */
  scenarioVersion: string;
  scenarioHash: string;
  snapshot: SaveSnapshot;
  /**
   * Set when the record arrived from an export file rather than from play.
   *
   * An import is re-keyed onto the project the player is in, so this is the
   * only remaining record of where the save actually came from.
   */
  origin?: { projectId: string; savedAt: number };
}

/**
 * The exported file envelope.
 *
 * Not a bare dump of the snapshot: a versionless blob would have to be guessed
 * at on the way back in, and this matches the `format`/`packVersion` convention
 * in `types/project.ts` so save files and project packs fail the same way when
 * they are newer than the app.
 */
export interface SaveFile {
  format: typeof SAVE_FORMAT;
  saveVersion: typeof SAVE_VERSION;
  record: SaveRecord;
}

/** The storage key for one slot of one project. */
export function saveKey(projectId: string, slot: string = DEFAULT_SAVE_SLOT): string {
  return `${projectId}:${slot}`;
}

/** A filesystem-safe stem for an exported save, e.g. `lantern-below-2026-09-26`. */
export function saveFileStem(projectTitle: string, savedAt: number): string {
  const slug = projectTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "save";
  const stamp = new Date(savedAt).toISOString().slice(0, 10);
  return `${slug}-${stamp}`;
}
