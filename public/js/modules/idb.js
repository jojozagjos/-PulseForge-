// public/js/modules/idb.js
// Tiny IndexedDB helper focused on persisting audio Blobs for the Editor.

class AudioStoreImpl {
  constructor() {
    this._dbp = null;
    this._dbName = 'pf-editor';
    this._storeName = 'audio';
  }

  async _open() {
    if (this._dbp) return this._dbp;
    this._dbp = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(this._dbName, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(this._storeName)) {
            db.createObjectStore(this._storeName, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      } catch (e) { reject(e); }
    });
    return this._dbp;
  }

  async put(id, blob, meta = {}) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this._storeName, 'readwrite');
        const store = tx.objectStore(this._storeName);
        const value = { id, blob, meta: { type: blob?.type || '', size: blob?.size || 0, savedAt: Date.now(), ...meta } };
        const req = store.put(value);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error || new Error('IndexedDB put failed'));
      } catch (e) { reject(e); }
    });
  }

  async get(id) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this._storeName, 'readonly');
        const store = tx.objectStore(this._storeName);
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error('IndexedDB get failed'));
      } catch (e) { reject(e); }
    });
  }

  async delete(id) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(this._storeName, 'readwrite');
        const store = tx.objectStore(this._storeName);
        const req = store.delete(id);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error || new Error('IndexedDB delete failed'));
      } catch (e) { reject(e); }
    });
  }
}

export const audioStore = new AudioStoreImpl();

// Utility: stable hex digest for ArrayBuffer (SHA-256)
export async function sha256Hex(arrayBuffer) {
  try {
    const digest = await crypto.subtle.digest('SHA-256', arrayBuffer);
    const bytes = new Uint8Array(digest);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Fallback: poor-man hash (not cryptographic)
    let h1 = 0x811c9dc5;
    const view = new Uint8Array(arrayBuffer);
    for (let i = 0; i < view.length; i++) { h1 ^= view[i]; h1 = (h1 + ((h1 << 1) + (h1 << 4) + (h1 << 7) + (h1 << 8) + (h1 << 24))) >>> 0; }
    return ('00000000' + h1.toString(16)).slice(-8);
  }
}
