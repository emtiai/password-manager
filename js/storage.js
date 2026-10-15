// Minimaler IndexedDB-Wrapper. Gespeichert wird ausschließlich der verschlüsselte Tresor.

const DB_NAME = 'pw-tresor';
const STORE = 'kv';
const VAULT_KEY = 'vault';

let dbPromise;

function openDb() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const loadVault = () => tx('readonly', (s) => s.get(VAULT_KEY));
export const storeVault = (record) => tx('readwrite', (s) => s.put(record, VAULT_KEY));
export const deleteVault = () => tx('readwrite', (s) => s.delete(VAULT_KEY));

// Bittet den Browser, die Daten nicht bei Speicherknappheit zu löschen.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      return await navigator.storage.persist();
    }
    return true;
  } catch {
    return false;
  }
}
