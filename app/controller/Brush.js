const BrushMod = require('../model/BrushMod');
const logger = require('../libs/logger');
const model = new BrushMod();

class Brush {
  async overview (req, res) {
    try { res.send({ success: true, data: await model.overview() }); } catch (error) {
      logger.error(error);
      res.send({ success: false, message: error.message });
    }
  }

  async action (req, res) {
    try { res.send({ success: true, message: await model.action(req.body) }); } catch (error) {
      res.send({ success: false, message: error.message });
    }
  }

  async preview (req, res) {
    try { res.send({ success: true, data: await model.preview(req.query) }); } catch (error) {
      res.send({ success: false, message: error.message });
    }
  }
}

module.exports = Brush;
