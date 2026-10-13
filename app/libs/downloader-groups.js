const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createRepository (filename) {
  let cache;
  function list () {
    if (!cache) cache = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : [];
    return cache.map(group => ({ ...group, clientIds: [...group.clientIds] }));
  }
  function write (groups) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename + '.tmp', JSON.stringify(groups, null, 2));
    fs.renameSync(filename + '.tmp', filename);
    cache = groups;
  }
  function save (input, adding = false) {
    const groups = list();
    const alias = typeof input.alias === 'string' ? input.alias.trim() : '';
    if (!alias || alias.length > 80) throw new Error('下载器组名称应为 1 到 80 个字符');
    if (!Array.isArray(input.clientIds) || input.clientIds.some(id => typeof id !== 'string' || !id)) throw new Error('请选择有效的下载器成员');
    const id = adding ? crypto.randomBytes(8).toString('hex') : input.id;
    if (!adding && !groups.some(group => group.id === id)) throw new Error('下载器组不存在');
    if (groups.some(group => group.id !== id && group.alias === alias)) throw new Error('下载器组名称已存在');
    const group = { id, alias, clientIds: [...new Set(input.clientIds)] };
    write(adding ? [...groups, group] : groups.map(item => item.id === id ? group : item));
    return group;
  }
  function remove (id) {
    const groups = list();
    if (!groups.some(group => group.id === id)) throw new Error('下载器组不存在');
    write(groups.filter(group => group.id !== id));
  }
  function validateReferences (ids) {
    if (ids === undefined) return;
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('下载器组引用必须为 ID 数组');
    const known = new Set(list().map(group => group.id));
    if (ids.some(id => !known.has(id))) throw new Error('引用的下载器组不存在，请重新选择');
  }
  function resolve (direct = [], ids = []) {
    const groups = ids.length ? list() : [];
    const selected = ids.map(id => groups.find(group => group.id === id));
    // A broken reference must never broaden a restricted downloader selection.
    if (selected.some(group => !group)) return [];
    return [...new Set([...direct, ...selected.flatMap(group => group.clientIds)].filter(Boolean))];
  }
  function normal (task) {
    return resolve(task.clientArr || [task.client], (task._rss || task).clientGroupIds || []);
  }
  function reseed (task) {
    const ids = (task._rss || task).reseedGroupIds || [];
    return resolve(task.reseedClients || (ids.length ? [] : normal(task)), ids);
  }
  function restricted (rule) {
    return !!((rule.clientArr || []).length || (rule.clientGroupIds || []).length);
  }
  function ruleClients (task, rule = {}) {
    if (rule.client && !(rule.clientGroupIds || []).length) return [rule.client];
    const clients = normal(task);
    return restricted(rule) ? resolve(rule.clientArr, rule.clientGroupIds).filter(id => clients.includes(id)) : clients;
  }
  function reseedClients (task, rule = {}) {
    const clients = reseed(task);
    const restrictedByRule = (task._rss || task).reseedRespectRules && (rule.client || restricted(rule));
    return restrictedByRule ? clients.filter(id => ruleClients(task, rule).includes(id)) : clients;
  }
  return { list, save, remove, validateReferences, resolve, normal, reseed, restricted, ruleClients, reseedClients };
}

module.exports = createRepository(path.join(__dirname, '../data/downloader-groups.json'));
module.exports.createRepository = createRepository;
