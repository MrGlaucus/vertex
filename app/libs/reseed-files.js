const path = require('path');

function normalize (name) {
  const value = String(name).replace(/\\/g, '/');
  if (!value || value.startsWith('/') || /^[a-z]:/i.test(value) || value.split('/').some(part => part === '..' || part === '.' || part === '')) throw new Error('种子文件路径不安全');
  return value;
}

function manifest (info) {
  const root = normalize((info['name.utf-8'] || info.name).toString());
  if (info.files) return info.files.map(file => ({ name: normalize(root + '/' + (file['path.utf-8'] || file.path).map(p => p.toString()).join('/')), size: Number(file.length) }));
  return [{ name: root, size: Number(info.length) }];
}

function sameFiles (expected, actual) {
  const map = files => files.map(f => normalize(f.name) + '\0' + Number(f.size)).sort();
  const a = map(expected);
  const b = map(actual);
  return a.length > 0 && a.length === b.length && new Set(a).size === a.length && a.every((value, i) => value === b[i]);
}

function overlaps (a, b) {
  const canonical = value => path.posix.normalize(String(value || '').replace(/\\/g, '/')).replace(/\/$/, '');
  const first = canonical(a);
  const second = canonical(b);
  return !!a && !!b && (first === second || first.startsWith(second + '/') || second.startsWith(first + '/'));
}

module.exports = { manifest, sameFiles, overlaps };
