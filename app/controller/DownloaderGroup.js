const Model = require('../model/DownloaderGroupMod');
const model = new Model();
const logger = require('../libs/logger');

const handle = action => (req, res) => {
  try { res.send({ success: true, ...action(req.body || {}) }); } catch (error) {
    logger.error(error);
    res.send({ success: false, message: error.message });
  }
};

class DownloaderGroup {
  constructor () {
    this.list = handle(() => ({ data: model.list() }));
    this.add = handle(options => ({ message: model.save(options, true) }));
    this.modify = handle(options => ({ message: model.save(options, false) }));
    this.delete = handle(options => ({ message: model.delete(options) }));
  }
}

module.exports = DownloaderGroup;
