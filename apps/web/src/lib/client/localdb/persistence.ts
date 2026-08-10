// SPDX-License-Identifier: Apache-2.0
// Prefer OPFS-sahpool (incremental, no manual snapshot). Fall back to the memory
// VFS + a debounced full-DB snapshot into IndexedDB (universal). Both return an
// oo1.DB; the caller's SQL is identical.

/** Open the named IndexedDB database and object store, returning the db handle. */
function openIdb(dbName: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Read a Uint8Array snapshot from IndexedDB, or null if none exists. */
function readSnapshot(idb: IDBDatabase, storeName: string, key: string): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const txn = idb.transaction(storeName, "readonly");
    const request = txn.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result ? new Uint8Array(request.result as ArrayBuffer) : null);
    request.onerror = () => reject(request.error);
  });
}

/** Write a Uint8Array snapshot to IndexedDB. */
function writeSnapshot(idb: IDBDatabase, storeName: string, key: string, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const txn = idb.transaction(storeName, "readwrite");
    const request = txn.objectStore(storeName).put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const IDB_STORE = "snapshots";

export async function pickBackend(sqlite3: any): Promise<{
  kind: "opfs" | "idb";
  openDb(name: string): Promise<any>;
  persist(db: any): Promise<void>;
}> {
  // Tier 1: OPFS-sahpool — needs SyncAccessHandle (worker context) but NOT COOP/COEP.
  if (sqlite3.installOpfsSAHPoolVfs) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "doota-localdb" });
      return {
        kind: "opfs",
        openDb: async (name: string) => new pool.OpfsSAHPoolDb(`/${name}.sqlite3`),
        persist: async () => {},
      };
    } catch {
      // fall through to IDB tier
    }
  }

  // Tier 2: memory VFS + IndexedDB snapshot.
  // openDb is async because we must deserialize the snapshot before first query.
  const idb = await openIdb("doota-localdb", IDB_STORE);
  return {
    kind: "idb",
    async openDb(name: string) {
      const db = new sqlite3.oo1.DB(":memory:", "c");
      const snap = await readSnapshot(idb, IDB_STORE, name);
      if (snap && snap.length > 0) {
        // ponytail: SQLITE_DESERIALIZE_RESIZEABLE=1, SQLITE_DESERIALIZE_FREEONCLOSE=2
        sqlite3.capi.sqlite3_deserialize(db.pointer, "main", snap, snap.length, snap.length, 1 | 2);
      }
      (db as any).__idbKey = name;
      return db;
    },
    async persist(db: any) {
      const bytes: Uint8Array = sqlite3.capi.sqlite3_js_db_export(db.pointer ?? db);
      await writeSnapshot(idb, IDB_STORE, (db as any).__idbKey, bytes);
    },
  };
}
