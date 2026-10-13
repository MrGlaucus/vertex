const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const bencode = require('bencode');
const { createRepository } = require('../app/libs/downloader-groups');

function load (file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), {
    module,
    global,
    Buffer,
    require: name => {
      if (name in mocks) return mocks[name];
      throw new Error('Unexpected dependency ' + name);
    }
  });
  return module.exports;
}

async function main () {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-groups-'));
  const originalClients = global.runningClient;
  try {
    const filename = path.join(temporary, 'data/downloader-groups.json');
    const groups = createRepository(filename);
    assert.deepEqual(groups.list(), [], 'old installations need no migration');
    const pool = groups.save({ alias: '夜间刷流', clientIds: ['a', 'a'] }, true);
    assert.deepEqual(pool.clientIds, ['a']);
    assert.deepEqual(createRepository(filename).list(), groups.list(), 'group membership persists after process restart');
    assert.throws(() => groups.save({ alias: pool.alias, clientIds: [] }, true), /已存在/);
    assert.throws(() => groups.save({ alias: 'invalid', clientIds: 'a' }, true), /有效/);
    assert.throws(() => groups.validateReferences(['missing']), /不存在/);
    assert.deepEqual(groups.resolve(['a', 'b'], [pool.id]), ['a', 'b'], 'direct IDs and group members form a deduplicated union');
    assert.deepEqual(groups.resolve(['a'], ['missing']), [], 'broken references fail closed');
    const copy = groups.list();
    copy[0].clientIds.push('injected');
    assert.deepEqual(groups.list()[0].clientIds, ['a'], 'API consumers cannot mutate runtime cache');

    const routing = load('app/libs/rss-routing.js', { './downloader-groups': groups, './capacity': require('../app/libs/capacity') });
    const client = id => ({ id, alias: id, status: true, _client: { type: 'qBittorrent' }, maindata: { freeSpaceOnDisk: 1000, torrents: [{ hash: 'source-' + id, name: 'file', size: 100, completed: 100, savePath: '/data' }] }, capacityUpdatedAt: Date.now() });
    const clients = { a: client('a'), b: client('b'), c: client('c') };
    const task = { id: 'task', clientArr: [], reseedClients: [], _rss: { clientGroupIds: [pool.id], reseedGroupIds: [pool.id], reseedRespectRules: true }, clientSortBy: 'freeSpaceOnDisk' };
    const rule = { id: 'rule', clientGroupIds: [pool.id] };
    const torrent = { hash: 'target', name: 'file', size: 100 };
    assert.equal(routing.select(task, torrent, rule, clients).client.id, 'a');
    assert.deepEqual(groups.reseedClients(task, rule), ['a']);
    groups.save({ ...pool, alias: '改名后的组', clientIds: ['b'] });
    assert.equal(routing.select(task, torrent, rule, clients).client.id, 'b', 'existing task and rule immediately use edited membership');
    assert.deepEqual(groups.reseedClients(task, rule), ['b']);
    assert.equal(task.clientArr.length, 0, 'group IDs are not flattened into task config');
    const polls = [];
    clients.b.status = false;
    clients.b.ensureAvailable = async () => { polls.push('b'); clients.b.status = true; };
    await routing.refresh(task, clients);
    assert.deepEqual(polls, ['b'], 'new group members are refreshed before selecting');
    const empty = groups.save({ alias: '空组', clientIds: [] }, true);
    assert.equal(routing.select(task, torrent, { clientGroupIds: [empty.id] }, clients).client, undefined, 'empty rule group never falls back to task downloaders');
    assert.equal(routing.select({ clientArr: ['a'] }, torrent, rule, clients).client, undefined, 'group rules still intersect task scope');
    assert.equal(routing.select({ clientArr: ['a'] }, torrent, { client: 'c' }, clients).client.id, 'c', 'old single-client overrides remain compatible');
    clients.b.status = false;
    assert.equal(routing.select(task, torrent, rule, clients).client, undefined, 'offline group members do not get added');
    clients.b.status = true;

    const metadata = path.join(temporary, 'seed.torrent');
    fs.writeFileSync(metadata, bencode.encode({ info: { name: 'file', length: 100 } }));
    const added = [];
    for (const c of Object.values(clients)) c.addTorrentByTorrentFile = async () => { added.push(c.id); };
    global.runningClient = clients;
    const autoReseed = load('app/libs/auto-reseed.js', {
      fs,
      bencode,
      './downloader-groups': groups,
      './reseed-files': require('../app/libs/reseed-files'),
      './brush-store': { get: () => undefined, list: () => [], remove () {}, event () {} },
      './brush-recovery': { completed: value => !!value, forFeed: () => undefined, lookup: async c => c.maindata.torrents[0] }
    });
    Object.assign(task, { onlyReseed: true, autoReseed: true, addCount: 0, _downloadTorrent: async () => ({ filepath: metadata, hash: torrent.hash }) });
    await autoReseed.attempt(task, torrent, rule);
    assert.deepEqual(added, ['b']);
    task._downloadTorrent = async () => {
      groups.save({ ...pool, clientIds: ['c'] });
      return { filepath: metadata, hash: torrent.hash };
    };
    await autoReseed.attempt(task, torrent, rule);
    assert.deepEqual(added, ['b'], 'member removed while fetching metadata must not receive a reseed');
    task._downloadTorrent = async () => ({ filepath: metadata, hash: torrent.hash });
    await autoReseed.attempt(task, torrent, rule);
    assert.deepEqual(added, ['b', 'c'], 'next reseed resolves newly added member');

    const rss = [{ alias: '夜间任务', enable: false, clientGroupIds: [pool.id], reseedGroupIds: [pool.id] }];
    const rules = [{ alias: '大种', clientGroupIds: [pool.id] }];
    const Model = load('app/model/DownloaderGroupMod.js', { '../libs/downloader-groups': groups, '../libs/util': { listRss: () => rss, listRssRule: () => rules, listClient: () => Object.values(clients).map(c => ({ id: c.id, alias: c.alias, type: 'qBittorrent', enable: true })) } });
    const model = new Model();
    assert.equal(model.list().find(g => g.id === pool.id).references.length, 3, 'all reference locations, including disabled tasks, are visible');
    assert.throws(() => model.delete({ id: pool.id }), /仍被引用/);
    assert.throws(() => model.save({ ...pool, clientIds: ['missing'] }), /不存在/);
    rss.length = 0;
    rules.length = 0;
    model.delete({ id: pool.id });
    assert.equal(groups.list().some(g => g.id === pool.id), false);
    assert.equal(routing.select(task, torrent, rule, clients).client, undefined, 'removed group does not broaden routing even for stale runtime references');
    console.log('Downloader group persistence, live RSS routing/reseed updates and reference protection tests passed');
  } finally {
    global.runningClient = originalClients;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
