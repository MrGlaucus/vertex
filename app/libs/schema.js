// Indexes the record tables need at runtime. They are created once and reused
// afterwards, so a fresh install and an existing database converge on the same
// schema without a migration step.
//
// Without these, every dashboard count/sum scans the full `torrents` table while
// holding the single Node thread, which stalls sockets and timers for seconds.
const INDEXES = [
  ['index_t_type_time', 'CREATE INDEX IF NOT EXISTS index_t_type_time ON torrents(record_type, record_time)'],
  ['index_t_delete_time', 'CREATE INDEX IF NOT EXISTS index_t_delete_time ON torrents(delete_time) WHERE delete_time IS NOT NULL'],
  ['index_t_sum', 'CREATE INDEX IF NOT EXISTS index_t_sum ON torrents(upload, download)'],
  ['index_t_rss_cover', 'CREATE INDEX IF NOT EXISTS index_t_rss_cover ON torrents(rss_id, upload, download)'],
  ['index_t_tracker_cover', 'CREATE INDEX IF NOT EXISTS index_t_tracker_cover ON torrents(tracker, upload, download)'],
  ['index_tf_hash_time', 'CREATE INDEX IF NOT EXISTS index_tf_hash_time ON torrent_flow(hash, time)']
];

// Lifetime totals live outside the rolling window. `torrents` only keeps recent
// rows, so a dashboard total summed from it alone shrinks every time the window
// slides. Anything pruned is folded in here first, which keeps the counters
// monotonic while the detail table stays small.
const TABLES = [
  `CREATE TABLE IF NOT EXISTS record_total (
    key TEXT NOT NULL PRIMARY KEY,
    upload INTEGER NOT NULL DEFAULT 0,
    download INTEGER NOT NULL DEFAULT 0,
    add_count INTEGER NOT NULL DEFAULT 0,
    reject_count INTEGER NOT NULL DEFAULT 0,
    delete_count INTEGER NOT NULL DEFAULT 0
  )`
];

const logger = require('./logger');

exports.ensure = function (db) {
  for (const sql of TABLES) {
    try {
      db.exec(sql);
    } catch (error) {
      logger.error('创建累计表失败:', error.message);
    }
  }
  for (const [name, sql] of INDEXES) {
    try {
      db.exec(sql);
    } catch (error) {
      // A missing table is expected on a fresh install before the first write.
      if (!/no such table/i.test(error.message)) logger.error('创建索引失败:', name, error.message);
    }
  }
};
