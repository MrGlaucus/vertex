// One connection and one transactional record store for recovery and data links.
let database;
const memory = new Map();
let lastPrune = 0;

function configure (db) {
  db.exec('CREATE TABLE IF NOT EXISTS brush_state (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, id)); CREATE INDEX IF NOT EXISTS brush_state_updated ON brush_state(kind, updated_at)');
  database = db;
}

function put (kind, id, data) {
  const json = JSON.stringify(data);
  if (database) database.prepare('INSERT INTO brush_state (kind,id,data,updated_at) VALUES (?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at').run(kind, id, json, Date.now());
  else memory.set(kind + ':' + id, json);
  return data;
}

function get (kind, id) {
  const row = database ? database.prepare('SELECT data FROM brush_state WHERE kind=? AND id=?').get(kind, id) : { data: memory.get(kind + ':' + id) };
  return row && row.data ? JSON.parse(row.data) : undefined;
}

function list (kind) {
  if (database) return database.prepare('SELECT data FROM brush_state WHERE kind=? ORDER BY updated_at DESC').all(kind).map(row => JSON.parse(row.data));
  return [...memory.entries()].filter(([key]) => key.startsWith(kind + ':')).map(([, json]) => JSON.parse(json));
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
    database.prepare('DELETE FROM brush_state WHERE kind IN (?,?) AND updated_at < ?').run('event', 'event-throttle', Date.now() - 30 * 86400000);
    database.exec('DELETE FROM brush_state WHERE kind=\'event\' AND id NOT IN (SELECT id FROM brush_state WHERE kind=\'event\' ORDER BY updated_at DESC LIMIT 10000)');
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

module.exports = { configure, put, get, list, remove, event, transaction };
