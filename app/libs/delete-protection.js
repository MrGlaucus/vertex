const store = require('./brush-store');
const recovery = require('./brush-recovery');
const { overlaps } = require('./reseed-files');

// Reconcile only drops pairs once they have had time to settle, so a torrent
// that is still being added is never mistaken for a removed one.
const SETTLE = 15 * 60000;
const terminal = ['done', 'stopped', 'verificationFailed', 'failed'];
const lower = value => String(value || '').toLowerCase();

function relationsOf (client, hash) {
  return store.listByRef('relation', client.id).filter(r => lower(r.sourceHash) === hash || lower(r.targetHash) === hash);
}

// Whether the peer of a relation still exists in the downloader. Live lookups
// are authoritative. A lookup that fails (downloader offline, timeout, stale
// cookie) says nothing about the peer, so it answers null and the caller keeps
// the files: deleting shared data cannot be undone, while a file that survives
// one round is still there to be judged again.
async function peerExists (client, other, live) {
  if (live) {
    try {
      return !!(await recovery.lookup(client, other));
    } catch (error) {
      return null;
    }
  }
  const snapshot = client.maindata.torrents || [];
  if (!snapshot.length) return null;
  return snapshot.some(t => lower(t.hash) === lower(other));
}

async function protection (client, torrent, live = false) {
  const hash = lower(torrent.hash);
  const snapshot = client.maindata.torrents || [];
  // An empty snapshot means the downloader is restarting or offline. Judging
  // shared files from it would delete data that is still seeding.
  if (!snapshot.length) return '下载器种子列表为空，暂不删除文件';
  let uncertain = '';
  for (const relation of relationsOf(client, hash)) {
    const other = lower(relation.sourceHash) === hash ? relation.targetHash : relation.sourceHash;
    const exists = await peerExists(client, other, live);
    // The peer could not be read, so there is no evidence either way. Keep the
    // files; the next delete round will ask again.
    if (exists === null) return '无法实时确认关联种子状态，保留共享数据';
    if (!exists) {
      // A peer that is still being added has no torrent yet, so its job state is
      // the only evidence the files are about to be shared. Relation age is not:
      // a reseed that fails verification gets deleted minutes after it was
      // created, and nothing ever revisits the pair afterwards.
      const peerJob = store.get('job', recovery.jobId(client.id, other));
      if (peerJob && !terminal.includes(peerJob.state)) {
        uncertain = '关联种子正在添加，保留共享数据';
        continue;
      }
      store.remove('relation', recovery.jobId(client.id, relation.targetHash));
      continue;
    }
    const job = store.get('job', recovery.jobId(client.id, relation.targetHash));
    if (job && !terminal.includes(job.state)) return '辅种或标签确认尚未完成，保留共享数据';
    return '文件仍被关联原种或辅种使用';
  }
  for (const other of snapshot) {
    if (lower(other.hash) === hash) continue;
    if ((other.name === torrent.name && other.size === torrent.size && overlaps(other.savePath, torrent.savePath)) || overlaps(other.originProp && other.originProp.content_path, torrent.originProp && torrent.originProp.content_path)) return '下载器中存在共用文件的其他种子';
  }
  return uncertain;
}

function removed (client, hash) {
  const target = lower(hash);
  for (const relation of relationsOf(client, target)) {
    const other = lower(relation.sourceHash) === target ? relation.targetHash : relation.sourceHash;
    if (!(client.maindata.torrents || []).some(t => lower(t.hash) === lower(other))) store.remove('relation', recovery.jobId(client.id, relation.targetHash));
  }
}

// Relations are only cleaned when this app deletes a torrent. Anything removed
// from the downloader directly (ratio limit, seed time limit, manual delete in
// the WebUI) leaves the pair behind, and a stale pair keeps protecting files
// that no torrent references any more. Reconcile against the live snapshot.
function reconcile (client) {
  // An empty or missing snapshot means the downloader is restarting or offline,
  // not that every torrent disappeared.
  if (!client.status || !Array.isArray(client.maindata.torrents) || !client.maindata.torrents.length) return 0;
  const live = new Set(client.maindata.torrents.map(t => lower(t.hash)));
  let dropped = 0;
  for (const relation of store.listByRef('relation', client.id)) {
    if (Date.now() - (relation.createdAt || 0) < SETTLE) continue;
    if (live.has(lower(relation.sourceHash)) || live.has(lower(relation.targetHash))) continue;
    store.remove('relation', recovery.jobId(client.id, relation.targetHash));
    dropped++;
  }
  return dropped;
}

module.exports = { protection, removed, reconcile };
