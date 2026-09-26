import type { ProjectData, RawProjectData } from "../types/index.ts";
import { normalizeProject } from "./project.ts";

const DB_NAME = "inkforge-project-library";
const DB_VERSION = 1;
const STORE_NAME = "projects";
const ACTIVE_KEY = "inkforge-active-project-v2";
const LEGACY_KEY = "inkforge-project-v1";

function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      if (!open.result.objectStoreNames.contains(STORE_NAME)) {
        open.result.createObjectStore(STORE_NAME, { keyPath: "identity.id" });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error || new Error("Could not open scenario library"));
  });
}

export async function listProjects(): Promise<ProjectData[]> {
  const db = await database();
  try {
    return await request(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll()) as ProjectData[];
  } finally {
    db.close();
  }
}

export async function getProject(id: string): Promise<ProjectData | undefined> {
  const db = await database();
  try {
    return await request(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id)) as
      | ProjectData
      | undefined;
  } finally {
    db.close();
  }
}

export async function putProject(project: ProjectData): Promise<void> {
  const db = await database();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(project);
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
  const db = await database();
  try {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(id);
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
