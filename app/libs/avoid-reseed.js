const fs = require('fs');
const bencode = require('bencode');
const files = require('./reseed-files');
const match = require('./reseed-match');
const groups = require('./downloader-groups');

// Downloaders that already hold the same content. Adding the torrent there
// would reuse the files, download nothing, and therefore earn nothing on sites
// that price upload against download. The caller excludes them and picks
// another machine, which is the exact opposite of what auto reseed does with
// the same match.
async function scan (task, torrent, rule = {}) {
  const clients = groups.ruleClients(task, rule)
    .map(id => (global.runningClient || {})[id])
    .filter(client => client && client.status && client.maindata && client._client.type === 'qBittorrent');
  const candidates = clients.flatMap(client => (client.maindata.torrents || [])
    .filter(item => +item.size === +torrent.size)
    .map(source => ({ client, source })));
  // No torrent of that size on any candidate, so no file can be reused. This is
  // the common case and it must not cost a metadata download.
  if (!candidates.length) return null;
  const metadata = await task._downloadTorrent(torrent.url, torrent.hash);
  const info = bencode.decode(fs.readFileSync(metadata.filepath)).info;
  const expected = files.manifest(info);
  const size = expected.reduce((total, file) => total + file.size, 0);
  const mode = task._rss.reseedMode || 'compatible';
  const excluded = new Set();
  for (const { client, source } of candidates) {
    // One hit is enough to drop the machine, no need to check its other seeds.
    if (excluded.has(client.id)) continue;
    // The same hash is capacity's job; it reports a plain duplicate instead.
    if (String(source.hash).toLowerCase() === String(metadata.hash).toLowerCase()) continue;
    if (await match.resolve({ client, source, info, expected, size, mode })) excluded.add(client.id);
  }
  return excluded.size ? excluded : null;
}

module.exports = { scan };
