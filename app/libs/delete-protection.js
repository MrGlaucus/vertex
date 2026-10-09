const store = require('./brush-store');
const recovery = require('./brush-recovery');
const { overlaps } = require('./reseed-files');

async function protection (client, torrent, live = false) {
  for (const relation of store.list('relation').filter(r => r.clientId === client.id && [r.sourceHash, r.targetHash].includes(torrent.hash))) {
    const other = relation.sourceHash === torrent.hash ? relation.targetHash : relation.sourceHash;
    const job = store.get('job', recovery.jobId(client.id, relation.targetHash));
    if (job && !['done', 'stopped', 'verificationFailed', 'failed'].includes(job.state)) return '辅种或标签确认尚未完成，保留共享数据';
    try {
      const found = live ? await recovery.lookup(client, other) : (client.maindata.torrents || []).find(t => t.hash === other);
      if (found) return '文件仍被关联原种或辅种使用';
    } catch (error) {
      return '无法实时确认关联种子状态，保留共享数据';
    }
  }
  for (const other of client.maindata.torrents || []) {
    if (other.hash === torrent.hash) continue;
    if ((other.name === torrent.name && other.size === torrent.size && overlaps(other.savePath, torrent.savePath)) || overlaps(other.originProp && other.originProp.content_path, torrent.originProp && torrent.originProp.content_path)) return '下载器中存在共用文件的其他种子';
  }
  return '';
}

function removed (client, hash) {
  for (const relation of store.list('relation').filter(r => r.clientId === client.id && [r.sourceHash, r.targetHash].includes(hash))) {
    const other = relation.sourceHash === hash ? relation.targetHash : relation.sourceHash;
    if (!(client.maindata.torrents || []).some(t => t.hash === other)) store.remove('relation', recovery.jobId(client.id, relation.targetHash));
  }
}

module.exports = { protection, removed };
