const log4js = require('log4js');
const config = require('./config');
let redis = null;

const loggerConfig = config.getLoggerConfig();
// The settings file is absent in unit tests and on a first run before the panel
// writes it, so fall back to the configured defaults instead of throwing.
let setting = {};
try {
  setting = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '../data/setting.json'), { encoding: 'utf-8' }));
} catch (ignored) {}
loggerConfig.categories.default.level = setting.loggerLevel || loggerConfig.categories.default.level;
// Every error used to fire its own unawaited read-modify-write against Redis.
// During an error flood that produced hundreds of concurrent round-trips and
// lost updates, which in turn starved the session store and made every API
// call slow. Queue them and let one serialized writer drain the queue.
const pendingErrors = [];
let flushing = false;

const flushErrors = async () => {
  if (flushing) return;
  flushing = true;
  try {
    if (!redis) redis = require('./redis');
    const errorList = JSON.parse((await redis.get('vertex:error:list') || '[]'));
    while (pendingErrors.length) errorList.push(pendingErrors.shift());
    while (errorList.length > 5) {
      errorList.shift();
    }
    await redis.set('vertex:error:list', JSON.stringify(errorList));
  } catch (e) {
    // Error reporting must never break logging itself.
  } finally {
    flushing = false;
    if (pendingErrors.length) flushErrors();
  }
};

loggerConfig.appenders.error.layout.tokens = {
  redis: (logEvent) => {
    delete logEvent.data.cert;
    pendingErrors.push(logEvent.data);
    if (pendingErrors.length > 50) pendingErrors.shift();
    flushErrors();
    return '';
  }
};
log4js.configure(loggerConfig);
const logger = log4js.getLogger('console');
logger.use = function (app) {
  app.use(log4js.connectLogger(logger, {
    format: (req, res, format) => format(`[${req.userIp}] [:method] [:url] [${req.headers['user-agent']}]`),
    level: 'trace'
  }));
};
module.exports = logger;
