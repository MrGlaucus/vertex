const bencode = require('bencode');
const crypto = require('crypto');
const { JSDOM } = require('jsdom');

function redact (text, context = {}) {
  const secrets = [];
  try {
    const url = new URL(context.url);
    secrets.push(url.username, url.password);
    url.searchParams.forEach(value => secrets.push(value));
    secrets.push(...url.pathname.split('/').filter(value => value.length >= 16));
  } catch (ignored) {}
  for (const cookie of String(context.cookie || '').split(';')) {
    const index = cookie.indexOf('=');
    if (index !== -1) secrets.push(cookie.slice(index + 1).trim());
  }
  let value = String(text || '');
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    const variants = new Set([secret, encodeURIComponent(secret)]);
    try { variants.add(decodeURIComponent(secret)); } catch (ignored) {}
    for (const variant of variants) value = value.split(variant).join('[已隐藏]');
  }
  return value
    .replace(/(?:https?:\/\/|\/\/)[^\s<>"']+/gi, '[地址已隐藏]')
    .replace(/\S*\?[^\s<>"']+/g, '[地址已隐藏]')
    .replace(/(?:cookie|set-cookie|authorization)\s*[:=][^\r\n]*/gi, '[认证信息已隐藏]')
    .replace(/(?:passkey|authkey|token|api[_-]?key|password|passwd|secret|session(?:id)?|username|uid|密码|口令|用户名)\s*["']?\s*[:=：]\s*(?:"[^"]*"|'[^']*'|[^\s,;<>]+)/gi, '[认证信息已隐藏]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\b[A-Za-z0-9_+/=-]{24,}\b/g, '[标识已隐藏]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[邮箱已隐藏]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // eslint-disable-line no-control-regex
    .replace(/\s+/g, ' ').trim();
}

function page (buffer, context) {
  const raw = buffer.subarray(0, 65536).toString('utf8');
  // Never include binary torrent contents, which can contain private tracker URLs.
  // eslint-disable-next-line no-control-regex
  if (/^d\d+:/.test(raw) || !/^\s*(?:<|\{|\[|[\p{L}\p{N}])/u.test(raw) || /[\u0000-\u0008\u000e-\u001f]/.test(raw)) return { text: '', summary: '二进制、种子数据或无法识别的响应，未记录正文' };
  let text = raw;
  let login = false;
  if (/^\s*</.test(raw)) {
    const dom = new JSDOM(raw);
    try {
      const document = dom.window.document;
      login = !!document.querySelector('input[type="password"]');
      document.querySelectorAll('script,style,noscript,template,svg,form,input,textarea,select').forEach(node => node.remove());
      const prominent = [...document.querySelectorAll('title,h1,[role="alert"],.error,.error-message,.alert-danger')].map(node => node.textContent).join(' ');
      text = prominent + ' ' + (document.body?.textContent || '');
    } finally { dom.window.close(); }
  }
  const clean = redact(text, context);
  return { text, login, summary: clean.slice(0, 240) || '响应正文为空或无可提取的错误文字' };
}

function failure (buffer, response = {}, context = {}, fallback = '响应不是有效的种子文件') {
  const status = Number(response.statusCode) || null;
  const rawType = response.headers?.['content-type'] || response.headers?.['Content-Type'] || '';
  // Retain only a MIME type, never arbitrary header parameters or other headers.
  const contentType = String(rawType).match(/^\s*([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)/i)?.[1].toLowerCase() || '未提供';
  const body = page(buffer, context);
  let category = fallback;
  if (status === 429) category = '站点限流';
  else if (status === 401) category = '站点认证失败（请检查登录凭据）';
  else if (status === 404 || status === 410) category = '下载链接不存在或已失效';
  else if (status >= 500) category = '站点服务异常';
  else if (/cloudflare|captcha|challenge|人机验证|安全验证/i.test(body.text)) category = '疑似站点安全验证或防护拦截';
  else if (body.login || /(?:please|must|need to)\s+(?:log\s*in|sign\s*in)|(?:session|login)\s+(?:has\s+)?expired|invalid\s+(?:passkey|authkey)|请先?登录|登录.{0,8}(?:过期|失效)|未登录/i.test(body.text)) category = '疑似登录失效或认证链接无效';
  else if (status === 403) category = '站点拒绝访问（权限不足或访问受限）';
  else if (status >= 300 && status < 400) category = '下载请求被重定向，未取得种子';
  else if (status >= 400) category = '站点返回 HTTP 错误';
  else if (/too many requests|rate.?limit|请求过于频繁|访问频繁|限流/i.test(body.text)) category = '疑似站点限流';
  const details = { status, contentType, category, summary: body.summary, bytes: buffer.length };
  const error = new Error(`种子文件获取失败: ${category}；HTTP ${status || '未知'}；响应类型: ${contentType}；摘要: ${body.summary}`);
  error.code = 'TORRENT_DOWNLOAD_ERROR';
  error.details = details;
  return error;
}

function decode (buffer) {
  const torrent = bencode.decode(buffer);
  const info = torrent && torrent.info;
  if (!info || !Buffer.isBuffer(info.name)) throw new Error('无有效 info 字段');
  const lengths = Number.isSafeInteger(info.length) ? [info.length] : Array.isArray(info.files) && info.files.length ? info.files.map(file => file.length) : [];
  if (!lengths.length || lengths.some(length => !Number.isSafeInteger(length) || length < 0)) throw new Error('无有效文件大小');
  const size = lengths.reduce((sum, length) => sum + length, 0);
  if (!Number.isSafeInteger(size)) throw new Error('文件大小无效');
  return { hash: crypto.createHash('sha1').update(bencode.encode(info)).digest('hex'), size, name: info.name.toString() };
}

function parse (response, context) {
  const buffer = Buffer.isBuffer(response.body) ? response.body : Buffer.from(typeof response.body === 'string' ? response.body : '');
  if (response.statusCode && (response.statusCode < 200 || response.statusCode >= 300)) throw failure(buffer, response, context);
  try {
    return { ...decode(buffer), buffer };
  } catch (ignored) {
    // Decoder exceptions can contain bytes from the body. Replace them entirely.
    throw failure(buffer, response, context);
  }
}

function networkFailure (error, context) {
  return failure(Buffer.from(redact(error.message, context)), {}, context, '网络请求失败，未取得 HTTP 响应');
}

module.exports = { parse, decode, networkFailure };
