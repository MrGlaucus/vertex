const fs = require('fs');
const bencode = require('bencode');
const files = require('./reseed-files');
const recovery = require('./brush-recovery');
const store = require('./brush-store');

async function attempt (task, torrent, rule = {}) {
  if (!task.autoReseed && !task.onlyReseed) return false;
  const clients = (task.reseedClients || task.clientArr || []).map(id => global.runningClient[id]).filter(c => c && c.status && c.maindata && c._client.type === 'qBittorrent');
  const allowed = task._rss.reseedRespectRules && (rule.client ? [rule.client] : rule.clientArr && rule.clientArr.length ? rule.clientArr.filter(id => task.clientArr.includes(id)) : null);
  const candidates = clients.filter(c => !allowed || allowed.includes(c.id)).flatMap(client => client.maindata.torrents.filter(t => +t.size === +torrent.size && recovery.completed(t)).map(source => ({ client, source })));
  if (candidates.length) {
    const metadata = await task._downloadTorrent(torrent.url, torrent.hash);
    const info = bencode.decode(fs.readFileSync(metadata.filepath)).info;
    const expected = files.manifest(info);
    const size = expected.reduce((total, file) => total + file.size, 0);
    const mode = task._rss.reseedMode || 'compatible';
    const oldJob = recovery.forFeed(task.id, torrent.hash);
    for (const { client, source } of candidates) {
      if (oldJob && oldJob.clientId !== client.id) continue;
      if (source.hash.toLowerCase() === metadata.hash.toLowerCase()) continue;
      const current = await recovery.lookup(client, source.hash);
      if (!recovery.completed(current) || !current.savePath || +current.size !== size) continue;
      if (mode === 'compatible') {
        if (current.name !== info.name.toString()) continue;
      } else if (!files.sameFiles(expected, await client.getFiles(source.hash))) continue;
      if (task.stopped) return true;
      if (task._rss.reseedRespectRules && (task.scrapeFree || task.scrapeHr)) {
        const util = require('./util');
        if ((task.scrapeFree && !await util.scrapeFree(torrent.link, task.cookie)) || (task.scrapeHr && await util.scrapeHr(torrent.link, task.cookie))) {
          store.event({ rssId: task.id, hash: torrent.hash, name: torrent.name, outcome: 'rejected', reason: '辅种未通过当前免费或 HR 检查' });
          return true;
        }
      }
      // Always add paused; only the recovery worker may start a confirmed seed.
      await client.addTorrentByTorrentFile(metadata.filepath, metadata.hash, mode === 'fast', task.uploadLimit, task.downloadLimit, current.savePath, task.category, false, true, {
        size,
        rssId: task.id,
        feedHash: torrent.hash,
        name: torrent.name,
        link: torrent.link,
        category: task.category,
        ruleId: rule.id,
        ruleAlias: rule.alias,
        reseed: { sourceHash: source.hash, mode, resume: !task.paused }
      });
      task.addCount++;
      store.remove('wait', task.id + ':' + torrent.hash);
      return true;
    }
  }
  if (task.onlyReseed) {
    const id = task.id + ':' + torrent.hash;
    const old = store.get('wait', id);
    const minutes = Math.min(1440, Math.max(0, Number(task._rss.reseedWaitMinutes) || 0));
    if (minutes && !old && store.list('wait').filter(w => w.rssId === task.id).length < 500) store.put('wait', id, { id, rssId: task.id, torrent, expiresAt: Date.now() + minutes * 60000 });
    store.event({ rssId: task.id, hash: torrent.hash, name: torrent.name, outcome: 'reseedMiss', reason: minutes ? '等待已有下载完成后重新匹配' : '仅辅种未找到完整数据' });
    return true;
  }
  return false;
}

function waiting (rssId) {
  const result = [];
  for (const entry of store.list('wait').filter(w => w.rssId === rssId)) {
    if (entry.expiresAt <= Date.now()) {
      store.remove('wait', entry.id);
      store.event({ rssId, hash: entry.torrent.hash, name: entry.torrent.name, outcome: 'waitExpired', reason: '辅种等待已过期' });
    } else result.push(entry.torrent);
  }
  return result;
}

module.exports = { attempt, waiting };
