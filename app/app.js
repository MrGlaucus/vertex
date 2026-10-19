const express = require('express');
const moment = require('moment');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const ws = require('express-ws');
const app = express();
const router = express.Router();
const cron = require('node-cron');

const Push = require('./common/Push');
const Script = require('./common/Script');
const Client = require('./common/Client');
const Rss = require('./common/Rss');
const Server = require('./common/Server');
const Douban = require('./common/Douban');
const Site = require('./common/Site');
const Watch = require('./common/Watch');
const IRC = require('./common/IRC');

const sites = require('./libs/site');
const logger = require('./libs/logger');
const util = require('./libs/util');
const config = require('./libs/config');
const { execSync } = require('child_process');
logger.use(app);

const initPush = function () {
  const webhookPush = util.listPush().filter(item => item.id === global.webhookPushTo)[0];
  if (webhookPush) {
    global.webhookPush = new Push({ ...webhookPush, push: true });
  }
  const doubanPush = util.listPush().filter(item => item.id === global.doubanPush)[0];
  if (doubanPush) {
    global.doubanPush = new Push({ ...doubanPush, push: true });
  }
};

const init = function () {
  // Record history used to grow without bound: after nine months `torrents`
  // held 425k rows and every dashboard count/sum scanned all of them while
  // blocking the event loop. Keep a rolling window instead.
  const recordKeepDays = Math.max(1, parseInt(process.env.VERTEX_RECORD_KEEP_DAYS, 10) || 30);
  global.clearDatabase = cron.schedule('1 0 * * *', async () => {
    try {
      await util.runRecord('delete from torrent_flow where time < ?', [moment().unix() - 1]);
      await util.runRecord('delete from tracker_flow where time < ?', [moment().unix() - 7 * 24 * 3600]);
      await util.runRecord('delete from torrents where record_time < ?', [moment().unix() - recordKeepDays * 24 * 3600]);
      execSync('rm -f /tmp/Vertex-backups-*');
    } catch (e) {
      logger.error(e);
    }
  });

  require('./libs/brush-recovery').setHistory(util);
  global.CONFIG = config;
  global.LOGGER = logger;
  global.SITE = sites;
  global.linkMapping = JSON.parse(fs.readFileSync(path.join(__dirname, './data/link-mapping.json')));
  const setting = JSON.parse(fs.readFileSync(path.join(__dirname, './data/setting.json')));
  if (!setting.password) {
    const password = util.uuid.v4();
    setting.username = 'admin';
    setting.password = util.md5(password);
    fs.writeFileSync(path.join(__dirname, './data/password'), password);
    fs.writeFileSync(path.join(__dirname, './data/setting.json'), JSON.stringify(setting, null, 2));
  }
  const proxySetting = JSON.parse(fs.readFileSync(path.join(__dirname, './data/setting/proxy.json')));
  global.proxy = proxySetting.proxy;
  global.domains = proxySetting.domains;
  // Surface proxy routing at startup: environment proxies are ignored on purpose.
  const envProxyNames = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].filter(name => process.env[name]);
  if (envProxyNames.length) {
    logger.warn('检测到环境变量代理:', envProxyNames.join(', '), '— VERTEX 已忽略它们, 如需代理请在「工具 → HTTP 代理」中配置');
  }
  logger.info('HTTP 代理:', global.proxy ? String(global.proxy).replace(/\/\/[^/@]*@/, '//***@') : '未配置',
    '| 代理域名:', String(global.domains || '').split('\n').map(item => item.trim()).filter(item => item).length, '条');
  global.auth = {
    username: setting.username,
    password: setting.password,
    otp: setting.otp
  };
  global.telegramProxy = setting.telegramProxy || 'https://api.telegram.org';
  global.wechatProxy = setting.wechatProxy;
  global.checkFinishCron = setting.checkFinishCron || '30 * * * * *';
  global.userAgent = setting.userAgent;
  global.ignoreError = setting.ignoreError;
  global.ignoreDependCheck = setting.ignoreDependCheck;
  global.webhookPushTo = setting.webhookPushTo;
  global.doubanPush = setting.doubanPush;
  global.apiKey = setting.apiKey;
  global.tmdbApiKey = setting.tmdbApiKey;
  global.trustVertexPanel = setting.trustVertexPanel;
  global.transparent = setting.transparent;
  global.background = setting.background;
  global.wechatCover = setting.wechatCover;
  global.embyCover = setting.embyCover;
  global.plexCover = setting.plexCover;
  global.theme = setting.theme || 'light';
  global.siteInfo = setting.siteInfo || {
    hide: [],
    hideName: [],
    watermark: 'vertex'
  };
  global.trustAllCerts = setting.trustAllCerts;
  global.menu = setting.menu || [];
  global.dashboardContent = setting.dashboardContent || [];
  global.wechatToken = setting.wechatToken;
  global.wechatAesKey = setting.wechatAesKey;
  global.panelKey = setting.panelKey;
  global.jellyfinCover = setting.jellyfinCover;
  global.dataPath = setting.dataPath || '/';
  global.runningClient = {};
  global.runningRss = {};
  global.runningServer = {};
  global.runningSite = {};
  global.runningRace = {};
  global.runningDouban = {};
  global.runningScript = {};
  global.runningWatch = {};
  global.runningIRC = {};
  global.startTime = moment().unix();
  initPush();
  for (const client of util.listClient()) {
    if (client.enable) {
      global.runningClient[client.id] = new Client(client);
    }
  }
  for (const rss of util.listRss()) {
    if ((rss.enable || rss.scheduleExpiredAt) && require('./libs/rss-schedule').state(rss).status === 'expired') {
      require('./libs/rss-schedule-expiry').close(rss);
      continue;
    }
    if (rss.enable) {
      global.runningRss[rss.id] = new Rss(rss);
    }
  }
  for (const server of util.listServer()) {
    if (server.enable) {
      global.runningServer[server.id] = new Server(server);
    }
  }
  for (const site of util.listSite()) {
    if (site.enable) {
      global.runningSite[site.name] = new Site(site);
    }
  }
  for (const douban of util.listDouban()) {
    if (douban.enable) {
      global.runningDouban[douban.id] = new Douban(douban);
    }
  }
  for (const script of util.listCrontabJavaScript()) {
    if (script.enable) {
      global.runningScript[script.id] = new Script(script);
    }
  }
  for (const watch of util.listWatch()) {
    if (watch.enable) {
      global.runningWatch[watch.id] = new Watch(watch);
    }
  }
  for (const irc of util.listIRC()) {
    if (irc.enable) {
      global.runningIRC[irc.id] = new IRC(irc);
    }
  }
  global.brushRecoveryJob = cron.schedule('* * * * *', () => require('./libs/brush-recovery').tick().catch(error => logger.error('刷流恢复失败:', error)));
  global.rssRetryJob = cron.schedule('*/5 * * * * *', () => require('./libs/rss-retry').tick().catch(error => logger.error('RSS 重试失败:', error)));
  // cookiecloud
  util.initCookieCloud();
};

(async () => {
  try {
    init();
  } catch (e) {
    logger.error('初始化任务报错\n', e);
  }
  try {
    const server = http.createServer(app).listen(process.env.PORT);
    ws(app, server);
    logger.info('HTTP 服务器启动, 监听端口: ', process.env.PORT);
  } catch (e) {
    logger.error(e);
    logger.error('HTTP 服务器启动失败, 监听端口: ', process.env.PORT);
  }
  if (process.env.HTTPS_ENABLE === 'true') {
    try {
      const options = {
        key: fs.readFileSync(path.join(__dirname, './data/ssl/https.key')),
        cert: fs.readFileSync(path.join(__dirname, './data/ssl/https.crt'))
      };
      const server = https.createServer(options, app).listen(process.env.HTTPS_PORT);
      ws(app, server);
      logger.info('HTTPS 服务器启动, 监听端口: ', process.env.HTTPS_PORT);
    } catch (e) {
      logger.error(e);
      logger.error('HTTPS 服务器启动失败, 监听端口: ', process.env.HTTPS_PORT);
    }
  }
  require('./routes/router.js')(app, express, router);
})();
