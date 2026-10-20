// Lifetime totals outlive the detail table. `torrents` keeps a rolling window,
// so summing it alone makes every dashboard counter fall when the window slides.
// Whatever leaves the window is folded into `record_total` first: the totals stay
// monotonic and the detail table stays small enough to scan quickly.
let database;

const EMPTY = { upload: 0, download: 0, addCount: 0, rejectCount: 0, deleteCount: 0 };

function configure (db) {
  database = db;
}

function get (key = 'total') {
  if (!database) return { ...EMPTY };
  let row;
  try {
    row = database.prepare('SELECT upload, download, add_count, reject_count, delete_count FROM record_total WHERE key = ?').get(key);
  } catch (ignored) {
    // schema.ensure creates the table at startup; before that there is nothing to report.
    return { ...EMPTY };
  }
  if (!row) return { ...EMPTY };
  return {
    upload: row.upload || 0,
    download: row.download || 0,
    addCount: row.add_count || 0,
    rejectCount: row.reject_count || 0,
    deleteCount: row.delete_count || 0
  };
}

function add (key, values) {
  if (!database) return;
  database.prepare(`INSERT INTO record_total (key, upload, download, add_count, reject_count, delete_count)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      upload = record_total.upload + excluded.upload,
      download = record_total.download + excluded.download,
      add_count = record_total.add_count + excluded.add_count,
      reject_count = record_total.reject_count + excluded.reject_count,
      delete_count = record_total.delete_count + excluded.delete_count`)
    .run(key, values.upload || 0, values.download || 0, values.addCount || 0, values.rejectCount || 0, values.deleteCount || 0);
}

// Fold and delete in one transaction. A crash between the two would either count
// the same rows twice or drop their traffic for good.
function fold (cutoff, key = 'total') {
  if (!database) return 0;
  const apply = () => {
    const row = database.prepare(`SELECT coalesce(sum(upload), 0) AS upload, coalesce(sum(download), 0) AS download,
      coalesce(sum(CASE WHEN record_type = 1 THEN 1 ELSE 0 END), 0) AS add_count,
      coalesce(sum(CASE WHEN record_type = 2 THEN 1 ELSE 0 END), 0) AS reject_count,
      coalesce(sum(CASE WHEN delete_time IS NOT NULL THEN 1 ELSE 0 END), 0) AS delete_count
      FROM torrents WHERE record_time < ?`).get(cutoff);
    if (row && (row.upload || row.download || row.add_count || row.reject_count || row.delete_count)) {
      add(key, { upload: row.upload, download: row.download, addCount: row.add_count, rejectCount: row.reject_count, deleteCount: row.delete_count });
    }
    return database.prepare('DELETE FROM torrents WHERE record_time < ?').run(cutoff).changes;
  };
  // The local test runtime's SQLite shim has no transaction helper.
  return typeof database.transaction === 'function' ? database.transaction(apply)() : apply();
}

module.exports = { configure, get, add, fold };
