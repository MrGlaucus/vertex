const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const tar = require('tar');

const required = ['db/sql.db', 'data/setting.json', 'config/logger.yaml'];
const parts = ['db', 'data', 'config', 'torrents'];
const markerName = '.pending-restore.json';
const journalName = '.restore-journal.json';
const exists = file => fs.existsSync(file);
const restoring = new Set();

function within (root, relative) {
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(root + path.sep)) throw new Error('备份路径越界');
  return target;
}

function writeJson (file, data) {
  const temporary = file + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function walk (root, relative = '') {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    const stat = fs.lstatSync(path.join(root, name));
    if (stat.isSymbolicLink()) throw new Error('备份目录中不允许链接');
    if (stat.isDirectory()) files.push(...walk(root, name));
    else if (stat.isFile()) files.push(name);
    else throw new Error('备份目录包含特殊文件');
  }
  return files;
}

function digest (file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', data => hash.update(data));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function validateDirectory (root, databaseCheck) {
  for (const relative of required) if (!exists(path.join(root, relative)) || !fs.lstatSync(path.join(root, relative)).isFile()) throw new Error('备份缺少必要文件: ' + relative);
  const setting = JSON.parse(fs.readFileSync(path.join(root, 'data/setting.json'), 'utf8'));
  if (!setting || typeof setting !== 'object' || Array.isArray(setting)) throw new Error('备份设置无效');
  const fd = fs.openSync(path.join(root, 'db/sql.db'), 'r');
  const header = Buffer.alloc(16);
  try { fs.readSync(fd, header, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (header.toString() !== 'SQLite format 3\0') throw new Error('备份数据库头无效');
  if (databaseCheck) await databaseCheck(path.join(root, 'db/sql.db'));
}

async function create (root, backupDatabase, includeTorrents = false) {
  root = path.resolve(root);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'Vertex-backup-stage-'));
  const output = path.join(os.tmpdir(), 'Vertex-backups-' + crypto.randomBytes(12).toString('hex') + '.tar.gz');
  try {
    const target = path.join(stage, 'vertex');
    fs.mkdirSync(path.join(target, 'db'), { recursive: true });
    for (const part of includeTorrents ? parts : parts.filter(p => p !== 'torrents')) {
      const source = path.join(root, part);
      if (!exists(source)) continue;
      for (const relative of walk(source)) {
        if (part === 'db' && /^sql\.db(?:-wal|-shm|-journal)?$/.test(relative)) continue;
        const destination = path.join(target, part, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(path.join(source, relative), destination);
      }
    }
    await backupDatabase(path.join(target, 'db/sql.db'));
    await validateDirectory(target);
    await tar.c({ gzip: true, file: output, cwd: stage, portable: true }, ['vertex']);
    return output;
  } catch (error) {
    if (exists(output)) fs.unlinkSync(output);
    throw error;
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

async function inspect (file, limits = {}) {
  const maxUpload = limits.maxUpload || Number(process.env.VERTEX_BACKUP_UPLOAD_MAX_BYTES) || 512 * 1024 * 1024;
  if (fs.statSync(file).size > maxUpload) throw new Error('恢复包超过上传大小限制');
  let count = 0;
  let size = 0;
  const names = new Set();
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(file);
    const parser = tar.t({
      strict: true,
      onentry: entry => {
        try {
          const name = entry.path.replace(/^\.\//, '').replace(/\/$/, '');
          if (entry.path.includes('\\') || name.includes(':') || name.startsWith('/') || name.split('/').some(p => !p || p === '..' || p === '.')) throw new Error('恢复包包含越界路径');
          if (name !== 'vertex' && !/^vertex\/(db|data|config|torrents)(\/|$)/.test(name)) throw new Error('恢复包包含非运行数据');
          if (!['File', 'Directory'].includes(entry.type)) throw new Error('恢复包不允许链接或特殊文件');
          if (names.has(name)) throw new Error('恢复包包含重复路径');
          names.add(name);
          count++;
          size += entry.size;
          if (!Number.isSafeInteger(entry.size) || entry.size < 0 || count > (limits.maxEntries || 100000) || size > (limits.maxSize || 8 * 1024 * 1024 * 1024)) throw new Error('恢复包解压大小或条目数量超限');
        } catch (error) {
          parser.abort(error);
        }
      }
    });
    parser.on('error', error => { stream.destroy(); reject(error); });
    stream.on('error', reject);
    parser.on('end', resolve);
    stream.pipe(parser);
  });
  for (const relative of required) if (!names.has('vertex/' + relative)) throw new Error('恢复包缺少必要文件: ' + relative);
}

async function stageRestore (file, root, databaseCheck) {
  root = path.resolve(root);
  if (restoring.has(root)) throw new Error('备份恢复校验正在进行');
  restoring.add(root);
  try {
    return await prepareRestore(file, root, databaseCheck);
  } finally {
    restoring.delete(root);
  }
}

async function prepareRestore (file, root, databaseCheck) {
  if (exists(path.join(root, markerName)) || exists(path.join(root, journalName))) throw new Error('已有待恢复任务，请先完成恢复');
  await inspect(file);
  const basename = '.restore-staging-' + crypto.randomBytes(12).toString('hex');
  const stage = within(root, basename);
  fs.mkdirSync(stage, { recursive: true, mode: 0o700 });
  try {
    await tar.x({ file, cwd: stage, strict: true, noChmod: true, noMtime: true });
    const data = path.join(stage, 'vertex');
    await validateDirectory(data, databaseCheck);
    const hashes = {};
    for (const relative of walk(data)) hashes[relative] = await digest(path.join(data, relative));
    writeJson(path.join(root, markerName), { stage: basename, hashes });
    return '备份校验通过，已暂存；下次启动切换，旧数据将保留。';
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

function rollback (root, journal) {
  if (!/^\.restore-previous-[a-f0-9]{24}$/.test(journal.previous) || !/^\.restore-staging-[a-f0-9]{24}$/.test(journal.stage)) throw new Error('无效的恢复日志路径');
  const previous = within(root, journal.previous);
  const stage = within(root, journal.stage);
  for (const part of [...journal.parts].reverse()) {
    if (!parts.includes(part)) throw new Error('无效的恢复日志');
    const old = path.join(previous, part);
    const target = path.join(root, part);
    if (exists(old)) {
      if (exists(target)) fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(old, target);
    } else if (!exists(path.join(stage, 'vertex', part)) && exists(target)) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }
  fs.unlinkSync(path.join(root, journalName));
}

async function applyRestore (root) {
  root = path.resolve(root);
  const journalFile = path.join(root, journalName);
  if (exists(journalFile)) {
    rollback(root, JSON.parse(fs.readFileSync(journalFile, 'utf8')));
    if (exists(path.join(root, markerName))) fs.unlinkSync(path.join(root, markerName));
    return false;
  }
  const marker = path.join(root, markerName);
  if (!exists(marker)) return false;
  const pending = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (!/^\.restore-staging-[a-f0-9]{24}$/.test(pending.stage)) throw new Error('无效的恢复暂存目录');
  const stage = within(root, pending.stage);
  const data = path.join(stage, 'vertex');
  const actual = walk(data);
  if (actual.length !== Object.keys(pending.hashes).length) throw new Error('恢复暂存内容已变化');
  for (const relative of actual) if (await digest(path.join(data, relative)) !== pending.hashes[relative]) throw new Error('恢复暂存校验失败');
  await validateDirectory(data);
  const journal = { stage: pending.stage, previous: '.restore-previous-' + crypto.randomBytes(12).toString('hex'), parts: [] };
  const previous = within(root, journal.previous);
  fs.mkdirSync(previous, { mode: 0o700 });
  try {
    for (const part of parts) {
      if (!exists(path.join(data, part))) continue;
      journal.parts.push(part);
      writeJson(journalFile, journal);
      if (exists(path.join(root, part))) fs.renameSync(path.join(root, part), path.join(previous, part));
      fs.renameSync(path.join(data, part), path.join(root, part));
    }
  } catch (error) {
    rollback(root, journal);
    // Some promoted files may have moved back into the previous runtime data.
    // Discard the marker and require a new upload instead of retrying a partial stage.
    fs.unlinkSync(marker);
    throw error;
  }
  fs.unlinkSync(marker);
  fs.unlinkSync(journalFile);
  fs.rmSync(stage, { recursive: true, force: true });
  return true;
}

module.exports = { create, inspect, stageRestore, applyRestore, validateDirectory };
