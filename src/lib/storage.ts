import { emptyHistory } from '../types';
import type { Attachment, Entry, PatientHistory } from '../types';

// This database is local to the current browser origin. It is not encrypted.
const DATABASE_NAME = 'symptom-trail-journal';
const DATABASE_VERSION = 1;
const ENTRIES_STORE = 'entries';
const SETTINGS_STORE = 'settings';
const HISTORY_KEY = 'patient-history';

function storageError(message: string, cause?: unknown): Error {
  return cause === undefined || cause === null
    ? new Error(message)
    : new Error(message, { cause });
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    let settled = false;

    const fail = (error: Error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    };

    try {
      if (typeof indexedDB === 'undefined') {
        throw new Error('IndexedDB is not available in this browser.');
      }
      request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      fail(storageError('Unable to access IndexedDB.', error));
      return;
    }

    request.onblocked = () => {
      // An open request cannot be cancelled directly. If the blocker goes away
      // later, abort its upgrade (or close its connection) rather than leaving
      // behind a live connection after reporting failure to the caller.
      fail(storageError('IndexedDB is blocked by another browser tab or connection.'));
    };
    request.onupgradeneeded = () => {
      if (settled) {
        try {
          request.transaction?.abort();
        } catch {
          // It may already have aborted.
        }
        try {
          request.result.close();
        } catch {
          // The connection may already have closed.
        }
        return;
      }
      try {
        const db = request.result;
        if (!db.objectStoreNames.contains(ENTRIES_STORE)) {
          db.createObjectStore(ENTRIES_STORE, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
          db.createObjectStore(SETTINGS_STORE);
        }
      } catch (error) {
        try {
          request.transaction?.abort();
        } catch {
          // The upgrade may already be aborting; retain the original error.
        }
        // Closing also prevents a failed upgrade from blocking a later retry.
        try {
          request.result.close();
        } catch {
          // Preserve the initialization error.
        }
        fail(storageError('Unable to initialize the journal database.', error));
      }
    };
    request.onerror = () => {
      fail(storageError('Unable to open the journal database.', request.error));
    };
    request.onsuccess = () => {
      const db = request.result;
      if (settled) {
        db.close();
        return;
      }
      settled = true;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

// A request's success does not mean its transaction committed. Resolve only
// on transaction completion; abort the whole transaction on any request error.
async function runTransaction<T>(
  stores: string[],
  mode: IDBTransactionMode,
  operation: (transaction: IDBTransaction) => IDBRequest<T>[],
): Promise<T[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    let transaction: IDBTransaction | undefined;
    let settled = false;
    let failure: Error | undefined;
    const results: T[] = [];
    let completedRequests = 0;
    let requestCount = 0;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      db.close();
      if (error) reject(error);
      else resolve(results);
    };

    try {
      transaction = db.transaction(stores, mode);
      const tx = transaction;
      tx.oncomplete = () => {
        if (failure || completedRequests !== requestCount) {
          finish(failure ?? storageError('The IndexedDB transaction did not complete all requests.'));
        } else {
          finish();
        }
      };
      tx.onerror = () => {
        failure ??= storageError('The IndexedDB transaction failed.', tx.error);
      };
      tx.onabort = () => {
        finish(failure ?? storageError('The IndexedDB transaction was aborted.', tx.error));
      };

      const requests = operation(tx);
      requestCount = requests.length;
      if (requestCount === 0) {
        throw new Error('A journal transaction must contain at least one request.');
      }
      requests.forEach((request, index) => {
        request.onsuccess = () => {
          results[index] = request.result;
          completedRequests += 1;
        };
        request.onerror = () => {
          failure ??= storageError('An IndexedDB request failed.', request.error);
          try {
            tx.abort();
          } catch {
            // A failed request may already have caused the transaction to abort.
          }
        };
      });
    } catch (error) {
      try {
        transaction?.abort();
      } catch {
        // Preserve the original synchronous error.
      }
      finish(storageError('Unable to run the journal transaction.', error));
    }
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isBlob(value: unknown): value is Blob {
  // Unlike instanceof, the native Blob method also accepts a Blob from another
  // browser realm while rejecting objects that merely imitate a Blob's shape.
  if (typeof Blob === 'undefined') return false;
  try {
    Blob.prototype.slice.call(value, 0, 0);
    return true;
  } catch {
    return false;
  }
}

function isAttachment(value: unknown): value is Attachment {
  return isRecord(value)
    && isId(value.id)
    && (value.kind === 'photo' || value.kind === 'audio')
    && typeof value.name === 'string'
    && typeof value.mimeType === 'string'
    && typeof value.capturedAt === 'string'
    && isBlob(value.blob);
}

function isEntry(value: unknown): value is Entry {
  return isRecord(value)
    && isId(value.id)
    && typeof value.symptom === 'string'
    && typeof value.details === 'string'
    && typeof value.startedAt === 'string'
    && (value.endedAt === null || typeof value.endedAt === 'string')
    && typeof value.ongoing === 'boolean'
    && (value.severity === null || (typeof value.severity === 'number' && Number.isFinite(value.severity)))
    && typeof value.impact === 'string'
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string'
    && Array.isArray(value.attachments)
    && value.attachments.every(isAttachment)
    && typeof value.demo === 'boolean';
}

function isHistory(value: unknown): value is PatientHistory {
  return isRecord(value)
    && typeof value.conditions === 'string'
    && typeof value.medications === 'string'
    && typeof value.tests === 'string'
    && typeof value.questions === 'string'
    && typeof value.bloodHistory === 'string'
    && typeof value.includeEsrNote === 'boolean';
}

export async function listEntries(): Promise<Entry[]> {
  const [records] = await runTransaction<unknown[]>([ENTRIES_STORE], 'readonly', tx => [
    tx.objectStore(ENTRIES_STORE).getAll(),
  ]);
  if (!Array.isArray(records) || !records.every(isEntry)) {
    throw new Error('The journal contains an invalid entry.');
  }
  return records;
}

export async function putEntry(entry: Entry): Promise<void> {
  if (!isEntry(entry)) throw new Error('Cannot save an invalid journal entry.');
  await runTransaction<IDBValidKey>([ENTRIES_STORE], 'readwrite', tx => {
    // Opening the database is asynchronous, so the caller might have mutated
    // the object since the initial check. Validate again at the actual write.
    if (!isEntry(entry)) throw new Error('Cannot save an invalid journal entry.');
    return [tx.objectStore(ENTRIES_STORE).put(entry)];
  });
}

export async function deleteEntry(id: string): Promise<void> {
  if (!isId(id)) throw new Error('Cannot delete an entry without a valid ID.');
  await runTransaction<undefined>([ENTRIES_STORE], 'readwrite', tx => [
    tx.objectStore(ENTRIES_STORE).delete(id),
  ]);
}

export async function readHistory(): Promise<PatientHistory> {
  const [records] = await runTransaction<unknown[]>([SETTINGS_STORE], 'readonly', tx => [
    tx.objectStore(SETTINGS_STORE).getAll(HISTORY_KEY),
  ]);
  if (records.length === 0) return { ...emptyHistory };
  if (records.length !== 1 || !isHistory(records[0])) {
    throw new Error('The stored patient history is invalid.');
  }
  return records[0];
}

export async function writeHistory(history: PatientHistory): Promise<void> {
  if (!isHistory(history)) throw new Error('Cannot save invalid patient history.');
  await runTransaction<IDBValidKey>([SETTINGS_STORE], 'readwrite', tx => {
    if (!isHistory(history)) throw new Error('Cannot save invalid patient history.');
    return [tx.objectStore(SETTINGS_STORE).put(history, HISTORY_KEY)];
  });
}

export async function clearJournal(): Promise<void> {
  await runTransaction<undefined>([ENTRIES_STORE, SETTINGS_STORE], 'readwrite', tx => [
    tx.objectStore(ENTRIES_STORE).clear(),
    tx.objectStore(SETTINGS_STORE).delete(HISTORY_KEY),
  ]);
}
