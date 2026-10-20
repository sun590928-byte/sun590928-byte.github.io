// 作品集預覽版測試：以 file:// 直接開單一 HTML 檔，確認零網路請求、各頁可開、本機辨識可用、正式版功能被擋下。
// 執行：NODE_PATH=$(npm root -g) node tools/build-demo.mjs && NODE_PATH=$(npm root -g) node tests/demo.mjs [截圖資料夾]

import { pathToFileURL, fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const FILE = fileURLToPath(new URL('../dist-demo/午月ERP預覽版.html', import.meta.url));
const OUT = process.argv[2] || fileURLToPath(new URL('../.e2e-shots/demo/', import.meta.url));
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' })).newPage();
const errors = [];
const network = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
page.on('request', (r) => !/^(file|data|blob):/.test(r.url()) && network.push(r.url()));
const assert = (c, msg) => {
  if (!c) throw new Error('檢查失敗：' + msg);
};
let n = 0;
const shot = (name, full = false) => page.screenshot({ path: join(OUT, `${String(++n).padStart(2, '0')}-${name}.png`), fullPage: full });
const go = async (hash) => {
  await page.evaluate((h) => (location.hash = h), '#/' + hash);
  await page.waitForFunction(() => !document.querySelector('#view')?.textContent.includes('載入中'), null, { timeout: 20000 });
  await page.waitForTimeout(400);
};

try {
  const t0 = Date.now();
  await page.goto(pathToFileURL(FILE).href);
  await page.waitForSelector('#nav-links a', { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('#demo-loading'), null, { timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('#view')?.textContent.includes('載入中'));
  console.log(`開啟到可操作：${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  assert(await page.isVisible('.demo-tour'), '導覽卡');
  assert((await page.textContent('#mode-pill')).includes('預覽版'), '資料位置顯示預覽版');
  await page.waitForTimeout(800);
  await shot('dashboard', true);

  // 每一頁都能開、沒有錯誤
  const routes = await page.$$eval('#nav-links a', (as) => as.map((a) => a.getAttribute('href').slice(2)));
  for (const r of routes) {
    await go(r);
    const t = await page.textContent('#view');
    assert(!t.includes('頁面載入失敗'), `${r} 載入失敗：${t.slice(0, 120)}`);
  }
  console.log('各頁可開：', routes.length, '頁');

  for (const [r, name] of [['income', 'income'], ['vat', 'vat'], ['payments', 'payments'], ['journal', 'journal'], ['inventory', 'inventory'], ['bank', 'bank']]) {
    await go(r);
    await shot(name, true);
  }

  // 本機辨識：待覆核 9 張
  await go('documents?tab=inbox');
  await page.evaluate(() => document.querySelector('.demo-tour') && (document.querySelector('.demo-tour').hidden = true));
  await shot('documents-before', true);
  const t1 = Date.now();
  await page.click('[data-act="recogAll"]');
  await page.waitForSelector('.recog-bar', { timeout: 10000 });
  await page.waitForSelector('.recog-bar', { state: 'detached', timeout: 120000 });
  await page.waitForTimeout(600);
  const cards = await page.$$eval('.doc-card', (cs) =>
    cs.map((c) => ({
      name: c.querySelector('.fn').textContent.trim(),
      badges: [...c.querySelectorAll('.badge')].map((b) => b.textContent.trim()).join(' '),
      issues: c.querySelector('.recog-note')?.textContent.replace(/\s+/g, ' ').trim() || '',
      amount: c.querySelector('[name=amount_total]').value,
      tax: c.querySelector('[name=tax_amount]').value,
      account: c.querySelector('[name=account]').value,
    })),
  );
  console.log(`本機辨識 ${cards.length} 張，${((Date.now() - t1) / 1000).toFixed(1)} 秒：`);
  for (const c of cards) console.log(' ', c.badges.padEnd(26), c.amount.padStart(6), c.tax.padStart(4), c.account, c.name.slice(0, 44), c.issues ? '｜' + c.issues.slice(0, 90) : '');
  const by = (k) => cards.find((c) => c.name.includes(k)) || {};
  assert(cards.filter((c) => c.badges.includes('已覆核（自動）')).length >= 4, '至少 4 張自動覆核');
  assert(/重複/.test(by('重拍').issues), '重拍的發票標重複');
  assert(/不是本店/.test(by('奶油乳酪鮮奶油').issues), '買方不是本店');
  assert(by('刀盤及保養').badges.includes('拆分 2 行'), '一張照片兩張發票自動拆分');
  assert(by('森林烘豆坊-咖啡豆5kg').account === '1211' || by('咖啡豆').account === '1211', '咖啡豆沿用以前科目 1211');
  await shot('documents-after', true);

  // 入帳一張、看照片
  await page.click('.doc-card [data-act="zoom"]');
  await page.waitForTimeout(800);
  await shot('photo');
  await page.keyboard.press('Escape');

  // 正式版功能被擋下
  await go('settings');
  await page.click('[data-act="backup"]');
  await page.waitForSelector('.toast >> text=預覽版沒有', { timeout: 5000 });
  assert(network.length === 0, '有網路請求：' + network.slice(0, 5).join(', '));
  console.log('網路請求：0');

  // 放進別的網頁的框裡（作品集網站、Artifact）：沙盒、不同來源、不能用儲存空間也要能顯示
  const framed = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  framed.on('pageerror', (e) => errors.push('iframe pageerror: ' + e.message));
  await framed.setContent('<!doctype html><title>作品集</title><body style="margin:0"><iframe id="f" sandbox="allow-scripts allow-popups" style="width:100%;height:100vh;border:0"></iframe></body>');
  const html = await readFile(FILE, 'utf8');
  await framed.evaluate((h) => (document.querySelector('#f').srcdoc = h), html);
  const frame = await (await framed.waitForSelector('#f')).contentFrame();
  await frame.waitForSelector('#nav-links a', { timeout: 30000 });
  await frame.waitForFunction(() => !document.querySelector('#demo-loading') && document.documentElement.style.display !== 'none', null, { timeout: 30000 });
  assert((await frame.textContent('#view')).includes('營業收入'), '框裡的儀表板有資料');
  await framed.screenshot({ path: join(OUT, `${String(++n).padStart(2, '0')}-in-iframe.png`) });
  console.log('放進框裡（沙盒、無儲存空間）：可正常顯示');
} catch (e) {
  errors.push('test: ' + e.message);
  await shot('failure', true).catch(() => {});
}
await browser.close();
if (errors.length) {
  console.error('\n錯誤：\n' + [...new Set(errors)].join('\n'));
  process.exit(1);
}
console.log('\n預覽版測試通過，截圖在', OUT);
