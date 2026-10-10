const store = require('./brush-store');
const capacity = require('./capacity');
const active = new Set();
const recovering = new Set();
let ticking = false;
let history;
const terminal = ['done', 'stopped', 'verificationFailed'];
const jobId = (clientId, hash) => clientId + ':' + String(hash).toLowerCase();
const safeError = error => String(error.message || error).replace(/https?:\/\/\S+/g, '[地址已隐藏]').slice(0, 500);

function save (job) {
  job.updatedAt = Date.now();
  store.put('job', job.id, job);
  return job;
}

function begin (client, hash, request, admission = {}) {
  const id = jobId(client.id, hash);
  const old = store.get('job', id);
  if (old && (!['failed', 'waiting'].includes(old.state) || old.attempts >= (admission.rssId ? 6 : 5) || old.nextAt > Date.now())) throw new Error('添加任务尚未到重试时间或已停止，请查看刷流中心');
  const job = { ...old, id, hash: String(hash).toLowerCase(), clientId: client.id, rssId: admission.rssId, feedHash: admission.feedHash || hash, name: admission.name || hash, link: admission.link, category: admission.category, ruleId: admission.ruleId, ruleAlias: admission.ruleAlias, request, reseed: admission.reseed, state: 'sending', recheckRequested: false, reseedConfirmed: false, resumed: false, targetObserved: false, httpAccepted: false, checkedFailure: false, attempts: (old ? old.attempts : 0) + 1, nextAt: Date.now() + 120000, createdAt: old ? old.createdAt : Date.now(), error: '' };
  save(job);
  active.add(id);
  if (job.reseed) store.put('relation', id, { clientId: client.id, sourceHash: job.reseed.sourceHash, targetHash: job.hash, savePath: request.savePath, state: 'pending', createdAt: Date.now() });
  return job;
}

function accepted (job) {
  job.state = 'accepted';
  job.httpAccepted = true;
  active.delete(job.id);
  save(job);
  store.event({ rssId: job.rssId, clientId: job.clientId, hash: job.hash, name: job.name, outcome: job.reseed ? 'reseedAccepted' : 'accepted', size: job.request.size || 0 });
}

function failed (job, error, definite) {
  job.state = definite ? 'failed' : 'uncertain';
  job.checkedFailure = false;
  job.error = safeError(error);
  job.nextAt = Date.now() + (job.rssId ? 30000 : Math.min(3600000, 120000 * Math.pow(2, job.attempts - 1)));
  active.delete(job.id);
  save(job);
  store.event({ rssId: job.rssId, clientId: job.clientId, hash: job.hash, name: job.name, outcome: job.state, reason: job.error });
  if (definite && job.reseed) store.remove('relation', job.id);
}

async function lookup (client, hash) {
  if (!client || !client.status) throw new Error('下载器离线');
  if (client._client.type === 'qBittorrent') return client.client.getTorrent(client.clientUrl, client.cookie, hash);
  const data = await client.client.getMaindata(client.clientUrl, client.cookie);
  if (!data || !Array.isArray(data.torrents)) throw new Error('下载器未返回有效种子列表');
  return data.torrents.find(t => t.hash.toLowerCase() === hash.toLowerCase());
}

function completed (torrent) {
  return torrent && +torrent.size > 0 && (+torrent.progress >= 1 || +torrent.completed >= +torrent.size) && !/checking|allocating|moving|error|missing/i.test(torrent.state || '');
}

async function tag (client, hash, value) {
  const current = await lookup(client, hash);
  if (!current) return false;
  if (!String(current.tags || '').split(',').map(s => s.trim()).includes(value)) await client.addTorrentTag(hash, value);
  const check = await lookup(client, hash);
  if (!check || !String(check.tags || '').split(',').map(s => s.trim()).includes(value)) throw new Error(value + ' 标签未确认');
  return true;
}

async function reconcile (job, client) {
  if (active.has(job.id) || terminal.includes(job.state)) return;
  const target = await lookup(client, job.hash);
  if (!target) {
    if (['tags', 'verifying'].includes(job.state)) {
      job.state = 'stopped';
      job.error = '目标种子已不存在，停止补标，不重新下载';
      capacity.releaseHash(client.id, job.hash);
      store.remove('relation', job.id);
    } else if (Date.now() >= job.nextAt) {
      capacity.releaseHash(client.id, job.hash);
      if (job.reseed) store.remove('relation', job.id);
      job.state = job.attempts >= (job.rssId ? 6 : 5) ? 'stopped' : 'failed';
      job.checkedFailure = true;
      job.error = '已实时查询原下载器，未找到种子；仅在重新满足当前规则时重试';
    }
    save(job);
    return;
  }
  job.targetObserved = true;
  capacity.releaseHash(client.id, job.hash);
  if (!job.reseed) {
    job.state = 'done';
    job.error = '';
    save(job);
    return;
  }
  const relation = store.get('relation', job.id) || { clientId: client.id, sourceHash: job.reseed.sourceHash, targetHash: job.hash, savePath: job.request.savePath };
  relation.state = 'active';
  store.put('relation', job.id, relation);
  if (job.reseed.mode !== 'fast') {
    if (!job.recheckRequested) {
      await client.client.recheckTorrent(client.clientUrl, client.cookie, job.hash);
      job.recheckRequested = true;
      job.state = 'verifying';
      job.verifyStartedAt = Date.now();
      job.nextAt = Date.now() + 60000;
      save(job);
      return;
    }
    if (!completed(target)) {
      if (!/checking|allocating|moving/i.test(target.state || '') && Date.now() - job.verifyStartedAt > 60000 && /paused|stopped|error|missing/i.test(target.state || '')) {
        await client.pauseTorrent(job.hash);
        job.state = 'verificationFailed';
        job.error = '校验未通过，保持暂停，禁止自动补下载';
      } else if (Date.now() - job.verifyStartedAt > 6 * 3600000) {
        await client.pauseTorrent(job.hash);
        job.state = 'verificationFailed';
        job.error = '校验超过六小时，请人工检查；保持暂停';
      }
      job.nextAt = Date.now() + 60000;
      save(job);
      return;
    }
  }
  job.state = 'tags';
  if (!await tag(client, job.hash, 'Reseed')) throw new Error('新种在标记前消失');
  job.reseedConfirmed = true;
  save(job);
  if (job.reseed.resume && !job.resumed && (!job.rssId || !global.runningRss[job.rssId]?.paused)) {
    await client.resumeTorrent(job.hash);
    const running = await lookup(client, job.hash);
    if (!running || /paused|stopped|error|missing/i.test(running.state || '')) throw new Error('新种启动状态尚未确认');
    job.resumed = true;
    save(job);
  }
  const source = await lookup(client, job.reseed.sourceHash);
  if (!source) {
    job.error = '原种已不存在，保留 Reseed，停止补 Brseed';
  } else {
    if (!await tag(client, job.reseed.sourceHash, 'Brseed')) throw new Error('原种在补标前消失');
    job.error = '';
  }
  job.state = 'done';
  save(job);
  store.event({ rssId: job.rssId, clientId: client.id, hash: job.hash, name: job.name, outcome: 'reseedConfirmed', reason: job.error });
}

async function recordHistory (job) {
  if (!history || !job.reseed || ['sending', 'uncertain'].includes(job.state) || (!job.httpAccepted && !job.targetObserved)) return;
  const note = job.state === 'stopped' ? '辅种（已停止恢复）: ' + job.error : job.state === 'verificationFailed' ? '辅种（校验失败，保持暂停）' : job.state === 'done' ? '辅种' + (job.error ? ': ' + job.error : '') : job.error ? '辅种（标签或校验待恢复）: ' + job.error : '辅种（等待校验或标签确认）';
  const recordType = !job.targetObserved && ['failed', 'stopped'].includes(job.state) ? 3 : 1;
  const resultNote = recordType === 3 ? '辅种（添加未确认或失败）: ' + job.error : note;
  const existing = await history.getRecord('SELECT id FROM torrents WHERE hash=? AND rss_id=? AND record_type IN (1,3)', [job.hash, job.rssId]);
  if (existing) await history.runRecord('UPDATE torrents SET record_note=?,record_type=? WHERE hash=? AND rss_id=? AND record_type IN (1,3)', [resultNote, recordType, job.hash, job.rssId]);
  else await history.runRecord('INSERT INTO torrents (hash,name,size,rss_id,category,link,record_time,add_time,record_type,record_note) VALUES (?,?,?,?,?,?,?,?,?,?)', [job.hash, job.name, job.request.size || 0, job.rssId || '', job.category || '', job.link || '', Math.floor(Date.now() / 1000), Math.floor(job.createdAt / 1000), recordType, resultNote]);
}

async function tick () {
  if (ticking) return;
  ticking = true;
  try {
    const jobs = store.list('job').filter(job => !terminal.includes(job.state) && (job.state !== 'failed' || !job.checkedFailure) && job.nextAt <= Date.now() && (!job.rssId || global.runningRss[job.rssId]) && global.runningClient[job.clientId]?.status).sort((a, b) => a.nextAt - b.nextAt).slice(0, 5);
    for (const job of jobs) {
      if (recovering.has(job.id)) continue;
      if (job.rssId && !global.runningRss[job.rssId]) continue;
      const client = global.runningClient[job.clientId];
      recovering.add(job.id);
      try {
        await reconcile(job, client);
        await recordHistory(job);
      } catch (error) {
        job.error = safeError(error);
        job.recoveryAttempts = (job.recoveryAttempts || 0) + 1;
        job.nextAt = Date.now() + Math.min(3600000, 60000 * Math.pow(2, Math.min(job.recoveryAttempts, 6)));
        if (job.reseed && job.recoveryAttempts >= 24 && ['tags', 'verifying'].includes(job.state)) job.state = 'stopped';
        save(job);
        try { await recordHistory(job); } catch (ignored) {}
      } finally {
        recovering.delete(job.id);
      }
    }
  } finally {
    ticking = false;
  }
}

function forFeed (rssId, hash) {
  return store.list('job').find(job => job.rssId === rssId && String(job.feedHash).toLowerCase() === String(hash).toLowerCase());
}

async function action (id, operation) {
  if (active.has(id) || recovering.has(id)) throw new Error('任务正在处理，请稍后重试');
  recovering.add(id);
  try { return await performAction(id, operation); } finally { recovering.delete(id); }
}

async function checkRetry (id, client) {
  if (active.has(id) || recovering.has(id)) throw new Error('添加任务正在核实，请稍后重试');
  recovering.add(id);
  try {
    const job = store.get('job', id);
    await reconcile(job, client);
    await recordHistory(job);
    return job;
  } finally { recovering.delete(id); }
}

async function performAction (id, operation) {
  const job = store.get('job', id);
  if (!job || active.has(id)) throw new Error('任务不存在或请求正在执行');
  if (operation === 'stop') {
    job.state = 'stopped';
    job.error = '用户停止恢复；未知请求的预占不会自动释放';
  } else if (operation === 'recheck') {
    if (!job.reseed || job.state !== 'verificationFailed') throw new Error('仅校验失败的辅种可以重新校验');
    const client = global.runningClient[job.clientId];
    if (!await lookup(client, job.hash)) throw new Error('目标种子已不存在');
    await client.pauseTorrent(job.hash);
    job.state = 'accepted';
    job.recheckRequested = false;
    job.error = '';
    job.nextAt = Date.now();
    job.recoveryAttempts = 0;
  } else if (operation === 'retry') {
    if (job.state === 'verificationFailed') throw new Error('校验失败的种子需要人工核验，不允许自动重下');
    if (job.rssId && !global.runningRss[job.rssId]) throw new Error('请先启用对应 RSS');
    const client = global.runningClient[job.clientId];
    const target = await lookup(client, job.hash);
    if (target) {
      job.state = job.reseed ? (job.recheckRequested ? 'verifying' : 'accepted') : 'done';
    } else {
      if (Date.now() - job.updatedAt < 120000) throw new Error('请求结果可能仍在处理中，请至少等待两分钟');
      capacity.releaseHash(job.clientId, job.hash);
      if (job.reseedConfirmed) throw new Error('已确认辅种的目标种子消失，不允许重新下载');
      job.state = 'failed';
      job.attempts = 0;
      job.error = '等待满足当前 RSS 规则后重试';
      if (!job.rssId) job.error = '已核实不存在并释放预占，请从原入口重新推送';
    }
    job.nextAt = Date.now();
    job.recoveryAttempts = 0;
  } else throw new Error('未知操作');
  save(job);
  if (operation === 'retry' && job.rssId && job.state === 'failed') require('./rss-retry').restart(job.rssId, job.feedHash);
  return job;
}

module.exports = { begin, accepted, failed, lookup, completed, reconcile, checkRetry, tick, forFeed, action, jobId, save, safeError, recordHistory, setHistory: adapter => { history = adapter; }, end: id => active.delete(id) };
