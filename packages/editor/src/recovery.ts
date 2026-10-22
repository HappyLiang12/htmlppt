/**
 * Unsaved-editor drafts live in IndexedDB so a crashed or reloaded tab can
 * offer its last dirty state. Host saves remain authoritative; a draft is
 * cleared as soon as a save succeeds.
 */
export interface DraftRecord {
  key: string;
  filePath: string;
  html: string;
  savedAt: number;
}

const DB_NAME = 'htmlppt-editor';
const DB_VERSION = 1;
const STORE = 'drafts';

let database: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null);
  }
  if (database) return database;
  database = new Promise<IDBDatabase | null>((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return database;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T | null> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve(true);
    transaction.onerror = () => resolve(false);
    transaction.onabort = () => resolve(false);
  });
}

/**
 * The same deck may arrive with either separator; normalize it so host and
 * standalone records of one file share a key. Case is preserved because the
 * editor has no reliable platform signal in the browser.
 */
export function draftKey(filePath: string): string {
  return filePath.trim().replace(/\\/g, '/');
}

export function hasUnsavedDraft(
  draft: DraftRecord | null,
  currentHtml: string
): draft is DraftRecord {
  return Boolean(draft && draft.html && draft.html !== currentHtml);
}

export async function readDraft(key: string): Promise<DraftRecord | null> {
  const db = await openDatabase();
  if (!db) return null;
  try {
    const transaction = db.transaction(STORE, 'readonly');
    const record = await requestResult<DraftRecord | undefined>(
      transaction.objectStore(STORE).get(key)
    );
    return record ?? null;
  } catch {
    return null;
  }
}

export async function listDrafts(): Promise<DraftRecord[]> {
  const db = await openDatabase();
  if (!db) return [];
  try {
    const transaction = db.transaction(STORE, 'readonly');
    const records = await requestResult<DraftRecord[]>(
      transaction.objectStore(STORE).getAll()
    );
    return (records ?? []).sort((first, second) => second.savedAt - first.savedAt);
  } catch {
    return [];
  }
}

export async function writeDraft(record: DraftRecord): Promise<boolean> {
  const db = await openDatabase();
  if (!db) return false;
  try {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(record);
    return await transactionDone(transaction);
  } catch {
    return false;
  }
}

export async function deleteDraft(key: string): Promise<boolean> {
  const db = await openDatabase();
  if (!db) return false;
  try {
    const transaction = db.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).delete(key);
    return await transactionDone(transaction);
  } catch {
    return false;
  }
}
