const fs = require('fs');
const path = require('path');
const store = require('./brush-store');
const retry = require('./rss-retry');
const schedule = require('./rss-schedule');
const logger = require('./logger');

function close (rss) {
  const filename = path.join(__dirname, '../data/rss/', rss.id + '.json');
  const settings = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (settings.expireAt !== rss.expireAt || schedule.state(settings).status !== 'expired') return;
  const previous = store.get('rss-schedule', rss.id);
  const expiredAt = settings.scheduleExpiredAt || previous?.expiredAt || Date.now();
  // Mark first: a crash before the config write is repaired at the next startup.
  store.put('rss-schedule', rss.id, { expiredAt });
  retry.cancelForRss(rss.id, 'RSS 已到期自动关闭');
  for (const entry of store.list('wait').filter(entry => entry.rssId === rss.id)) {
    store.remove('wait', entry.id);
    store.event({ rssId: rss.id, hash: entry.torrent.hash, name: entry.torrent.name, outcome: 'waitExpired', reason: 'RSS 已到期自动关闭，取消等待辅种' });
  }
  if (settings.enable) {
    settings.enable = false;
    settings.scheduleExpiredAt = expiredAt;
    fs.writeFileSync(filename, JSON.stringify(settings, null, 2));
  }
  if (!previous) {
    store.event({ rssId: rss.id, name: settings.alias || rss.id, outcome: 'scheduleExpired', reason: '到达设定截止时间，RSS 任务已自动关闭' });
    logger.info('Rss 任务', settings.alias, '到达设定截止时间，已自动关闭');
  }
}

module.exports = { close };
