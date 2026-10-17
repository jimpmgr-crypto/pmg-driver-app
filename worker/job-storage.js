// Transactional day backup. Only a Durable Object may call these methods.
// No omission-based deletes; immutable revisions and operation receipts share a transaction.
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(typeof value === 'string' ? value : canonical(value))))).map(x => x.toString(16).padStart(2, '0')).join('');
}
export function flattenJobs(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') throw new Error('invalid_jobs_shape');
  if (Array.isArray(payload.jobs)) return payload.jobs;
  const result = [];
  for (const [driver, rows] of Object.entries(payload)) {
    if (!Array.isArray(rows)) throw new Error('invalid_jobs_group');
    for (const row of rows) result.push({ ...row, driver: row.driver || driver });
  }
  return result;
}
export function movementKey(row) {
  const id = row?.movementId || row?._movementId || row?.id || row?.jobId;
  return typeof id === 'string' && id.trim() && id.length <= 200 ? id.trim() : '';
}
export function cleanRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid_job_row');
  const result = { ...row };
  for (const key of Object.keys(result)) if (key.startsWith('_backup')) delete result[key];
  return result;
}
function terminalStatus(value) { return ['cancelled','canceled','not-done','not_done','carry-forward','carried-forward','void'].includes(String(value || '').trim().toLowerCase()); }
function rowIdentities(row) {
  return [...new Set([movementKey(row), row.id, row._id, row.jobId, row.haultechJobId, row.consignmentId,
    ...(Array.isArray(row.consignments) ? row.consignments : []).flatMap(c => [c?.id, c?.consignmentId])].filter(value => value !== undefined && value !== null && value !== '').map(String))];
}
function terminalOverride(row, statuses) {
  return rowIdentities(row).map(id => ({ id, ...statuses[id] })).find(value => terminalStatus(value.status));
}
function reconcileLegacyStatus(indexValue, individualValue) {
  if (!indexValue) return { value: individualValue };
  if (canonical(indexValue) === canonical(individualValue)) return { value: individualValue };
  const a = Date.parse(indexValue.updatedAt || ''), b = Date.parse(individualValue.updatedAt || '');
  const aTerminal = terminalStatus(indexValue.status), bTerminal = terminalStatus(individualValue.status);
  // No legacy Start is evidence that a cancellation was explicitly reopened.
  // Preserve the terminal record and disclose the competing source for review.
  if (aTerminal !== bTerminal) return { value: aTerminal ? indexValue : individualValue, reason: 'terminal_status_conflict' };
  if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return { value: b > a ? individualValue : indexValue };
  return { value: indexValue, reason: 'ambiguous_legacy_status_order' };
}
function reply(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }); }

export class JobStorage {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, row TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history (id TEXT NOT NULL, revision INTEGER NOT NULL, operation_id TEXT NOT NULL, row TEXT NOT NULL, actor TEXT NOT NULL, saved_at TEXT NOT NULL, PRIMARY KEY(id, revision));
      CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, receipt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conflicts (operation_id TEXT PRIMARY KEY, proposal TEXT NOT NULL, current_row TEXT, reason TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS status_overrides (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, row TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS status_history (id TEXT NOT NULL, revision INTEGER NOT NULL, row TEXT NOT NULL, PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  meta(key) { return this.sql.exec('SELECT value FROM metadata WHERE key = ?', key).toArray()[0]?.value; }
  get(id) { const row = this.sql.exec('SELECT * FROM jobs WHERE id = ?', id).toArray()[0]; return row ? { id: row.id, revision: row.revision, row: JSON.parse(row.row) } : null; }
  rows() { return this.sql.exec('SELECT * FROM jobs ORDER BY id').toArray().map(r => ({ ...JSON.parse(r.row), _backupRevision: r.revision, _backupMovementId: r.id })); }
  append(id, row, operationId, actor) {
    const revision = (this.get(id)?.revision || 0) + 1, encoded = JSON.stringify(row);
    this.sql.exec('INSERT INTO jobs(id,revision,row) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,row=excluded.row', id, revision, encoded);
    this.sql.exec('INSERT INTO history(id,revision,operation_id,row,actor,saved_at) VALUES(?,?,?,?,?,?)', id, revision, operationId, encoded, actor, new Date().toISOString());
    return { movementId: id, revision };
  }
  async initialize(date) {
    if (this.meta('migration')) return;
    // Lock covers the one remote legacy read; concurrent requests cannot import twice.
    const raw = await this.env.PMG_DATA.get('jobs:' + date), sourceHash = await digest(raw || '{}');
    let rows;
    try { rows = flattenJobs(raw ? JSON.parse(raw) : {}); } catch { throw new Error('legacy_jobs_invalid_do_not_overwrite'); }
    // Recover individual legacy status keys as well as the old day index; the
    // latter may already have lost an independent phone's concurrent update.
    let statuses = {}; const statusConflicts = [];
    const oldIndex = await this.env.PMG_DATA.get('job-status-index:' + date);
    if (oldIndex) { try { statuses = JSON.parse(oldIndex); } catch { throw new Error('legacy_status_invalid_do_not_overwrite'); } }
    let cursor;
    do {
      const page = await this.env.PMG_DATA.list({ prefix: 'job-status:' + date + ':', limit: 100, ...(cursor ? { cursor } : {}) });
      if (page.keys.length) {
        const values = await this.env.PMG_DATA.get(page.keys.map(k => k.name));
        for (const key of page.keys) {
          const raw = values.get(key.name); if (!raw) throw new Error('legacy_status_incomplete');
          const id = key.name.slice(('job-status:' + date + ':').length), individual = JSON.parse(raw);
          const resolved = reconcileLegacyStatus(statuses[id], individual);
          if (resolved.reason) statusConflicts.push({ id, reason: resolved.reason, index: statuses[id], individual });
          statuses[id] = resolved.value;
        }
      }
      cursor = page.list_complete ? null : page.cursor;
      if (!page.list_complete && !cursor) throw new Error('legacy_status_page_incomplete');
    } while (cursor);
    const counts = new Map();
    for (const row of rows) { const id = movementKey(row); if (id) counts.set(id, (counts.get(id) || 0) + 1); }
    this.ctx.storage.transactionSync(() => {
      if (this.meta('migration')) return;
      const unresolved = [];
      rows.forEach((original, i) => {
        let row = cleanRow(original), id = movementKey(row);
        const held = terminalOverride(row, statuses);
        if (held && !terminalStatus(row.status)) row = { ...row, originalStatus: row.status, status: held.status, _backupLegacyStatus: held };
        if (!id || counts.get(id) > 1) {
          const issue = !id ? 'missing_identity' : 'duplicate_identity';
          const originalId = id || String(row.movementId ?? row._movementId ?? row.id ?? row.jobId ?? ''); id = `legacy:${sourceHash.slice(0,16)}:${i}`;
          // Quarantined rows remain readable/exportable but cannot be auto-posted.
          row = { ...row, _backupMigrationIssue: issue, _backupOriginalIdentity: originalId, status: 'not-done', originalStatus: row.status, haultechWriteState: 'needs office review' };
          unresolved.push({ id, originalId, index: i });
        }
        this.append(id, row, 'migration:' + sourceHash + ':' + i, 'legacy-import');
      });
      for (const [id, row] of Object.entries(statuses)) this.sql.exec('INSERT INTO status_overrides(id,revision,row) VALUES(?,1,?)', id, JSON.stringify(row));
      this.sql.exec('INSERT INTO metadata(key,value) VALUES(?,?)', 'migration', JSON.stringify({ date, sourceHash, sourceCount: rows.length, importedStatusCount: Object.keys(statuses).length, statusConflicts, importedCount: rows.length, unresolved, importedAt: new Date().toISOString() }));
    });
  }
  apply(envelope, fingerprint) {
    const reservedIds = new Set((JSON.parse(this.meta('migration') || '{}').unresolved || []).map(item => item.originalId).filter(Boolean));
    const statuses = Object.fromEntries(this.sql.exec('SELECT id,row FROM status_overrides').toArray().map(r => [r.id, JSON.parse(r.row)]));
    const modern = envelope?.protocol === 'pmg-jobs-v3';
    let operations;
    if (modern) {
      if (!Array.isArray(envelope.operations) || !envelope.operations.length || envelope.operations.length > 300) return reply({ error: 'invalid_operations' }, 400);
      operations = envelope.operations;
    } else {
      let rows; try { rows = flattenJobs(envelope); } catch { return reply({ error: 'invalid_jobs_shape' }, 400); }
      operations = rows.map((row, i) => ({ operationId: `legacy:${fingerprint}:${i}`, movementId: movementKey(row), expectedRevision: null, row }));
    }
    const seen = new Set(), operationIds = new Set(), prepared = [];
    for (const op of operations) {
      if (!op || typeof op.operationId !== 'string' || !op.operationId || op.operationId.length > 240 || typeof op.movementId !== 'string' || !op.movementId || op.movementId.length > 200 || seen.has(op.movementId) || operationIds.has(op.operationId)) return reply({ error: 'invalid_or_duplicate_movement' }, 400);
      seen.add(op.movementId); operationIds.add(op.operationId);
      let row; try { row = cleanRow(op.row); } catch { return reply({ error: 'invalid_job_row' }, 400); }
      if (movementKey(row) !== op.movementId) return reply({ error: 'movement_identity_mismatch' }, 400);
      if (modern && (!Number.isSafeInteger(op.expectedRevision) || op.expectedRevision < 0)) return reply({ error: 'expected_revision_required' }, 400);
      prepared.push({ ...op, row, fingerprint: canonical({ movementId: op.movementId, expectedRevision: op.expectedRevision, row }) });
    }
    return this.ctx.storage.transactionSync(() => {
      const conflicts = [], receipts = [];
      for (const op of prepared) {
        const prior = this.sql.exec('SELECT * FROM operations WHERE id = ?', op.operationId).toArray()[0];
        if (prior) {
          if (prior.fingerprint !== op.fingerprint) conflicts.push({ operationId: op.operationId, movementId: op.movementId, reason: 'operation_id_reused' });
          else { op.replay = JSON.parse(prior.receipt); receipts.push(op.replay); }
          continue;
        }
        if (reservedIds.has(op.movementId)) {
          const conflict = { operationId: op.operationId, movementId: op.movementId, reason: 'quarantined_identity_requires_office_resolution' };
          conflicts.push(conflict);
          this.sql.exec('INSERT OR IGNORE INTO conflicts(operation_id,proposal,current_row,reason) VALUES(?,?,?,?)', op.operationId, JSON.stringify(op), null, conflict.reason);
          continue;
        }
        const current = this.get(op.movementId);
        const heldStatus = terminalStatus(current?.row.status) ? current.row.status : terminalOverride(op.row, statuses)?.status;
        if (heldStatus && op.row.status !== heldStatus) {
          const conflict = { operationId: op.operationId, movementId: op.movementId, reason: 'cancelled_backup_requires_office_review' };
          conflicts.push(conflict);
          this.sql.exec('INSERT OR IGNORE INTO conflicts(operation_id,proposal,current_row,reason) VALUES(?,?,?,?)', op.operationId, JSON.stringify(op), JSON.stringify(current), conflict.reason);
          continue;
        }
        if (current && canonical(current.row) === canonical(op.row)) { op.noop = current; continue; }
        if (current && (!modern || current.revision !== op.expectedRevision) || !current && modern && op.expectedRevision !== 0) {
          const conflict = { operationId: op.operationId, movementId: op.movementId, reason: modern ? 'revision_conflict' : 'legacy_update_requires_reload', current: current ? { ...current.row, _backupRevision: current.revision } : null };
          conflicts.push(conflict);
          this.sql.exec('INSERT OR IGNORE INTO conflicts(operation_id,proposal,current_row,reason) VALUES(?,?,?,?)', op.operationId, JSON.stringify(op), JSON.stringify(current), conflict.reason);
        }
      }
      if (conflicts.length) return reply({ ok: false, error: 'backup_conflict', conflicts, retained: true }, 409);
      for (const op of prepared) {
        if (op.replay) continue;
        const receipt = { operationId: op.operationId, ...(op.noop ? { movementId: op.movementId, revision: op.noop.revision } : this.append(op.movementId, op.row, op.operationId, String(envelope.actor || 'legacy-client'))), unchanged: !!op.noop };
        this.sql.exec('INSERT INTO operations(id,fingerprint,receipt) VALUES(?,?,?)', op.operationId, op.fingerprint, JSON.stringify(receipt)); receipts.push(receipt);
      }
      return reply({ ok: true, protocol: 'pmg-jobs-v3', receipts });
    });
  }
  payment(body, updatePayload) {
    return this.ctx.storage.transactionSync(() => {
      const candidates = this.rows().filter(row => [row.id, row.jobId, row.haultechJobId, row.movementId, row.ticketNo, row.jobNumber].filter(Boolean).map(String).includes(String(body.jobId)));
      if (candidates.length > 1) return reply({ ok: false, error: 'ambiguous_backup_payment_identity' }, 409);
      if (!candidates.length) return reply({ ok: true, found: false, updated: false });
      const row = candidates[0], id = row._backupMovementId;
      if (row._backupMigrationIssue) return reply({ ok: false, error: 'quarantined_backup_requires_office_resolution' }, 409);
      // Existing payment normalisation/traffic-note semantics are reused by callback.
      const changed = updatePayload([{ ...row, id: body.jobId }], body.jobId, body.paymentStatus);
      const updated = cleanRow({ ...changed.payload[0], id: row.id });
      if (canonical(updated) === canonical(cleanRow(row))) return reply({ ok: true, found: true, updated: true, unchanged: true });
      const receipt = this.append(id, updated, 'payment:' + crypto.randomUUID(), 'verified-haultech-payment');
      return reply({ ok: true, found: true, updated: true, paymentStatus: changed.paymentStatus, receipt });
    });
  }
  status(body) {
    return this.ctx.storage.transactionSync(() => {
      const previous = this.sql.exec('SELECT revision,row FROM status_overrides WHERE id=?', body.jobId).toArray()[0];
      const previousData = previous ? JSON.parse(previous.row) : null;
      const terminal = terminalStatus;
      if (terminal(previousData?.status) && previousData.status !== body.status) return reply({ ok: false, error: 'cancelled_backup_requires_office_review' }, 409);
      const candidates = this.rows().filter(row => body.movementId
        ? movementKey(row) === body.movementId
        : [row.id, row.jobId, row.haultechJobId, row.consignmentId].filter(Boolean).map(String).includes(String(body.jobId)));
      if (candidates.length > 1) return reply({ ok: false, error: 'ambiguous_backup_status_identity' }, 409);
      const row = candidates[0];
      if (row?._backupMigrationIssue) return reply({ ok: false, error: 'quarantined_backup_requires_office_resolution' }, 409);
      if (row && terminal(row.status) && row.status !== body.status) return reply({ ok: false, error: 'cancelled_backup_requires_office_review' }, 409);
      const statusData = { status: body.status, driver: body.driver || '', date: body.date || '', reason: body.reason || '', note: body.note || '' };
      const compare = value => { const copy = { ...value }; delete copy.updatedAt; return canonical(copy); };
      let overrideRevision = previous?.revision || 0;
      if (!previousData || compare(previousData) !== compare(statusData)) {
        overrideRevision++;
        const stored = JSON.stringify({ ...statusData, updatedAt: new Date().toISOString() });
        this.sql.exec('INSERT INTO status_overrides(id,revision,row) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,row=excluded.row', body.jobId, overrideRevision, stored);
        this.sql.exec('INSERT INTO status_history(id,revision,row) VALUES(?,?,?)', body.jobId, overrideRevision, stored);
      }
      let receipt;
      if (row && row.status !== body.status) receipt = this.append(row._backupMovementId, { ...cleanRow(row), status: body.status }, 'status:' + crypto.randomUUID(), 'driver-status');
      return reply({ ok: true, found: !!row, updated: !!receipt, overrideRevision, ...(receipt ? { receipt } : {}) });
    });
  }
  async handle(request, date, updatePayload) {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.initialize(date);
      const url = new URL(request.url);
      if (request.method === 'GET') {
        if (url.pathname.endsWith('/statuses')) return reply(Object.fromEntries(this.sql.exec('SELECT id,row FROM status_overrides').toArray().map(r => [r.id, JSON.parse(r.row)])));
        if (url.searchParams.get('audit') === '1') return reply({ protocol: 'pmg-jobs-v3', migration: JSON.parse(this.meta('migration')), jobs: this.rows(), history: this.sql.exec('SELECT * FROM history ORDER BY id, revision').toArray(), conflicts: this.sql.exec('SELECT * FROM conflicts').toArray() });
        return reply(this.rows());
      }
      let body; try { body = await request.json(); } catch { return reply({ error: 'bad_json' }, 400); }
      if (url.pathname.endsWith('/payment')) return this.payment(body, updatePayload);
      if (url.pathname.endsWith('/status')) return this.status(body);
      const proposedRows = body?.protocol === 'pmg-jobs-v3' ? body.operations?.map(op => op.row) : (() => { try { return flattenJobs(body); } catch { return []; } })();
      if (proposedRows?.some(row => row?.date && row.date !== date)) return reply({ error: 'row_date_mismatch' }, 400);
      const response = this.apply(body, await digest(body));
      // Legacy KV is retained as the pre-cutover snapshot, never a dual writable truth.
      return response;
    });
  }
}
