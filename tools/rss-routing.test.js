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

  const moment = () => ({ unix: () => 1000 });
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
  const metadata = client();
  capacity.reserve(metadata, 'metadata', 100).accepted();
  metadata.maindata.torrents = [{ hash: 'metadata', size: 0, completed: 0 }];
  assert.equal(capacity.snapshot(metadata).reserved, 1, 'wait for metadata before releasing reserved disk');

  const RuleMod = load('app/model/RssRuleMod.js', { fs: {}, path: {}, '../libs/util': {} });
  const ruleMod = new RuleMod();
  assert.equal(ruleMod.normalize({ client: 'legacy', clientArr: ['legacy'] }).client, 'legacy');
  assert.equal(ruleMod.normalize({ client: 'legacy', clientArr: ['new'] }).client, undefined);
  assert.equal(ruleMod.normalize({ client: 'legacy', clientArr: [] }).client, undefined);
  assert.throws(() => ruleMod.normalize({ clientArr: 'invalid' }), /数组/);
  assert.throws(() => ruleMod.normalize({ priority: 'invalid' }), /数字/);
  const ClientMod = load('app/model/ClientMod.js', { fs: {}, path: {}, '../common/Client': Client, '../libs/capacity': capacity, '../libs/util': {} });
  assert.throws(() => new ClientMod().add({ capacityMode: 'invalid' }), /未知空间计算模式/);
  assert.throws(() => new ClientMod().modify({ capacityMode: 'invalid' }), /未知空间计算模式/);

  let records = [];
  const torrent = { name: 'example', size: 100, hash: 'rss-test', link: 'link' };
  const Rss = load('app/common/Rss.js', {
    '../libs/rss': { getTorrents: async () => [{ ...torrent }] },
    '../libs/util': { getRecord: async () => null, runRecord: async (...args) => records.push(args), uuid: { v4: () => 'uuid' } },
    '../libs/logger': logger,
    '../libs/redis': {},
    'node-cron': {},
    bencode: {},
    crypto: {},
    fs: {},
    path: {},
    moment,
    './Push': {},
    '../libs/rss-routing': routing,
    '../libs/auto-reseed': { attempt: async () => false, waiting: () => [] },
    '../libs/rss-retry': require('../app/libs/rss-retry'),
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
    assert.equal(preview[0].downloader, b.alias);
    assert.equal(preview[0].matchedRule, '指定机器');
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
