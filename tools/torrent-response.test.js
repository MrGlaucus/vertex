const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const bencode = require('bencode');
const crypto = require('crypto');
const response = require('../app/libs/torrent-response');

const context = { url: 'https://tracker.example/download.php?id=123&passkey=private-key-abc', cookie: 'session=private-cookie-xyz; user=Alice' };
const html = '<title>Please log in</title><form><input type="password" value="hidden-password"></form><script>private-script-data</script><p>Session expired. passkey=private-key-abc user Alice session private-cookie-xyz https://tracker.example/download.php?secret=other-secret</p>';
function failure (statusCode, body, type = 'text/html; charset=UTF-8') {
  try {
    response.parse({ statusCode, headers: { 'content-type': type }, body: Buffer.from(body) }, context);
    assert.fail('expected invalid response to fail');
  } catch (error) {
    assert.equal(error.code, 'TORRENT_DOWNLOAD_ERROR');
    assert.equal(error.details.status, statusCode);
    assert.ok(error.message.length < 500, 'diagnostics fit retry error records');
    return error;
  }
}

async function main () {
  const login = failure(200, html);
  assert.match(login.message, /疑似登录失效/);
  assert.match(login.message, /HTTP 200/);
  assert.equal(login.details.contentType, 'text/html');
  for (const secret of ['private-key-abc', 'private-cookie-xyz', 'Alice', 'hidden-password', 'private-script-data', 'other-secret', 'tracker.example']) assert.ok(!JSON.stringify(login).includes(secret) && !login.message.includes(secret), 'redact ' + secret);
  assert.match(failure(401, 'Unauthorized').message, /认证失败/);
  assert.match(failure(403, 'Forbidden').message, /拒绝访问/);
  assert.doesNotMatch(failure(403, 'Forbidden').message, /登录失效/);
  assert.match(failure(403, '<title>Cloudflare challenge</title>').message, /安全验证/);
  assert.match(failure(429, 'Too many requests').message, /站点限流/);
  assert.match(failure(404, 'Not found').message, /链接不存在或已失效/);
  assert.match(failure(410, 'Gone').message, /链接不存在或已失效/);
  assert.match(failure(503, 'Service unavailable').message, /站点服务异常/);
  assert.match(failure(302, 'Moved').message, /被重定向/);
  assert.match(failure(200, '<p>Too many requests</p>').message, /疑似站点限流/);
  const invalidKey = failure(200, '<p>Invalid passkey: short-secret</p>');
  assert.match(invalidKey.message, /认证链接无效/);
  assert.doesNotMatch(invalidKey.message, /short-secret/);
  assert.match(failure(200, '<p>普通错误页面</p>').message, /响应不是有效的种子文件/);
  assert.match(failure(200, '').message, /未记录正文/);
  const json = failure(400, '{"error":"Invalid token", "token":"short-secret", "password":"secret-password"}', 'application/json');
  assert.equal(json.details.contentType, 'application/json');
  assert.doesNotMatch(json.message, /short-secret|secret-password/);
  const entities = failure(200, '<p>passkey&#61;unknown-secret token: unknown-token email: test@example.com</p>');
  assert.doesNotMatch(entities.message, /unknown-secret|unknown-token|test@example.com/);
  const network = response.networkFailure(new Error('ETIMEDOUT ' + context.url + ' Cookie: session=private-cookie-xyz'), context);
  assert.match(network.message, /网络请求失败/);
  assert.match(network.message, /HTTP 未知/);
  assert.doesNotMatch(network.message, /private-key|private-cookie|tracker.example/);

  const info = { name: 'example', length: 100, 'piece length': 16384, pieces: Buffer.alloc(20) };
  const valid = bencode.encode({ announce: 'https://tracker.example/secret-tracker', info });
  const parsed = response.parse({ statusCode: 200, headers: { 'content-type': 'application/octet-stream' }, body: valid }, context);
  assert.equal(parsed.hash, crypto.createHash('sha1').update(bencode.encode(info)).digest('hex'));
  assert.equal(parsed.size, 100);
  assert.equal(parsed.name, 'example');
  assert.equal(parsed.buffer, valid);
  assert.equal(response.parse({ statusCode: 200, headers: { 'content-type': 'text/plain' }, body: valid }, context).hash, parsed.hash, 'valid torrents work despite nonstandard content type');
  const multi = bencode.encode({ info: { name: 'multi', files: [{ length: 5, path: ['a'] }, { length: 10, path: ['b'] }] } });
  assert.equal(response.decode(multi).size, 15);
  assert.throws(() => response.parse({ statusCode: 500, body: valid }, context), /HTTP 500/, 'HTTP errors are never cached even if body decodes');
  const invalidInfo = failure(200, 'd4:infod4:name4:testee', 'application/x-bittorrent');
  assert.doesNotMatch(invalidInfo.message, /4:info|4:name/, 'do not dump malformed torrent bytes');

  // Exercise the actual RSS fetch, cache and history paths without network or disk writes.
  let cache;
  let requests = 0;
  let writes = 0;
  let adds = 0;
  let reply = { statusCode: 200, body: valid };
  let retryError;
  const logs = [];
  const records = [];
  const mocks = {
    '../libs/torrent-response': response,
    '../libs/util': {
      requestPromise: async options => { requests++; assert.equal(options.encoding, null); return reply; },
      runRecord: async (...args) => records.push(args)
    },
    '../libs/logger': { error: (...args) => logs.push(args.join(' ')) },
    '../libs/rss-retry': { fail: (id, torrent, clientId, error) => { retryError = error; } },
    fs: { existsSync: () => !!cache, readFileSync: () => cache, writeFileSync: (filename, buffer) => { writes++; cache = buffer; } },
    path,
    moment: () => ({ unix: () => 1 })
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/common/Rss.js'), 'utf8'), {
    module, Buffer, Date, __dirname: path.join(__dirname, '../app/common'), require: name => mocks[name] || {}
  });
  const task = Object.assign(Object.create(module.exports.prototype), {
    id: 'diagnostic-rss',
    alias: 'test',
    cookie: context.cookie,
    pushTorrentFile: true,
    _rss: {},
    canRun: () => true,
    ntf: { addTorrentError: async () => {} }
  });
  const downloaded = await task._downloadTorrent(context.url, 'feed-hash');
  assert.equal(downloaded.hash, parsed.hash);
  assert.equal(writes, 1);
  await task._downloadTorrent(context.url, 'feed-hash');
  assert.equal(requests, 1, 'valid cache avoids HTTP requests');
  cache = Buffer.from('<html>old broken cache</html>');
  await task._downloadTorrent(context.url, 'feed-hash');
  assert.equal(requests, 2, 'invalid cache is bypassed');
  assert.equal(writes, 2, 'only a valid replacement is cached');
  cache = undefined;
  reply = { statusCode: 429, headers: { 'content-type': 'text/html' }, body: Buffer.from(html) };
  const client = { id: 'client', alias: 'test', maindata: {}, addTorrentByTorrentFile: async () => { adds++; } };
  await task._pushTorrent({ hash: 'feed-hash', url: context.url, name: 'test', size: 100 }, client);
  assert.equal(adds, 0, 'error response never reaches the downloader');
  assert.equal(writes, 2, 'error page is never written to torrent cache');
  assert.match(records[0][1][7], /HTTP 429.*响应类型: text\/html.*摘要:/);
  assert.match(retryError.message, /HTTP 429/);
  assert.ok(logs.some(line => /尚未提交下载器/.test(line)));
  assert.doesNotMatch(JSON.stringify([logs, records, retryError.message]), /private-key-abc|private-cookie-xyz|private-script-data/);
  console.log('Torrent HTTP diagnostics, redaction, cache recovery and RSS integration tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
