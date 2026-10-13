const moment = require('moment');

const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;
const deadline = settings => moment(settings.expireAt, ['YYYY-MM-DDTHH:mm:ss', 'YYYY-MM-DDTHH:mm'], true);

function validate (settings, preview = false) {
  if (settings.dailyWindowEnabled) {
    if (!timePattern.test(settings.windowStart || '') || !timePattern.test(settings.windowEnd || '')) throw new Error('每日运行时段请填写有效的开始和结束时间');
    if (settings.windowStart === settings.windowEnd) throw new Error('开始和结束时间不能相同；全天运行请关闭每日运行时段');
  }
  if (settings.expireEnabled) {
    if (!deadline(settings).isValid()) throw new Error('请选择有效的自动关闭日期和时间');
    if (settings.enable && !preview && deadline(settings).valueOf() <= Date.now()) throw new Error('截止时间已过去，请修改或关闭到期自动关闭后再启用任务');
  }
}

function state (settings = {}, now = Date.now()) {
  const current = moment(now);
  const zone = process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const result = { timezone: zone, serverTime: current.format('YYYY-MM-DD HH:mm:ss') };
  if (settings.expireEnabled && deadline(settings).isValid()) {
    result.expiresAt = deadline(settings).format('YYYY-MM-DD HH:mm:ss');
    if (now >= deadline(settings).valueOf()) return { ...result, status: 'expired', allowed: false };
  }
  if (settings.enable === false) return { ...result, status: 'disabled', allowed: false };
  if (settings.dailyWindowEnabled) {
    const time = current.format('HH:mm');
    const start = settings.windowStart;
    const end = settings.windowEnd;
    const inside = start < end ? time >= start && time < end : time >= start || time < end;
    if (!inside) {
      const next = current.clone().startOf('day').hour(+start.slice(0, 2)).minute(+start.slice(3));
      if (next.valueOf() <= now) next.add(1, 'day');
      // There is no next running window when the deadline comes first.
      if (!result.expiresAt || next.valueOf() < deadline(settings).valueOf()) result.nextAt = next.format('YYYY-MM-DD HH:mm:ss');
      return { ...result, status: 'outside', allowed: false };
    }
  }
  return { ...result, status: 'running', allowed: true };
}

function pausedError () {
  const error = new Error('RSS 当前不在运行时段内或已到期关闭');
  error.code = 'RSS_SCHEDULE_PAUSED';
  return error;
}

module.exports = { validate, state, pausedError };
