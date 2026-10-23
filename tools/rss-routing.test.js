const assert = require('assert').strict;
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const capacity = require('../app/libs/capacity');
const routing = require('../app/libs/rss-routing');

let serial = 0;
function client (options = {}) {
  return {
    id: 'test-' + serial++,
    alias: '测试下载器',
    status: true,
    _client: {},
    maxLeechNum: 0,
    minFreeSpace: 0,
    maindata: { torrents: [], leechingCount: 0, freeSpaceOnDisk: 1000 },
    capacityUpdatedAt: Date.now(),
    avgUploadSpeed: 0,
    avgDownloadSpeed: 0,
    ...options
  };
}

function load (file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module,
    exports: module.exports,
    global,
    Buffer,
    Date,
    require: name => {
      if (Object.prototype.hasOwnProperty.call(mocks, name)) return mocks[name];
      throw new Error('Unexpected dependency: ' + name);
    }
  }, { filename: file });
  return module.exports;
}

async function main () {
  const a = client({ maxLeechNum: 1 });
  const task = { clientArr: [a.id], clientSortBy: 'leechingCount' };
  const clients = { [a.id]: a };
  assert.equal(routing.select(task, { size: 100 }, {}, clients).client, a);
  assert.equal(routing.select(task, { size: 100 }, { clientArr: ['outside'] }, clients).client, undefined);
  const b = client();
  clients[b.id] = b;
  assert.equal(routing.select(task, { size: 100 }, { client: b.id }, clients).client, b, 'legacy override');
  assert.equal(routing.select(task, { size: 100 }, { clientArr: [b.id] }, clients).client, undefined, 'new groups require task membership');
  // Avoid reseed hands the excluded ids in, so a machine that already holds the
  // files never wins the slot no matter how attractive it looks.
  const both = { ...task, clientArr: [a.id, b.id] };
  assert.equal(routing.select(both, { size: 100 }, {}, clients, new Set([a.id])).client, b, 'an excluded downloader is skipped');
  assert.match(routing.select(task, { size: 100 }, {}, clients, new Set([a.id])).reason, /避开辅种/, 'excluding every candidate rejects the torrent');
  assert.equal(routing.select(task, { size: 100 }, {}, clients, null).client, a, 'no exclusion set leaves routing untouched');
  assert.deepEqual(routing.orderedRules([{ id: 'a' }, { id: 'b', priority: 0 }, { id: 'c', priority: 2 }], ['b', 'a', 'c']).map(r => r.id), ['c', 'b', 'a']);
  const sorting = { ...task, clientArr: [a.id, b.id], clientSortBy: 'freeSpaceOnDisk' };
  b.maindata.freeSpaceOnDisk = 2000;
  assert.equal(routing.select(sorting, { size: 100 }, {}, clients).client, b, 'largest free disk first');
  b.maxDownloadSpeed = 10;
  b.avgDownloadSpeed = 10;
  assert.equal(routing.select(sorting, { size: 100 }, { clientArr: [b.id] }, clients).client, undefined, 'unavailable group never falls back');
  b.maxDownloadSpeed = 0;
  b.avgDownloadSpeed = 0;

  const r = capacity.reserve(a, 'HASH', 100);
  assert.throws(() => capacity.reserve(a, 'other', 100), /最大下载数量/);
  r.accepted();
  assert.equal(capacity.snapshot(a).count, 1, 'accepted but unseen request retains its slot');
  a.maindata.torrents = [{ hash: 'hash', size: 100, completed: 10 }];
  a.maindata.leechingCount = 1;
  assert.equal(capacity.snapshot(a).reserved, 0, 'observed hash reconciles reservation');
  assert.equal(capacity.snapshot(a).count, 1, 'no double count');
  assert.equal(capacity.duplicate(a, 'HASH'), 'existing');
  assert.match(capacity.reason(a, 100, { hash: 'HASH' }), /已存在于下载器/);
  assert.doesNotMatch(capacity.reason(a, 100, { hash: 'HASH' }), /等待/);

  const space = client({ _client: { capacityGuard: true }, minFreeSpace: 100 });
  space.maindata.torrents = [{ hash: 'existing', size: 400, completed: 100 }];
  assert.equal(capacity.reason(space, 600), '');
  assert.match(capacity.reason(space, 601), /预计剩余空间不足/);
  const held = capacity.reserve(space, 'new', 500);
  assert.match(capacity.reason(space, 101), /预计剩余空间不足/);
  held.release();
  assert.equal(capacity.reason(space, 101), '');
  assert.match(capacity.reason(space, 0), /大小/);
  space.capacityUpdatedAt = Date.now() - 121000;
  assert.match(capacity.reason(space, 10), /过期/);
  const old = client();
  assert.equal(capacity.reason(old, 0), '', 'space protection is opt-in');
  const unknown = capacity.reserve(old, 'unknown', 100);
  unknown.uncertain();
  assert.match(capacity.reason(old, 100, { hash: 'UNKNOWN' }), /正在添加/);
  assert.equal(capacity.snapshot({ ...old }).reserved, 1, 'recreated instances share reservations');

  const relaxed = client({ _client: { capacityGuard: true, capacityMode: 'relaxed' }, minFreeSpace: 100 });
  relaxed.maindata.torrents = [{ hash: 'slow', size: 10000, completed: 100, state: 'pausedDL' }];
  assert.equal(capacity.snapshot(relaxed).free, 1000, 'relaxed mode uses actual disk free space without subtracting unfinished downloads');
  assert.equal(capacity.reason(relaxed, 100000), '', 'relaxed mode does not subtract the proposed torrent size');
  assert.equal(capacity.reason(relaxed, 0), '', 'unknown future size does not block relaxed mode');
  const relaxedSlot = capacity.reserve(relaxed, 'relaxed-pending', 5000);
  relaxedSlot.uncertain();
  assert.equal(capacity.snapshot(relaxed).free, 1000, 'unconfirmed additions do not reserve disk bytes in relaxed mode');
  assert.equal(capacity.snapshot(relaxed).reserved, 1, 'pending requests still count toward task limits');
  assert.match(capacity.reason(relaxed, 1, { hash: 'relaxed-pending' }), /正在添加/);
  assert.match(capacity.reason(relaxed, 1, { maxCount: 1 }), /RSS 下载任务上限/);
  relaxed._client.capacityMode = 'strict';
  assert.equal(capacity.snapshot(relaxed).free, -13900, 'switching back to strict mode accounts for existing pending bytes');
  assert.match(capacity.reason(relaxed, 1), /预计剩余空间不足/);
  relaxed._client.capacityMode = 'relaxed';
  relaxed.maindata.freeSpaceOnDisk = 100;
  assert.match(capacity.reason(relaxed, 1), /最小剩余空间/);
  relaxed.maindata.freeSpaceOnDisk = 0;
  relaxed.minFreeSpace = 0;
  assert.match(capacity.reason(relaxed, 1), /当前剩余空间不足/);
  relaxed.maindata.freeSpaceOnDisk = NaN;
  assert.match(capacity.reason(relaxed, 1), /无法确认下载器剩余空间/);
  relaxed.maindata.freeSpaceOnDisk = 800;
  relaxed.capacityUpdatedAt = Date.now() - 121000;
  assert.match(capacity.reason(relaxed, 1), /过期/);
  relaxed.capacityUpdatedAt = Date.now();
  const strictChoice = client({ _client: { capacityGuard: true } });
  strictChoice.maindata.torrents = [{ hash: 'incomplete', size: 800, completed: 0 }];
  const modeTask = { clientArr: [strictChoice.id, relaxed.id], clientSortBy: 'freeSpaceOnDisk' };
  const modeClients = { [strictChoice.id]: strictChoice, [relaxed.id]: relaxed };
  assert.equal(routing.select(modeTask, { size: 100 }, {}, modeClients).client, relaxed, 'routing sorts by the configured space calculation mode');
  strictChoice._client.capacityGuard = false;
  assert.equal(routing.select(modeTask, { size: 100 }, {}, modeClients).client, strictChoice, 'disabled space protection retains original raw free space sorting');
  relaxedSlot.release();

  let currentUnix = 1000;
  const moment = () => ({ unix: () => currentUnix });
  moment.unix = require('moment').unix;
  const logger = { info () {}, debug () {}, error () {} };
  let release;
  let requests = 0;
  const transport = { addTorrent: async () => { requests++; await new Promise(resolve => { release = resolve; }); return { statusCode: 200 }; } };
  const Client = load('app/common/Client.js', {
    '../libs/client/qb': transport,
    '../libs/client/de': {},
    '../libs/client/tr': {},
    '../libs/util': { runRecord: async () => { throw new Error('database unavailable'); } },
    '../libs/redis': {},
    moment,
    '../libs/logger': logger,
    'node-cron': {},
    './Push': {},
    '../libs/capacity': capacity,
    '../libs/brush-recovery': require('../app/libs/brush-recovery'),
    '../libs/request-limit': require('../app/libs/request-limit'),
    '../libs/delete-protection': require('../app/libs/delete-protection'),
    '../libs/brush-store': require('../app/libs/brush-store')
  });
  const live = Object.assign(Object.create(Client.prototype), client({ maxLeechNum: 1 }), { client: transport, login () {} });
  let loginRequests = 0;
  let polls = 0;
  let finishLogin;
  const stateClient = Object.assign(Object.create(Client.prototype), client({ status: false, maindata: null }), {
    cookie: null,
    trackerStatus: {},
    monitor: {},
    ntf: { clientLoginError: async () => {} },
    errorCount: 0,
    client: {
      login: async () => { loginRequests++; return new Promise(resolve => { finishLogin = resolve; }); },
      getMaindata: async () => { polls++; return { torrents: [], freeSpaceOnDisk: 1000, uploadSpeed: 0, downloadSpeed: 0 }; }
    }
  });
  const initialPoll = stateClient.getMaindata();
  const concurrentPoll = stateClient.getMaindata();
  assert.equal(loginRequests, 1, 'initial polling shares one login instead of racing sessions');
  finishLogin('session');
  await Promise.all([initialPoll, concurrentPoll]);
  assert.equal(polls, 1, 'login immediately continues to fetch data without waiting for the next cron tick');
  assert.equal(stateClient.status, true);
  assert.equal(stateClient.maindata.torrents.length, 0);

  let finishPoll;
  stateClient.client.getMaindata = async () => { polls++; return new Promise((resolve, reject) => { finishPoll = reject; }); };
  const failingPoll = stateClient.getMaindata();
  const overlappingPoll = stateClient.getMaindata();
  assert.equal(polls, 2, 'overlapping refreshes share one request; an older failure cannot overwrite a newer success');
  finishPoll(new Error('temporary timeout https://private.example/passkey'));
  await Promise.all([failingPoll, overlappingPoll]);
  assert.match(capacity.reason(stateClient, 100), /状态读取失败.*temporary timeout/);
  assert.equal(capacity.reason(stateClient, 100).includes('private.example'), false);
  assert.throws(() => capacity.reserve(stateClient, 'not-sent', 100), error => error.code === 'CAPACITY_UNAVAILABLE');
  stateClient.client.getMaindata = async () => { polls++; return { torrents: [], freeSpaceOnDisk: 1000, uploadSpeed: 0, downloadSpeed: 0 }; };
  await routing.refresh({ clientArr: [stateClient.id], acceptRules: [] }, { [stateClient.id]: stateClient });
  assert.equal(stateClient.status, true, 'RSS rechecks a failed cached state before rejecting the downloader');
  assert.equal(capacity.reason(stateClient, 100), '');
  stateClient.status = false;
  stateClient.maindata = null;
  let recoveredAdds = 0;
  stateClient.client.addTorrent = async () => { recoveredAdds++; return { statusCode: 200 }; };
  await stateClient.addTorrent('url', 'refresh-before-send', false, 0, 0, '', '', false, false, { size: 100 });
  assert.equal(recoveredAdds, 1, 'refresh again before final admission when state changed after RSS selection');
  const adding = live.addTorrent('url', 'one', false, 0, 0, '', '', false, false, { size: 100 });
  await assert.rejects(live.addTorrent('url', 'two', false), /最大下载数量/);
  release();
  await adding;
  assert.equal(requests, 1, 'concurrent admission prevented before HTTP');
  assert.equal(capacity.snapshot(live).reserved, 1, 'database failure does not undo accepted request');

  const failed = Object.assign(Object.create(Client.prototype), client(), { client: { addTorrent: async () => ({ statusCode: 400 }) }, login () {} });
  await assert.rejects(failed.addTorrent('url', 'bad', false), /状态码/);
  assert.equal(capacity.snapshot(failed).reserved, 0, 'explicit rejection releases slot');
  failed.client.addTorrent = async () => { throw new Error('timeout'); };
  await assert.rejects(failed.addTorrent('url', 'timeout', false), /timeout/);
  assert.equal(capacity.snapshot(failed).reserved, 1, 'unknown outcome retains slot');
  failed.client.addTorrent = async () => ({ statusCode: 500 });
  await assert.rejects(failed.addTorrent('url', 'server-error', false), /状态码/);
  assert.equal(capacity.snapshot(failed).reserved, 2, 'server error may occur after request acceptance');
  const fileClient = Object.assign(Object.create(Client.prototype), client({ maxLeechNum: 1 }), {
    client: { addTorrentByTorrentFile: async () => ({ statusCode: 204 }), addTorrent: async () => ({ statusCode: 204 }) }
  });
  await fileClient.addTorrentByTorrentFile('file', 'file-hash', false, 0, 0, '', '', false, false, { size: 100 });
  await assert.rejects(fileClient.addTorrent('url', 'other', false), /最大下载数量/);
  const asyncClient = Object.assign(Object.create(Client.prototype), client(), {
    client: { addTorrent: async () => ({ statusCode: 202 }), addTorrentByTorrentFile: async () => ({ statusCode: 202 }) }
  });
  await asyncClient.addTorrent('url', 'async-url', false, 0, 0, '', '', false, false, { size: 100 });
  await asyncClient.addTorrentByTorrentFile('file', 'async-file', false, 0, 0, '', '', false, false, { size: 100 });
  assert.equal(capacity.snapshot(asyncClient).reserved, 2, '202 Accepted retains both URL and file reservations until observed');
  const asyncJobs = require('../app/libs/brush-store').list('job').filter(job => job.clientId === asyncClient.id);
  assert.equal(asyncJobs.length, 2);
  assert.equal(asyncJobs.every(job => job.state === 'accepted'), true, '202 Accepted is queued for reconciliation, not treated as an error');
  const scheduleTasks = global.runningRss;
  try {
    let allowed = true;
    let sent = 0;
    let freeQueue;
    const guarded = Object.assign(Object.create(Client.prototype), client(), {
      client: { addTorrent: async () => { sent++; return { statusCode: 200 }; } }
    });
    global.runningRss = { scheduled: { canRun: () => allowed } };
    const store = require('../app/libs/brush-store');
    const queue = require('../app/libs/request-limit');
    const holding = queue.run('add:' + guarded.id, 1, () => new Promise(resolve => { freeQueue = resolve; }));
    const queuedAdd = guarded.addTorrent('url', 'schedule-queued', false, 0, 0, '', '', false, false, { size: 100, rssId: 'scheduled' });
    const rejected = assert.rejects(queuedAdd, error => error.code === 'RSS_SCHEDULE_PAUSED');
    while (!store.get('job', guarded.id + ':schedule-queued')) await new Promise(resolve => setImmediate(resolve));
    allowed = false;
    freeQueue();
    await holding;
    await rejected;
    assert.equal(sent, 0, 'time window is checked again after waiting in the downloader request queue');
    assert.equal(capacity.snapshot(guarded).reserved, 0, 'a request blocked before sending releases its reservation');
    assert.equal(store.get('job', guarded.id + ':schedule-queued').attempts, 0, 'a blocked send does not consume an add attempt');
    allowed = true;
    global.runningRss.scheduled = { canRun: () => true, allowsClient: () => allowed };
    const groupHolding = queue.run('add:' + guarded.id, 1, () => new Promise(resolve => { freeQueue = resolve; }));
    const groupAdd = guarded.addTorrent('url', 'group-queued', false, 0, 0, '', '', false, false, { size: 100, rssId: 'scheduled' });
    const groupRejected = assert.rejects(groupAdd, error => error.code === 'CAPACITY_REJECTED' && /组或规则已变更/.test(error.message));
    while (!store.get('job', guarded.id + ':group-queued')) await new Promise(resolve => setImmediate(resolve));
    allowed = false;
    freeQueue();
    await groupHolding;
    await groupRejected;
    assert.equal(sent, 0, 'removed group members are blocked at final HTTP dispatch');
    assert.equal(capacity.snapshot(guarded).reserved, 0, 'removed member releases the unexecuted reservation');
  } finally { global.runningRss = scheduleTasks; }
  const metadata = client();
  capacity.reserve(metadata, 'metadata', 100).accepted();
  metadata.maindata.torrents = [{ hash: 'metadata', size: 0, completed: 0 }];
  assert.equal(capacity.snapshot(metadata).reserved, 1, 'wait for metadata before releasing reserved disk');

  const RuleMod = load('app/model/RssRuleMod.js', { fs: {}, path: {}, '../libs/util': {}, '../libs/downloader-groups': require('../app/libs/downloader-groups') });
  const ruleMod = new RuleMod();
  assert.equal(ruleMod.normalize({ client: 'legacy', clientArr: ['legacy'] }).client, 'legacy');
  assert.equal(ruleMod.normalize({ client: 'legacy', clientArr: ['new'] }).client, undefined);
  assert.equal(ruleMod.normalize({ client: 'legacy', clientArr: [] }).client, undefined);
  assert.throws(() => ruleMod.normalize({ clientArr: 'invalid' }), /数组/);
  assert.throws(() => ruleMod.normalize({ priority: 'invalid' }), /数字/);
  const schedule = require('../app/libs/rss-schedule');
  const clientMocks = { fs: {}, path: {}, '../common/Client': Client, '../libs/capacity': capacity, '../libs/util': {}, '../libs/downloader-groups': require('../app/libs/downloader-groups'), '../libs/rss-schedule': schedule };
  const ClientMod = load('app/model/ClientMod.js', clientMocks);
  assert.throws(() => new ClientMod().add({ capacityMode: 'invalid' }), /未知空间计算模式/);
  assert.throws(() => new ClientMod().modify({ capacityMode: 'invalid' }), /未知空间计算模式/);

  // A task that is switched off never pushes a torrent, so it must not lock the
  // downloader switch even though it still blocks deletion.
  const rssTasks = [{ id: 'on', enable: true, clientArr: ['c1'] }, { id: 'off', enable: false, clientArr: ['c1'] }];
  const lockMod = load('app/model/ClientMod.js', {
    ...clientMocks,
    '../libs/util': { listRss: () => rssTasks, listDouban: () => [], listClient: () => [{ id: 'c1', enable: true }], listWatch: () => [] },
    '../libs/downloader-groups': { list: () => [] }
  });
  const savedRunningClient = global.runningClient;
  const savedIgnore = global.ignoreDependCheck;
  global.runningClient = {};
  global.ignoreDependCheck = false;
  let [entry] = new lockMod().list();
  assert.equal(entry.enableLocked, true, 'a running task locks the downloader switch');
  assert.equal(entry.used, true, 'a running task blocks deletion');
  rssTasks[0].enable = false;
  [entry] = new lockMod().list();
  assert.equal(entry.enableLocked, false, 'a switched-off task leaves the switch free');
  assert.equal(entry.used, true, 'a switched-off task still blocks deletion');
  rssTasks[0].enable = true;
  rssTasks[0].expireEnabled = true;
  rssTasks[0].expireAt = '2000-01-01T00:00:00';
  [entry] = new lockMod().list();
  assert.equal(entry.enableLocked, false, 'an expired task leaves the switch free');
  global.runningClient = savedRunningClient;
  global.ignoreDependCheck = savedIgnore;

  let records = [];
  let fetchedSettings;
  let fetchedOptions;
  let fetchFailure;
  let emptyFeed = false;
  const autoReseed = { attempt: async () => false, waiting: () => [] };
  const avoidReseed = { scan: async () => null };
  const torrent = { name: 'example', size: 100, hash: 'rss-test', link: 'link' };
  const Rss = load('app/common/Rss.js', {
    '../libs/rss': { getTorrents: async (url, settings, options) => { fetchedSettings = settings; fetchedOptions = options; if (fetchFailure) throw fetchFailure; return emptyFeed ? [] : [{ ...torrent }]; } },
    '../libs/util': { getRecord: async () => null, runRecord: async (...args) => records.push(args), uuid: { v4: () => 'uuid' } },
    '../libs/logger': logger,
    '../libs/redis': {},
    'node-cron': {},
    '../libs/torrent-response': require('../app/libs/torrent-response'),
    fs: {},
    path: {},
    moment,
    './Push': {},
    '../libs/rss-routing': routing,
    '../libs/auto-reseed': autoReseed,
    '../libs/avoid-reseed': avoidReseed,
    '../libs/rss-retry': require('../app/libs/rss-retry'),
    '../libs/rss-schedule': require('../app/libs/rss-schedule'),
    '../libs/downloader-groups': require('../app/libs/downloader-groups'),
    '../libs/brush-recovery': require('../app/libs/brush-recovery'),
    '../libs/brush-store': require('../app/libs/brush-store')
  });
  const savedClients = global.runningClient;
  try {
    global.runningClient = clients;
    const rss = Object.assign(Object.create(Rss.prototype), task, {
      _rss: {},
      urls: ['rss'],
      id: 'task',
      acceptRules: [{ id: 'route', alias: '指定机器', clientArr: [b.id] }],
      rejectRules: [],
      addCount: 0,
      addCountPerHour: 20,
      lastRssTime: 1000,
      maxSleepTime: 120,
      ntf: { rejectTorrent: async () => {} },
      _fitRule: () => true
    });
    let pushed = false;
    rss._pushTorrent = async () => { pushed = true; };
    await rss.rss([torrent]);
    assert.equal(pushed, false, 'actual RSS execution does not fall back outside rule group');
    assert.match(records[0][1][7], /不回退/);
    rss.clientArr = [a.id, b.id];
    const preview = await rss.dryrun();
    assert.equal(fetchedSettings, rss._rss, 'dry run passes task replacement settings to RSS parsing');
    assert.equal(preview[0].downloader, b.alias);
    assert.equal(preview[0].matchedRule, '指定机器');
    assert.equal(fetchedOptions.throwOnError, true, 'dry run must not hide RSS failures as an empty feed');
    let lifecycleAdds = 0;
    const lifecycle = Object.assign(Object.create(Rss.prototype), rss, {
      id: 'restart-rss',
      acceptRules: [],
      lastRssTime: 0,
      fetchErrorAt: null,
      _pushTorrent: async () => { lifecycleAdds++; }
    });
    try {
      currentUnix = 10000;
      await lifecycle.rss();
      assert.equal(lifecycleAdds, 0, 'a fresh instance has no previous fetch, so its first batch is rejected as a long sleep');
      assert.equal(lifecycle.lastRssTime, 10000);
      currentUnix += 30;
      await lifecycle.rss();
      assert.equal(lifecycleAdds, 1);
      fetchFailure = new Error('RSS temporarily unavailable');
      currentUnix += 10;
      await assert.rejects(lifecycle.rss(), /RSS temporarily unavailable/);
      assert.equal(lifecycle.lastRssTime, 10030, 'RSS errors never refresh the last successful fetch time');
      assert.equal(lifecycle.fetchErrorAt, 10040);
      currentUnix += 180;
      await assert.rejects(lifecycle.rss(), /RSS temporarily unavailable/);
      assert.equal(lifecycle.fetchErrorAt, 10040, 'repeated failures retain the initial failure time');
      fetchFailure = null;
      await lifecycle.rss();
      assert.equal(lifecycleAdds, 1, 'long RSS outage still rejects the first recovered batch');
      const outageNote = records[records.length - 1][1][7];
      assert.match(outageNote, /上次成功获取: \d{4}-\d{2}-\d{2}/);
      assert.match(outageNote, /本次成功获取: \d{4}-\d{2}-\d{2}/);
      assert.match(outageNote, /实际间隔: 190 秒；配置阈值: 120 秒/);
      assert.equal(lifecycle.lastRssTime, currentUnix);
      currentUnix += 30;
      await lifecycle.rss();
      assert.equal(lifecycleAdds, 2, 'the next healthy batch is processed normally');
      const successAt = lifecycle.lastRssTime;
      currentUnix += 300;
      await lifecycle.rss([torrent], true);
      assert.equal(lifecycle.lastRssTime, successAt, 'retry processing cannot mask a failing RSS feed');
      lifecycle.lastRssTime = 0;
      lifecycle.fetchErrorAt = null;
      fetchFailure = new Error('failed during startup');
      await assert.rejects(lifecycle.rss(), /failed during startup/);
      const beforeRecovery = lifecycleAdds;
      currentUnix += 121;
      fetchFailure = null;
      await lifecycle.rss();
      assert.equal(lifecycleAdds, beforeRecovery, 'startup with prolonged fetch errors is distinguished from a healthy restart');
      assert.match(records[records.length - 1][1][7], /上次成功获取: 无（启动后尚未成功）；首次获取失败:/);
      assert.match(records[records.length - 1][1][7], /实际间隔: 121 秒/);
      currentUnix += 30;
      emptyFeed = true;
      await lifecycle.rss();
      assert.equal(lifecycle.lastRssTime, currentUnix, 'a successful empty feed refreshes health');
      currentUnix += 30;
      emptyFeed = false;
      await lifecycle.rss();
      assert.equal(lifecycleAdds, beforeRecovery + 1);
    } finally {
      currentUnix = 1000;
      fetchFailure = null;
      emptyFeed = false;
    }
    const reseedStore = require('../app/libs/brush-store');
    const realReseed = require('../app/libs/auto-reseed');
    const reseedAttempts = [];
    let ordinaryAdds = 0;
    const sleepNotices = [];
    const afterOutage = Object.assign(Object.create(Rss.prototype), rss, {
      id: 'sleep-only-reseed',
      _rss: { reseedWaitMinutes: 60, reseedRespectRules: true },
      onlyReseed: true,
      acceptRules: [],
      lastRssTime: 1000,
      _pushTorrent: async () => { ordinaryAdds++; },
      ntf: { rejectTorrent: async (...args) => sleepNotices.push(args[3]) }
    });
    try {
      currentUnix = 2000;
      autoReseed.attempt = async (...args) => { reseedAttempts.push(args[1].hash); return realReseed.attempt(...args); };
      autoReseed.waiting = realReseed.waiting;
      const beforeReseedHistory = records.length;
      await afterOutage.rss();
      assert.equal(reseedAttempts.length, 1, 'only-reseed still attempts matching after a long RSS gap');
      const waitId = afterOutage.id + ':' + torrent.hash;
      assert.ok(reseedStore.get('wait', waitId), 'unmatched candidate is retained for reseeding instead of rejected');
      emptyFeed = true;
      currentUnix += 1000;
      await afterOutage.rss();
      assert.equal(reseedAttempts.length, 2, 'saved waiting candidate is checked even when the recovered feed is empty');
      assert.ok(reseedStore.get('wait', waitId));
      assert.equal(records.length, beforeReseedHistory, 'no permanent rejection history for waiting reseeds');
      assert.equal(sleepNotices.length, 0);
      assert.equal(ordinaryAdds, 0);

      emptyFeed = false;
      autoReseed.attempt = async () => { reseedAttempts.push('matched'); return true; };
      afterOutage.id = 'sleep-auto-reseed';
      afterOutage.onlyReseed = false;
      afterOutage.autoReseed = true;
      afterOutage.lastRssTime = 1000;
      await afterOutage.rss();
      assert.equal(reseedAttempts[2], 'matched', 'automatic reseed is tried before the ordinary download sleep guard');
      assert.equal(records.length, beforeReseedHistory);
      assert.equal(ordinaryAdds, 0);

      autoReseed.attempt = async () => false;
      afterOutage.id = 'sleep-fallback';
      afterOutage.lastRssTime = 1000;
      await afterOutage.rss();
      assert.equal(ordinaryAdds, 0, 'unmatched auto-reseed cannot fall back to ordinary downloading after an outage');
      assert.match(records[records.length - 1][1][7], /最长休眠时间.*实际间隔: 2000 秒；配置阈值: 120 秒/);
      assert.equal(sleepNotices[0], records[records.length - 1][1][7], 'notification and persisted history carry identical timing diagnostics');

      afterOutage.id = 'sleep-reject-rule';
      afterOutage.onlyReseed = true;
      afterOutage.lastRssTime = 1000;
      afterOutage.rejectRules = [{ alias: '拒绝优先' }];
      autoReseed.attempt = async () => { assert.fail('reject rules must run before reseeding'); };
      await afterOutage.rss();
      assert.match(records[records.length - 1][1][7], /拒绝规则: 拒绝优先/);
      afterOutage.id = 'sleep-accept-rule';
      afterOutage.lastRssTime = 1000;
      afterOutage.rejectRules = [];
      afterOutage.acceptRules = [{ alias: '必须匹配' }];
      afterOutage._fitRule = () => false;
      await afterOutage.rss();
      assert.match(records[records.length - 1][1][7], /不符合所有选择规则/);
      assert.doesNotMatch(records[records.length - 1][1][7], /最长休眠/);
      assert.equal(ordinaryAdds, 0, 'only-reseed never reaches ordinary download fallback');
    } finally {
      autoReseed.attempt = async () => false;
      autoReseed.waiting = () => [];
      for (const entry of reseedStore.list('wait').filter(entry => entry.rssId === 'sleep-only-reseed')) reseedStore.remove('wait', entry.id);
      currentUnix = 1000;
      emptyFeed = false;
    }
    records = [];
    await rss.rss([torrent]);
    assert.equal(pushed, true);
    rss.rejectRules = [{ alias: '拒绝' }];
    pushed = false;
    await rss.rss([torrent]);
    assert.equal(pushed, false, 'reject rules take precedence');
    rss.rejectRules = [];
    let sent;
    b.addTorrent = async (...args) => { sent = args; };
    rss.ntf.addTorrent = async () => {};
    await Rss.prototype._pushTorrent.call(rss, { ...torrent, url: 'download-url' }, b, { savePath: '/rule', category: 'rule-category' });
    assert.equal(sent[0], 'download-url');
    assert.equal(sent[5], '/rule');
    assert.equal(sent[6], 'rule-category');
    assert.equal(sent[9].size, 100);
    rss.useCustomRegex = true;
    rss._rss.regexScope = 'xml';
    rss.regexStr = '/download/g';
    rss.replaceStr = 'must-not-apply-again';
    await Rss.prototype._pushTorrent.call(rss, { ...torrent, url: 'download-url' }, b, {});
    assert.equal(sent[0], 'download-url', 'XML mode must not apply the old download-link replacement a second time');
    delete rss._rss.regexScope;
    await Rss.prototype._pushTorrent.call(rss, { ...torrent, url: 'download-url' }, b, {});
    assert.equal(sent[0], 'must-not-apply-again-url', 'legacy configurations still replace download links');
    rss.useCustomRegex = false;
    sent = undefined;
    rss._downloadTorrent = async () => ({ filepath: 'torrent-file', hash: 'real-hash', size: 110 });
    b.addTorrentByTorrentFile = async (...args) => { sent = args; };
    await Rss.prototype._pushTorrent.call(rss, { ...torrent, hash: 'fakehash-123', url: 'url' }, b, {});
    assert.equal(sent[1], 'real-hash', 'synthetic RSS hashes must resolve before reserving');
    assert.equal(sent[9].size, 110, 'file metadata size used for final admission');
    const retryQueue = require('../app/libs/rss-retry');
    const retryStore = require('../app/libs/brush-store');
    const savedRss = global.runningRss;
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      let adds = 0;
      let lookups = 0;
      let target;
      const retryClient = Object.assign(Object.create(Client.prototype), client({ _client: { type: 'qBittorrent' } }), {
        login () {},
        client: {
          getTorrent: async () => { lookups++; return target; },
          addTorrent: async () => { adds++; return { statusCode: 400 }; }
        }
      });
      global.runningClient[retryClient.id] = retryClient;
      const retryTask = Object.assign(Object.create(Rss.prototype), rss, {
        id: 'retry-task',
        clientArr: [retryClient.id],
        acceptRules: [],
        _pushTorrent: Rss.prototype._pushTorrent,
        ntf: { addTorrent: async () => {}, addTorrentError: async () => {}, rejectTorrent: async () => {} }
      });
      global.runningRss = { [retryTask.id]: retryTask };
      const retryTorrent = { ...torrent, hash: 'retry-five', url: 'url' };
      await retryTask.rss([retryTorrent]);
      assert.equal(adds, 1);
      assert.equal(retryQueue.get(retryTask.id, retryTorrent.hash).nextAt, clock + 30000);
      clock += 29999;
      await retryQueue.tick();
      assert.equal(adds, 1, 'never retry before 30 seconds');
      clock++;
      for (let i = 1; i <= 5; i++) {
        await retryQueue.tick();
        assert.equal(adds, i + 1, 'exactly one request per retry');
        clock += 30000;
      }
      await retryQueue.tick();
      await retryTask.rss([retryTorrent]);
      assert.equal(adds, 6, 'five retries after the first failure, then permanently give up');
      assert.equal(lookups, 5, 'fresh original downloader lookup before every retry');
      assert.equal(retryQueue.get(retryTask.id, retryTorrent.hash).state, 'exhausted');
      const logs = retryStore.list('event').filter(e => e.hash === retryTorrent.hash);
      assert.equal(logs.filter(e => e.outcome === 'retryStarted').length, 5);
      assert.equal(logs.filter(e => e.outcome === 'retryExhausted').length, 1);

      const late = { ...retryTorrent, hash: 'timeout-late' };
      retryClient.client.addTorrent = async () => { adds++; throw new Error('timeout https://secret.example/passkey'); };
      await retryTask.rss([late]);
      const before = adds;
      assert.equal(retryQueue.get(retryTask.id, late.hash).error.includes('secret.example'), false);
      target = { hash: late.hash, size: 100 };
      clock += 30000;
      await Promise.all([retryQueue.tick(), retryQueue.tick()]);
      assert.equal(adds, before, 'late accepted timeout must never be sent again');
      assert.equal(retryQueue.get(retryTask.id, late.hash).state, 'done');
      target = undefined;

      // Reproduce an older checked failure whose target appears later. Previously
      // every feed scan bypassed history and emitted the same rejection forever.
      const recovery = require('../app/libs/brush-recovery');
      const orphan = { ...retryTorrent, hash: 'legacy-late-target' };
      const orphanJob = recovery.begin(retryClient, orphan.hash, { size: 100 }, { rssId: retryTask.id, feedHash: orphan.hash });
      recovery.failed(orphanJob, new Error('old timeout'), false);
      clock += 30000;
      await recovery.checkRetry(orphanJob.id, retryClient);
      assert.equal(recovery.forFeed(retryTask.id, orphan.hash).checkedFailure, true);
      target = { hash: orphan.hash, size: 100 };
      retryClient.maindata.torrents = [target];
      let rejections = 0;
      retryTask.ntf.rejectTorrent = async () => { rejections++; };
      const beforeOrphan = adds;
      for (let i = 0; i < 15; i++) await retryTask.rss([orphan]);
      assert.equal(rejections, 0, 'feed scans never report a late existing target as repeated rejection');
      assert.equal(retryQueue.get(retryTask.id, orphan.hash).state, 'waiting', 'legacy retry restored exactly once');
      clock += 30000;
      await retryQueue.tick();
      assert.equal(recovery.forFeed(retryTask.id, orphan.hash).state, 'done', 'real lookup closes the old failure');
      assert.equal(retryQueue.get(retryTask.id, orphan.hash).state, 'done');
      assert.equal(adds, beforeOrphan, 'legacy migration never resends an existing torrent');
      for (let i = 0; i < 15; i++) await retryTask.rss([orphan]);
      assert.equal(rejections, 0);
      target = undefined;
      retryClient.maindata.torrents = [];

      const exhaustedOrphan = { ...orphan, hash: 'legacy-exhausted' };
      retryQueue.restore(retryTask.id, exhaustedOrphan, { ...orphanJob, state: 'failed', checkedFailure: true, attempts: 6 });
      assert.equal(retryQueue.get(retryTask.id, exhaustedOrphan.hash).state, 'exhausted', 'migration preserves the five-retry limit');
      const partialOrphan = { ...orphan, hash: 'legacy-partial' };
      retryQueue.restore(retryTask.id, partialOrphan, { ...orphanJob, state: 'failed', checkedFailure: true, attempts: 4 });
      assert.equal(retryQueue.get(retryTask.id, partialOrphan.hash).attempts, 3, 'initial request is not counted as a retry');
      retryQueue.stop(retryQueue.get(retryTask.id, partialOrphan.hash).id);

      const already = { ...orphan, hash: 'existing-without-job' };
      retryClient.maindata.torrents = [{ hash: already.hash.toUpperCase(), size: 100 }];
      await retryTask.rss([already]);
      assert.equal(rejections, 0, 'existing torrents are skipped without rejection notifications');
      assert.match(records[records.length - 1][1][7], /跳过重复添加/);
      assert.equal(adds, beforeOrphan);
      retryClient.maindata.torrents = [];

      const pendingTorrent = { ...orphan, hash: 'pending-without-job' };
      const pendingSlot = capacity.reserve(retryClient, pendingTorrent.hash, 100);
      pendingSlot.uncertain();
      const beforePendingHistory = records.length;
      for (let i = 0; i < 15; i++) await retryTask.rss([pendingTorrent]);
      assert.equal(rejections, 0, 'pending confirmations do not produce rejection spam');
      assert.equal(records.length, beforePendingHistory, 'pending is not recorded as permanently rejected');
      retryQueue.fail(retryTask.id, pendingTorrent, retryClient.id, new Error('metadata failure'));
      clock += 30000;
      await retryQueue.tick();
      assert.equal(retryQueue.get(retryTask.id, pendingTorrent.hash).state, 'waiting');
      assert.equal(retryQueue.get(retryTask.id, pendingTorrent.hash).attempts, 0, 'waiting for another addition does not consume retries');
      retryClient.maindata.torrents = [{ hash: pendingTorrent.hash, size: 100 }];
      clock += 30000;
      await retryQueue.tick();
      assert.equal(retryQueue.get(retryTask.id, pendingTorrent.hash).state, 'done');
      assert.equal(rejections, 0);
      assert.equal(adds, beforeOrphan);
      pendingSlot.release();
      retryClient.maindata.torrents = [];

      const rejectedTorrent = { ...orphan, hash: 'deduplicated-rejection' };
      retryTask.rejectRules = [{ alias: '拒绝规则' }];
      for (let i = 0; i < 15; i++) await retryTask.rss([rejectedTorrent], true);
      assert.equal(rejections, 1, 'repeated policy rejections notify only once per RSS and hash');
      const recreatedTask = Object.assign(Object.create(Rss.prototype), retryTask);
      await recreatedTask.rss([{ ...rejectedTorrent, hash: rejectedTorrent.hash.toUpperCase() }], true);
      assert.equal(rejections, 1, 'notification deduplication survives task recreation and hash casing');
      recreatedTask.id = 'another-rss-notice';
      await recreatedTask.rss([rejectedTorrent], true);
      assert.equal(rejections, 2, 'different RSS tasks retain independent notifications');
      retryTask.rejectRules = [];

      const eventual = { ...retryTorrent, hash: 'retry-success' };
      await retryTask.rss([eventual]);
      retryClient.client.addTorrent = async () => { adds++; return { statusCode: 200 }; };
      clock += 30000;
      await retryQueue.tick();
      assert.equal(retryQueue.get(retryTask.id, eventual.hash).state, 'done', 'successful retry closes the queue');
      const acceptedAdds = adds;
      clock += 30000;
      await retryQueue.tick();
      assert.equal(adds, acceptedAdds, 'successful retry does not run again');

      const blocked = { ...retryTorrent, hash: 'retry-rejected' };
      retryQueue.fail(retryTask.id, blocked, retryClient.id, new Error('metadata failure'));
      retryTask.rejectRules = [{ alias: '新增拒绝规则' }];
      clock += 30000;
      await retryQueue.tick();
      assert.equal(adds, acceptedAdds, 'current reject rules prevent any add request');
      assert.equal(retryQueue.get(retryTask.id, blocked.hash).state, 'stopped');
      retryTask.rejectRules = [];

      const metadataFailure = { ...retryTorrent, hash: 'fakehash-retry-metadata' };
      let downloads = 0;
      retryTask._downloadTorrent = async () => { downloads++; throw new Error('metadata unavailable'); };
      await retryTask.rss([metadataFailure]);
      clock += 30000;
      retryTask.stopped = true;
      await retryQueue.tick();
      assert.equal(downloads, 1, 'disabled RSS never retries');
      retryTask.stopped = false;
      retryClient.status = false;
      await retryQueue.tick();
      assert.equal(downloads, 1, 'offline downloader waits without consuming a retry');
      retryClient.status = true;
      clock += 30000;
      await retryQueue.tick();
      assert.equal(downloads, 2, 'metadata failures retry without needing the RSS item to reappear');
      retryQueue.stop(retryQueue.get(retryTask.id, metadataFailure.hash).id);
      clock += 30000;
      await retryQueue.tick();
      assert.equal(downloads, 2, 'manual stop survives subsequent ticks');
    } finally {
      Date.now = realNow;
      global.runningRss = savedRss;
    }
    const unavailableClient = client({ status: false, maindata: null, lastStateError: 'socket hang up' });
    let recovered = false;
    unavailableClient.ensureAvailable = async () => {
      if (recovered) {
        unavailableClient.status = true;
        unavailableClient.maindata = { torrents: [], freeSpaceOnDisk: 1000 };
      }
    };
    global.runningClient[unavailableClient.id] = unavailableClient;
    const temporaryTorrent = { ...torrent, hash: 'temporary-unavailable' };
    let temporaryRejections = 0;
    let temporaryAdds = 0;
    const temporaryTask = Object.assign(Object.create(Rss.prototype), rss, {
      id: 'temporary-rss',
      clientArr: [unavailableClient.id],
      acceptRules: [],
      ntf: { rejectTorrent: async () => { temporaryRejections++; } },
      _pushTorrent: async torrent => { temporaryAdds++; retryQueue.success(temporaryTask.id, torrent.hash); }
    });
    await temporaryTask.rss([temporaryTorrent]);
    const queuedTemporary = retryQueue.get(temporaryTask.id, temporaryTorrent.hash);
    assert.equal(queuedTemporary.state, 'waiting', 'temporary state rejection retains RSS payload for retry instead of losing the item');
    assert.equal(temporaryRejections, 0, 'a transient status request failure is not notified as a permanent rejection');
    assert.equal(records[records.length - 1][1][6], 3);
    assert.match(records[records.length - 1][1][7], /自动重试队列.*socket hang up/);
    recovered = true;
    queuedTemporary.nextAt = Date.now() - 1;
    retryStore.put('rss-retry', queuedTemporary.id, queuedTemporary);
    global.runningRss = { [temporaryTask.id]: temporaryTask };
    try {
      temporaryTask.processing = true;
      await retryQueue.tick();
      assert.equal(retryQueue.get(temporaryTask.id, temporaryTorrent.hash).attempts, 0, 'busy RSS defers a retry without losing or consuming it');
      assert.equal(temporaryAdds, 0);
      temporaryTask.processing = false;
      await retryQueue.tick();
      assert.equal(retryQueue.get(temporaryTask.id, temporaryTorrent.hash).state, 'done', 'recovered downloader receives the saved RSS item');
      assert.equal(temporaryAdds, 1);
      assert.equal(temporaryRejections, 0);

      // All six members of a rule group fail status reads in the same scan. An
      // otherwise healthy downloader outside that group must never receive them.
      const failedClients = Array.from({ length: 6 }, () => client({ status: false, maindata: null, lastStateError: 'socket hang up', ensureAvailable: async () => false }));
      for (const failed of failedClients) global.runningClient[failed.id] = failed;
      temporaryTask.clientArr = [...failedClients.map(c => c.id), unavailableClient.id];
      temporaryTask.acceptRules = [{ id: 'failed-group-rule', clientArr: failedClients.map(c => c.id) }];
      const exhausted = { ...torrent, hash: 'status-retry-exhausted' };
      await temporaryTask.rss([exhausted]);
      assert.equal(temporaryRejections, 0);
      for (let i = 1; i <= 5; i++) {
        const entry = retryQueue.get(temporaryTask.id, exhausted.hash);
        entry.nextAt = Date.now() - 1;
        retryStore.put('rss-retry', entry.id, entry);
        await retryQueue.tick();
        assert.equal(retryQueue.get(temporaryTask.id, exhausted.hash).attempts, i);
        assert.equal(temporaryRejections, i === 5 ? 1 : 0, 'notify abandonment only after all five retries');
      }
      await retryQueue.tick();
      await temporaryTask.rss([exhausted]);
      assert.equal(retryQueue.get(temporaryTask.id, exhausted.hash).state, 'exhausted');
      assert.equal(temporaryRejections, 1, 'later scans never repeat the abandonment notification');
      assert.equal(temporaryAdds, 1, 'never fall back outside the rule group');
      assert.equal(retryStore.list('event').filter(event => event.hash === exhausted.hash && event.outcome === 'retryStarted').length, 5);
      assert.match(records[records.length - 1][1][7], /自动重试已达 5 次/);

      const TorrentMod = load('app/model/TorrentMod.js', {
        '../libs/util': { getRecords: async () => [{ rssId: temporaryTask.id, hash: exhausted.hash }], getRecord: async () => ({ total: 1 }) },
        '../libs/logger': logger,
        path: {},
        child_process: {},
        '../libs/rss-retry': retryQueue
      });
      const history = await new TorrentMod().listHistory({ type: 'rss', page: 1, length: 20 });
      assert.equal(history.torrents[0].retry.state, 'exhausted');
      assert.equal(history.torrents[0].retry.attempts, 5);
      assert.equal(history.torrents[0].retry.nextAt, null);
      assert.equal(history.torrents[0].retry.torrent, undefined, 'history only exposes retry status, not the stored download request');
    } finally { global.runningRss = savedRss; }
    let finish;
    let runs = 0;
    rss._runRss = async () => { runs++; await new Promise(resolve => { finish = resolve; }); };
    const run = rss.rss([]);
    await rss.rss([]);
    assert.equal(runs, 1, 'overlapping ticks are skipped');
    finish();
    await run;
    rss.stopped = true;
    await rss.rss([]);
    assert.equal(runs, 1, 'disabled tasks do not start new work');
  } finally {
    global.runningClient = savedClients;
  }
  let apiVersion;
  let qbRequest;
  const qb = load('app/libs/client/qb.js', {
    '../util': {
      requestPromise: async request => {
        if (request.url.endsWith('webapiVersion')) return { statusCode: apiVersion ? 200 : 503, body: apiVersion || '' };
        qbRequest = request;
        return { statusCode: 200, body: 'Ok.' };
      }
    },
    '../logger': { debug: () => {}, error: () => {} },
    url: require('url'),
    fs: { createReadStream: () => 'torrent-stream' }
  });
  await assert.rejects(qb.addTorrentByTorrentFile('qb', 'cookie', 'file', false, 0, 0, '/data', '', false, false, true), /拒绝添加暂停任务/);
  assert.equal(qbRequest, undefined, 'unknown API version must never send a potentially unpaused reseed');
  apiVersion = '2.11.0';
  await qb.addTorrentByTorrentFile('qb-new', 'cookie', 'file', false, 0, 0, '/data', '', false, false, true);
  assert.equal(qbRequest.formData.stopped, 'true');
  apiVersion = '2.9.3';
  await qb.addTorrentByTorrentFile('qb-old', 'cookie', 'file', false, 0, 0, '/data', '', false, false, true);
  assert.equal(qbRequest.formData.paused, 'true');
  console.log('RSS routing, capacity and Client integration tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
