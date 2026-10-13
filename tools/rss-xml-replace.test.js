const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const transform = require('../app/libs/rss-xml-replace');

const settings = regexRules => ({ useCustomRegex: true, regexScope: 'xml', regexRules });
const rule = (regexStr, replaceStr) => ({ regexStr, replaceStr });
const xml = '<?xml version="1.0"?><rss><channel><title>old channel</title><item><title>old Episode 12 [广告]</title><description><![CDATA[old description]]></description><link>https://old.example/details.php?id=42</link><enclosure url="https://old.example/download.php?id=42&amp;passkey=private" length="100"/><guid>unchanged-hash</guid><pubDate>Tue, 13 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>';

async function main () {
  assert.deepEqual(transform.compile({}), []);
  assert.deepEqual(transform.compile({ useCustomRegex: true, regexStr: '/old/g', replaceStr: 'new' }), [], 'existing configuration keeps download-link scope');
  assert.equal(transform.apply('old old', transform.compile(settings([rule('/old/', 'new')]))), 'new old');
  assert.equal(transform.apply('OLD old', transform.compile(settings([rule('/old/gi', 'new')]))), 'new new');
  assert.equal(transform.apply('a\nb', transform.compile(settings([rule('/a.b/s', 'done')]))), 'done');
  assert.equal(transform.apply('Episode 12', transform.compile(settings([rule('/Episode (\\d+)/g', 'E$1')]))), 'E12');
  assert.equal(transform.apply('[广告]name', transform.compile(settings([rule('/\\[广告\\]/g', '')]))), 'name');
  assert.equal(transform.apply('old', transform.compile(settings([rule('/old/g', 'middle'), rule('/middle/g', 'new')]))), 'new', 'rules execute in configuration order');
  assert.throws(() => transform.compile(settings([])), /至少添加/);
  assert.throws(() => transform.compile(settings([rule('old', 'new')])), /格式/);
  assert.throws(() => transform.compile(settings([rule('/[/g', 'new')])), /无效/);
  assert.throws(() => transform.compile(settings([rule('/old/gg', 'new')])), /无效/);
  assert.throws(() => transform.compile(settings([rule('/old/g', null)])), /替换内容/);

  const cache = new Map();
  const expires = new Map();
  let cacheClock = 0;
  let requests = 0;
  let responseXml = xml;
  let responseError = null;
  const mocks = {
    xml2js: require('xml2js'),
    crypto: require('crypto'),
    moment: require('moment'),
    path,
    fs,
    bencode: require('bencode'),
    './rss-xml-replace': transform,
    './util': { promisify: require('util').promisify, requestPromise: async url => { requests++; if (responseError) throw responseError; return { body: String(url).includes('m-team') ? responseXml.replace('/details.php?id=42', '/torrent/42') : responseXml }; } },
    './redis': { get: async key => expires.get(key) > cacheClock ? cache.get(key) : undefined, setWithExpire: async (key, value, seconds) => { cache.set(key, value); expires.set(key, cacheClock + seconds * 1000); } },
    './logger': { error () {}, info () {} }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app/libs/rss.js'), 'utf8'), { module, exports: module.exports, global, URL, Buffer, require: name => { if (!(name in mocks)) throw new Error('Unexpected dependency ' + name); return mocks[name]; } });
  const rss = module.exports;
  const url = 'https://tracker.example/rss?key=private';
  const options = settings([rule('/old/g', 'new'), rule('/length="100"/g', 'length="200"'), rule('/Episode (\\d+)/g', 'E$1'), rule('/ \\[广告\\]/g', '')]);
  const result = await rss.getTorrents(url, options);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'new E12');
  assert.equal(result[0].description, 'new description');
  assert.equal(result[0].url, 'https://new.example/download.php?id=42&passkey=private');
  assert.equal(result[0].link, 'https://new.example/details.php?id=42');
  assert.equal(result[0].size, '200', 'attribute replacement runs before extracting size');
  assert.equal(result[0].hash, 'unchanged-hash');
  assert.equal(cache.get('vertex:rss:' + url), xml, 'cache retains original XML');
  const another = await rss.getTorrents(url, settings([rule('/old/g', 'other')]));
  assert.equal(another[0].name, 'other Episode 12 [广告]', 'same URL can use different per-task rules');
  const original = await rss.getTorrents(url);
  assert.equal(original[0].name, 'old Episode 12 [广告]');
  assert.equal(requests, 1, 'replacement runs after cache reads without changing shared cached content');
  cache.clear();
  const beforeConcurrent = requests;
  const paired = await Promise.all([
    rss.getTorrents(url, options),
    rss.getTorrents(url, settings([rule('/old/g', 'other')]))
  ]);
  assert.equal(requests, beforeConcurrent + 1, 'simultaneous cache misses for the same feed share one upstream request');
  assert.equal(paired[0][0].name, 'new E12');
  assert.equal(paired[1][0].name, 'other Episode 12 [广告]', 'concurrent tasks independently replace the shared original XML');
  cacheClock += 39999;
  await rss.getTorrents(url);
  assert.equal(requests, beforeConcurrent + 1, 'normal RSS cache lasts 40 seconds');
  cacheClock += 2;
  await Promise.all([rss.getTorrents(url), rss.getTorrents(url)]);
  assert.equal(requests, beforeConcurrent + 2, 'after expiry, the next round also shares one fresh request');
  const beforeDistinct = requests;
  await Promise.all([rss.getTorrents(url + '&task=1'), rss.getTorrents(url + '&task=2')]);
  assert.equal(requests, beforeDistinct + 2, 'different complete URLs are not combined');

  const mteam = await rss.getTorrents('https://m-team.example/rss', options);
  assert.equal(mteam[0].name, 'new E12', 'site-specific MTeam adapter applies replacements');
  assert.equal(mteam[0].size, '200');
  await assert.rejects(rss.getTorrents(url, settings([rule('/<\\/title>/g', '')])), error => error.code === 'RSS_XML_INVALID' && !error.message.includes('private'));
  await assert.rejects(rss.getTorrents(url, settings([rule('/[/g', '')])), /规则 1/);
  assert.equal((await rss.getTorrents(url))[0].name, 'old Episode 12 [广告]', 'invalid replacement does not poison cached XML');
  cache.clear();
  responseXml = '<rss><channel><title>empty feed</title></channel></rss>';
  assert.equal((await rss.getTorrents(url, {}, { throwOnError: true })).length, 0, 'valid empty RSS is a success, not an outage');
  assert.equal((await rss.getTorrents('https://m-team.example/rss', {}, { throwOnError: true })).length, 0, 'site-specific empty RSS is also successful');
  cache.clear();
  responseXml = '<rss><channel>';
  await assert.rejects(rss.getTorrents(url, {}, { throwOnError: true }), /获取或解析 RSS 失败/);
  assert.equal((await rss.getTorrents(url)).length, 0, 'legacy callers keep their empty-list failure behavior');
  cache.clear();
  responseError = new Error('socket hang up https://private.example/key');
  const beforeFailure = requests;
  const failures = await Promise.allSettled([rss.getTorrents(url, {}, { throwOnError: true }), rss.getTorrents(url, {}, { throwOnError: true })]);
  assert.equal(requests, beforeFailure + 1, 'failed concurrent requests are combined too');
  for (const failure of failures) {
    assert.equal(failure.status, 'rejected');
    assert.equal(failure.reason.message.includes('socket hang up'), true);
    assert.equal(failure.reason.message.includes('private.example'), false);
  }
  responseError = null;
  responseXml = xml;
  assert.equal((await rss.getTorrents(url, {}, { throwOnError: true })).length, 1, 'a failed shared request is removed so later requests can recover');
  assert.equal(requests, beforeFailure + 2);
  console.log('RSS XML replacement, regex validation, adapter parsing and task cache isolation tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
