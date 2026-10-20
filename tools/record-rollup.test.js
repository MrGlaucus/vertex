const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const rollup = require('../app/libs/record-rollup');

function openDatabase (filename) {
  try { return new (require('better-sqlite3'))(filename); } catch (error) {
    // Node 24's built-in SQLite is used by the local test runtime only.
    const sqlite = require('node:sqlite');
    return new sqlite.DatabaseSync(filename);
  }
}

function main () {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-rollup-test-'));
  const database = openDatabase(path.join(temporary, 'rollup.db'));
  try {
    database.exec(`CREATE TABLE torrents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      upload INTEGER,
      download INTEGER,
      record_time INTEGER NOT NULL,
      delete_time INTEGER,
      record_type INTEGER
    )`);
    rollup.configure(database);

    // Before the table exists there is simply nothing folded yet.
    assert.deepEqual(rollup.get('total'), { upload: 0, download: 0, addCount: 0, rejectCount: 0, deleteCount: 0 }, 'a missing table reports zeros instead of throwing');

    database.exec(`CREATE TABLE record_total (
      key TEXT NOT NULL PRIMARY KEY,
      upload INTEGER NOT NULL DEFAULT 0,
      download INTEGER NOT NULL DEFAULT 0,
      add_count INTEGER NOT NULL DEFAULT 0,
      reject_count INTEGER NOT NULL DEFAULT 0,
      delete_count INTEGER NOT NULL DEFAULT 0
    )`);

    const insert = database.prepare('INSERT INTO torrents (hash, name, size, upload, download, record_time, delete_time, record_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insert.run('old-add', '老种子甲', 100, 1000, 500, 100, null, 1);
    insert.run('old-reject', '老种子乙', 100, 0, 0, 110, null, 2);
    insert.run('old-deleted', '老种子丙', 100, 2000, 800, 120, 130, 1);
    insert.run('fresh-add', '新种子', 100, 7000, 3000, 900, null, 1);

    const folded = rollup.fold(500);
    assert.equal(folded, 3, 'every row older than the cutoff is folded');
    assert.deepEqual(rollup.get('total'), { upload: 3000, download: 1300, addCount: 2, rejectCount: 1, deleteCount: 1 }, 'folded totals match the expired rows');
    assert.equal(database.prepare('SELECT count(*) AS count FROM torrents').get().count, 1, 'only the row inside the window survives');

    // Folding again must not count the same traffic twice.
    assert.equal(rollup.fold(500), 0, 'a second fold finds nothing to delete');
    assert.deepEqual(rollup.get('total'), { upload: 3000, download: 1300, addCount: 2, rejectCount: 1, deleteCount: 1 }, 'totals stay put when there is nothing to fold');

    // A later fold accumulates on top of the earlier one.
    insert.run('next-old', '再老一点', 100, 400, 100, 200, null, 1);
    assert.equal(rollup.fold(500), 1, 'newly expired rows are folded too');
    assert.deepEqual(rollup.get('total'), { upload: 3400, download: 1400, addCount: 3, rejectCount: 1, deleteCount: 1 }, 'totals accumulate across folds');

    // Nothing expired yet: the counters must not move.
    insert.run('still-fresh', '还在窗口里', 100, 5000, 5000, 950, null, 1);
    assert.equal(rollup.fold(500), 0, 'rows inside the window are left alone');
    assert.equal(rollup.get('total').upload, 3400, 'untouched totals stay unchanged');
    console.log('record-rollup tests passed');
  } finally {
    database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main();
