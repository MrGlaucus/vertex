const capacity = require('./capacity');

function orderedRules (rules, ids, order = 'configured') {
  const selected = order === 'legacy' ? rules.filter(rule => ids.includes(rule.id)) : ids.map(id => rules.find(rule => rule.id === id)).filter(Boolean);
  return selected
    .sort((a, b) => order === 'legacy' ? +b.priority - +a.priority : (Number(b.priority) || 0) - (Number(a.priority) || 0));
}

function select (task, torrent, rule = {}, clients = {}) {
  const group = !rule.client && Array.isArray(rule.clientArr) && rule.clientArr.length > 0;
  // Legacy single-downloader overrides remain usable without task membership.
  const ids = group ? rule.clientArr.filter(id => task.clientArr.includes(id)) : rule.client ? [rule.client] : task.clientArr;
  const candidates = [...new Set(ids)].map(id => {
    const client = clients[id];
    let reason = capacity.reason(client, torrent.size, { maxCount: task.maxClientDownloadCount, hash: torrent.hash });
    if (!reason) {
      const peers = client.sameServerClients && client.sameServerClients.length ? client.sameServerClients.map(id => clients[id]).filter(Boolean) : [client];
      const upload = peers.reduce((sum, c) => sum + (+c.avgUploadSpeed || 0), 0);
      const download = peers.reduce((sum, c) => sum + (+c.avgDownloadSpeed || 0), 0);
      if ((task.maxClientUploadSpeed > 0 && client.avgUploadSpeed >= task.maxClientUploadSpeed) || (client.maxUploadSpeed > 0 && upload >= client.maxUploadSpeed)) reason = '达到上传速度上限';
      if ((task.maxClientDownloadSpeed > 0 && client.avgDownloadSpeed >= task.maxClientDownloadSpeed) || (client.maxDownloadSpeed > 0 && download >= client.maxDownloadSpeed)) reason = '达到下载速度上限';
    }
    return { id, alias: client ? client.alias : id, reason };
  });
  const available = candidates.filter(c => !c.reason).map(c => clients[c.id]);
  const metric = client => {
    const view = capacity.snapshot(client);
    if (task.clientSortBy === 'leechingCount') return view.count;
    if (task.clientSortBy === 'freeSpaceOnDisk' && client._client.capacityGuard) return view.free;
    return Number(client.maindata[task.clientSortBy]) || 0;
  };
  available.sort((a, b) => (task.clientSortBy === 'freeSpaceOnDisk' ? -1 : 1) * (metric(a) - metric(b)));
  return {
    client: available[0],
    candidates,
    reason: available.length ? '' : (group ? '规则下载器组无可用机器，不回退组外' : '无可用下载器') + (candidates.length ? ': ' + candidates.map(c => `${c.alias}: ${c.reason}`).join('; ') : '（请检查规则组与 RSS 下载器列表）')
  };
}

module.exports = { orderedRules, select };
