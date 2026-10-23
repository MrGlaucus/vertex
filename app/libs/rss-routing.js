const capacity = require('./capacity');
const groups = require('./downloader-groups');

function orderedRules (rules, ids, order = 'configured') {
  const selected = order === 'legacy' ? rules.filter(rule => ids.includes(rule.id)) : ids.map(id => rules.find(rule => rule.id === id)).filter(Boolean);
  return selected
    .sort((a, b) => order === 'legacy' ? +b.priority - +a.priority : (Number(b.priority) || 0) - (Number(a.priority) || 0));
}

async function refresh (task, clients = {}) {
  const ids = [...groups.normal(task), ...groups.reseed(task), ...(task.acceptRules || []).flatMap(rule => groups.ruleClients(task, rule))];
  await Promise.all([...new Set(ids)].map(async id => {
    const client = clients[id];
    if (client?.ensureAvailable && capacity.isUnavailable(client)) await client.ensureAvailable();
  }));
}

function select (task, torrent, rule = {}, clients = {}, excluded = null) {
  const group = (!rule.client || (rule.clientGroupIds || []).length) && groups.restricted(rule);
  // Legacy single-downloader overrides remain usable without task membership.
  const ids = groups.ruleClients(task, rule);
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
    // Files that are already there download nothing, which is exactly what an
    // avoid-reseed task is trying to prevent. Capacity problems still win the
    // slot because they are the harder blocker.
    if (!reason && excluded && excluded.has(id)) reason = '已存在相同内容的种子（避开辅种）';
    return { id, alias: client ? client.alias : id, reason, duplicate: capacity.duplicate(client, torrent.hash), temporary: !!reason && capacity.isUnavailable(client) };
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
    duplicate: !available.length && (candidates.find(c => c.duplicate === 'existing') || candidates.find(c => c.duplicate === 'pending')),
    temporary: !available.length && candidates.some(c => c.temporary),
    reason: available.length ? '' : (group ? '规则下载器组无可用机器，不回退组外' : '无可用下载器') + (candidates.length ? ': ' + candidates.map(c => `${c.alias}: ${c.reason}`).join('; ') : '（请检查规则组与 RSS 下载器列表）')
  };
}

module.exports = { orderedRules, select, refresh };
