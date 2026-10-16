const assert = require('assert').strict;
const policy = require('../app/libs/request-policy');

const PROXY = 'http://192.168.1.1:7890';

assert.equal(policy.resolve('https://pt.example.com/dl?id=1', '', ''), false, 'no proxy configured -> direct');
assert.equal(policy.resolve('https://pt.example.com/dl', PROXY, ''), false, 'empty domain list -> direct');
assert.equal(policy.resolve('https://pt.example.com/dl', PROXY, 'pt.example.com'), PROXY, 'exact host matches');
assert.equal(policy.resolve('https://www.pt.example.com/dl', PROXY, 'pt.example.com'), PROXY, 'subdomain matches listed domain');
assert.equal(policy.resolve('https://pt.example.com/dl', PROXY, 'www.pt.example.com'), false, 'parent host must not match a more specific entry');

// The regression that caused the socket hang ups: an unmatched host used to be
// left undefined, which let the request library inherit HTTP_PROXY/HTTPS_PROXY.
assert.equal(policy.resolve('https://other.example.com/dl', PROXY, 'pt.example.com'), false, 'unmatched host -> forced direct');
assert.equal(policy.resolve('http://192.168.1.50:8080/api/v2/sync/maindata', PROXY, 'pt.example.com'), false, 'LAN downloader -> forced direct');

assert.equal(policy.resolve('https://pt.example.com/dl', PROXY, '  https://pt.example.com/torrents  '), PROXY, 'scheme and path are stripped');
assert.equal(policy.resolve('https://pt.example.com:443/dl', PROXY, 'pt.example.com:8080'), PROXY, 'port in the list is stripped');
assert.equal(policy.resolve('https://pt.example.com/dl', PROXY, '*.pt.example.com'), PROXY, 'leading wildcard label is stripped');
assert.equal(policy.resolve('https://PT.Example.com/dl', PROXY, 'PT.EXAMPLE.COM'), PROXY, 'matching is case insensitive');
assert.equal(policy.resolve('https://pt.example.com/dl', PROXY, 'pt.example.com\n\n  \nwww.other.com'), PROXY, 'blank lines are ignored');

assert.equal(policy.resolve('https://pt.example.com/dl', PROXY, '*'), PROXY, 'wildcard proxies public hosts');
assert.equal(policy.resolve('http://10.0.0.5:8080/api', PROXY, '*'), false, 'wildcard still skips LAN hosts');
assert.equal(policy.resolve('http://127.0.0.1:8080/api', PROXY, '*'), false, 'loopback is never proxied');
assert.equal(policy.resolve('http://qbittorrent:8080/api', PROXY, '*'), false, 'single-label host is treated as LAN');
assert.equal(policy.resolve('http://nas.local/api', PROXY, '*'), false, '.local is treated as LAN');
assert.equal(policy.resolve('http://172.20.3.4/api', PROXY, '*'), false, '172.16/12 is treated as LAN');
assert.equal(policy.resolve('http://172.32.3.4/api', PROXY, '*'), PROXY, '172.32 is public');

assert.equal(policy.resolve('not a url', PROXY, '*'), false, 'unparsable target -> direct');

assert.deepEqual(policy.parseDomains('A.com\n\n b.com \n'), ['a.com', 'b.com']);
assert.equal(policy.isLanHost('192.168.0.1'), true);
assert.equal(policy.isLanHost('8.8.8.8'), false);
assert.equal(policy.isLanHost('tracker.example.com'), false);

// Timeout budget: LAN hosts get the short one so an unreachable downloader
// releases its concurrency slot immediately instead of holding it for minutes.
assert.equal(policy.timeoutFor('http://192.168.1.50:8080/api', 10000, 30000), 10000, 'LAN uses the short budget');
assert.equal(policy.timeoutFor('https://pt.example.com/dl', 10000, 30000), 30000, 'public host uses the long budget');
assert.equal(policy.timeoutFor('not a url', 10000, 30000), 30000, 'unparsable target falls back to the long budget');

assert.equal(policy.positiveNumber('45000', 30000), 45000, 'valid override wins');
assert.equal(policy.positiveNumber('0', 30000), 30000, 'zero falls back');
assert.equal(policy.positiveNumber('-1', 30000), 30000, 'negative falls back');
assert.equal(policy.positiveNumber('abc', 30000), 30000, 'garbage falls back');
assert.equal(policy.positiveNumber(undefined, 30000), 30000, 'missing falls back');

console.log('Request policy (proxy routing and timeout budget) tests passed');
