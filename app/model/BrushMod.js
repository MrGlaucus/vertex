const store = require('../libs/brush-store');
const capacity = require('../libs/capacity');
const recovery = require('../libs/brush-recovery');
const util = require('../libs/util');

class BrushMod {
  async overview () {
    const clients = Object.values(global.runningClient || {}).map(client => ({
      id: client.id,
      alias: client.alias,
      status: client.status,
      type: client._client.type,
      capacity: capacity.snapshot(client),
      uploadSpeed: client.avgUploadSpeed,
      downloadSpeed: client.avgDownloadSpeed,
      updatedAt: client.capacityUpdatedAt,
      torrents: client.maindata ? client.maindata.torrents.length : 0
    }));
    const rss = global.runningRss || {};
    const clientAlias = id => clients.find(c => c.id === id)?.alias || id;
    const rssAlias = id => rss[id]?.alias || id || '手动 / 订阅推送';
    const jobs = store.list('job');
    const liveTorrents = new Map();
    const traffic = {};
    for (const client of Object.values(global.runningClient || {})) {
      for (const torrent of client.maindata?.torrents || []) {
        liveTorrents.set(client.id + ':' + torrent.hash.toLowerCase(), torrent);
        const key = client.id + ':' + (torrent.tracker || '未知站点');
        if (!traffic[key]) traffic[key] = { id: key, client: client.alias, tracker: torrent.tracker || '未知站点', count: 0, upload: 0, download: 0, size: 0 };
        const row = traffic[key];
        row.count++;
        row.upload += +torrent.uploaded || 0;
        row.download += +torrent.downloaded || 0;
        row.size += +torrent.size || 0;
      }
    }
    const rules = {};
    for (const job of jobs) {
      const key = job.ruleId || 'default';
      if (!rules[key]) rules[key] = { id: key, alias: job.ruleAlias || '默认 / 旧任务', accepted: 0, reseed: 0, upload: 0, download: 0, size: 0 };
      const rule = rules[key];
      if (['done', 'accepted', 'verifying', 'tags'].includes(job.state)) rule.accepted++;
      if (job.reseedConfirmed) rule.reseed++;
      const live = liveTorrents.get(job.clientId + ':' + job.hash);
      if (live) {
        rule.upload += +live.uploaded || 0;
        rule.download += +live.downloaded || 0;
        rule.size += +live.size || 0;
      }
    }
    const history = await util.getRecords('SELECT rss_id, count(*) AS records, sum(CASE WHEN record_type=2 THEN 1 ELSE 0 END) AS rejected, sum(COALESCE(upload,0)) AS upload, sum(COALESCE(download,0)) AS download FROM torrents GROUP BY rss_id');
    return {
      clients,
      traffic: Object.values(traffic),
      jobs: jobs.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500).map(job => ({
        id: job.id, hash: job.hash, name: job.name, client: clientAlias(job.clientId), rss: rssAlias(job.rssId), state: job.state, attempts: job.attempts, recoveryAttempts: job.recoveryAttempts || 0, nextAt: job.nextAt, error: job.error, mode: job.reseed?.mode || '普通下载', updatedAt: job.updatedAt
      })),
      events: store.list('event').sort((a, b) => b.time - a.time).slice(0, 200).map(e => ({ ...e, rss: rssAlias(e.rssId), client: clientAlias(e.clientId) })),
      retries: store.list('rss-retry').sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500).map(entry => ({ id: entry.id, name: entry.torrent.name, rss: rssAlias(entry.rssId), client: clientAlias(entry.clientId), state: entry.state, attempts: entry.attempts, nextAt: entry.state === 'waiting' ? entry.nextAt : null, error: entry.error })),
      waiting: store.list('wait').map(w => ({ id: w.id, name: w.torrent.name, rss: rssAlias(w.rssId), expiresAt: w.expiresAt })),
      rules: Object.values(rules),
      history: history.map(row => ({ ...row, alias: rssAlias(row.rss_id) })),
      pendingRestore: require('fs').existsSync(require('path').resolve(global.dataPath || '/', 'vertex/.pending-restore.json'))
    };
  }

  async action (options) {
    if (options.operation === 'stopRetry') {
      require('../libs/rss-retry').stop(options.id);
      return '操作完成';
    }
    if (options.operation === 'cancelWait') {
      if (!store.get('wait', options.id)) throw new Error('等待任务不存在');
      store.remove('wait', options.id);
    } else await recovery.action(options.id, options.operation);
    return '操作完成';
  }

  async preview (options) {
    const client = global.runningClient[options.clientId];
    if (!client || !client.status) throw new Error('下载器不可用');
    return { updatedAt: client.capacityUpdatedAt, items: await client.previewDelete() };
  }
}

module.exports = BrushMod;
