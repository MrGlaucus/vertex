const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const moment = require('moment');
const schedule = require('../app/libs/rss-schedule');
const store = require('../app/libs/brush-store');
const retry = require('../app/libs/rss-retry');
const recovery = require('../app/libs/brush-recovery');

function load (file, mocks, extra = {}) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module,
    exports: module.exports,
    global,
    Date,
    Buffer,
    __dirname: path.join(__dirname, '../app/common'),
    ...extra,
    require: name => {
      if (name in mocks) return mocks[name];
      throw new Error('Unexpected dependency ' + name);
    }
  });
  return module.exports;
}

async function main () {
  const realNow = Date.now;
  const savedTasks = global.runningRss;
  const savedClients = global.runningClient;
  let clock = moment('2026-10-13T22:59:59').valueOf();
  Date.now = () => clock;
  const settings = { id: 'schedule-test', enable: true, dailyWindowEnabled: true, windowStart: '23:00', windowEnd: '08:00' };
  const at = time => schedule.state(settings, moment(time).valueOf());
  try {
    assert.equal(schedule.state({}).allowed, true, 'existing tasks are unaffected');
    assert.equal(schedule.state({ enable: false }).status, 'disabled');
    assert.equal(at('2026-10-13T22:59:59').allowed, false);
    assert.equal(at('2026-10-13T23:00:00').allowed, true);
    assert.equal(at('2026-10-14T00:00:00').allowed, true);
    assert.equal(at('2026-10-14T07:59:59').allowed, true);
    assert.equal(at('2026-10-14T08:00:00').allowed, false, 'end boundary is exclusive');
    assert.equal(at('2026-10-14T08:00:00').nextAt, '2026-10-14 23:00:00');
    const daytime = { ...settings, windowStart: '09:00', windowEnd: '17:00' };
    assert.equal(schedule.state(daytime, moment('2026-10-14T09:00').valueOf()).allowed, true);
    assert.equal(schedule.state(daytime, moment('2026-10-14T17:00').valueOf()).allowed, false);
    assert.throws(() => schedule.validate({ ...settings, windowEnd: '23:00' }), /不能相同/);
    assert.throws(() => schedule.validate({ ...settings, windowStart: '25:00' }), /有效/);
    assert.throws(() => schedule.validate({ expireEnabled: true, expireAt: '2026-02-30T12:00' }), /有效/);
    const expired = { ...settings, expireEnabled: true, expireAt: '2026-10-13T20:00' };
    assert.throws(() => schedule.validate(expired), /截止时间已过去/);
    schedule.validate({ ...expired, enable: false });
    schedule.validate(expired, true);
    assert.equal(schedule.state(expired).status, 'expired', 'deadline has priority over daily window');
    assert.equal(schedule.state({ ...settings, expireEnabled: true, expireAt: '2026-10-13T23:00' }).nextAt, undefined, 'no next window at or after deadline');
    assert.equal(schedule.state({ ...settings, expireEnabled: true, expireAt: '2026-10-14T02:00' }, moment('2026-10-14T02:00').valueOf()).status, 'expired');

    let persisted = { ...settings, expireEnabled: true, expireAt: '2026-10-14T02:00' };
    let writes = 0;
    const fakeFs = { readFileSync: () => JSON.stringify(persisted), writeFileSync: (filename, data) => { persisted = JSON.parse(data); writes++; } };
    const expiry = load('app/libs/rss-schedule-expiry.js', { fs: fakeFs, path, './brush-store': store, './rss-retry': retry, './rss-schedule': schedule, './logger': { info () {} } });
    let fetches = 0;
    let adds = 0;
    let scheduledTimer;
    let stoppedJobs = 0;
    const mocks = {
      '../libs/rss': { getTorrents: async () => { fetches++; return [{ hash: 'item', name: 'item', size: 1 }]; } },
      '../libs/util': { listPush: () => [], listRssRule: () => [], calSize: () => 0, getRecord: async () => null, runRecord: async () => ({}) },
      '../libs/logger': { info () {}, error () {} },
      '../libs/redis': {},
      'node-cron': { schedule: () => ({ stop: () => { stoppedJobs++; } }) },
      '../libs/torrent-response': require('../app/libs/torrent-response'),
      fs: fakeFs,
      path,
      moment,
      './Push': class { async rejectTorrent () {} async addTorrent () {} },
      '../libs/rss-routing': { orderedRules: () => [], refresh: async () => {}, select: () => ({ client: { id: 'client' } }) },
      '../libs/auto-reseed': { waiting: () => [], attempt: async () => false },
      '../libs/avoid-reseed': { scan: async () => null },
      '../libs/brush-recovery': recovery,
      '../libs/brush-store': store,
      '../libs/rss-retry': retry,
      '../libs/rss-schedule': schedule,
      '../libs/downloader-groups': require('../app/libs/downloader-groups'),
      '../libs/rss-schedule-expiry': expiry
    };
    const Rss = load('app/common/Rss.js', mocks, { setInterval: fn => { scheduledTimer = fn; return { unref () {} }; }, clearInterval () {} });
    const task = new Rss({ ...persisted, cron: '* * * * *', rssUrls: ['url'], maxSleepTime: 10 });
    task._pushTorrent = async () => { adds++; };
    global.runningRss = { [settings.id]: task };
    global.runningClient = {};
    task.lastRssTime = 1;
    task.fetchErrorAt = 2;
    await task.rss();
    assert.equal(fetches, 0, 'no fetching outside the window');
    assert.equal(task.lastRssTime, 0, 'scheduled downtime clears previous fetch baseline');
    assert.equal(task.fetchErrorAt, null);
    clock = moment('2026-10-13T23:00').valueOf();
    await task.rss();
    assert.equal(fetches, 1);
    assert.equal(adds, 0, 'the first fetch after planned downtime is judged like any other long sleep');
    clock = moment('2026-10-13T23:00:05').valueOf();
    await task.rss();
    assert.equal(adds, 1, 'the next fetch inside the window adds normally');

    const queued = { hash: 'queued', name: 'queued', size: 1 };
    retry.fail(task.id, queued, undefined, new Error('timeout'));
    clock = moment('2026-10-14T01:59:59').valueOf();
    let release;
    const offline = { ensureAvailable: () => new Promise(resolve => { release = resolve; }), status: true };
    global.runningClient.client = offline;
    const entry = retry.get(task.id, queued.hash);
    entry.clientId = 'client';
    store.put('rss-retry', entry.id, entry);
    const pending = retry.tick();
    clock = moment('2026-10-14T02:00').valueOf();
    release();
    await pending;
    assert.equal(retry.get(task.id, queued.hash).attempts, 0, 'deadline while awaiting downloader consumes no retry');
    assert.equal(retry.get(task.id, queued.hash).state, 'stopped');
    assert.equal(persisted.enable, false, 'deadline persists disabled config');
    assert.equal(global.runningRss[task.id], undefined);
    assert.equal(stoppedJobs, 2);
    assert.equal(writes, 1);
    expiry.close(persisted);
    assert.equal(writes, 1, 'startup repairs and repeated expiry are idempotent');
    assert.equal(store.list('event').filter(e => e.rssId === task.id && e.outcome === 'scheduleExpired').length, 1);
    retry.fail(task.id, { hash: 'late', name: 'late' }, undefined, new Error('late failure'));
    assert.equal(retry.get(task.id, 'late').state, 'stopped', 'an in-flight request failure cannot recreate retries after expiry');

    // Daily pauses preserve pending retries and do not consume attempts.
    const daily = new Rss({ ...settings, id: 'daily', rssUrls: ['url'], cron: '* * * * *' });
    global.runningRss.daily = daily;
    retry.fail('daily', queued, undefined, new Error('timeout'));
    clock = moment('2026-10-14T08:00').valueOf();
    await retry.tick();
    assert.equal(retry.get('daily', queued.hash).attempts, 0);
    assert.equal(retry.get('daily', queued.hash).state, 'waiting');
    clock = moment('2026-10-14T23:00').valueOf();
    daily.rss = async () => false;
    await retry.tick();
    assert.equal(retry.get('daily', queued.hash).attempts, 0, 'a boundary crossed inside RSS processing rolls back its retry attempt');
    clock += 30000;
    daily.rss = async () => { retry.success('daily', queued.hash); };
    await retry.tick();
    assert.equal(retry.get('daily', queued.hash).attempts, 1);
    assert.equal(retry.get('daily', queued.hash).state, 'done');

    // The expiry worker runs separately from the task's RSS Cron.
    const timerTask = new Rss({ ...settings, id: 'timer', expireEnabled: true, expireAt: '2026-10-15T02:00', cron: '0 23 * * *' });
    persisted = { ...timerTask._rss };
    global.runningRss.timer = timerTask;
    store.put('wait', 'timer:waiting', { id: 'timer:waiting', rssId: 'timer', torrent: queued, expiresAt: clock + 86400000 });
    clock = moment('2026-10-15T02:00').valueOf();
    scheduledTimer();
    assert.equal(persisted.enable, false, 'expiry does not wait for sparse RSS Cron');
    assert.equal(store.get('wait', 'timer:waiting'), undefined, 'expiry removes unexecuted reseed candidates');
    assert.equal(global.runningRss.timer, undefined);
    const confirmingClient = { id: 'confirming', status: true, _client: { type: 'qBittorrent' }, client: { getTorrent: async () => ({ hash: 'already-sent', size: 1 }) } };
    global.runningClient.confirming = confirmingClient;
    const sentJob = recovery.begin(confirmingClient, 'already-sent', { size: 1 }, { rssId: 'timer' });
    recovery.accepted(sentJob);
    sentJob.nextAt = clock;
    recovery.save(sentJob);
    await recovery.tick();
    assert.equal(store.get('job', sentJob.id).state, 'done', 'already sent requests are reconciled even after expiry and disabled config');
    console.log('RSS daily windows, expiry persistence, cron independence and retry boundaries tests passed');
  } finally {
    Date.now = realNow;
    global.runningRss = savedTasks;
    global.runningClient = savedClients;
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
