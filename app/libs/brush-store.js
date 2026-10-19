// One connection and one transactional record store for recovery and data links.
let database;
const memory = new Map();
let lastPrune = 0;

// RSS looks a job up by feed hash on every scan. Deriving an indexed `ref`
// column keeps that lookup off the full-kind scan, which used to read and parse
// every stored job once per torrent per minute.
// Relations are read by downloader on every delete, so they use the same column
// with the client id as key instead of scanning the whole kind.
function refOf (kind, data) {
  if (!data) return null;
  if (kind === 'job') {
    if (!data.rssId || !data.feedHash) return null;
    return data.rssId + ':' + String(data.feedHash).toLowerCase();
  }
  if (kind === 'relation') return data.clientId || null;
  return null;
}

// Older rows predate the ref column. Fill them once so lookups stay index-only.
function backfill (db) {
  let rows;
  try {
    rows = db.prepare('SELECT id, kind, data FROM brush_state WHERE kind IN (\'job\', \'relation\') AND ref IS NULL').all();
  } catch (ignored) {
    return;
  }
  if (!rows.length) return;
  const update = db.prepare('UPDATE brush_state SET ref = ? WHERE kind = ? AND id = ?');
  const apply = list => {
    for (const row of list) {
      let data;
      try { data = JSON.parse(row.data); } catch (ignored) { continue; }
      const ref = refOf(row.kind, data);
      if (ref) update.run(ref, row.kind, row.id);
    }
  };
  // The local test runtime's SQLite shim has no transaction helper.
  if (typeof db.transaction === 'function') db.transaction(apply)(rows);
  else apply(rows);
}

function configure (db) {
  db.exec('CREATE TABLE IF NOT EXISTS brush_state (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, id))');
  const columns = db.prepare('PRAGMA table_info(brush_state)').all().map(column => column.name);
  if (!columns.includes('ref')) db.exec('ALTER TABLE brush_state ADD COLUMN ref TEXT');
  backfill(db);
  db.exec('CREATE INDEX IF NOT EXISTS brush_state_updated ON brush_state(kind, updated_at)');
  db.exec('CREATE INDEX IF NOT EXISTS brush_state_ref ON brush_state(kind, ref)');
  database = db;
}

function put (kind, id, data) {
  const json = JSON.stringify(data);
  if (database) database.prepare('INSERT INTO brush_state (kind,id,data,updated_at,ref) VALUES (?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at,ref=excluded.ref').run(kind, id, json, Date.now(), refOf(kind, data));
  else memory.set(kind + ':' + id, json);
  return data;
}

function get (kind, id) {
  const row = database ? database.prepare('SELECT data FROM brush_state WHERE kind=? AND id=?').get(kind, id) : { data: memory.get(kind + ':' + id) };
  return row && row.data ? JSON.parse(row.data) : undefined;
}

function getByRef (kind, ref) {
  if (!ref) return undefined;
  if (!database) {
    for (const [key, json] of memory.entries()) {
      if (key.indexOf(kind + ':') !== 0) continue;
      let data;
      try { data = JSON.parse(json); } catch (ignored) { continue; }
      if (refOf(kind, data) === ref) return data;
    }
    return undefined;
  }
  const row = database.prepare('SELECT data FROM brush_state WHERE kind=? AND ref=? LIMIT 1').get(kind, ref);
  return row && row.data ? JSON.parse(row.data) : undefined;
}

function list (kind) {
  if (database) return database.prepare('SELECT data FROM brush_state WHERE kind=? ORDER BY updated_at DESC').all(kind).map(row => JSON.parse(row.data));
  return [...memory.entries()].filter(([key]) => key.startsWith(kind + ':')).map(([, json]) => JSON.parse(json));
}

// Every row of one kind sharing a ref value. Relations are grouped by client id,
// so a delete only parses the rows of the downloader it touches.
function listByRef (kind, ref) {
  if (!ref) return [];
  if (database) return database.prepare('SELECT data FROM brush_state WHERE kind=? AND ref=?').all(kind, ref).map(row => JSON.parse(row.data));
  const result = [];
  for (const [key, json] of memory.entries()) {
    if (key.indexOf(kind + ':') !== 0) continue;
    let data;
    try { data = JSON.parse(json); } catch (ignored) { continue; }
    if (refOf(kind, data) === ref) result.push(data);
  }
  return result;
}

function remove (kind, id) {
  if (database) database.prepare('DELETE FROM brush_state WHERE kind=? AND id=?').run(kind, id);
  else memory.delete(kind + ':' + id);
}

function event (data) {
  if (['reseedMiss', 'rejected', 'reseedError'].includes(data.outcome)) {
    const key = require('crypto').createHash('sha256').update(JSON.stringify([data.rssId, data.hash, data.outcome, data.reason])).digest('hex');
    const previous = get('event-throttle', key);
    if (previous && Date.now() - previous.time < 15 * 60000) return;
    put('event-throttle', key, { time: Date.now() });
  }
  const id = require('crypto').randomBytes(12).toString('hex');
  put('event', id, { ...data, id, time: Date.now() });
  if (database && Date.now() - lastPrune > 3600000) {
    // The panel only renders the newest 200 events, so keeping more than a few
    // thousand just slows every list() that parses them.
    database.prepare('DELETE FROM brush_state WHERE kind IN (?,?) AND updated_at < ?').run('event', 'event-throttle', Date.now() - 30 * 86400000);
    database.prepare('DELETE FROM brush_state WHERE kind=? AND updated_at < ?').run('rss-reject-notice', Date.now() - 7 * 86400000);
    database.exec('DELETE FROM brush_state WHERE kind=\'event\' AND id NOT IN (SELECT id FROM brush_state WHERE kind=\'event\' ORDER BY updated_at DESC LIMIT 2000)');
    lastPrune = Date.now();
  }
}

function transaction (action) {
  if (database) {
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = action();
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  const before = new Map(memory);
  try { return action(); } catch (error) {
    memory.clear();
    for (const [key, value] of before) memory.set(key, value);
    throw error;
  }
}

module.exports = { configure, put, get, getByRef, list, listByRef, remove, event, transaction };
