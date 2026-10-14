// Run after `npm run build` in webui. Uses only a local mock server.
// Set CHROME_PATH if Chrome is not at the default Windows location.
const assert = require('assert').strict;
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const puppeteer = require('puppeteer');

async function main () {
  const root = path.resolve(__dirname, '../app/static');
  assert.ok(fs.existsSync(path.join(root, 'index.html')), 'build webui first');
  const clients = Array.from({ length: 24 }, (_, i) => ({ id: 'client-' + i, alias: '下载器 ' + String(i + 1).padStart(2, '0'), type: 'qBittorrent', enable: true }));
  const groups = [{ id: 'group-a', alias: '大容量 HDD', clientIds: ['client-0'], members: [clients[0]], references: [] }, { id: 'group-b', alias: '日常刷流', clientIds: ['client-1'], members: [clients[1]], references: [] }];
  let rule = { id: 'rule-a', alias: '大小规则', type: 'normal', conditions: [], clientArr: [], clientGroupIds: [] };
  const writes = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.endsWith('/theme.less')) {
      res.setHeader('Content-Type', 'text/css');
      res.end('// Local test uses the bundled default theme.\n');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        writes.push({ url: url.pathname, body });
        if (url.pathname === '/api/rssRule/modify') rule = body;
      }
      const data = url.pathname === '/api/user/get'
        ? { menu: [] }
        : url.pathname === '/api/downloader/list'
          ? clients
          : url.pathname === '/api/downloaderGroup/list'
            ? groups
            : url.pathname === '/api/rssRule/list' ? [rule] : [];
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, data, message: '测试成功' }));
      return;
    }
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); res.end(); return; }
    const actual = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(root, 'index.html');
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
    res.setHeader('Content-Type', types[path.extname(actual)] || 'application/octet-stream');
    fs.createReadStream(actual).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  let page;
  try {
    const localChrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    browser = await puppeteer.launch({ headless: true, executablePath: process.env.CHROME_PATH || (fs.existsSync(localChrome) ? localChrome : undefined) });
    page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', request => request.url().startsWith('http://127.0.0.1:') || request.url().startsWith('data:') ? request.continue() : request.abort());
    await page.emulate(puppeteer.devices['iPhone 12']);
    const base = 'http://127.0.0.1:' + server.address().port;
    const drawer = '.ant-drawer-open';
    const waitOpen = async () => { await page.waitForSelector(drawer + ' .multi-option'); await page.waitForTimeout(400); };
    const tap = async (selector, index = 0) => { const elements = await page.$$(selector); assert.ok(elements[index], selector); await elements[index].tap(); };
    const clickText = async (selector, text) => {
      let element;
      for (const button of await page.$$(drawer + ' .' + selector + ' button')) {
        if ((await button.evaluate(node => node.textContent.replace(/\s/g, ''))).includes(text)) { element = button; break; }
      }
      assert.ok(element, text);
      await element.tap();
    };
    await page.goto(base + '/base/downloader-group', { waitUntil: 'networkidle0' });
    await tap('.multi-trigger');
    await waitOpen();
    assert.equal(await page.evaluate(() => document.activeElement.tagName === 'INPUT'), false, 'opening picker does not focus an input or summon keyboard');
    await tap(drawer + ' .multi-option', 0);
    await tap(drawer + ' .multi-option', 1);
    assert.equal(await page.$$eval('.ant-drawer-open .multi-option input:checked', elements => elements.length), 2, 'touch selections keep panel open');
    assert.equal(writes.length, 0, 'draft selections do not save immediately');
    await clickText('multi-footer', '取消');
    await page.waitForSelector(drawer, { hidden: true });
    await page.waitForTimeout(400);
    assert.match(await page.$eval('.multi-trigger', element => element.textContent), /选择下载器/);
    await tap('.multi-trigger');
    await waitOpen();
    await tap(drawer + ' .multi-option', 0);
    await tap(drawer + ' .multi-option', 1);
    await clickText('multi-tools', '搜索');
    await page.type('.multi-search input', '24');
    await page.waitForFunction(() => document.querySelectorAll('.ant-drawer-open .multi-option').length === 1);
    // Headless Chrome cannot summon an OS keyboard. Simulate VisualViewport shrink
    // and pan, then verify the scrolling list and confirmation footer stay visible.
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => 430 });
      Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, get: () => 24 });
      window.visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForFunction(() => {
      const rect = document.querySelector('.ant-drawer-open .multi-footer').getBoundingClientRect();
      return rect.bottom <= 454 && rect.top >= 24;
    });
    const screenshot = path.join(os.tmpdir(), 'vertex-mobile-select.png');
    await page.screenshot({ path: screenshot });
    await tap(drawer + ' .multi-option');
    await clickText('multi-footer', '确定');
    await page.waitForSelector(drawer, { hidden: true });
    await page.waitForTimeout(400);
    assert.match(await page.$eval('.multi-trigger', element => element.textContent), /已选 3 项/);
    await page.evaluate(() => { delete window.visualViewport.height; delete window.visualViewport.offsetTop; window.visualViewport.dispatchEvent(new Event('resize')); });
    await tap('.multi-trigger');
    await waitOpen();
    assert.equal(await page.$$eval('.ant-drawer-open input:checked', elements => elements.length), 3, 'searching does not discard earlier selections');
    await clickText('multi-tools', '清空选择');
    await clickText('multi-footer', '确定');
    await page.waitForSelector(drawer, { hidden: true });
    await page.waitForTimeout(400);
    assert.match(await page.$eval('.multi-trigger', element => element.textContent), /选择下载器/);

    await page.goto(base + '/rule/rss', { waitUntil: 'networkidle0' });
    await tap('.ant-table .multi-trigger', 0);
    await waitOpen();
    await tap(drawer + ' .multi-option', 0);
    await tap(drawer + ' .multi-option', 1);
    assert.equal(writes.length, 0, 'inline rule editor does not refresh on every mobile selection');
    await Promise.all([page.waitForResponse(response => response.url().includes('/api/rssRule/modify')), clickText('multi-footer', '确定')]);
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].body.clientArr, ['client-0', 'client-1']);
    await page.waitForSelector(drawer, { hidden: true });
    await page.waitForTimeout(400);
    await tap('.ant-table .multi-trigger', 1);
    await waitOpen();
    await tap(drawer + ' .multi-option', 0);
    await tap(drawer + ' .multi-option', 1);
    await Promise.all([page.waitForResponse(response => response.url().includes('/api/rssRule/modify')), clickText('multi-footer', '确定')]);
    assert.deepEqual(writes[1].body.clientGroupIds, ['group-a', 'group-b']);

    await page.setViewport({ width: 1280, height: 800, isMobile: false, hasTouch: false });
    await page.setUserAgent('Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36');
    await page.goto(base + '/base/downloader-group', { waitUntil: 'networkidle0' });
    assert.equal(await page.$('.multi-trigger'), null, 'desktop retains searchable dropdown');
    await page.click('.multi-select .ant-select');
    await page.waitForSelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
    await page.click('.ant-select-item-option');
    assert.ok(await page.$('.ant-select-selection-item'), 'desktop selection still works');
    assert.deepEqual(errors, []);
    console.log('Mobile touch selection, cancel/confirm, search, viewport resize, inline save and desktop checks passed');
    console.log('Screenshot: ' + screenshot);
  } catch (error) {
    if (page) {
      const screenshot = path.join(os.tmpdir(), 'vertex-mobile-select-failure.png');
      await page.screenshot({ path: screenshot });
      console.log('Failure screenshot: ' + screenshot);
      console.log(await page.evaluate(() => {
        const trigger = document.querySelector('.multi-trigger');
        const rect = trigger?.getBoundingClientRect();
        return { trigger: rect?.toJSON(), overlay: rect && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.outerHTML.slice(0, 600), drawers: [...document.querySelectorAll('.ant-drawer')].map(node => ({ class: node.className, style: node.getAttribute('style') })) };
      }));
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
