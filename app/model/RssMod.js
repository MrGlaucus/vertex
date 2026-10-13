const fs = require('fs');
const path = require('path');
const Rss = require('../common/Rss');

const util = require('../libs/util');
const schedule = require('../libs/rss-schedule');
const store = require('../libs/brush-store');
const groups = require('../libs/downloader-groups');
function validate (rssSet, preview = false) {
  groups.validateReferences(rssSet.clientGroupIds);
  groups.validateReferences(rssSet.reseedGroupIds);
  schedule.validate(rssSet, preview);
  require('../libs/rss-xml-replace').compile(rssSet);
  if (rssSet.reseedMode && !['safe', 'fast', 'compatible'].includes(rssSet.reseedMode)) throw new Error('未知辅种策略');
  if (rssSet.ruleOrder && !['legacy', 'configured'].includes(rssSet.ruleOrder)) throw new Error('未知规则顺序');
  if (rssSet.reseedWaitMinutes !== undefined && (!Number.isFinite(Number(rssSet.reseedWaitMinutes)) || +rssSet.reseedWaitMinutes < 0 || +rssSet.reseedWaitMinutes > 1440)) throw new Error('辅种等待时间应在 0 到 1440 分钟之间');
}

class RssMod {
  add (options) {
    const id = util.uuid.v4().split('-')[0];
    const rssSet = { ...options };
    validate(rssSet);
    delete rssSet.scheduleState;
    delete rssSet.scheduleExpiredAt;
    rssSet.id = id;
    fs.writeFileSync(path.join(__dirname, '../data/rss/', id + '.json'), JSON.stringify(rssSet, null, 2));
    if (global.runningRss[id]) global.runningRss[id].destroy();
    if (rssSet.enable) global.runningRss[id] = new Rss(rssSet);
    return '添加 Rss 成功';
  };

  delete (options) {
    fs.unlinkSync(path.join(__dirname, '../data/rss/', options.id + '.json'));
    store.remove('rss-schedule', options.id);
    if (global.runningRss[options.id]) global.runningRss[options.id].destroy();
    return '删除 Rss 成功';
  };

  async deleteRecord (options) {
    await util.runRecord('delete from torrents where id = ?', [options.id]);
    return '删除 Rss 记录成功';
  };

  modify (options) {
    const rssSet = { ...options };
    validate(rssSet);
    delete rssSet.scheduleState;
    if (rssSet.enable) {
      delete rssSet.scheduleExpiredAt;
    }
    rssSet.sameServerClients = rssSet.sameServerClients || [];
    // Keep an omitted reseed selection as a live fallback to the task scope.
    fs.writeFileSync(path.join(__dirname, '../data/rss/', options.id + '.json'), JSON.stringify(rssSet, null, 2));
    if (rssSet.enable) store.remove('rss-schedule', rssSet.id);
    if (global.runningRss[options.id]) global.runningRss[options.id].destroy();
    if (rssSet.enable) global.runningRss[options.id] = new Rss(rssSet);
    return '修改 Rss 成功';
  };

  list () {
    const rssList = util.listRss();
    for (const rss of rssList) {
      rss.scheduleState = schedule.state(rss);
      if (rss.client) {
        rss.clientArr = [rss.client];
        delete rss.client;
      }
      rss.reseedMode = rss.reseedMode || 'compatible';
      rss.ruleOrder = rss.ruleOrder || 'legacy';
      rss.clientArr = rss.clientArr || [];
      if (!rss.reseedClients && !(rss.clientGroupIds || []).length && !(rss.reseedGroupIds || []).length) rss.reseedClients = rss.clientArr || [rss.client];
      rss.acceptRules = rss.acceptRules || [];
      rss.rejectRules = rss.rejectRules || [];
    }
    return rssList;
  };

  async dryrun (options) {
    const id = util.uuid.v4().split('-')[0];
    const rssSet = { ...options };
    validate(rssSet, true);
    rssSet.id = id;
    rssSet.dryrun = true;
    const rss = new Rss(rssSet);
    const torrents = await rss.dryrun();
    return torrents;
  };

  async mikanSearch (options) {
    const rssList = util.listRss();
    const rssSet = rssList.filter(item => item.id === options.rss)[0];
    rssSet.dryrun = true;
    const rss = new Rss(rssSet);
    const torrents = await rss.mikanSearch(options.name);
    return torrents;
  };

  async mikanPush (options) {
    const rssList = util.listRss();
    const rssSet = rssList.filter(item => item.id === options.rss)[0];
    if (!rssSet || !schedule.state(rssSet).allowed) throw new Error('RSS 未启用、不在运行时段内或已到期关闭');
    rssSet.dryrun = true;
    const rss = new Rss(rssSet);
    rss.rss(options.torrents);
    return '任务已开始执行。';
  };
}

module.exports = RssMod;
