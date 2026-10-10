const rss = require('../libs/rss');
const util = require('../libs/util');
const logger = require('../libs/logger');
const redis = require('../libs/redis');
const cron = require('node-cron');
const bencode = require('bencode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const moment = require('moment');
const Push = require('./Push');
const routing = require('../libs/rss-routing');
const autoReseed = require('../libs/auto-reseed');
const recovery = require('../libs/brush-recovery');
const store = require('../libs/brush-store');
const rssRetry = require('../libs/rss-retry');

class Rss {
  constructor (rss) {
    this._rss = rss;
    this.id = rss.id;
    this.maxSleepTime = rss.maxSleepTime;
    this.lastRssTime = 0;
    this.alias = rss.alias;
    this.urls = rss.rssUrls;
    this.clientArr = rss.clientArr || [rss.client];
    this.clientSortBy = rss.clientSortBy;
    this.autoReseed = rss.autoReseed;
    this.onlyReseed = rss.onlyReseed;
    this.reseedClients = rss.reseedClients || rss.clientArr || [rss.client];
    this.pushMessage = rss.pushMessage;
    this.skipSameTorrent = rss.skipSameTorrent;
    this.scrapeFree = rss.scrapeFree;
    this.scrapeHr = rss.scrapeHr;
    this.sleepTime = rss.sleepTime;
    this.cookie = rss.cookie;
    this.savePath = rss.savePath;
    this.category = rss.category;
    this.paused = rss.paused;
    this.autoTMM = rss.autoTMM;
    this.useCustomRegex = rss.useCustomRegex;
    this.regexStr = rss.regexStr;
    this.replaceStr = rss.replaceStr;
    this.addCountPerHour = +rss.addCountPerHour || 20;
    this.addCount = 0;
    this.pushTorrentFile = rss.pushTorrentFile;
    this.notify = util.listPush().filter(item => item.id === rss.notify)[0] || {};
    this.notify.push = rss.pushNotify;
    this.notify.dryrun = rss.dryrun;
    this.ntf = new Push(this.notify);
    this._acceptRules = rss.acceptRules || [];
    this._rejectRules = rss.rejectRules || [];
    this.acceptRules = routing.orderedRules(util.listRssRule(), this._acceptRules, this._rss.ruleOrder || 'legacy');
    this.rejectRules = routing.orderedRules(util.listRssRule(), this._rejectRules, this._rss.ruleOrder || 'legacy');
    this.downloadLimit = util.calSize(rss.downloadLimit, rss.downloadLimitUnit);
    this.uploadLimit = util.calSize(rss.uploadLimit, rss.uploadLimitUnit);
    this.maxClientUploadSpeed = util.calSize(rss.maxClientUploadSpeed, rss.maxClientUploadSpeedUnit);
    this.maxClientDownloadSpeed = util.calSize(rss.maxClientDownloadSpeed, rss.maxClientDownloadSpeedUnit);
    this.maxClientDownloadCount = +rss.maxClientDownloadCount;
    if (!rss.dryrun) {
      this.rssJob = cron.schedule(rss.cron, async () => { try { await this.rss(); } catch (e) { logger.error(this.alias, e); } });
      this.clearCount = cron.schedule('0 * * * *', () => { this.addCount = 0; });
      logger.info('Rss 任务', this.alias, '初始化完毕');
    }
  }

  _all (str, keys) {
    if (!keys || keys.length === 0) return true;
    for (const key of keys) {
      if (str.indexOf(key) === -1) return false;
    }
    return true;
  };

  _sum (arr) {
    let sum = 0;
    for (const item of arr) {
      sum += item;
    }
    return sum;
  }

  _getSum (a, b) {
    return a + b;
  };

  async _downloadTorrent (url, _hash) {
    if (_hash && fs.existsSync(path.join(__dirname, '../../torrents', _hash + '.torrent'))) {
      const filepath = path.join(__dirname, '../../torrents', _hash + '.torrent');
      const info = bencode.decode(fs.readFileSync(filepath)).info;
      return { hash: crypto.createHash('sha1').update(bencode.encode(info)).digest('hex'), filepath, size: info.length || info.files.reduce((sum, f) => sum + f.length, 0) };
    }
    const res = await util.requestPromise({
      url: url,
      method: 'GET',
      encoding: null,
      headers: {
        cookie: this.cookie
      }
    });
    const buffer = Buffer.from(res.body, 'utf-8');
    const torrent = bencode.decode(buffer);
    const size = torrent.info.length || torrent.info.files.map(i => i.length).reduce(this._getSum, 0);
    const fsHash = crypto.createHash('sha1');
    fsHash.update(bencode.encode(torrent.info));
    const md5 = fsHash.digest('md5');
    let hash = '';
    for (const v of md5) {
      hash += v < 16 ? '0' + v.toString(16) : v.toString(16);
    };
    const filepath = path.join(__dirname, '../../torrents', hash + '.torrent');
    fs.writeFileSync(filepath, buffer);
    return {
      filepath,
      hash,
      size,
      name: torrent.info.name.toString()
    };
  };

  _fitConditions (_torrent, conditions) {
    let fit = true;
    const torrent = { ..._torrent };
    torrent.description = torrent.description || '';
    for (const condition of conditions) {
      let value;
      switch (condition.compareType) {
      case 'equals':
        fit = fit && (torrent[condition.key] === condition.value || torrent[condition.key] === +condition.value);
        break;
      case 'bigger':
        value = 1;
        condition.value.split('*').forEach(item => {
          value *= +item;
        });
        fit = fit && torrent[condition.key] > value;
        break;
      case 'smaller':
        value = 1;
        condition.value.split('*').forEach(item => {
          value *= +item;
        });
        fit = fit && torrent[condition.key] < value;
        break;
      case 'contain':
        fit = fit && condition.value.split(',').filter(item => torrent[condition.key].indexOf(item) !== -1).length !== 0;
        break;
      case 'includeIn':
        fit = fit && condition.value.split(',').indexOf(torrent[condition.key]) !== -1;
        break;
      case 'notContain':
        fit = fit && condition.value.split(',').filter(item => torrent[condition.key].indexOf(item) !== -1).length === 0;
        break;
      case 'notIncludeIn':
        fit = fit && condition.value.split(',').indexOf(torrent[condition.key]) === -1;
        break;
      case 'regExp':
        fit = fit && (torrent[condition.key] + '').match(new RegExp(condition.value, 'ig'));
        break;
      case 'notRegExp':
        fit = fit && !(torrent[condition.key] + '').match(new RegExp(condition.value, 'ig'));
        break;
      }
    }
    return fit;
  }

  _fitRule (_rule, _torrent) {
    const rule = { ..._rule };
    const torrent = { ..._torrent };
    if (rule.type === 'javascript') {
      try {
        // eslint-disable-next-line no-eval
        return (eval(rule.code))(torrent);
      } catch (e) {
        logger.error(this.alias, 'Rss 规则', rule.alias, '存在语法错误\n', e);
        return false;
      }
    } else {
      try {
        return rule.conditions.length !== 0 && this._fitConditions(torrent, rule.conditions);
      } catch (e) {
        logger.error(this.alias, 'Rss 规则', rule.alias, '遇到错误\n', e);
        return false;
      }
    }
  }

  destroy () {
    logger.info('销毁 Rss 实例:', this.alias);
    this.stopped = true;
    this.rssJob.stop();
    delete this.rssJob;
    this.clearCount.stop();
    delete this.clearCount;
    delete global.runningRss[this.id];
  }

  reloadRssRule () {
    logger.info('重新载入 Rss 规则', this.alias);
    this.acceptRules = routing.orderedRules(util.listRssRule(), this._acceptRules, this._rss.ruleOrder || 'legacy');
    this.rejectRules = routing.orderedRules(util.listRssRule(), this._rejectRules, this._rss.ruleOrder || 'legacy');
  }

  reloadPush () {
    logger.info('Rss', this.alias, '重新载入推送方式');
    this.notify = util.listPush().filter(item => item.id === this._rss.notify)[0] || {};
    this.notify.push = this._rss.pushNotify;
    this.ntf = new Push(this.notify);
  }

  async _pushTorrent (torrent, _client, fitRule = {}) {
    if (!this.onlyReseed) {
      let speed;
      if (_client.sameServerClients) {
        speed = {
          uploadSpeed: this._sum(_client.sameServerClients.map(index => global.runningClient[index]?.maindata?.uploadSpeed || 0)),
          downloadSpeed: this._sum(_client.sameServerClients.map(index => global.runningClient[index]?.maindata?.downloadSpeed || 0))
        };
      } else {
        speed = {
          uploadSpeed: _client.avgUploadSpeed,
          downloadSpeed: _client.avgDownloadSpeed
        };
      }
      if (_client.maxUploadSpeed && speed.uploadSpeed > _client.maxUploadSpeed) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 超过下载器最大上传速度 ${util.formatSize(speed.uploadSpeed)}/s`]);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, `拒绝原因: 超过下载器最大上传速度 ${util.formatSize(speed.uploadSpeed)}/s`);
        return;
      }
      if (_client.maxDownloadSpeed && speed.downloadSpeed > _client.maxDownloadSpeed) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 超过下载器最大下载速度 ${util.formatSize(speed.downloadSpeed)}/s`]);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, `拒绝原因: 超过下载器最大下载速度 ${util.formatSize(speed.downloadSpeed)}/s`);
        return;
      }
      const leechNum = _client.maindata.leechingCount;
      if (_client.maxLeechNum && leechNum >= _client.maxLeechNum) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 超过下载器最大下载数量 ${leechNum}`]);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, `拒绝原因: 超过下载器最大下载数量 ${leechNum}`);
        return;
      }
      if (_client.minFreeSpace && _client.maindata.freeSpaceOnDisk <= _client.minFreeSpace) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 低于下载器最小剩余空间 ${util.formatSize(_client.maindata.freeSpaceOnDisk)}`]);
        await this.ntf.rejectTorrent(this._rss, _client, torrent, `拒绝原因: 低于下载器最小剩余空间 ${util.formatSize(_client.maindata.freeSpaceOnDisk)}`);
        return;
      }
      if (this.scrapeFree) {
        try {
          if (!await util.scrapeFree(torrent.link, this.cookie)) {
            const isScraped = await redis.get(`vertex:scrape:free:${torrent.hash}`);
            if (this.sleepTime && (moment().unix() - +this.sleepTime) < torrent.pubTime && !isScraped) {
              logger.info(this.alias, '已设置等待时间', this.sleepTime, ', ', torrent.name, '发布时间为', moment(torrent.pubTime * 1000).format('YYYY-MM-DD HH:mm:ss'), ', 跳过');
              await redis.setWithExpire(`vertex:scrape:free:${torrent.hash}`, '7777', 3600 * 4);
            } else {
              await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
                [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 非免费种']);
            }
            await this.ntf.rejectTorrent(this._rss, _client, torrent, '拒绝原因: 非免费种');
            return;
          }
        } catch (e) {
          logger.error(this.alias, '抓取免费种子失败: ', e.message);
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 抓取免费种子失败 ${e.message}`]);
          await this.ntf.scrapeError(this._rss, torrent);
          return;
        }
      }
      if (this.scrapeHr) {
        try {
          if (await util.scrapeHr(torrent.link, this.cookie)) {
            await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
              [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: HR']);
            await this.ntf.rejectTorrent(this._rss, _client, torrent, '拒绝原因: HR');
            return;
          }
        } catch (e) {
          logger.error(this.alias, '抓取 HR 种子失败: ', e.message);
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 抓取 HR 种子失败 ${e.message}`]);
          await this.ntf.scrapeError(this._rss, torrent);
          return;
        }
      }
      if (this.skipSameTorrent) {
        for (const key of Object.keys(global.runningClient)) {
          const client = global.runningClient[key];
          if (!client || !client.maindata || client._client.type !== 'qBittorrent') {
            continue;
          }
          for (const _torrent of client.maindata.torrents) {
            if (+_torrent.size === +torrent.size) {
              await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
                [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 跳过同大小种子']);
              await this.ntf.rejectTorrent(this._rss, _client, torrent, '拒绝原因: 跳过同大小种子');
              return;
            }
          }
        }
        const sameTorrent = await util.getRecord('select * from torrents where size = ? and add_time > ? and record_type = 1', [torrent.size, moment().unix() - 1200]);
        if (sameTorrent && sameTorrent.id) {
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 跳过同大小种子']);
          await this.ntf.rejectTorrent(this._rss, _client, torrent, '拒绝原因: 跳过同大小种子');
          return;
        }
      }
      let savePath = fitRule.savePath || this.savePath;
      if (savePath) {
        savePath = savePath.replace('{RANDOM}', util.uuid.v4().replace(/-/g, ''));
      }
      const category = fitRule.category || this.category;
      const client = _client;
      let accepted = false;
      try {
        let truehash = '';
        if (this.stopped) return;
        let downloadUrl = torrent.url;
        if (this.useCustomRegex && !this.pushTorrentFile) {
          const match = (this.regexStr || '').match(/^\/(.*)\/([gimuy]*)$/);
          if (!match) throw new Error('自定义下载链接正则表达式无效');
          downloadUrl = downloadUrl.replace(new RegExp(match[1], match[2]), this.replaceStr);
        }
        if (this.pushTorrentFile || torrent.hash.indexOf('fakehash') !== -1) {
          const { filepath, hash, size } = await this._downloadTorrent(downloadUrl, torrent.hash);
          truehash = hash;
          if (this.stopped) return;
          await client.addTorrentByTorrentFile(filepath, hash, false, this.uploadLimit, this.downloadLimit, savePath, category, this.autoTMM, this.paused, { size: size || torrent.size, maxCount: this.maxClientDownloadCount, rssId: this.id, feedHash: torrent.hash, name: torrent.name, ruleId: fitRule.id, ruleAlias: fitRule.alias });
        } else {
          await client.addTorrent(downloadUrl, torrent.hash, false, this.uploadLimit, this.downloadLimit, savePath, category, this.autoTMM, this.paused, { size: torrent.size, maxCount: this.maxClientDownloadCount, rssId: this.id, feedHash: torrent.hash, name: torrent.name, ruleId: fitRule.id, ruleAlias: fitRule.alias });
        }
        accepted = true;
        rssRetry.success(this.id, torrent.hash);
        this.addCount += 1;
        try {
          await this.ntf.addTorrent(this._rss, client, torrent);
        } catch (e) {
          logger.error('通知信息发送失败: \n', e);
        }
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, category, record_time, add_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, category, moment().unix(), moment().unix(), 1, '添加种子']);
        if (truehash && torrent.hash !== truehash) {
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, category, record_time, add_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [truehash, torrent.name, torrent.size, this.id, torrent.link, category, moment().unix(), moment().unix(), 1, '添加种子']);
        }
      } catch (error) {
        if (accepted) {
          logger.error(this.alias, '种子添加请求已接受，历史记录写入失败:', error.message);
          return;
        }
        logger.error(this.alias, '下载器', client.alias, '添加种子失败:', error.message);
        if (error.code !== 'CAPACITY_REJECTED') rssRetry.fail(this.id, torrent, client.id, error);
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), error.code === 'CAPACITY_REJECTED' ? 2 : 3, '添加未完成: ' + error.message]);
        try {
          await this.ntf.addTorrentError(this._rss, client, torrent);
        } catch (e) {
          logger.error('通知信息发送失败: \n', e);
        }
      }
    }
  }

  async rss (_torrents, retryOnly = false) {
    if (this.processing || this.stopped) return;
    this.processing = true;
    try {
      await this._runRss(_torrents, retryOnly);
    } finally {
      this.processing = false;
    }
  }

  async _runRss (_torrents, retryOnly = false) {
    let torrents = [];
    if (_torrents) {
      torrents = _torrents;
    } else {
      torrents = (await Promise.all(this.urls.map(url => rss.getTorrents(url)))).flat();
    }
    torrents = [...new Map([...torrents, ...(retryOnly ? [] : autoReseed.waiting(this.id))].map(t => [t.hash, t])).values()];
    for (const torrent of torrents) {
      if (this.stopped) return;
      const queued = rssRetry.get(this.id, torrent.hash);
      if (queued && !retryOnly) continue;
      const sqlRes = await util.getRecord('SELECT * FROM torrents WHERE hash = ? AND rss_id = ?', [torrent.hash, this.id]);
      const oldJob = recovery.forFeed(this.id, torrent.hash);
      const retry = retryOnly || (oldJob && oldJob.state === 'failed' && oldJob.checkedFailure && oldJob.attempts < 6 && oldJob.nextAt <= Date.now());
      if (oldJob && !retry) continue;
      if (sqlRes && sqlRes.id && !retry) continue;
      if (torrent.name.indexOf('[FROZEN]') !== -1) continue;
      if (this.addCount >= this.addCountPerHour) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝原因: 达到单小时推送上限: ${this.addCount} / ${this.addCountPerHour}`]);
        await this.ntf.rejectTorrent(this._rss, undefined, torrent, `拒绝原因: 达到单小时推送上限: ${this.addCount} / ${this.addCountPerHour}`);
        return;
      }
      if (!retryOnly && moment().unix() - this.lastRssTime > +this.maxSleepTime) {
        await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
          [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: 最长休眠时间']);
        await this.ntf.rejectTorrent(this._rss, undefined, torrent, '拒绝原因: 最长休眠时间');
        continue;
      }
      let reject = false;
      for (const rejectRule of this.rejectRules) {
        if (this._fitRule(rejectRule, torrent)) {
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, `拒绝规则: ${rejectRule.alias}`]);
          await this.ntf.rejectTorrent(this._rss, undefined, torrent, `拒绝规则: ${rejectRule.alias}`);
          reject = true;
          break;
        }
      }
      if (!reject) {
        // Legacy reseed tasks previously ran before acceptance rules and ordinary capacity.
        // Keep that eligibility; new tasks can explicitly request rule filtering for reseeds.
        const matches = this.acceptRules.find(rule => this._fitRule(rule, torrent));
        if (!this._rss.reseedRespectRules || matches || !this.acceptRules.length) {
          try {
            if (await autoReseed.attempt(this, torrent, matches)) {
              const job = recovery.forFeed(this.id, torrent.hash);
              if (job && ['accepted', 'done', 'verifying', 'tags'].includes(job.state)) rssRetry.success(this.id, torrent.hash);
              continue;
            }
          } catch (error) {
            logger.error(this.alias, '辅种处理失败:', error.message);
            store.event({ rssId: this.id, hash: torrent.hash, name: torrent.name, outcome: 'reseedError', reason: recovery.safeError(error) });
            if (error.code !== 'CAPACITY_REJECTED') rssRetry.fail(this.id, torrent, recovery.forFeed(this.id, torrent.hash)?.clientId, error);
            continue;
          }
        }
        const fitRule = this.acceptRules.find(rule => this._fitRule(rule, torrent));
        const selection = fitRule || !this.acceptRules.length
          ? routing.select(this, torrent, fitRule, global.runningClient)
          : { reason: '不符合所有选择规则' };
        if (retry && oldJob?.reseed) continue;
        const originalClient = oldJob?.clientId || queued?.clientId;
        if (retry && originalClient && selection.client && selection.client.id !== originalClient) {
          const allowed = selection.candidates.some(c => c.id === originalClient && !c.reason);
          if (allowed) selection.client = global.runningClient[originalClient];
          else selection.reason = '恢复任务原下载器不符合当前规则或容量，不改投其他机器';
        }
        if (selection.reason) {
          store.event({ rssId: this.id, hash: torrent.hash, name: torrent.name, outcome: 'rejected', reason: selection.reason });
          await util.runRecord('INSERT INTO torrents (hash, name, size, rss_id, link, record_time, record_type, record_note) values (?, ?, ?, ?, ?, ?, ?, ?)',
            [torrent.hash, torrent.name, torrent.size, this.id, torrent.link, moment().unix(), 2, '拒绝原因: ' + selection.reason]);
          await this.ntf.rejectTorrent(this._rss, undefined, torrent, selection.reason);
          continue;
        }
        await this._pushTorrent(torrent, selection.client, fitRule);
      }
    }
    if (!retryOnly) this.lastRssTime = moment().unix();
  }

  async dryrun () {
    const torrents = (await Promise.all(this.urls.map(url => rss.getTorrents(url)))).flat();
    for (const torrent of torrents) {
      let reject = false;
      for (const rejectRule of this.rejectRules) {
        if (this._fitRule(rejectRule, torrent)) {
          torrent.status = '匹配到拒绝规则: ' + rejectRule.alias;
          reject = true;
          break;
        }
      }
      if (reject) {
        continue;
      }
      const rule = this.acceptRules.find(item => this._fitRule(item, torrent));
      torrent.matchedRule = rule ? rule.alias : '无选择规则，默认接受';
      if (!rule && this.acceptRules.length) {
        torrent.status = '未匹配到选择规则';
        continue;
      }
      const selection = routing.select(this, torrent, rule, global.runningClient);
      torrent.candidates = selection.candidates;
      torrent.downloader = selection.client ? selection.client.alias : '';
      torrent.status = selection.reason || '可分配（仅检查规则与当前容量，未执行抓取、辅种或添加）';
    }
    return torrents;
  }

  async mikanSearch (name) {
    const torrents = await util.mikanSearch(name);
    for (const torrent of torrents) {
      let reject = false;
      for (const rejectRule of this.rejectRules) {
        if (this._fitRule(rejectRule, torrent)) {
          torrent.status = '匹配到拒绝规则: ' + rejectRule.alias;
          reject = true;
          break;
        }
      }
      if (reject) {
        continue;
      }
      const fitRules = this.acceptRules.filter(item => this._fitRule(item, torrent));
      if (this.acceptRules.length === 0) {
        torrent.status = '无选择规则, 默认选中该种子';
        continue;
      } else if (fitRules.length === 0) {
        torrent.status = '未匹配到规则';
        continue;
      } else {
        torrent.status = '匹配到选择规则: ' + fitRules[0].alias;
        continue;
      }
    }
    return torrents;
  }
}
module.exports = Rss;
