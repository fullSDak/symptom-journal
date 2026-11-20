import { IDBDatabase, IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyHistory } from '../types';
import type { Entry, PatientHistory } from '../types';
import { clearJournal, deleteEntry, listEntries, putEntry, readHistory, writeHistory } from './storage';

const DATABASE_NAME = 'symptom-trail-journal';

function entry(id = 'entry-1'): Entry {
  return {
    id,
    symptom: 'Fictional headache',
    details: 'Example only',
    startedAt: '2026-01-01T09:00',
    endedAt: null,
    ongoing: true,
    severity: 3,
    impact: 'Rested',
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: '2026-01-01T09:00:00.000Z',
    attachments: [],
    demo: true,
  };
}

const history: PatientHistory = {
  conditions: 'Example condition',
  medications: 'Example medication',
  tests: 'Example test',
  questions: 'Example question',
  bloodHistory: 'Example history',
  includeEsrNote: true,
};

function openRawDatabase(name = DATABASE_NAME, version = 1): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

function done(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('failed'));
  });
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('journal storage', () => {
  it('creates, lists, updates, and deletes entries', async () => {
    expect(await listEntries()).toEqual([]);
    await putEntry(entry('a'));
    await putEntry(entry('b'));
    await putEntry({ ...entry('a'), details: 'Updated' });
    expect(await listEntries()).toEqual([
      { ...entry('a'), details: 'Updated' },
      entry('b'),
    ]);
    await deleteEntry('a');
    await deleteEntry('missing');
    expect(await listEntries()).toEqual([entry('b')]);
  });

  it('persists photo and audio Blobs, their bytes, metadata, and types', async () => {
    const photo = new Blob([new Uint8Array([0, 42, 255])], { type: 'image/png' });
    const audio = new Blob(['fictional audio'], { type: 'audio/webm' });
    const original: Entry = {
      ...entry(),
      attachments: [
        { id: 'photo', kind: 'photo', name: 'example.png', mimeType: 'image/png', capturedAt: '2026-01-01', blob: photo },
        { id: 'audio', kind: 'audio', name: 'example.webm', mimeType: 'audio/webm', capturedAt: '2026-01-02', blob: audio },
      ],
    };
    await putEntry(original);
    const [saved] = await listEntries();
    expect(saved.attachments.map(({ blob, ...metadata }) => metadata)).toEqual(
      original.attachments.map(({ blob, ...metadata }) => metadata),
    );
    expect(saved.attachments[0].blob.type).toBe('image/png');
    expect(Array.from(new Uint8Array(await saved.attachments[0].blob.arrayBuffer()))).toEqual([0, 42, 255]);
    expect(saved.attachments[1].blob.type).toBe('audio/webm');
    expect(await saved.attachments[1].blob.text()).toBe('fictional audio');
  });

  it('returns independent empty history defaults and saves replacements', async () => {
    const first = await readHistory();
    expect(first).toEqual(emptyHistory);
    first.conditions = 'local mutation';
    expect(await readHistory()).toEqual(emptyHistory);
    await writeHistory(history);
    expect(await readHistory()).toEqual(history);
    await writeHistory({ ...history, questions: 'Updated question' });
    expect((await readHistory()).questions).toBe('Updated question');
  });

  it('clears entries and history atomically without clearing unrelated keys or databases', async () => {
    await putEntry(entry());
    await writeHistory(history);
    const journal = await openRawDatabase();
    const addOtherSetting = journal.transaction('settings', 'readwrite');
    addOtherSetting.objectStore('settings').put('keep', 'unrelated-setting');
    await done(addOtherSetting);
    journal.close();

    const other = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('another-application', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('data');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    const putOther = other.transaction('data', 'readwrite');
    putOther.objectStore('data').put('keep', 'key');
    await done(putOther);
    other.close();

    await clearJournal();
    expect(await listEntries()).toEqual([]);
    expect(await readHistory()).toEqual(emptyHistory);
    const journalAfter = await openRawDatabase();
    const tx = journalAfter.transaction('settings');
    const settingRequest = tx.objectStore('settings').get('unrelated-setting');
    const settingDone = done(tx);
    await settingDone;
    expect(settingRequest.result).toBe('keep');
    journalAfter.close();
    const otherAfter = await openRawDatabase('another-application');
    const otherTx = otherAfter.transaction('data');
    const otherRequest = otherTx.objectStore('data').get('key');
    await done(otherTx);
    expect(otherRequest.result).toBe('keep');
    otherAfter.close();
  });

  it('rejects malformed inputs rather than persisting them', async () => {
    await expect(putEntry({ ...entry(), id: '' })).rejects.toThrow(/invalid/i);
    await expect(putEntry({ ...entry(), severity: NaN })).rejects.toThrow(/invalid/i);
    await expect(putEntry({ ...entry(), attachments: [{ id: 'p', kind: 'photo', name: 'x', mimeType: 'image/png', capturedAt: '', blob: {} as Blob }] })).rejects.toThrow(/invalid/i);
    await expect(deleteEntry('  ')).rejects.toThrow(/valid ID/i);
    await expect(writeHistory({ ...history, includeEsrNote: 'yes' } as unknown as PatientHistory)).rejects.toThrow(/invalid/i);
    expect(await listEntries()).toEqual([]);
    expect(await readHistory()).toEqual(emptyHistory);
  });

  it('rejects invalid records already present in the database', async () => {
    await putEntry(entry());
    const db = await openRawDatabase();
    let tx = db.transaction('entries', 'readwrite');
    tx.objectStore('entries').put({ id: 'bad', symptom: 12 });
    await done(tx);
    await expect(listEntries()).rejects.toThrow(/invalid entry/i);
    tx = db.transaction('settings', 'readwrite');
    tx.objectStore('settings').put({ conditions: 'incomplete' }, 'patient-history');
    await done(tx);
    db.close();
    await expect(readHistory()).rejects.toThrow(/invalid/i);
    const dbAgain = await openRawDatabase();
    const undefinedTx = dbAgain.transaction('settings', 'readwrite');
    undefinedTx.objectStore('settings').put(undefined, 'patient-history');
    await done(undefinedTx);
    dbAgain.close();
    await expect(readHistory()).rejects.toThrow(/invalid/i);
  });

  it('revalidates objects mutated while the database is opening', async () => {
    const changingEntry = entry();
    const pendingEntry = putEntry(changingEntry);
    changingEntry.id = '';
    await expect(pendingEntry).rejects.toThrow();
    expect(await listEntries()).toEqual([]);

    const changingHistory = { ...history };
    const pendingHistory = writeHistory(changingHistory);
    (changingHistory as unknown as { includeEsrNote: unknown }).includeEsrNote = 'invalid';
    await expect(pendingHistory).rejects.toThrow();
    expect(await readHistory()).toEqual(emptyHistory);
  });

  it('reports missing, denied, and newer-version IndexedDB errors', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(listEntries()).rejects.toThrow(/IndexedDB/i);
    vi.stubGlobal('indexedDB', { open: () => { throw new DOMException('Denied', 'SecurityError'); } });
    await expect(readHistory()).rejects.toThrow(/IndexedDB/i);
    vi.stubGlobal('indexedDB', new IDBFactory());
    const newer = await openRawDatabase(DATABASE_NAME, 2);
    newer.close();
    await expect(listEntries()).rejects.toThrow(/open/i);
  });

  it('aborts a failed database initialization and allows a later retry', async () => {
    const schemaSpy = vi.spyOn(IDBDatabase.prototype, 'createObjectStore').mockImplementationOnce(() => {
      throw new DOMException('Cannot initialize', 'UnknownError');
    });
    await expect(listEntries()).rejects.toThrow(/initialize/i);
    schemaSpy.mockRestore();
    expect(await listEntries()).toEqual([]);
  });

  it('rejects a synchronous cloning error instead of reporting a write', async () => {
    const uncloneable = { ...entry(), extra: () => 'not cloneable' };
    await expect(putEntry(uncloneable)).rejects.toThrow(/transaction/i);
    expect(await listEntries()).toEqual([]);
  });

  it('rejects blocked opens and aborts any later upgrade or closes a late success', async () => {
    const abort = vi.fn();
    const close = vi.fn();
    const request = {
      transaction: { abort },
      result: { close },
      onblocked: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
    } as unknown as IDBOpenDBRequest;
    vi.spyOn(indexedDB, 'open').mockReturnValue(request);
    const pending = listEntries();
    request.onblocked?.call(request, new Event('blocked') as IDBVersionChangeEvent);
    await expect(pending).rejects.toThrow(/blocked/i);
    request.onupgradeneeded?.call(request, new Event('upgradeneeded') as IDBVersionChangeEvent);
    expect(abort).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    request.onsuccess?.call(request, new Event('success'));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('does not report a request as saved if its transaction subsequently aborts', async () => {
    const originalPut = IDBObjectStore.prototype.put;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      const request = originalPut.call(this, value, key);
      request.addEventListener('success', () => this.transaction.abort(), { once: true });
      return request;
    });
    await expect(putEntry(entry())).rejects.toThrow(/abort/i);
    putSpy.mockRestore();
    expect(await listEntries()).toEqual([]);
  });

  it('rejects asynchronous IndexedDB request errors without overwriting data', async () => {
    await putEntry(entry());
    const originalAdd = IDBObjectStore.prototype.add;
    const putSpy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
      return originalAdd.call(this, value, key);
    });
    await expect(putEntry({ ...entry(), details: 'should not be saved' })).rejects.toThrow(/failed/i);
    putSpy.mockRestore();
    expect(await listEntries()).toEqual([entry()]);
  });

  it('rolls back both stores if a clear transaction aborts', async () => {
    await putEntry(entry());
    await writeHistory(history);
    const originalClear = IDBObjectStore.prototype.clear;
    const clearSpy = vi.spyOn(IDBObjectStore.prototype, 'clear').mockImplementation(function (this: IDBObjectStore) {
      const request = originalClear.call(this);
      request.addEventListener('success', () => this.transaction.abort(), { once: true });
      return request;
    });
    await expect(clearJournal()).rejects.toThrow(/abort|failed/i);
    clearSpy.mockRestore();
    expect(await listEntries()).toEqual([entry()]);
    expect(await readHistory()).toEqual(history);
  });
});
