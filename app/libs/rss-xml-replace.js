function compile (settings = {}) {
  if (!settings.useCustomRegex) return [];
  const scope = settings.regexScope || 'download';
  if (!['xml', 'download'].includes(scope)) throw new Error('未知的正则替换范围');
  if (scope !== 'xml') return [];
  if (!Array.isArray(settings.regexRules) || !settings.regexRules.length) throw new Error('启用 RSS 全文替换后，请至少添加一条正则规则');
  return settings.regexRules.map((rule, index) => {
    const prefix = 'RSS 正则替换规则 ' + (index + 1) + ': ';
    if (!rule || typeof rule.regexStr !== 'string') throw new Error(prefix + '请输入 /pattern/flags 格式的正则表达式');
    const match = rule.regexStr.match(/^\/([\s\S]*)\/([gimsuy]*)$/);
    if (!match || !match[1]) throw new Error(prefix + '请输入 /pattern/flags 格式的非空正则表达式');
    if (typeof rule.replaceStr !== 'string') throw new Error(prefix + '替换内容必须是文本，留空表示删除');
    try { return { expression: new RegExp(match[1], match[2]), replacement: rule.replaceStr }; } catch (error) { throw new Error(prefix + '正则表达式或标记无效'); }
  });
}

function apply (xml, rules) {
  let result = String(xml);
  for (const rule of rules) {
    rule.expression.lastIndex = 0;
    result = result.replace(rule.expression, rule.replacement);
  }
  return result;
}

module.exports = { compile, apply };
