const recovery = require('./brush-recovery');
const files = require('./reseed-files');

// Auto reseed and avoid reseed are the same judgement pointed in opposite
// directions: one adds the torrent where the files already are, the other
// refuses to. They share this function so the two can never drift apart, which
// would let a task reseed a torrent it was explicitly told to avoid.
// Returns the matching torrent, or null when the files are not identical.
async function resolve ({ client, source, info, expected, size, mode }) {
  const current = await recovery.lookup(client, source.hash);
  if (!recovery.completed(current) || !current.savePath) return null;
  if (+current.size !== +size) return null;
  if (mode === 'compatible') return current.name === info.name.toString() ? current : null;
  return files.sameFiles(expected, await client.getFiles(source.hash)) ? current : null;
}

module.exports = { resolve };
