// 端對端測試：以 Chromium 實際操作網頁（匯入 → 整併 → 帳務報表 → 各頁），收集錯誤並截圖。
// 執行：NODE_PATH=$(npm root -g) node tests/e2e.mjs [截圖輸出資料夾]

import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FX = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const OUT = process.argv[2] || fileURLToPath(new URL('../.e2e-shots/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

const server = createServer(async (req, res) => {
  try {
    const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    const file = join(ROOT, p.endsWith('/') || p === '' ? p + 'index.html' : p);
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((r) => server.listen(8123, '127.0.0.1', r));
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
const BASE = 'http://127.0.0.1:8123/erp/';
let step = 0;
const shot = async (name, full = true) => {
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(OUT, `${String(++step).padStart(2, '0')}-${name}.png`), fullPage: full });
};
const go = async (hash) => {
  await page.goto(BASE + '#/' + hash);
  await page.waitForFunction(() => !document.querySelector('#view')?.textContent.includes('載入中'), null, { timeout: 15000 });
  await page.waitForTimeout(300);
};
const importFile = async (file, expectTarget) => {
  await go('import');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="pick"]')]);
  await chooser.setFiles(FX(file));
  await page.waitForSelector('[data-act="commit"]', { timeout: 15000 });
  const target = await page.$eval('[data-act="target"]', (el) => el.value);
  if (expectTarget && target !== expectTarget) throw new Error(`${file} 判斷為 ${target}，預期 ${expectTarget}`);
  return target;
};
const commit = async () => {
  const label = await page.$eval('[data-act="commit"]', (el) => el.textContent.trim());
  await page.click('[data-act="commit"]');
  await page.waitForSelector('.drop', { timeout: 20000 });
  return label;
};
const assert = (cond, msg) => {
  if (!cond) throw new Error('檢查失敗：' + msg);
};

try {
  await go('dashboard');
  assert(await page.isVisible('text=歡迎使用午月營運帳務系統'), '首頁空狀態');
  await shot('dashboard-empty', false);

  // POS（Big5、標題列）
  await importFile('synthetic-pos-big5.csv', 'sales');
  const salesInfo = await page.textContent('#prep');
  assert(/老闆招待 \d+ 筆/.test(salesInfo), '顯示作廢統計');
  await shot('import-pos-mapping');
  console.log('POS:', await commit());

  // 綠界刷卡明細（依檔名判斷）
  await page.goto(BASE + '#/import');
  await page.waitForSelector('[data-act="pick"]');
  {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="pick"]')]);
    await chooser.setFiles(FX('synthetic-ecpay-tx.csv'));
    await page.waitForSelector('[data-act="commit"]');
    await page.selectOption('[data-act="target"]', 'ecpay_tx');
    await page.waitForTimeout(400);
    console.log('ECPay:', await commit());
  }

  // 舊帳 XLSX
  const t = await importFile('sample-books.xlsx');
  if (t !== 'journal') {
    await page.selectOption('[data-act="target"]', 'journal');
    await page.waitForTimeout(400);
  }
  await shot('import-xlsx-journal');
  console.log('XLSX:', await commit());
  await shot('import-history', false);

  // 品項整併
  await go('products');
  const clusters = await page.$$eval('.cluster', (els) => els.map((e) => e.querySelector('h3').textContent));
  console.log('疑似同品項群組：', clusters);
  assert(clusters.some((c) => c.includes('美式咖啡') && c.includes('美式')), '找到 美式咖啡／美式');
  await shot('products-dup');
  for (let i = 0; i < 4; i++) {
    const btn = await page.$('.cluster [data-act="merge"]');
    if (!btn) break;
    await btn.click();
    await page.waitForTimeout(700);
  }
  await page.click('[data-act="tab"][data-tab="master"]');
  await shot('products-master');

  // 儀表板
  await go('dashboard');
  await page.waitForSelector('#c-daily svg');
  await shot('dashboard');

  await go('sales?view=voids&void=1');
  await shot('sales-voids', false);

  // 帳務
  await go('journal?ym=2026-08');
  await shot('journal-aug', false);
  await go('trial?pm=ytd&ym=2026-09');
  assert(await page.isVisible('text=借貸平衡'), '試算表平衡');
  await shot('trial');
  await go('income?pm=ytd&ym=2026-09');
  await shot('income');
  await go('balance?asof=2026-09-30');
  assert(await page.isVisible('text=資產＝負債＋權益'), '資產負債表平衡');
  await shot('balance');
  await go('ledger?pm=month&ym=2026-09&acc=1111');
  await shot('ledger-1111', false);
  await go('vouchers?ym=2026-08');
  await shot('vouchers', false);

  // 固定資產（新增一台咖啡機）
  await go('assets?ym=2026-09');
  await page.click('[data-act="add"]');
  await page.fill('dialog [name=name]', '義式咖啡機（雙孔）');
  await page.fill('dialog [name=acquired_on]', '2026-07-15');
  await page.fill('dialog [name=cost]', '180000');
  await page.click('dialog .btn.primary');
  await page.waitForSelector('text=2,500');
  await shot('assets');

  // 金流、成本、月結、行事曆、損益、設定
  await go('payments');
  await shot('payments');
  await go('cost?ym=2026-09');
  await shot('cost', false);
  await go('closing?ym=2026-09');
  await shot('closing');
  await go('tax?year=2026');
  await shot('tax', false);
  await go('pnl');
  await shot('pnl');
  await go('bank');
  await go('accounts');
  await shot('accounts', false);
  await go('settings');
  await shot('settings');

  // 憑證（已命名檔案 → 帶入欄位 → 入帳）
  await go('documents');
  {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="pick"]')]);
    // 以記憶體檔案傳入（保留中文檔名；此環境的 Playwright 無法直接使用含中文的檔案路徑）
    const mem = async (n) => ({ name: n, mimeType: 'image/png', buffer: await readFile(FX(n)) });
    await chooser.setFiles([await mem('20260902_全聯_鮮乳2瓶_356.png'), await mem('1150905-好市多-NT$1,280-AB12345678.png')]);
    await page.waitForSelector('.doc-card');
    const vals = await page.$$eval('.doc-card', (cards) => cards.map((c) => [c.querySelector('[name=doc_date]').value, c.querySelector('[name=vendor_name]').value, c.querySelector('[name=amount_total]').value, c.querySelector('[name=invoice_no]').value]));
    console.log('憑證帶入：', vals);
    assert(vals.some((v) => v[0] === '2026-09-02' && v[1] === '全聯' && v[2] === '356'), '已命名檔名解析');
    await shot('documents-inbox');
    await page.click('.doc-card [data-act="post"]');
    await page.waitForTimeout(800);
    await page.click('[data-act="tab"][data-t="posted"]');
    await shot('documents-posted', false);
  }

  // 營運：新增原料 → 進貨 → 配方 → 庫存水位扣除 POS 耗用
  await go('inventory');
  await page.click('[data-act="addItem"]');
  await page.fill('dialog [name=name]', '花季配方豆');
  await page.selectOption('dialog [name=category]', 'beans');
  await page.fill('dialog [name=safety_stock]', '1500');
  await page.click('dialog .modal-foot .btn.primary');
  await page.waitForSelector('[data-act="addMove"]');
  await page.click('[data-act="addMove"]');
  await page.selectOption('dialog [name=type]', 'purchase');
  await page.fill('dialog [name=date]', '2026-08-21');
  await page.fill('dialog [name=qty]', '5000');
  await page.fill('dialog [name=amount]', '5500');
  await page.click('dialog .modal-foot .btn.primary');
  await page.waitForTimeout(400);
  await page.click('[data-act="tab"][data-tab="bom"]');
  await page.click('[data-act="recipe"]');
  await page.selectOption('dialog [name=item]', { index: 1 });
  await page.fill('dialog [name=qty]', '18');
  await page.click('dialog .modal-foot .btn.primary');
  await page.waitForTimeout(400);
  await page.click('[data-act="tab"][data-tab="stock"]');
  await page.waitForTimeout(300);
  const onHand = await page.$$eval('table.grid tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
  console.log('庫存水位：', onHand[0]);
  await shot('inventory', false);
  await go('suppliers');
  await shot('suppliers', false);
  await go('customers');
  await shot('customers', false);
  // 行銷活動：關鍵字「燕麥」
  await go('campaigns');
  await page.click('[data-act="add"]');
  await page.fill('dialog [name=name]', '燕麥奶加購週');
  await page.fill('dialog [name=start_date]', '2026-09-01');
  await page.fill('dialog [name=end_date]', '2026-09-22');
  await page.fill('dialog [name=keywords]', '燕麥');
  await page.fill('dialog [name=marketing_cost]', '500');
  await page.click('dialog .modal-foot .btn.primary');
  await page.waitForSelector('#cp-table table');
  const cp = await page.$eval('#cp-table tbody tr', (tr) => [...tr.children].map((td) => td.textContent.trim()).slice(0, 6));
  console.log('活動成效：', cp);
  assert(Number(cp[3].replace(/,/g, '')) > 0, '活動有符合訂單');
  await shot('campaigns', false);

  // 手機版
  await page.setViewportSize({ width: 390, height: 844 });
  await go('dashboard');
  await shot('mobile-dashboard', false);
  await page.click('#menu-btn');
  await page.waitForTimeout(300);
  await shot('mobile-menu', false);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert(overflow <= 1, `手機版水平捲動 ${overflow}px`);

  // 深色模式
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await go('dashboard');
  await shot('dashboard-dark', false);
} catch (e) {
  errors.push('test: ' + e.message);
  await page.screenshot({ path: join(OUT, 'FAILED.png'), fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  server.close();
}

if (errors.length) {
  console.error('\n錯誤：\n' + errors.join('\n'));
  process.exit(1);
}
console.log(`\n通過，截圖在 ${OUT}`);
