const store = require('./brush-store');
const recovery = require('./brush-recovery');
const active = new Set();
const interval = 30000;
const key = (rssId, hash) => rssId + ':' + String(hash).toLowerCase();
const get = (rssId, hash) => store.get('rss-retry', key(rssId, hash));

function log (entry, outcome, reason) {
  store.event({ rssId: entry.rssId, clientId: entry.clientId, hash: entry.torrent.hash, name: entry.torrent.name, outcome, reason, retryAttempt: entry.attempts, nextAt: entry.state === 'waiting' ? entry.nextAt : undefined });
}

function save (entry) {
  entry.version = (entry.version || 0) + 1;
  entry.updatedAt = Date.now();
  store.put('rss-retry', entry.id, entry);
}

function fail (rssId, torrent, clientId, error) {
  const old = get(rssId, torrent.hash);
  const entry = { ...old, id: key(rssId, torrent.hash), rssId, torrent, clientId: clientId || old?.clientId, attempts: old?.attempts || 0, state: 'waiting', nextAt: Date.now() + interval, error: recovery.safeError(error) };
  if (entry.attempts >= 5) entry.state = 'exhausted';
  save(entry);
  log(entry, entry.state === 'exhausted' ? 'retryExhausted' : 'retryScheduled', entry.error);
}

function finish (entry, state, reason) {
  entry.state = state;
  entry.error = reason;
  save(entry);
  log(entry, state === 'done' ? 'retrySucceeded' : 'retryStopped', reason);
}

function success (rssId, hash) {
  const entry = get(rssId, hash);
  if (entry && entry.state === 'waiting') finish(entry, 'done', '添加请求已接受');
}

function stop (id) {
  if (active.has(id)) throw new Error('重试正在处理，请稍后停止');
  const entry = store.get('rss-retry', id);
  if (!entry) throw new Error('重试任务不存在');
  finish(entry, 'stopped', '用户停止自动重试');
}

function restart (rssId, hash) {
  const entry = get(rssId, hash);
  if (!entry) return;
  if (active.has(entry.id)) throw new Error('重试正在处理');
  entry.attempts = 0;
  entry.state = 'waiting';
  entry.nextAt = Date.now();
  save(entry);
  log(entry, 'retryScheduled', '用户重新启动重试');
}

async function tick () {
  const entries = store.list('rss-retry').filter(entry => entry.state === 'waiting' && entry.nextAt <= Date.now()).sort((a, b) => a.nextAt - b.nextAt);
  for (const candidate of entries) {
    const entry = get(candidate.rssId, candidate.torrent.hash);
    if (!entry || entry.state !== 'waiting' || entry.nextAt > Date.now()) continue;
    const task = global.runningRss?.[entry.rssId];
    if (!task || task.stopped || task.processing || active.has(entry.id)) continue;
    const client = global.runningClient?.[entry.clientId];
    if (entry.clientId && !client?.status) continue;
    active.add(entry.id);
    let invoked = false;
    try {
      let job = recovery.forFeed(entry.rssId, entry.torrent.hash);
      if (job) {
        if (['stopped', 'verificationFailed'].includes(job.state)) {
          finish(entry, 'stopped', '原添加任务已停止或辅种校验失败');
          continue;
        }
        // Fresh lookup also reconciles ambiguous timeouts before any new add request.
        job = await recovery.checkRetry(job.id, global.runningClient?.[job.clientId]);
        if (['done', 'accepted', 'tags', 'verifying'].includes(job.state)) {
          finish(entry, 'done', '已实时确认种子存在，不重复添加');
          continue;
        }
        if (job.state !== 'failed' || !job.checkedFailure || job.nextAt > Date.now()) continue;
      }
      if (task.processing || task.stopped || global.runningRss?.[entry.rssId] !== task) continue;
      if (entry.attempts >= 5) {
        entry.state = 'exhausted';
        save(entry);
        log(entry, 'retryExhausted', '重试次数已达 5 次，停止自动添加');
        continue;
      }
      entry.attempts++;
      entry.nextAt = Date.now() + interval;
      save(entry);
      log(entry, 'retryStarted', '开始第 ' + entry.attempts + ' / 5 次重试');
      invoked = true;
      await task.rss([entry.torrent], true);
      const current = get(entry.rssId, entry.torrent.hash);
      // A policy rejection is not an add failure: never bypass current RSS rules.
      if (current.state === 'waiting' && current.version === entry.version) finish(current, 'stopped', '当前规则、免费/HR 检查、容量或推送上限不允许添加');
    } catch (error) {
      if (invoked) {
        fail(entry.rssId, entry.torrent, entry.clientId, error);
        continue;
      }
      // A lookup failure is not evidence that the previous request failed.
      entry.nextAt = Date.now() + interval;
      entry.error = recovery.safeError(error);
      save(entry);
      log(entry, 'retryDeferred', entry.error);
    } finally {
      active.delete(entry.id);
    }
  }
}

module.exports = { get, fail, success, stop, restart, tick };
