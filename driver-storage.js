/* Recover localStorage headroom without discarding pending work. Old, ordinary
 * job caches are copied byte-for-byte to IndexedDB, committed and read back
 * before their unchanged localStorage copy may be removed. No network writes. */
(function (root) {
  'use strict';
  const DB_NAME = 'pmg-driver-cache-archive-v1';
  const STORE = 'snapshots';
  const HELP = 'Phone app storage is full or unavailable. Keep this form open; ask the office for Storage recovery. Do not clear app data.';
  function quota(error) {
    return error?.name === 'QuotaExceededError' || error?.name === 'NS_ERROR_DOM_QUOTA_REACHED' || error?.code === 22 || error?.code === 1014;
  }
  function keys(storage) {
    return Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter(Boolean);
  }
  function parse(raw, fallback) {
    if (raw === null) return fallback;
    try { return JSON.parse(raw); } catch { return undefined; }
  }
  function pendingForDate(storage, date) {
    const queue = parse(storage.getItem('pmg_writeback_queue_' + date), []);
    const retry = parse(storage.getItem('pmg_retry_queue'), []);
    if (!Array.isArray(queue) || !Array.isArray(retry)) return true;
    if (queue.some(row => !row || row.state !== 'written')) return true;
    if (retry.some(row => !row || row.date === date || !row.date)) return true;
    return keys(storage).some(key => key.startsWith('pmg_backup_operation_' + date + '_') || key === 'pmg_backup_problem_' + date);
  }
  function eligible(storage, key, today) {
    const match = /^pmg_local_jobs_(\d{4}-\d{2}-\d{2})$/.exec(key);
    if (!match || match[1] >= today || pendingForDate(storage, match[1])) return false;
    const rows = parse(storage.getItem(key), null);
    if (!Array.isArray(rows) || !rows.length) return false;
    return rows.every(row => row && typeof row === 'object' && !Array.isArray(row) &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(row.id || '')) &&
      !row._driverAdded && !row.driverAdded && !row.addedBy && !row.createdBy &&
      !/^driver-|^local-/i.test(String(row.movementId || row._movementId || '')) &&
      !row.proofReceipt && !row._proofReceipt && !row.attachments && !row._attachments &&
      (!row.haultechWriteState || row.haultechWriteState === 'written') &&
      (!row._haultechWriteState || row._haultechWriteState === 'written'));
  }
  function openArchive(indexedDB = root.indexedDB) {
    return new Promise((resolve, reject) => {
      if (!indexedDB) return reject(new Error('Local archive unavailable'));
      const request = indexedDB.open(DB_NAME, 1);
      let settled = false;
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onerror = () => { settled = true; reject(request.error || new Error('Local archive unavailable')); };
      request.onblocked = () => { settled = true; reject(new Error('Local archive blocked; close the other recovery tab and retry')); };
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve({
          put(record) {
            return new Promise((done, fail) => {
              const tx = db.transaction(STORE, 'readwrite');
              tx.objectStore(STORE).put(record);
              tx.oncomplete = () => done();
              tx.onabort = tx.onerror = () => fail(tx.error || new Error('Archive save failed'));
            });
          },
          get(id) {
            return new Promise((done, fail) => {
              const tx = db.transaction(STORE, 'readonly');
              const request = tx.objectStore(STORE).get(id);
              tx.oncomplete = () => done(request.result);
              tx.onabort = tx.onerror = () => fail(tx.error || new Error('Archive verification failed'));
            });
          },
          close() { db.close(); },
        });
      };
    });
  }
  async function archiveOne(storage, archive, key, today) {
    if (!eligible(storage, key, today)) return 0;
    const raw = storage.getItem(key);
    // A unique ID preserves every revision, including interrupted attempts.
    const id = root.crypto.randomUUID();
    const record = { id, key, raw, archivedAt: new Date().toISOString(), reason: 'old ordinary job cache; storage headroom' };
    await archive.put(record);
    const verified = await archive.get(id);
    if (verified?.id !== id || verified?.key !== key || verified?.raw !== raw) throw new Error('Archive did not match; original cache retained');
    // Recheck after async work: never remove another tab's newer edit or queue.
    if (storage.getItem(key) !== raw || !eligible(storage, key, today)) return 0;
    storage.removeItem(key);
    return raw.length * 2;
  }
  // Active snapshots have a stable lookup key. Older app tabs can still see their
  // inline copy of today's work. If one changes it, keep both versions for review.
  function jobKey(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid job snapshot date');
    return 'pmg_local_jobs_' + date;
  }
  async function withJobStore(date, action) {
    const key = jobKey(date);
    async function access() {
      const db = await openArchive();
      try { return await action(root.localStorage, db, key); }
      finally { db.close(); }
    }
    return root.navigator?.locks ? root.navigator.locks.request('pmg-job-store:' + key, access) : access();
  }
  function activeValue(record, inline) {
    if (!record) return inline;
    if (typeof record.raw !== 'string' || (inline !== null && inline !== record.inline)) {
      throw new Error('Another app version changed this saved day. Both copies are retained for the office.');
    }
    return record.raw;
  }
  async function readJobRaw(date) {
    return withJobStore(date, async (storage, db, key) =>
      activeValue(await db.get('active:' + key), storage.getItem(key)));
  }
  async function saveVerified(db, record) {
    await db.put(record);
    const check = await db.get(record.id);
    if (!check || check.key !== record.key || check.raw !== record.raw ||
        check.inline !== record.inline) {
      throw new Error('Phone archive verification failed. Keep this screen open.');
    }
  }
  async function writeJobRaw(date, raw, expected) {
    return withJobStore(date, async (storage, db, key) => {
      const id = 'active:' + key;
      const record = await db.get(id);
      const inline = storage.getItem(key);
      const current = activeValue(record, inline);
      if (expected !== undefined && current !== expected) return false;
      if (current === raw) return true;
      if (!record) {
        try { storage.setItem(key, raw); return true; }
        catch (error) { if (!quota(error)) throw error; }
      }
      if (!root.navigator?.locks) throw new Error(HELP);
      await saveVerified(db, { id, key, raw, inline });
      if (storage.getItem(key) !== inline) throw new Error('The phone copy changed during backup. Both copies are retained.');
      return true;
    });
  }
  async function movePastJobDay(date, today) {
    if (date >= today) return 0;
    return withJobStore(date, async (storage, db, key) => {
      const id = 'active:' + key;
      const record = await db.get(id);
      const inline = storage.getItem(key);
      if (!inline || !Array.isArray(parse(inline, null))) return 0;
      const raw = activeValue(record, inline);
      // Preserve the exact inline revision too if an overflow save superseded it.
      if (raw !== inline) {
        await saveVerified(db, { id: root.crypto.randomUUID(), key, raw: inline, reason: 'previous inline day' });
      }
      await saveVerified(db, { id, key, raw, inline });
      if (storage.getItem(key) !== inline) return 0;
      storage.removeItem(key);
      return inline.length * 2;
    });
  }
  async function ensureSpace({ storage = root.localStorage, today, reserveChars = 128 * 1024, archiveFactory = openArchive, activeJobs = false } = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today || '')) throw new Error('Storage recovery requires the work date');
    const probeKey = 'pmg_storage_probe_' + root.crypto.randomUUID();
    const probe = () => {
      try { storage.setItem(probeKey, '0'.repeat(reserveChars)); return true; }
      catch (error) { if (quota(error)) return false; throw error; }
      finally { storage.removeItem(probeKey); }
    };
    let archive;
    let archivedCaches = 0, freedBytes = 0;
    try {
      if (probe()) return { ok: true, archivedCaches, freedBytes };
      if (activeJobs && root.navigator?.locks) {
        // Only date-scoped job lists move. Drafts, proof and retry journals keep
        // their existing keys. Every job list remains readable by date in the app.
        const days = keys(storage).filter(key => /^pmg_local_jobs_\d{4}-\d{2}-\d{2}$/.test(key)).sort();
        for (const key of days) {
          const bytes = await movePastJobDay(key.slice(-10), today);
          if (bytes) { archivedCaches++; freedBytes += bytes; }
          if (probe()) return { ok: true, archivedCaches, freedBytes };
        }
        throw new Error('Remaining storage is protected');
      }
      const candidates = keys(storage).filter(key => eligible(storage, key, today)).sort();
      if (!candidates.length) throw new Error('No eligible old caches; pending data retained');
      archive = await archiveFactory();
      for (const key of candidates) {
        const bytes = await archiveOne(storage, archive, key, today);
        if (bytes) { archivedCaches++; freedBytes += bytes; }
        if (probe()) return { ok: true, archivedCaches, freedBytes };
      }
      throw new Error('Insufficient space; remaining records protected');
    } catch (cause) {
      const error = new Error(HELP);
      error.cause = cause;
      error.name = 'DriverStorageError';
      throw error;
    } finally { archive?.close(); }
  }
  root.PmgDriverStorage = { readJobRaw, writeJobRaw, ensureSpace, openArchive, archiveOne, eligible, quota, HELP, DB_NAME, STORE };
})(typeof globalThis !== 'undefined' ? globalThis : this);
