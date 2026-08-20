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
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
}

/** Read a Uint8Array snapshot from IndexedDB, or null if none exists. */
function readSnapshot(idb: IDBDatabase, storeName: string, key: string): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const txn = idb.transaction(storeName, "readonly");
    const request = txn.objectStore(storeName).get(key);
    request.onsuccess = () => resolve(request.result ? new Uint8Array(request.result as ArrayBuffer) : null);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
  });
}

/** Write a Uint8Array snapshot to IndexedDB. */
function writeSnapshot(idb: IDBDatabase, storeName: string, key: string, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const txn = idb.transaction(storeName, "readwrite");
    const request = txn.objectStore(storeName).put(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB write failed"));
  });
}

const IDB_STORE = "snapshots";

/** The local mirror is single-owner; another tab already holds it. Not an
 * error condition for the user — the app reads from the server instead. */
export class MirrorHeldByAnotherTab extends Error {
  constructor() {
    super("The offline copy is open in another tab");
    this.name = "MirrorHeldByAnotherTab";
  }
}

export async function pickBackend(sqlite3: any): Promise<{
  kind: "opfs" | "idb";
  openDb(name: string): Promise<any>;
  persist(db: any): Promise<void>;
  destroy(name: string): Promise<void>;
}> {
  // Tier 1: OPFS-sahpool — needs SyncAccessHandle (worker context) but NOT COOP/COEP.
  if (sqlite3.installOpfsSAHPoolVfs) {
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({ name: "doota-localdb" });
      return {
        kind: "opfs",
        openDb: async (name: string) => new pool.OpfsSAHPoolDb(`/${name}.sqlite3`),
        persist: async () => {},
        async destroy(name: string) {
          // ponytail: unlink returns false if not found — both outcomes are fine here
          try { pool.unlink(`/${name}.sqlite3`); } catch { /* missing = ok */ }
        },
      };
    } catch (err) {
      // A second tab is the common case here: SAH-pool needs an exclusive
      // SyncAccessHandle, so the loser throws NoModificationAllowedError.
      //
      // Falling through to the IndexedDB tier was wrong for that case. The
      // leader's data lives in OPFS, so the follower got an EMPTY database,
      // then re-seeded into it and raced the leader — a silent downgrade that
      // looked like data loss. Refusing instead leaves localReady false, and
      // the app renders from the server, which is correct and honest.
      //
      // Any other failure (no OPFS support at all) still earns the IDB tier.
      // ponytail: error-name sniffing. A navigator.locks leader election would
      // be deterministic; do that if the names ever shift under us.
      const name = (err as { name?: string } | null)?.name ?? "";
      if (name === "NoModificationAllowedError" || name === "InvalidStateError") {
        throw new MirrorHeldByAnotherTab();
      }
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
    async destroy(name: string) {
      await new Promise<void>((resolve, reject) => {
        const txn = idb.transaction(IDB_STORE, "readwrite");
        const req = txn.objectStore(IDB_STORE).delete(name);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    },
  };
}
