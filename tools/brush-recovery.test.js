const assert = require('assert').strict;
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../app/libs/brush-store');
const capacity = require('../app/libs/capacity');
const recovery = require('../app/libs/brush-recovery');
const protection = require('../app/libs/delete-protection');
const { sameFiles, manifest } = require('../app/libs/reseed-files');
const backup = require('../app/libs/backup-safe');
const limiter = require('../app/libs/request-limit');
const tar = require('tar');

function openDatabase (filename) {
  try { return new (require('better-sqlite3'))(filename); } catch (error) {
    // Node 24's built-in SQLite is used by the local test runtime only.
    const sqlite = require('node:sqlite');
    const database = new sqlite.DatabaseSync(filename);
    database.backup = target => sqlite.backup(database, target);
    return database;
  }
}

async function main () {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vertex-brush-test-'));
  let database;
  const savedClients = global.runningClient;
  const savedRss = global.runningRss;
  try {
    const filename = path.join(temporary, 'state.db');
    database = openDatabase(filename);
    store.configure(database);
    const client = {
      id: 'persist',
      alias: 'qB',
      status: true,
      _client: { type: 'qBittorrent' },
      maxLeechNum: 1,
      maindata: { torrents: [], leechingCount: 0, freeSpaceOnDisk: 10000 }
    };
    capacity.reserve(client, 'durable', 100).uncertain();
    const retryQueue = require('../app/libs/rss-retry');
    retryQueue.fail('persistent-rss', { hash: 'retry-persist', name: '持久化重试', url: 'private-url' }, client.id, new Error('timeout'));
    const retryBefore = retryQueue.get('persistent-rss', 'retry-persist');
    database.close();
    database = openDatabase(filename);
    store.configure(database);
    assert.equal(capacity.snapshot({ ...client }).uncertain, 1, 'reservations survive a real SQLite connection restart');
    assert.deepEqual(retryQueue.get('persistent-rss', 'retry-persist'), retryBefore, 'retry payload, count and deadline survive a real SQLite restart');
    assert.equal(store.list('event').some(e => e.hash === 'retry-persist' && e.outcome === 'retryScheduled'), true, 'retry logs survive restart');
    capacity.releaseHash(client.id, 'durable');
    assert.throws(() => store.transaction(() => {
      capacity.reserve(client, 'rollback-slot', 100);
      recovery.begin(client, 'rollback-slot', { size: 100 });
      throw new Error('transaction failed');
    }), /transaction failed/);
    recovery.end('persist:rollback-slot');
    assert.equal(store.get('capacity', 'persist:rollback-slot'), undefined);
    assert.equal(store.get('job', 'persist:rollback-slot'), undefined, 'job and reservation roll back together');

    const torrents = new Map();
    let rechecks = 0;
    let resumes = 0;
    const order = [];
    client.client = {
      getTorrent: async (url, cookie, hash) => torrents.get(hash),
      recheckTorrent: async () => { rechecks++; }
    };
    client.addTorrentTag = async (hash, tag) => {
      order.push(tag);
      torrents.get(hash).tags = (torrents.get(hash).tags || '') + ',' + tag;
    };
    client.resumeTorrent = async hash => { resumes++; torrents.get(hash).state = 'stalledUP'; };
    client.pauseTorrent = async () => {};
    global.runningClient = { persist: client };
    global.runningRss = { rss: { id: 'rss' } };

    const request = { method: 'file', target: 'file', savePath: '/data', size: 100 };
    const job = recovery.begin(client, 'target', request, { rssId: 'rss', feedHash: 'feed', name: 'new', reseed: { sourceHash: 'source', mode: 'safe', resume: true } });
    recovery.accepted(job);
    torrents.set('target', { hash: 'target', size: 100, completed: 0, progress: 0, state: 'pausedDL' });
    torrents.set('source', { hash: 'source', size: 100, completed: 100, progress: 1, savePath: '/data' });
    client.maindata.torrents = [...torrents.values()];
    assert.match(await protection.protection(client, torrents.get('source'), true), /尚未完成/);
    await recovery.reconcile(job, client);
    assert.equal(rechecks, 1);
    assert.equal(resumes, 0, 'do not start an unchecked seed');
    torrents.get('target').completed = 100;
    torrents.get('target').progress = 1;
    torrents.get('target').state = 'pausedUP';
    await recovery.reconcile(job, client);
    assert.deepEqual(order, ['Reseed', 'Brseed']);
    assert.equal(resumes, 1);
    assert.equal(store.get('job', job.id).state, 'done');
    assert.match(await protection.protection(client, torrents.get('source'), true), /关联/);

    const absent = recovery.begin(client, 'absent', request, { rssId: 'rss' });
    recovery.failed(absent, new Error('timeout'), false);
    absent.nextAt = Date.now() - 1;
    recovery.save(absent);
    capacity.reserve({ ...client, maindata: { ...client.maindata, torrents: [], leechingCount: 0 } }, 'absent', 100).uncertain();
    await recovery.reconcile(absent, client);
    assert.equal(absent.state, 'failed');
    assert.equal(store.get('capacity', 'persist:absent'), undefined, 'absence verified before releasing');

    const invalid = recovery.begin(client, 'invalid', request, { rssId: 'rss', reseed: { sourceHash: 'source', mode: 'safe', resume: true } });
    recovery.accepted(invalid);
    torrents.set('invalid', { hash: 'invalid', size: 100, progress: 0.5, state: 'pausedDL' });
    await recovery.reconcile(invalid, client);
    invalid.verifyStartedAt = Date.now() - 120000;
    await recovery.reconcile(invalid, client);
    assert.equal(invalid.state, 'verificationFailed');
    assert.equal(resumes, 1, 'failed validation never downloads missing pieces');

    const missingSource = recovery.begin(client, 'orphan', request, { rssId: 'rss', reseed: { sourceHash: 'missing-source', mode: 'fast', resume: false } });
    recovery.accepted(missingSource);
    torrents.set('orphan', { hash: 'orphan', size: 100, completed: 100, progress: 1, state: 'pausedUP' });
    await recovery.reconcile(missingSource, client);
    assert.equal(missingSource.state, 'done');
    assert.match(missingSource.error, /原种已不存在/);
    assert.equal(order[order.length - 1], 'Reseed');

    const tagFailure = recovery.begin(client, 'tag-fail', request, { rssId: 'rss', reseed: { sourceHash: 'source', mode: 'fast', resume: false } });
    recovery.accepted(tagFailure);
    torrents.set('tag-fail', { hash: 'tag-fail', size: 100, completed: 100, state: 'pausedUP' });
    const originalTag = client.addTorrentTag;
    client.addTorrentTag = async () => { throw new Error('tag API offline'); };
    await assert.rejects(recovery.reconcile(tagFailure, client), /offline/);
    assert.equal(store.get('job', tagFailure.id).reseedConfirmed, false, 'failed Reseed never marks its source');
    client.addTorrentTag = originalTag;
    await recovery.reconcile(tagFailure, client);
    assert.equal(tagFailure.state, 'done');

    const expected = manifest({ name: Buffer.from('folder'), files: [{ path: [Buffer.from('one.mkv')], length: 100 }] });
    assert.equal(sameFiles(expected, [{ name: 'folder/one.mkv', size: 100 }]), true);
    assert.equal(sameFiles(expected, [{ name: 'folder/two.mkv', size: 100 }]), false);
    assert.throws(() => manifest({ name: Buffer.from('../bad'), length: 100 }), /路径/);
    const metadata = path.join(temporary, 'reseed.torrent');
    fs.writeFileSync(metadata, require('bencode').encode({ info: { name: 'folder', files: [{ path: ['one.mkv'], length: 100 }] } }));
    const autoReseed = require('../app/libs/auto-reseed');
    const task = { id: 'match-test', autoReseed: true, onlyReseed: true, clientArr: ['persist'], reseedClients: ['persist'], addCount: 0, _rss: { reseedMode: 'safe', reseedRespectRules: true, reseedWaitMinutes: 10 }, _downloadTorrent: async () => ({ filepath: metadata, hash: 'new-match' }) };
    const feed = { hash: 'new-feed', size: 100, name: 'folder' };
    client.getFiles = async () => [{ name: 'folder/one.mkv', size: 100 }];
    let added;
    client.addTorrentByTorrentFile = async (...args) => { added = args; };
    assert.equal(await autoReseed.attempt(task, feed, { id: 'rule', clientArr: ['persist'] }), true);
    assert.equal(added[2], false, 'safe mode never skips checking');
    assert.equal(added[5], '/data', 'reuse the original client save path');
    assert.equal(added[8], true, 'new reseed starts paused');
    assert.equal(added[9].ruleId, 'rule');
    added = undefined;
    await autoReseed.attempt(task, { ...feed, hash: 'wait-feed' }, { client: 'other-client' });
    assert.equal(added, undefined, 'respect the matched rule downloader');
    assert.equal(autoReseed.waiting(task.id).length, 1);
    let inFlight = 0;
    let maximum = 0;
    await Promise.all(Array.from({ length: 20 }, () => limiter.run('test', 2, async () => { inFlight++; maximum = Math.max(maximum, inFlight); await new Promise(resolve => setImmediate(resolve)); inFlight--; })));
    assert.equal(maximum, 2, 'request concurrency is bounded');

    const root = path.join(temporary, 'runtime');
    for (const part of ['data', 'db', 'config']) fs.mkdirSync(path.join(root, part), { recursive: true });
    fs.writeFileSync(path.join(root, 'data/setting.json'), '{"username":"before"}');
    fs.writeFileSync(path.join(root, 'config/logger.yaml'), 'level: info');
    // The online snapshot includes committed WAL rows.
    database.exec('PRAGMA journal_mode=WAL; CREATE TABLE backup_probe(value TEXT); INSERT INTO backup_probe VALUES (\'committed\')');
    const archive = await backup.create(root, target => database.backup(target));
    try {
      await backup.inspect(archive);
      await assert.rejects(backup.inspect(archive, { maxSize: 1 }), /超限/);
      const check = target => {
        const restored = openDatabase(target);
        try { assert.equal(restored.prepare('SELECT value FROM backup_probe').get().value, 'committed'); } finally { restored.close(); }
      };
      const preparing = backup.stageRestore(archive, root, check);
      await assert.rejects(backup.stageRestore(archive, root, check), /正在进行/);
      await preparing;
      await assert.rejects(backup.stageRestore(archive, root, check), /已有待恢复/);
      fs.writeFileSync(path.join(root, 'data/setting.json'), '{"username":"after"}');
      assert.equal(await backup.applyRestore(root), true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/setting.json'))).username, 'before');
      const previous = fs.readdirSync(root).find(name => name.startsWith('.restore-previous-'));
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, previous, 'data/setting.json'))).username, 'after');
      // A failed promotion rolls the old data back and discards the pending marker.
      await backup.stageRestore(archive, root, check);
      fs.writeFileSync(path.join(root, 'data/setting.json'), '{"username":"rollback"}');
      const rename = fs.renameSync;
      let injected = false;
      fs.renameSync = (source, destination) => {
        if (!injected && source.includes('.restore-staging-') && source.endsWith(path.join('vertex', 'data'))) { injected = true; throw new Error('injected move failure'); }
        return rename(source, destination);
      };
      try { await assert.rejects(backup.applyRestore(root), /injected/); } finally { fs.renameSync = rename; }
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/setting.json'))).username, 'rollback');
      assert.equal(fs.existsSync(path.join(root, '.pending-restore.json')), false);
      await backup.stageRestore(archive, root, check);
      const marker = JSON.parse(fs.readFileSync(path.join(root, '.pending-restore.json')));
      fs.writeFileSync(path.join(root, marker.stage, 'vertex/data/setting.json'), '{"username":"tampered"}');
      await assert.rejects(backup.applyRestore(root), /校验失败/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data/setting.json'))).username, 'rollback', 'tampered staging never replaces runtime data');
    } finally { fs.unlinkSync(archive); }

    const unsafe = path.join(temporary, 'unsafe.tar');
    const pack = new tar.Pack({ portable: true });
    // A symbolic link header can be generated without Windows symlink privileges.
    const header = new tar.Header({ path: 'vertex/data/link', type: 'SymbolicLink', linkpath: '../../outside', size: 0, mode: 0o777 });
    header.encode();
    fs.writeFileSync(unsafe, Buffer.concat([header.block, Buffer.alloc(1024)]));
    await assert.rejects(backup.inspect(unsafe), /链接/);
    pack.destroy();
    const traversal = new tar.Header({ path: 'vertex/data/../../outside', type: 'File', size: 0, mode: 0o600 });
    traversal.encode();
    fs.writeFileSync(unsafe, Buffer.concat([traversal.block, Buffer.alloc(1024)]));
    await assert.rejects(backup.inspect(unsafe), /越界/);
    console.log('Persistent recovery, reseed validation, file protection, limiter and backup tests passed');
  } finally {
    global.runningClient = savedClients;
    global.runningRss = savedRss;
    if (database) database.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
