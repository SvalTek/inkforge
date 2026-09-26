import type { ProjectData, RawProjectData } from "../types/index.ts";
import { normalizeProject } from "./project.ts";
import { deleteSavesIn, openDatabase, PROJECT_STORE, request, SAVE_STORE, transactionDone } from "./db.ts";

const ACTIVE_KEY = "inkforge-active-project-v2";
const LEGACY_KEY = "inkforge-project-v1";

export async function listProjects(): Promise<ProjectData[]> {
  const db = await openDatabase();
  try {
    return await request(
      db.transaction(PROJECT_STORE, "readonly").objectStore(PROJECT_STORE).getAll(),
    ) as ProjectData[];
  } finally {
    db.close();
  }
}

export async function getProject(id: string): Promise<ProjectData | undefined> {
  const db = await openDatabase();
  try {
    return await request(db.transaction(PROJECT_STORE, "readonly").objectStore(PROJECT_STORE).get(id)) as
      | ProjectData
      | undefined;
  } finally {
    db.close();
  }
}

export async function putProject(project: ProjectData): Promise<void> {
  const db = await openDatabase();
  try {
    const transaction = db.transaction(PROJECT_STORE, "readwrite");
    transaction.objectStore(PROJECT_STORE).put(project);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export async function saveProject(project: ProjectData): Promise<void> {
  project.updatedAt = Date.now();
  await putProject(project);
  setActiveProjectId(project.identity.id);
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDatabase();
  try {
    // One transaction, so a project and its saves can never end up half-deleted:
    // a surviving save pointing at a project that no longer exists is unreachable
    // state, and the slot it would occupy would look taken in any future re-import.
    const transaction = db.transaction([PROJECT_STORE, SAVE_STORE], "readwrite");
    transaction.objectStore(PROJECT_STORE).delete(id);
    deleteSavesIn(transaction, id);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

export function activeProjectId(): string | null {
  return localStorage.getItem(ACTIVE_KEY);
}

export function setActiveProjectId(id: string): void {
  localStorage.setItem(ACTIVE_KEY, id);
}

function readLegacy(): RawProjectData | null {
  const saved = localStorage.getItem(LEGACY_KEY);
  if (!saved) return null;
  try {
    return JSON.parse(saved) as RawProjectData;
  } catch {
    return null;
  }
}

export async function migrateLegacyProject(): Promise<ProjectData | null> {
  const legacy = readLegacy();
  if (!legacy) return null;
  const project = normalizeProject({
    ...legacy,
    identity: { id: "migrated-local-project", title: "Migrated Adventure", version: "0.1.0" },
  });
  await putProject(project);
  localStorage.removeItem(LEGACY_KEY);
  setActiveProjectId(project.identity.id);
  return project;
}
