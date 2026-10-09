// Shared by every Client instance, including instances recreated after editing.
const store = require('./brush-store');
const keyOf = hash => String(hash || '').toLowerCase();

function pending (client) {
  return new Map(store.list('capacity').filter(entry => entry.clientId === client.id).map(entry => [entry.hash, entry]));
}

function releaseHash (clientId, hash) {
  store.remove('capacity', clientId + ':' + keyOf(hash));
}

function snapshot (client) {
  const data = client.maindata || {};
  const torrents = data.torrents || [];
  const entries = pending(client);
  const hashes = new Set(torrents.filter(t => +t.size > 0).map(t => keyOf(t.hash)));
  for (const [hash, entry] of entries) {
    if (entry.state !== 'sending' && hashes.has(hash)) { entries.delete(hash); releaseHash(client.id, hash); }
  }
  const remaining = torrents.reduce((sum, t) => sum + Math.max(0, (+t.size || 0) - (+t.completed || 0)), 0);
  const reserved = [...entries.values()].reduce((sum, entry) => sum + entry.size, 0);
  return {
    count: (+data.leechingCount || 0) + [...entries.values()].filter(entry => !entry.reseed).length,
    free: Number(data.freeSpaceOnDisk) - remaining - reserved,
    reserved: [...entries.values()].filter(entry => !entry.reseed).length,
    uncertain: [...entries.values()].filter(entry => entry.state === 'uncertain').length
  };
}

function reason (client, size = 0, options = {}) {
  if (!client || !client.status || !client.maindata) return '下载器未启动或状态不可用';
  const view = snapshot(client);
  if (options.hash && (pending(client).has(keyOf(options.hash)) || (client.maindata.torrents || []).some(t => keyOf(t.hash) === keyOf(options.hash)))) return '种子已存在或正在添加，等待下载器确认';
  if (client._client.maxTorrentNum > 0 && (client.maindata.torrents || []).length + pending(client).size >= client._client.maxTorrentNum) return '达到下载器总种子数量上限';
  if (options.reseed) return '';
  if (client.maxLeechNum > 0 && view.count >= client.maxLeechNum) return '达到下载器最大下载数量（含预占）';
  if (options.maxCount > 0 && view.count >= options.maxCount) return '达到 RSS 下载任务上限（含预占）';
  if (client.minFreeSpace > 0 && client.maindata.freeSpaceOnDisk <= client.minFreeSpace) return '低于下载器最小剩余空间';
  if (client._client.capacityGuard) {
    const maxAge = Number(client._client.capacityMaxAge) || 120;
    if (!client.capacityUpdatedAt || Date.now() - client.capacityUpdatedAt > maxAge * 1000) return '下载器容量状态已过期，等待刷新';
    if (!Number.isFinite(+size) || +size <= 0) return '无法确认种子大小，空间保护拒绝添加';
    if (!Number.isFinite(view.free)) return '无法确认下载器剩余空间';
    if (view.free - size < (client.minFreeSpace || 0)) return '预计剩余空间不足（已计入未完成下载和预占）';
  }
  return '';
}

function reserve (client, hash, size, options = {}) {
  const error = reason(client, size, { ...options, hash });
  if (error) {
    const rejection = new Error(error);
    rejection.code = 'CAPACITY_REJECTED';
    throw rejection;
  }
  const key = keyOf(hash);
  if (!key) throw new Error('缺少种子标识，无法预占容量');
  const entry = { clientId: client.id, hash: key, size: options.reseed ? 0 : Math.max(0, Number(size) || 0), reseed: !!options.reseed, state: 'sending', createdAt: Date.now() };
  const id = client.id + ':' + key;
  store.put('capacity', id, entry);
  return {
    accepted () { entry.state = 'accepted'; store.put('capacity', id, entry); },
    uncertain () { if (store.get('capacity', id)) { entry.state = 'uncertain'; store.put('capacity', id, entry); } },
    release () { releaseHash(client.id, key); }
  };
}

module.exports = { snapshot, reason, reserve, releaseHash };
