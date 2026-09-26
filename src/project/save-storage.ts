import type { SaveFile, SaveRecord, SaveSnapshot } from "../types/index.ts";
import { DEFAULT_SAVE_SLOT, SAVE_FORMAT, SAVE_LIMITS, SAVE_VERSION } from "../types/save.ts";
import { openDatabase, request, SAVE_STORE, transactionDone } from "./db.ts";

/** Every save in the library, newest first — what the save manager lists. */
export async function listSaves(): Promise<SaveRecord[]> {
  const db = await openDatabase();
  try {
    const records = await request(
      db.transaction(SAVE_STORE, "readonly").objectStore(SAVE_STORE).getAll(),
    ) as SaveRecord[];
    return records.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  } finally {
    db.close();
  }
}

export async function getSave(projectId: string, slot: string = DEFAULT_SAVE_SLOT): Promise<SaveRecord | undefined> {
  const db = await openDatabase();
  try {
    return await request(db.transaction(SAVE_STORE, "readonly").objectStore(SAVE_STORE).get([projectId, slot])) as
      | SaveRecord
      | undefined;
  } finally {
    db.close();
  }
}

export async function putSave(record: SaveRecord): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(SAVE_STORE, "readwrite");
    transaction.objectStore(SAVE_STORE).put(record);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function deleteSave(projectId: string, slot: string = DEFAULT_SAVE_SLOT): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(SAVE_STORE, "readwrite");
    transaction.objectStore(SAVE_STORE).delete([projectId, slot]);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

/** Build the exported file body for a record. */
export function serializeSaveFile(record: SaveRecord): string {
  const file: SaveFile = { format: SAVE_FORMAT, saveVersion: SAVE_VERSION, record };
  return JSON.stringify(file, null, 2);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function asTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Read an exported save file back.
 *
 * The player picked this file, so it is untrusted: the size is bounded before
 * parsing and the envelope is checked rather than assumed. Only the envelope
 * and the record's own denormalized fields are validated here — the snapshot's
 * runtime fields are narrowed by `fromSnapshot`, so the two never disagree about
 * what a valid snapshot is.
 */
export function parseSaveFile(text: string): SaveRecord {
  if (text.length > SAVE_LIMITS.maxFileBytes) {
    throw new Error(`That save file is too large (limit ${Math.round(SAVE_LIMITS.maxFileBytes / 1024)} KB).`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new Error("That file is not valid JSON.");
  }
  const file = asObject(parsed);
  if (!file) throw new Error("That file is not an Inkforge save.");
  if (file.format !== SAVE_FORMAT) throw new Error("That file is not an Inkforge save.");
  if (file.saveVersion !== SAVE_VERSION) {
    throw new Error(`That save was written by a newer version of Inkforge (save v${String(file.saveVersion)}).`);
  }
  const record = asObject(file.record);
  const snapshot = asObject(record?.snapshot);
  if (!record || !snapshot) throw new Error("That save file is missing its game state.");
  const origin = asObject(record.origin);
  const parsedSnapshot = snapshot as unknown as SaveSnapshot;
  return {
    projectId: asString(record.projectId, ""),
    slot: asString(record.slot, DEFAULT_SAVE_SLOT),
    savedAt: asTimestamp(record.savedAt),
    location: asString(record.location, parsedSnapshot.location),
    scenarioVersion: asString(record.scenarioVersion, ""),
    scenarioHash: asString(record.scenarioHash, ""),
    snapshot: parsedSnapshot,
    origin: origin ? { projectId: asString(origin.projectId, ""), savedAt: asTimestamp(origin.savedAt) } : undefined,
  };
}
