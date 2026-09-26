/**
 * The one IndexedDB connection shared by the project library and the save store.
 *
 * Both live in the same database on purpose: a save belongs to a project, so
 * deleting a project has to be able to reach its saves in the same transaction.
 * Splitting them across two databases would make that cascade impossible to
 * make atomic.
 */

export const DB_NAME = "inkforge-project-library";
export const DB_VERSION = 2;
export const PROJECT_STORE = "projects";
export const SAVE_STORE = "saves";
/** Index for "every slot belonging to this project", which the save manager lists. */
export const SAVE_PROJECT_INDEX = "byProject";

export function request<T>(operation: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error || new Error("IndexedDB request failed"));
  });
}

export function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => {
      const db = open.result;
      if (!db.objectStoreNames.contains(PROJECT_STORE)) {
        db.createObjectStore(PROJECT_STORE, { keyPath: "identity.id" });
      }
      if (!db.objectStoreNames.contains(SAVE_STORE)) {
        // A compound key rather than a synthetic string: the slot is part of the
        // record's identity, and the index below is what makes "this project's
        // saves" a single lookup instead of a full scan.
        const store = db.createObjectStore(SAVE_STORE, { keyPath: ["projectId", "slot"] });
        store.createIndex(SAVE_PROJECT_INDEX, "projectId", { unique: false });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error || new Error("Could not open scenario library"));
  });
}

/** Delete a project's saves inside a transaction the caller already owns. */
export function deleteSavesIn(transaction: IDBTransaction, projectId: string): void {
  const index = transaction.objectStore(SAVE_STORE).index(SAVE_PROJECT_INDEX);
  const cursorRequest = index.openKeyCursor(IDBKeyRange.only(projectId));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    transaction.objectStore(SAVE_STORE).delete(cursor.primaryKey);
    cursor.continue();
  };
}
