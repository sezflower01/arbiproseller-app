/**
 * IndexedDB-based persistence for inventory data.
 * Stores the full inventory result so it can be shown instantly
 * on page load before the background refresh from Supabase completes.
 */

const DB_NAME = "arbi_inventory_cache";
const DB_VERSION = 1;
const STORE_NAME = "inventory";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getInventoryCache(userId: string): Promise<{ data: any[]; timestamp: number } | null> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(userId);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function setInventoryCache(userId: string, data: any[]): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put({ data, timestamp: Date.now() }, userId);
  } catch (e) {
    console.warn("Failed to write inventory cache:", e);
  }
}

export async function clearInventoryCache(userId: string): Promise<void> {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(userId);
  } catch {
    // ignore
  }
}
