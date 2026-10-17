/* Durable, per-operation Plant write identities. No network or automatic replay. */
(function (root, factory) {
  const exported = factory();
  if (typeof module === 'object' && module.exports) module.exports = exported;
  else root.PMGPlantWrites = exported;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function canonical(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
    throw new Error('Plant request contains unsupported data. Nothing was sent.');
  }
  function scopeFor(kind, path, payload) {
    if (!['service', 'asset', 'identity'].includes(kind)) throw new Error('Unknown Plant write.');
    if (kind === 'service' && (path !== '/plant/service-events' || typeof payload.assetId !== 'string' || !payload.assetId.trim())) throw new Error('Plant service identity is missing.');
    if (kind === 'asset' && path !== '/plant/assets') throw new Error('Invalid Plant create route.');
    if (kind === 'identity' && !/^\/plant\/assets\/[^/]+$/.test(path)) throw new Error('Invalid Plant identity route.');
    return kind + ':' + (kind === 'service' ? payload.assetId : path);
  }
  function createIndexedStore(indexedDB) {
    let database;
    async function open() {
      if (!indexedDB) throw new Error('Durable storage unavailable. Nothing was sent.');
      if (!database) database = new Promise((resolve, reject) => {
        const request = indexedDB.open('pmg-plant-write-journal', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('writes', {keyPath: 'scope'});
        request.onerror = () => { database = null; reject(new Error('Durable storage unavailable. Nothing was sent.')); };
        request.onblocked = () => { database = null; reject(new Error('Close older Plant tabs to unlock durable storage. Nothing was sent.')); };
        request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      });
      return database;
    }
    return {
      async mutate(scope, change) {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction('writes', 'readwrite');
          const store = tx.objectStore('writes');
          const read = store.get(scope);
          let value, failure;
          read.onsuccess = () => {
            try { value = change(read.result || null); store.put(value); }
            catch (error) { failure = error; tx.abort(); }
          };
          tx.oncomplete = () => resolve(value);
          tx.onerror = tx.onabort = () => reject(failure || tx.error || new Error('Could not preserve the Plant request. Nothing was sent.'));
        });
      },
      async list() {
        const db = await open();
        return new Promise((resolve, reject) => {
          const tx = db.transaction('writes', 'readonly');
          const read = tx.objectStore('writes').getAll();
          tx.oncomplete = () => resolve(read.result || []);
          tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not read pending Plant requests.'));
        });
      }
    };
  }
  function createJournal(store, randomUUID) {
    return {
      async prepare(kind, path, method, payload, newIntent = false, intentToken = null) {
        if (method !== (kind === 'identity' ? 'PATCH' : 'POST')) throw new Error('Invalid Plant write method.');
        const scope = scopeFor(kind, path, payload);
        const fingerprint = canonical({kind, path, method, payload});
        return store.mutate(scope, previous => {
          if (previous) {
            if (previous.status === 'confirmed' && previous.fingerprint === fingerprint && !newIntent) return previous;
            if (previous.status === 'pending' && previous.fingerprint === fingerprint) return previous;
            if (previous.status === 'pending') throw new Error('A previous save for this item is still unconfirmed. Use Retry original below before changing it.');
          }
          if (typeof randomUUID !== 'function') throw new Error('Secure request identity unavailable. Nothing was sent.');
          return {scope, kind, path, method, payload: JSON.parse(JSON.stringify(payload)), fingerprint,
            requestId: randomUUID(), intentToken, status: 'pending', createdAt: new Date().toISOString()};
        });
      },
      async confirm(entry, receipt) {
        return store.mutate(entry.scope, previous => {
          if (!previous || previous.requestId !== entry.requestId || previous.fingerprint !== entry.fingerprint) throw new Error('Plant request identity changed.');
          return {...previous, status: 'confirmed', receipt, confirmedAt: new Date().toISOString()};
        });
      },
      async reject(entry, error) {
        return store.mutate(entry.scope, previous => {
          if (!previous || previous.requestId !== entry.requestId || previous.fingerprint !== entry.fingerprint) throw new Error('Plant request identity changed.');
          return {...previous,status:'rejected',error:String(error || 'Request rejected')};
        });
      },
      async pending() { return (await store.list()).filter(entry => entry.status === 'pending'); }
    };
  }
  return {canonical, scopeFor, createIndexedStore, createJournal};
});
