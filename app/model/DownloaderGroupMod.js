const groups = require('../libs/downloader-groups');
const util = require('../libs/util');

class DownloaderGroupMod {
  references (id, tasks = util.listRss(), rules = util.listRssRule()) {
    return [
      ...tasks.flatMap(task => [
        ...(task.clientGroupIds || []).includes(id) ? ['RSS 任务「' + task.alias + '」普通下载器'] : [],
        ...(task.reseedGroupIds || []).includes(id) ? ['RSS 任务「' + task.alias + '」辅种下载器'] : []
      ]),
      ...rules.filter(rule => (rule.clientGroupIds || []).includes(id)).map(rule => 'RSS 规则「' + rule.alias + '」')
    ];
  }

  list () {
    const clients = util.listClient();
    const tasks = util.listRss();
    const rules = util.listRssRule();
    return groups.list().map(group => ({
      ...group,
      references: this.references(group.id, tasks, rules),
      members: group.clientIds.map(id => {
        const client = clients.find(client => client.id === id);
        return { id, alias: client?.alias || id, missing: !client, enable: !!client?.enable, type: client?.type };
      })
    }));
  }

  save (options, adding) {
    const clients = new Set(util.listClient().map(client => client.id));
    if (!Array.isArray(options.clientIds) || options.clientIds.some(id => !clients.has(id))) throw new Error('组内包含不存在的下载器，请移除后保存');
    groups.save(options, adding);
    return '下载器组已保存，所有引用立即使用最新成员';
  }

  delete (options) {
    const references = this.references(options.id);
    if (references.length) throw new Error('下载器组仍被引用，请先解除引用：' + references.join('；'));
    groups.remove(options.id);
    return '删除下载器组成功';
  }
}

module.exports = DownloaderGroupMod;
