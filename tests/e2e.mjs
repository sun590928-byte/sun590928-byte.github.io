// 端對端測試：以 Chromium 實際操作網頁（匯入 → 整併 → 帳務報表 → 各頁），收集錯誤並截圖。
// 執行：NODE_PATH=$(npm root -g) node tests/e2e.mjs [截圖輸出資料夾]

import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { readXlsx } from '../erp/js/lib/xlsx.js';
import { DEFAULT_ACCOUNTS, TYPE_LABELS } from '../erp/js/lib/coa.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FX = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
const OUT = process.argv[2] || fileURLToPath(new URL('../.e2e-shots/', import.meta.url));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };

const server = createServer(async (req, res) => {
  try {
    // 先判斷是不是目錄再 normalize：Windows 的 normalize 會把 / 換成 \，endsWith('/') 會失準
    const raw = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = join(ROOT, normalize(raw.endsWith('/') || raw === '' ? raw + 'index.html' : raw).replace(/^([/\\])+/, ''));
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
const PORT = Number(process.env.E2E_PORT) || 8123; // 8123 被占用時用 E2E_PORT 換
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
await mkdir(OUT, { recursive: true });

// 瀏覽器需要 UTF-8 語系，下載的中文檔名才不會變成 download
const browser = await chromium.launch({ env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
// Tesseract 載入繁中語言檔時會印出舊版參數的警告（無害）
page.on('console', (m) => m.type() === 'error' && !/^Warning: Parameter not found|模擬存檔失敗/.test(m.text()) && errors.push('console: ' + m.text())); // 模擬存檔失敗：早午餐企劃故意測的
const BASE = `http://127.0.0.1:${PORT}/erp/`;
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
// 會計項目下拉：1 資產 … 8 所得稅 每一類都要能選
const SAMPLE_CODES = ['1101', '2111', '2133', '2134', '3101', '3102', '4101', '4191', '5101', '6101', '7101', '7501', '8101'];
const assertAllAccounts = async (selector, label) => {
  const lists = await page.$$eval(selector, (sels) => sels.map((s) => [...s.options].map((o) => o.value)));
  assert(lists.length, `${label}：找不到會計項目下拉選單`);
  for (const vals of lists) {
    const miss = SAMPLE_CODES.filter((c) => !vals.includes(c));
    assert(!miss.length, `${label}：少了 ${miss.join('、')}`);
  }
};
const PASS = '午月咖啡2026';
const unlock = async (pass = PASS) => {
  await page.waitForSelector('#g-unlock');
  await page.fill('#g-unlock [name=p]', pass);
  await page.click('#g-unlock [type=submit]');
};
// 讀取 IndexedDB 裡實際存放的內容，確認沒有明文
const rawDb = () =>
  page.evaluate(async () => {
    const db = await new Promise((r, j) => {
      const q = indexedDB.open('wuyue-erp');
      q.onsuccess = () => r(q.result);
      q.onerror = () => j(q.error);
    });
    const all = (s) => new Promise((r) => (db.transaction(s).objectStore(s).getAll().onsuccess = (e) => r(e.target.result)));
    const td = new TextDecoder();
    const enc = await all('_enc');
    const files = await all('_files');
    const meta = await all('_meta');
    const text = [...enc, ...files].map((x) => td.decode(x.data)).join('') + JSON.stringify(meta);
    db.close();
    return { tables: enc.map((x) => x.id), files: files.length, plain: /拿鐵|美式|咖啡|全聯|午月咖啡2026/.test(text) };
  });

try {
  // 模擬舊版（未加密）的本機資料：設定開啟密碼時應加密搬移，並清空舊表
  await page.goto(BASE.replace('/erp/', '/'));
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('wuyue-erp', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('settings', { keyPath: 'id' });
          db.createObjectStore('tax_tasks', { keyPath: 'id' });
          db.createObjectStore('files', { keyPath: 'id' });
        };
        req.onsuccess = () => {
          const t = req.result.transaction(['settings', 'tax_tasks', 'files'], 'readwrite');
          t.objectStore('settings').put({ id: 'main', value: { business_name: '午月咖啡廳（舊版資料）' } });
          t.objectStore('tax_tasks').put({ id: 'legacy-task', done: true });
          t.objectStore('files').put({ id: 'doc_legacy', name: '舊照片.jpg', type: 'image/jpeg', blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }) });
          t.oncomplete = () => {
            req.result.close();
            resolve();
          };
          t.onerror = () => reject(t.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );

  // 第一次開啟：設定開啟密碼 → 復原碼 → 進入
  await page.goto(BASE + '#/dashboard');
  await page.waitForSelector('#g-setup');
  await shot('gate-setup', false);
  await page.fill('#g-setup [name=p1]', '1234');
  await page.fill('#g-setup [name=p2]', '1234');
  await page.click('#g-setup [type=submit]');
  await page.waitForTimeout(300);
  assert(await page.isVisible('#g-setup'), '太短的密碼不能建立');
  await page.fill('#g-setup [name=p1]', PASS);
  await page.fill('#g-setup [name=p2]', PASS);
  await page.click('#g-setup [type=submit]');
  await page.waitForSelector('#g-code');
  const recovery = (await page.textContent('#g-code')).trim();
  assert(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){4}$/.test(recovery), '復原碼格式 ' + recovery);
  await shot('gate-recovery', false);
  await page.check('#g-ok');
  await page.click('#g-next');
  await page.waitForSelector('#nav-links a');
  await page.waitForFunction(() => !document.querySelector('#view')?.textContent.includes('載入中'));
  assert(await page.isVisible('text=歡迎使用午月營運帳務系統'), '首頁空狀態');
  {
    const legacy = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open('wuyue-erp');
          req.onsuccess = () => {
            const db = req.result;
            const t = db.transaction(['settings', 'tax_tasks', 'files', '_files']);
            const n = {};
            let left = 4;
            for (const s of ['settings', 'tax_tasks', 'files', '_files'])
              t.objectStore(s).count().onsuccess = (e) => {
                n[s] = e.target.result;
                if (!--left) {
                  db.close();
                  resolve(n);
                }
              };
          };
        }),
    );
    console.log('舊版資料搬移：', legacy);
    assert(legacy.settings === 0 && legacy.tax_tasks === 0 && legacy.files === 0 && legacy._files === 1, '舊表已清空、照片已加密搬移');
    await go('settings');
    assert((await page.inputValue('[name=business_name]')) === '午月咖啡廳（舊版資料）', '舊版設定已搬進加密資料庫');
    await page.fill('[name=business_name]', '午月咖啡廳');
    await page.click('[data-act="saveBiz"]');
    await page.waitForTimeout(300);
    await go('dashboard');
  }
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
  // 分錄視窗：會計項目下拉選單蓋到灰色背景時，選完的那一下 click 目標是 dialog 本身，不能因此把視窗關掉
  {
    await page.click('[data-act="add"]');
    await page.waitForSelector('dialog #je-lines');
    const stillOpen = await page.evaluate(() => {
      const dlg = document.querySelector('dialog[open]');
      const sel = dlg.querySelector('[name=acc]');
      const r = sel.getBoundingClientRect();
      sel.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 5, clientY: r.top + 5 }));
      dlg.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 5, clientY: 5 }));
      return !!document.querySelector('dialog[open] #je-lines');
    });
    assert(stillOpen, '選科目時分錄視窗不會自己關掉');
    await page.selectOption('dialog [name=acc] >> nth=0', '6112');
    assert(await page.isVisible('dialog #je-lines'), '選好科目後分錄視窗還在');
    await assertAllAccounts('dialog [name=acc]', '日記簿分錄的會計項目');
    // 科目下拉打字篩選：點開 → 打「21」只剩 21xx → 再打「33」Enter 選 2133
    const accVal = (i) => page.$$eval('dialog [name=acc]', (s, i) => s[i].value, i);
    await page.click('dialog [name=acc] >> nth=1');
    await page.waitForSelector('dialog .acc-pop .acc-q');
    await page.keyboard.type('21');
    const shown21 = await page.$$eval('dialog .acc-pop .acc-o .acc-c', (els) => els.map((e) => e.textContent));
    assert(shown21.length > 1 && shown21.every((c) => c.startsWith('21')), '打 21 只剩 21xx：' + shown21.join(','));
    await shot('acc-pick', false);
    await page.keyboard.type('33');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.acc-pop', { state: 'detached' });
    assert((await accVal(1)) === '2133', '打 2133 按 Enter 選到 2133');
    // 下拉有焦點時直接打字：第一個字帶進搜尋框；Esc 只關清單，不關分錄視窗、不改科目
    await page.focus('dialog [name=acc] >> nth=0');
    await page.keyboard.press('6');
    await page.waitForSelector('dialog .acc-pop');
    assert((await page.inputValue('dialog .acc-q')) === '6', '第一個字帶進搜尋框');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.acc-pop', { state: 'detached' });
    assert(await page.isVisible('dialog #je-lines'), 'Esc 只關清單，分錄視窗還在');
    assert((await accVal(0)) === '6112', 'Esc 不改科目');
    // 真的點第一列、第二列的欄位：列的 data-i 不能被當成底部按鈕（第一列＝取消會把視窗關掉）
    await page.click('dialog #je-lines tr[data-i="0"] input >> nth=0');
    await page.click('dialog #je-lines tr[data-i="1"] input >> nth=0');
    assert(await page.isVisible('dialog #je-lines'), '點分錄第一列、第二列的欄位，視窗不會關掉');
    // 打中文名稱，點選清單項目
    await page.click('dialog [name=acc] >> nth=0');
    await page.keyboard.type('代墊');
    const shownCn = await page.$$eval('dialog .acc-pop .acc-o', (els) => els.map((e) => e.textContent));
    assert(shownCn.length && shownCn.every((t) => t.includes('代墊')), '打「代墊」篩選名稱：' + shownCn.join(','));
    await page.click('dialog .acc-pop .acc-o >> nth=0');
    await page.waitForSelector('.acc-pop', { state: 'detached' });
    assert(/^213/.test(await accVal(0)) && (await page.isVisible('dialog #je-lines')), '點選清單項目，分錄視窗還在');
    await page.mouse.click(4, 4); // 真的在背景按下放開才關
    await page.waitForSelector('dialog', { state: 'detached', timeout: 5000 });
    // 期初開帳：全部會計項目（含 3 權益、4 營業收入）都能填
    await page.click('[data-act="opening"]');
    await page.waitForSelector('dialog #op-rows');
    const opCodes = await page.$$eval('dialog input[data-code][data-side="d"]', (els) => els.map((e) => e.dataset.code));
    const opMiss = SAMPLE_CODES.filter((c) => !opCodes.includes(c));
    assert(!opMiss.length, '期初開帳少了 ' + opMiss.join('、'));
    await page.fill('dialog #op-q', '業主');
    assert((await page.$$eval('dialog #op-rows tr[data-row]', (trs) => trs.filter((t) => !t.hidden).map((t) => t.dataset.row))).every((r) => r.includes('業主')), '期初開帳搜尋科目');
    await page.click('dialog .modal-foot .btn'); // 取消
    await page.waitForSelector('dialog', { state: 'detached' });
  }
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
  assert(await page.isVisible('text=期初開帳'), '起算日前購置的資產列入期初');
  // 新購製冰機：上傳發票 → 儲存 → 建立購置分錄（預填、可修改）
  await page.click('[data-act="add"]');
  await page.fill('dialog [name=name]', '製冰機');
  await page.selectOption('dialog [name=category]', 'equipment');
  {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('dialog [data-att="upload"]')]);
    await chooser.setFiles([{ name: '20260905_冷凍設備行_製冰機_CD12345678_31500.png', mimeType: 'image/png', buffer: await readFile(FX('20260902_全聯_鮮乳2瓶_356.png')) }]);
  }
  await page.waitForSelector('dialog .attach-chip');
  const prefilled = await page.$$eval('dialog [name=acquired_on], dialog [name=cost], dialog [name=tax_amount], dialog [name=invoice_no], dialog [name=supplier]', (els) => els.map((el) => el.value));
  console.log('發票帶入：', prefilled);
  assert(JSON.stringify(prefilled) === JSON.stringify(['2026-09-05', '30000', '1500', 'CD12345678', '冷凍設備行']), '從發票檔名帶入日期、成本、稅額、發票號、廠商');
  await shot('asset-dialog', false);
  await page.click('dialog .modal-foot .btn.primary');
  await page.waitForSelector('dialog >> text=要現在建立「製冰機」的購置分錄嗎');
  await page.click('dialog .modal-foot .btn.primary');
  await page.waitForSelector('dialog >> text=建立購置分錄：製冰機');
  const lines = await page.$$eval('dialog #je-lines tr', (trs) => trs.map((tr) => [tr.querySelector('[name=acc]').value, tr.querySelector('[name=dr]').value, tr.querySelector('[name=cr]').value]));
  console.log('購置分錄預填：', lines);
  assert(JSON.stringify(lines) === JSON.stringify([['1521', '30000', ''], ['1261', '1500', ''], ['1103', '', '31500']]), '購置分錄預填借資產、進項稅額，貸銀行');
  assert((await page.textContent('dialog #je-bal')).includes('平衡'), '購置分錄借貸平衡');
  assert(await page.isVisible('dialog .attach-chip'), '購置分錄帶入發票附件');
  await shot('asset-purchase-entry', false);
  await page.click('dialog .modal-foot .btn.primary');
  await page.waitForFunction(() => [...document.querySelectorAll('table.grid tbody tr')].some((tr) => tr.textContent.includes('製冰機') && /11509-\d{4}/.test(tr.textContent)), null, { timeout: 10000 }).catch(() => {});
  const assetRow = await page.$$eval('table.grid tbody tr', (trs) => trs.map((tr) => tr.textContent).find((t) => t.includes('製冰機')));
  assert(/11509-\d{4}/.test(assetRow), '資產列顯示購置分錄傳票號 ' + assetRow);
  await shot('assets');

  // 金流、成本、月結、行事曆、損益、設定
  await go('payments');
  await shot('payments');
  await go('cost?ym=2026-09');
  // 2026-11-10 老闆新增存貨科目 1217 果汁糖漿：啟動時自動補進科目表，存貨與成本頁要有這一列
  const acc1217 = await page.evaluate(async () => {
    const { store } = await import('/erp/js/store.js');
    return (await store.all('accounts')).find((a) => a.code === '1217')?.name || '';
  });
  assert(acc1217 === '原料－各項果汁糖漿', '科目表自動補上 1217 ' + acc1217);
  const costAccounts = await page.$$eval('.report table.grid tbody tr td:first-child', (tds) => tds.map((td) => td.textContent.trim()));
  assert(costAccounts.includes('1217 原料－各項果汁糖漿'), '存貨與成本頁列出 1217 ' + costAccounts.join('｜'));
  assert(costAccounts[0].startsWith('1211') && costAccounts.indexOf('1217 原料－各項果汁糖漿') === costAccounts.length - 1, '存貨科目依代號排序 ' + costAccounts.join('｜'));
  await shot('cost', false);
  await go('closing?ym=2026-09');
  await shot('closing');
  await go('tax?year=2026');
  await shot('tax', false);
  await go('pnl');
  await shot('pnl');

  // 早午餐企劃：第一次是示範數字 → 匯入企劃檔 → 試算器拉桿、菜單成本、進度表勾選、測試紀錄判斷（含 POS 時段營收）、手機寬度
  await go('brunch');
  assert((await page.textContent('#view')).includes('畫面上是示範數字'), '早午餐企劃：第一次使用要說明是示範數字');
  {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="importPlan"]')]);
    await chooser.setFiles(FX('synthetic-brunch-plan.json'));
    await page.waitForSelector('dialog.modal');
    assert((await page.textContent('dialog.modal')).includes('每日紀錄是現場記的'), '早午餐匯入：要說明每日紀錄不會被刪');
    await page.click('dialog.modal .modal-foot [data-i="1"]');
    await page.waitForFunction(() => document.querySelector('#view')?.textContent.includes('示範店早午餐企劃') && !document.querySelector('#view').textContent.includes('畫面上是示範數字'));
  }
  await page.$eval('input[type=range][data-k="people"]', (el) => {
    el.value = '12';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const bpDay = (await page.textContent('#bp-result .stat-value')).trim();
  assert(bpDay.startsWith('+'), '早午餐試算器：12 位客人應該多賺，實際 ' + bpDay);
  assert(!(await page.isDisabled('[data-act="saveSim"]')), '早午餐試算器：改了參數可以存');
  await shot('brunch-sim');
  await go('brunch?tab=menu');
  const bpMenu = await page.textContent('#view');
  assert(bpMenu.includes('示範可頌盤') && bpMenu.includes('40.0%') && bpMenu.includes('1 道還沒有成本'), '早午餐菜單：成本率與缺成本提示');
  await shot('brunch-menu');
  await go('brunch?tab=plan');
  await page.click('[data-act="toggleTask"][data-id="t1"]');
  await page.waitForFunction(() => document.querySelector('#view .stat-value')?.textContent.includes('1／3'));
  // 存檔衝突：別台裝置剛改過 → 不覆蓋、改載入最新的；存檔失敗 → 退回改之前並提示
  await page.evaluate(async () => {
    const { store } = await import('/erp/js/store.js');
    const row = (await store.all('settings')).find((r) => r.id === 'brunch_plan');
    await store.put('settings', { id: 'brunch_plan', value: { ...row.value, name: '別台裝置改的企劃', updated_at: new Date(Date.now() + 1000).toISOString() } });
  });
  await page.click('[data-act="toggleTask"][data-id="t2"]');
  await page.waitForFunction(() => document.querySelector('#view').textContent.includes('別台裝置改的企劃'));
  assert(!(await page.isChecked('[data-act="toggleTask"][data-id="t2"]')), '早午餐存檔衝突：不能覆蓋別台裝置的修改');
  assert((await page.textContent('#toasts')).includes('別的裝置剛改過'), '早午餐存檔衝突：要提示');
  await page.evaluate(async () => {
    const { store } = await import('/erp/js/store.js');
    const orig = store.put;
    store.put = async () => {
      store.put = orig;
      throw new Error('模擬存檔失敗');
    };
  });
  await page.click('[data-act="toggleTask"][data-id="t2"]');
  await page.waitForFunction(() => document.querySelector('#toasts')?.textContent.includes('沒有存到'));
  assert(!(await page.isChecked('[data-act="toggleTask"][data-id="t2"]')), '早午餐存檔失敗：要退回改之前');
  await page.click('[data-act="toggleTask"][data-id="t2"]');
  await page.waitForFunction(() => document.querySelector('#view .stat-value')?.textContent.includes('2／3'));
  await shot('brunch-plan');
  await go('brunch?tab=test');
  await page.waitForSelector('#bp-bars svg');
  const bpTest = await page.textContent('#view');
  assert(bpTest.includes('過關') && bpTest.includes('出餐太慢'), '早午餐測試紀錄：兩個週末日都多賺 → 過關');
  const bpPosRows = await page.$$eval('#view table.grid tbody tr', (trs) => trs.filter((tr) => /\$\d/.test(tr.children[1]?.textContent || '')).length);
  assert(bpPosRows > 0, '早午餐測試紀錄：要帶出 POS 時段營收');
  await shot('brunch-test');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ['sim', 'menu', 'plan', 'test']) {
    await go(`brunch?tab=${tab}`);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(ov <= 1, `早午餐企劃手機版（${tab}）水平捲動 ${ov}px`);
  }
  await shot('brunch-mobile', false);
  await page.setViewportSize({ width: 1360, height: 900 });

  // 濾掛與禮盒企劃：示範數字 → 匯入企劃檔 → 單包毛利、缺豆價提示、改共用成本、禮盒貢獻、進度勾選與存檔衝突、批次效期與留樣、POS 銷量對照、新增批次、手機寬度
  await go('dripbag');
  assert((await page.textContent('#view')).includes('畫面上是示範數字'), '濾掛企劃：第一次使用要說明是示範數字');
  {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="importPlan"]')]);
    await chooser.setFiles(FX('synthetic-dripbag-plan.json'));
    await page.waitForSelector('dialog.modal');
    assert((await page.textContent('dialog.modal')).includes('批次與留樣紀錄是現場記的'), '濾掛匯入：要說明批次紀錄不會被刪');
    await page.click('dialog.modal .modal-foot [data-i="1"]');
    await page.waitForFunction(() => document.querySelector('#view')?.textContent.includes('示範店濾掛企劃') && !document.querySelector('#view').textContent.includes('畫面上是示範數字'));
  }
  {
    const t = await page.textContent('#view');
    assert(t.includes('80%') && t.includes('示範濾掛乙 還沒有熟豆成本'), '濾掛單包：毛利率與缺豆價提示');
    await page.fill('[data-act="param"][data-k="loss"]', '20');
    await page.dispatchEvent('[data-act="param"][data-k="loss"]', 'change');
    await page.waitForFunction(() => document.querySelector('#view').textContent.includes('75%'));
  }
  await shot('dripbag-cost');
  await go('dripbag?tab=gift');
  assert((await page.textContent('#view')).includes('示範禮盒'), '濾掛禮盒：要列出禮盒');
  await shot('dripbag-gift');
  await go('dripbag?tab=plan');
  await page.click('[data-act="toggleTask"][data-id="t1"]');
  await page.waitForFunction(() => document.querySelector('#view .stat-value')?.textContent.includes('1／3'));
  await page.evaluate(async () => {
    const { store } = await import('/erp/js/store.js');
    const row = (await store.all('settings')).find((r) => r.id === 'dripbag_plan');
    await store.put('settings', { id: 'dripbag_plan', value: { ...row.value, name: '別台裝置改的濾掛企劃', updated_at: new Date(Date.now() + 1000).toISOString() } });
  });
  await page.click('[data-act="toggleTask"][data-id="t2"]');
  await page.waitForFunction(() => document.querySelector('#view').textContent.includes('別台裝置改的濾掛企劃'));
  assert(!(await page.isChecked('[data-act="toggleTask"][data-id="t2"]')), '濾掛存檔衝突：不能覆蓋別台裝置的修改');
  await shot('dripbag-plan');
  await go('dripbag?tab=batch');
  {
    const t = await page.textContent('#view');
    assert(t.includes('260825-1') && t.includes('已過期') && t.includes('逾期沒記'), '濾掛批次：過期與留樣逾期要標出來');
    assert(t.includes('還不能延長'), '濾掛效期：沒有第 30 天合格不能延長');
    assert(!(await page.$('[data-act="shelf"][data-k="days"]')), '濾掛效期：已經有批次就不能直接改天數');
    // 留樣第 30 天還沒到、沒選結果都不能記
    await page.click('[data-act="check"][data-day="14"]');
    await page.waitForSelector('dialog.modal');
    await page.click('dialog.modal .modal-foot [data-i="1"]');
    await page.waitForFunction(() => document.querySelector('#toasts')?.textContent.includes('請選結果'));
    await page.click('dialog.modal .modal-foot [data-i="0"]');
    await page.click('[data-act="addBatch"]');
    await page.waitForSelector('dialog.modal');
    await page.fill('dialog.modal [name=packs]', '30');
    await page.click('dialog.modal .modal-foot [data-i="1"]');
    await page.waitForFunction(() => document.querySelectorAll('#view table.grid tbody tr').length === 2);
  }
  await shot('dripbag-batch');
  await go('dripbag?tab=sales');
  {
    const t = await page.textContent('#view');
    assert(/開賣以來[^包]*?[1-9][\d,]* 包/.test(t), '濾掛銷售對照：要從 POS 帶出包數');
    assert(['達標', '要調整', '不擴大'].some((w) => t.includes(w)), '濾掛銷售對照：滿 14 天要有判斷');
  }
  await shot('dripbag-sales');
  await page.setViewportSize({ width: 390, height: 844 });
  for (const tab of ['cost', 'gift', 'plan', 'batch', 'sales']) {
    await go(`dripbag?tab=${tab}`);
    const ov = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(ov <= 1, `濾掛企劃手機版（${tab}）水平捲動 ${ov}px`);
  }
  await shot('dripbag-mobile', false);
  await page.setViewportSize({ width: 1360, height: 900 });

  await go('bank');
  await go('accounts');
  await shot('accounts', false);
  await go('settings');
  await shot('settings');
  assert((await page.inputValue('#biz [name=doc_pay_account]')) === '2134', '設定：憑證歸檔預設付款方式 2134');
  // 老闆把 POS 的暫列科目填成 2133（其實是想設憑證的預設付款方式）：載入時搬到憑證設定、POS 的回到 1105
  await page.evaluate(async () => {
    const { store } = await import('/erp/js/store.js');
    const main = (await store.all('settings')).find((r) => r.id === 'main');
    const { doc_pay_account, ...rest } = main.value;
    await store.put('settings', { id: 'main', value: { ...rest, unknown_payment_account: '2133' } });
  });
  await go('dashboard'); // 已經在設定頁，hash 不變不會重畫，先離開再回來
  await go('settings');
  assert((await page.inputValue('#biz [name=unknown_payment_account]')) === '1105' && (await page.inputValue('#biz [name=doc_pay_account]')) === '2133', '負債科目搬到憑證預設付款方式、POS 回到 1105');
  await page.fill('#biz [name=unknown_payment_account]', '2134');
  await page.click('[data-act="saveBiz"]');
  await page.waitForSelector('.toast >> text=現金類科目');
  await page.fill('#biz [name=unknown_payment_account]', '1105');
  await page.selectOption('#biz [name=doc_pay_account]', '2134');
  await page.click('[data-act="saveBiz"]');
  await page.waitForTimeout(600);
  // 既有的憑證流程測試先關掉「上傳後自動本機辨識」（另有專門的辨識測試）
  const setRecognize = async (on, taxId) => {
    await go('settings');
    await page.setChecked('#biz [name=auto_recognize]', on);
    if (taxId !== undefined) await page.fill('#biz [name=tax_id]', taxId);
    await page.click('[data-act="saveBiz"]');
    await page.waitForTimeout(600);
  };
  await setRecognize(false);

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

  // 全部入帳（不用 AI）：資料齊的直接入帳並歸檔，缺欄位的列出來讓人補
  {
    await page.click('[data-act="tab"][data-t="inbox"]');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="pick"]')]);
    await chooser.setFiles([{ name: 'IMG_0007.png', mimeType: 'image/png', buffer: await readFile(FX('20260902_全聯_鮮乳2瓶_356.png')) }]);
    await page.waitForFunction(() => document.querySelectorAll('.doc-card').length === 2);
    const dfltPay = await page.$eval('.doc-card:has-text("IMG_0007.png") [name=pay_account]', (el) => el.value);
    assert(dfltPay === '2134', '直接上傳（沒有資料夾）的憑證，付款方式先列設定的暫列科目 2134，不是 1101：' + dfltPay);
    assert(await page.isVisible('[data-act="postAll"]'), '有「全部入帳」按鈕');
    await page.click('[data-act="postAll"]');
    await page.waitForSelector('dialog >> text=全部入帳（1）');
    await shot('documents-postall', false);
    await page.click('dialog .modal-foot .btn.primary');
    await page.waitForSelector('dialog >> text=已入帳 1 張');
    const summary = (await page.textContent('dialog .modal-body')).replace(/\s+/g, ' ').trim();
    console.log('批次入帳結果：', summary);
    assert(/略過/.test(summary) && /IMG_0007/.test(summary) && /缺/.test(summary), '缺欄位的憑證被列出：' + summary);
    await page.click('dialog .modal-foot .btn');
    await page.waitForTimeout(300);
  }
  await go('journal?ym=2026-09');
  assert((await page.textContent('table.grid')).includes('好市多'), '批次入帳有產生分錄');
  await go('documents?tab=inbox');

  // 依資料夾上傳：子資料夾名稱決定付款方式；已上傳過的同名檔案只更新付款方式；存摺照片送到「銀行存摺對帳」
  {
    const png = await readFile(FX('20260902_全聯_鮮乳2瓶_356.png'));
    const [c0] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="pick"]')]);
    await c0.setFiles([{ name: '20260911_大創_小碟5件_245.png', mimeType: 'image/png', buffer: png }]);
    await page.waitForSelector('.doc-card >> text=20260911_大創_小碟5件_245.png');
    // 新預設就是 2134，先把它改成 1101 並暫存，才測得到「同名檔案只更新付款方式」
    await page.selectOption('.doc-card:has-text("20260911_大創_小碟5件_245.png") [name=pay_account]', '1101');
    await page.click('.doc-card:has-text("20260911_大創_小碟5件_245.png") [data-act="save"]');
    await page.waitForFunction(async () => { const { store } = await import('/erp/js/store.js'); const d = (await store.all('documents')).find((x) => x.original_name === '20260911_大創_小碟5件_245.png'); return !!d && d.pay_account === '1101'; });
    const dir = join(OUT, 'fx-folder', '原始憑證');
    await rm(join(OUT, 'fx-folder'), { recursive: true, force: true });
    for (const [sub, name] of [
      ['員工代墊支出', '20260911_大創_小碟5件_245.png'],
      ['員工代墊支出', '20260910_蝦皮_吧台抹布_150.png'],
      ['主要帳戶', '20260912_設備商_磨豆機訂金及尾款_120000.png'],
      ['存摺明細', '20260921_存摺.png'],
    ]) {
      await mkdir(join(dir, sub), { recursive: true });
      await writeFile(join(dir, sub, name), png);
    }
    const [c1] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="pickDir"]')]);
    await c1.setFiles(dir);
    await page.waitForSelector('dialog >> text=依資料夾匯入憑證');
    const rows = await page.$$eval('dialog tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
    console.log('資料夾對應：', rows);
    const row = (f) => rows.find((r) => r[0] === f) || [];
    assert(/2134/.test(row('員工代墊支出')[1]) && row('員工代墊支出')[2] === '1' && row('員工代墊支出')[3] === '1', '員工代墊：新上傳 1、更新 1');
    assert(/1103/.test(row('主要帳戶')[1]), '主要帳戶 → 1103');
    assert(/存摺照片 1 張/.test(row('存摺明細')[1]), '存摺照片送到銀行存摺對帳');
    await shot('documents-folder', false);
    await page.click('dialog .modal-foot .btn.primary');
    await page.waitForSelector('.doc-card >> text=20260912_設備商_磨豆機訂金及尾款_120000.png');
    const pays = await page.$$eval('.doc-card', (cards) => Object.fromEntries(cards.map((c) => [c.querySelector('.fn').textContent.trim(), c.querySelector('[name=pay_account]').value])));
    await assertAllAccounts('.doc-card [name=account]', '憑證卡片的會計項目');
    await assertAllAccounts('.doc-card [name=pay_account]', '憑證卡片的付款方式');
    console.log('付款方式：', pays);
    assert(pays['20260911_大創_小碟5件_245.png'] === '2134' && pays['20260910_蝦皮_吧台抹布_150.png'] === '2134' && pays['20260912_設備商_磨豆機訂金及尾款_120000.png'] === '1103', '依資料夾設定付款方式');
    assert(!Object.keys(pays).some((k) => k.includes('存摺')), '存摺沒有上傳');

    // 拆分明細：一張照片兩張發票（訂金＋尾款），固定資產 → 入帳時自動建立資產
    const card = page.locator('.doc-card', { hasText: '20260912_設備商_磨豆機訂金及尾款_120000.png' });
    await card.locator('[data-act="split"]').click();
    await page.waitForSelector('dialog #ln');
    const fillRow = async (i, inv, acc, amt, tax) => {
      const tr = page.locator('dialog #ln tr').nth(i);
      await tr.locator('[name=inv]').fill(inv);
      await tr.locator('[name=acc]').fill(acc); // 打代號即可，離開格子會換成「代號 名稱」
      await tr.locator('[name=amt]').fill(String(amt));
      await tr.locator('[name=tax]').fill(String(tax));
    };
    await fillRow(0, 'FA11111111', '1511', 50000, 2381);
    await fillRow(1, 'FA11111112', '1511', 70000, 3333);
    await shot('documents-split', false);
    await page.click('dialog .modal-foot .btn.primary');
    await page.waitForSelector('.doc-card >> text=拆分 2 行');
    await page.locator('.doc-card', { hasText: '20260912_設備商_磨豆機訂金及尾款_120000.png' }).locator('[data-act="post"]').click();
    await page.waitForSelector('text=已建立固定資產');
    // 暫緩：全部入帳會略過
    await page.locator('.doc-card', { hasText: '20260910_蝦皮_吧台抹布_150.png' }).locator('[data-act="hold"]').click();
    await page.waitForSelector('.doc-card >> text=暫緩入帳');
    await go('journal?ym=2026-09');
    const jt = await page.textContent('table.grid');
    assert(jt.includes('FA11111111+FA11111112') && jt.includes('5,714'), '拆分入帳：兩張發票、進項稅額 5,714');
    await go('assets?ym=2026-09');
    const at = await page.textContent('#view');
    assert(at.includes('磨豆機訂金及尾款') && at.includes('114,286'), '自動建立固定資產，成本 114,286（未稅）');
    await shot('assets-auto', false);
  }

  // 本機辨識（瀏覽器內，不用外部 AI）：電子發票 QR 碼 → 自動帶入；沒有 QR 的收據 → 文字辨識 → 標「需確認」
  {
    await setRecognize(true, '12345675');
    await go('documents?tab=inbox');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="pick"]')]);
    await chooser.setFiles([{ name: '20260915-測試烘豆-咖啡豆鮮乳.png', mimeType: 'image/png', buffer: await readFile(FX('einvoice-qr.png')) }]);
    const card = page.locator('.doc-card', { hasText: '20260915-測試烘豆-咖啡豆鮮乳.png' });
    await card.locator('.badge >> text=本機辨識').waitFor({ timeout: 60000 });
    const v = await card.evaluate((c) => Object.fromEntries(['doc_date', 'invoice_no', 'amount_total', 'tax_amount', 'vendor_name', 'vendor_tax_id'].map((n) => [n, c.querySelector(`[name=${n}]`).value]).concat([['deductible', c.querySelector('[name=deductible]').checked]])));
    console.log('QR 辨識：', v);
    assert(v.invoice_no === 'QR00000001' && v.doc_date === '2026-09-15' && v.amount_total === '1050' && v.tax_amount === '50' && v.deductible && v.vendor_tax_id === '10047514' && v.vendor_name === '測試烘豆', 'QR 碼帶入發票號碼、日期、金額、稅額、賣方統編、可扣抵');
    assert((await card.textContent('.recog-why')).includes('QR 碼'), '辨識依據列出 QR 碼');
    await shot('documents-recognize-qr', false);
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await card.screenshot({ path: join(OUT, `${String(++step).padStart(2, '0')}-card-qr.png`) });

    // 沒有 QR 的收據：在瀏覽器畫一張合成收據，交給文字辨識
    const b64 = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 900;
      c.height = 1000;
      const g = c.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#000';
      g.font = 'bold 56px "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif';
      ['收  據', '測試商行', '日期 2026/09/20 10:11', '品名 抹布 3 條', '總計 356 元'].forEach((t, i) => g.fillText(t, 70, 130 + i * 160));
      return c.toDataURL('image/png').split(',')[1];
    });
    const [c2] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="pick"]')]);
    await c2.setFiles([{ name: 'IMG_0101.png', mimeType: 'image/png', buffer: Buffer.from(b64, 'base64') }]);
    const rc = page.locator('.doc-card', { hasText: 'IMG_0101.png' });
    await rc.locator('.badge >> text=本機辨識').waitFor({ timeout: 180000 });
    const r = await rc.evaluate((c) => ({ date: c.querySelector('[name=doc_date]').value, amt: c.querySelector('[name=amount_total]').value, note: c.querySelector('.recog-note')?.textContent || '' }));
    console.log('文字辨識：', r);
    assert(r.amt === '356' && r.date === '2026-09-20', '文字辨識帶入金額與日期');
    assert(/需確認/.test(r.note) && /文字辨識/.test(r.note), '只靠文字辨識的欄位標「需確認」');
    await shot('documents-recognize-ocr', false);
    await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
    await rc.locator('.recog-why summary').click();
    await rc.screenshot({ path: join(OUT, `${String(++step).padStart(2, '0')}-card-ocr.png`) });
    // 老闆看過按「暫存」＝確認，清掉需確認
    await rc.locator('[data-act="save"]').click();
    await page.waitForTimeout(500);
    assert(!(await rc.locator('.recog-note').count()), '暫存後不再標需確認');
    // 存摺照片（合成）：本機辨識 → 用結存逐列核對 → 列出全部讀到的列勾選匯入 → 批次補登建議科目
    {
      await go('bank');
      // 先前選資料夾時送過來的存摺照片（測試用的是發票圖，讀不到明細）：打開這頁會自動辨識，關掉結果
      await page.waitForSelector('dialog', { timeout: 60000 });
      await page.click('dialog .modal-foot .btn');
      await page.waitForSelector('dialog', { state: 'detached' });
      const pb = await page.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 1500;
        c.height = 800;
        const g = c.getContext('2d');
        g.fillStyle = '#eef3ee';
        g.fillRect(0, 0, c.width, c.height);
        g.fillStyle = 'rgba(70,120,90,0.16)';
        g.font = '15px Arial';
        for (let y = 18; y < c.height; y += 20) g.fillText('THE DEMO CREDIT COOPERATIVE  '.repeat(6), (y % 40) - 30, y);
        g.fillStyle = '#111';
        g.font = 'bold 32px "Microsoft JhengHei", "Noto Sans CJK TC", sans-serif';
        const rows = [
          ['', '帳號:9999999-11-0000001', '', '*100,000.00 本數:0'],
          ['1150901', '網銀 1150831', '*2,500.00 (8月代墊)', '*97,500.00 營業部'],
          ['1150901', '電匯 (綠界科技股)', '*1,989.00', '*99,489.00'],
          ['1150902', '現金 (0901銷)', '*3,275.00', '*102,764.00'],
          ['1150903', '現金 (0902銷)', '*1,590.00', '*104,354.00'],
          ['1150903', '網銀 (房租)', '*5,000.00', '*99,354.00 營業部'],
        ];
        rows.forEach((r, i) => {
          const y = 110 + i * 100;
          g.fillText(r[0], 30, y);
          g.fillText(r[1], 200, y);
          g.fillText(r[2], 620, y);
          g.fillText(r[3], 1020, y);
        });
        g.fillStyle = '#1d3fbf';
        g.font = 'italic 34px cursive';
        g.fillText('9/1', 1400, 330); // 藍筆手寫：前處理要濾掉
        return c.toDataURL('image/png').split(',')[1];
      });
      const [cp] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="photos"]')]);
      await cp.setFiles([{ name: '20260901-20260903-示範存摺.png', mimeType: 'image/png', buffer: Buffer.from(pb, 'base64') }]);
      await page.waitForSelector('dialog #pb-rows', { timeout: 120000 });
      const info = (await page.textContent('dialog .callout')).replace(/\s+/g, ' ');
      const okRows = Number((/對得上 (\d+)/.exec(info) || [])[1] || 0);
      console.log('存摺照片：', info.slice(0, 60), '；', await page.textContent('#pb-sum'));
      assert(okRows >= 4, '合成存摺至少 4 列對得上：' + info);
      await shot('bank-passbook-review', false);
      await page.click('dialog .modal-foot .btn.primary');
      await page.waitForSelector('text=已匯入', { timeout: 15000 });
      await page.waitForSelector('[data-act="bookMany"]');
      await assertAllAccounts('[data-act="gl"]', '存摺對應會計項目');
      await page.click('[data-act="bookMany"]');
      await page.waitForSelector('dialog >> text=批次補登');
      const sugg = await page.$$eval('dialog tbody tr', (trs) => trs.map((tr) => [tr.children[2].textContent, tr.querySelector('[name=acc]').value]));
      console.log('補登建議：', sugg.filter(([d]) => /綠界|代墊|銷|房租/.test(d)));
      assert(sugg.some(([d, a]) => /綠界/.test(d) && a === '1111'), '綠界撥款建議 1111');
      assert(sugg.some(([d, a]) => /銷/.test(d) && a === '1105'), '現金營收存入建議 1105 現金');
      await shot('bank-bookmany', false);
      await page.click('dialog .modal-foot .btn');
      await page.waitForTimeout(300);
    }
    await setRecognize(false, '');
    await go('documents?tab=inbox');
  }

  // 會計項目：匯入整份科目表 CSV（預覽差異）→ 重新開啟系統後仍是新的
  {
    await go('accounts');
    assert(await page.isVisible('text=資料位置：'), '頁首顯示資料位置');
    const rowsCsv = [['代號', '名稱', '類別', '餘額方向', '成本性質', '營所稅申報欄位', '說明'], ...DEFAULT_ACCOUNTS.map((a) => [a.code, a.code === '6130' ? '訓練費（員工教育）' : a.name, TYPE_LABELS[a.type], a.side === 'credit' ? '貸' : '借', '', a.tax_line || '', a.hint || ''])];
    rowsCsv.push(['6137', '測試新科目', '營業費用', '借', '固定', '借', '匯入測試']);
    rowsCsv.push(['1116', '應收帳款－測試', '營業費用', '借', '', '', '']);
    const csv = '\uFEFF' + rowsCsv.map((r) => r.join(',')).join('\r\n');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="import"]')]);
    await chooser.setFiles([{ name: '會計項目表-測試.csv', mimeType: 'text/csv', buffer: Buffer.from(csv, 'utf8') }]);
    await page.waitForSelector('dialog >> text=匯入科目表');
    const body = (await page.textContent('dialog .modal-body')).replace(/\s+/g, ' ');
    assert(/新增 2 個/.test(body) && /改名 1 個/.test(body) && /自動修正 2 處/.test(body), '匯入預覽：' + body.slice(0, 300));
    await shot('accounts-import', false);
    await page.click('dialog .modal-foot .btn.primary');
    await page.waitForSelector('text=已匯入並確認');
    await page.reload();
    await unlock();
    await page.waitForSelector('#nav-links a');
    await go('accounts');
    const t = await page.textContent('#view');
    assert(t.includes('訓練費（員工教育）') && t.includes('測試新科目') && t.includes('應收帳款－測試'), '重新開啟後科目仍是新的');
  }

  // 匯入已申報的 7–8 月媒體檔（合成資料）→ 標記已申報並逐張核對
  {
    const rec = (fmt, ym, buyer, seller, inv, amount, taxType, tax, ded) => [fmt, '000000000', '0000001', ym, String(buyer).padEnd(8, ' '), String(seller).padEnd(8, ' '), inv.padEnd(10, ' '), String(amount).padStart(12, '0'), taxType, String(tax).padStart(10, '0'), ded, '     ', ' ', ' ', ' '].join('');
    const txt = [
      rec('25', '11508', '12345675', '66666666', 'AB12345678', 1219, '1', 61, '1'),
      rec('25', '11508', '12345675', '11111111', 'ZZ00000001', 1000, '1', 50, '1'),
      rec('35', '11508', '', '12345675', 'DV00000001', 10500, '1', 0, ' '),
      rec('35', '11508', '', '12345675', 'DV00000002', 0, 'F', 0, ' '),
    ].join('\r\n');
    await go('vat?p=2026-07');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="media"]')]);
    await chooser.setFiles([{ name: '12345675.TXT', mimeType: 'text/plain', buffer: Buffer.from(txt, 'latin1') }]);
    await page.waitForSelector('dialog >> text=匯入申報媒體檔');
    assert((await page.inputValue('dialog [name=o]')) === '500', '銷項稅額估算 10,500 ÷ 1.05 × 5%');
    assert((await page.inputValue('dialog [name=ie]')) === '111', '可扣抵進項稅額 61＋50');
    await page.click('dialog .modal-foot .btn.primary');
    await page.waitForSelector('text=申報媒體檔核對');
    const vt = (await page.textContent('#view')).replace(/\s+/g, ' ');
    assert(/系統找不到這張憑證：1 張/.test(vt), '找不到 ZZ00000001');
    assert(vt.includes('已申報'), '7–8 月標記已申報');
    assert(vt.includes('$389') && vt.includes('依申報紀錄'), '已申報期別顯示 401 數字（應繳 500－111＝389）');
    await shot('vat-media', false);
  }

  // 營業稅 401 工作表：固定資產進項稅額、產生結轉分錄、標記申報
  await go('vat?p=2026-09');
  const vatText = await page.textContent('#view');
  assert(vatText.includes('CD12345678') && vatText.includes('固定資產'), '401 進項清單列出資產發票');
  assert(vatText.includes('1,500'), '固定資產進項稅額 1,500');
  await shot('vat');
  assert(!(await page.textContent('#view')).includes('帳上本期進項稅額'), '資產發票稅額與帳上進項稅額一致');
  await page.click('[data-act="settle"]');
  await page.waitForSelector('text=結轉分錄：');
  await page.click('[data-act="file"]');
  if (await page.isVisible('dialog >> text=仍要標記已申報')) await page.click('dialog .modal-foot .btn.primary');
  await page.waitForSelector('text=已申報（');
  await go('tax?year=2026');
  assert(await page.isVisible('text=目標 11/12（四）'), '行事曆顯示 9–10 月營業稅目標日 11/12');
  await go('journal?ym=2026-10');
  assert((await page.textContent('table.grid')).includes('營業稅結轉（115 年 9–10 月）'), '日記簿有營業稅結轉分錄');

  // 11/12 需求 二-2～二-4（稅務）：伙食費／水電電信沒有本店統編 → 自動扣抵代號 3；匯入國稅局進項 CSV 後列出 ERP 沒入帳的；一鍵產生申報媒體檔 TXT（全為合成資料）
  {
    const SHOP = '12345675';
    await setRecognize(false, SHOP);
    await page.evaluate(async (shop) => {
      const { store } = await import('/erp/js/store.js');
      const base = { kind: 'receipt', status: 'reviewed', mime: 'image/png', pay_account: '2134', invoice_type: '電子發票', deductible: true, created_at: new Date().toISOString() };
      await store.put('documents', [
        { ...base, id: 'doc_t1112a', original_name: '1112-伙食.png', doc_date: '2026-11-03', vendor_name: '測試便當', vendor_tax_id: '10047514', buyer_tax_id: shop, invoice_no: 'QA11120001', amount_total: 1050, tax_amount: 50, account: '6126', summary: '員工餐' },
        { ...base, id: 'doc_t1112b', original_name: '1112-電費-無統編.png', doc_date: '2026-11-04', vendor_name: '測試電力', vendor_tax_id: '10324679', buyer_tax_id: '', invoice_no: 'BB11120002', amount_total: 2100, tax_amount: 100, account: '6118', summary: '電費' },
        { ...base, id: 'doc_t1112c', original_name: '1112-電話-本店.png', doc_date: '2026-11-05', vendor_name: '測試電信', vendor_tax_id: '10324679', buyer_tax_id: shop, invoice_no: 'QA11120003', amount_total: 1365, tax_amount: 65, account: '6115', summary: '電話費' },
      ]);
    }, SHOP);
    await go('documents?tab=inbox');
    const autoCode = (name) => page.$eval(`.doc-card:has-text("${name}") [name=ded_code] option[value=""]`, (o) => o.textContent.trim());
    assert((await autoCode('1112-伙食.png')).includes('自動（3）'), '伙食費自動判斷扣抵代號 3');
    assert((await autoCode('1112-電費-無統編.png')).includes('自動（3）'), '電費帳單沒有本店統編 → 3');
    assert((await autoCode('1112-電話-本店.png')).includes('自動（1）'), '電話費帳單有本店統編 → 照常 1');
    for (const name of ['1112-伙食.png', '1112-電費-無統編.png', '1112-電話-本店.png']) {
      await page.locator('.doc-card', { hasText: name }).locator('[data-act="post"]').click();
      // 等憑證標「已入帳」而且分錄讀得到，再點下一張
      await page.waitForFunction(
        async (n) => {
          const { store } = await import('/erp/js/store.js');
          const d = (await store.all('documents')).find((x) => x.original_name === n);
          return d?.status === 'posted' && (await store.all('journal_entries')).some((e) => e.id === d.entry_id);
        },
        name,
        { timeout: 15000 },
      );
      await page.waitForTimeout(300);
    }
    const posted = await page.evaluate(async () => {
      const { store } = await import('/erp/js/store.js');
      const docs = await store.all('documents');
      const entries = await store.all('journal_entries');
      return Object.fromEntries(['doc_t1112a', 'doc_t1112b', 'doc_t1112c'].map((id) => { const d = docs.find((x) => x.id === id); const e = entries.find((x) => x.id === d?.entry_id); return [id, { status: d?.status, entry: d?.entry_id, ded: d?.ded_code, lines: (e?.lines || []).map((l) => [l.account, l.debit, l.credit]) }]; }));
    });
    console.log('11/12 扣抵入帳：', JSON.stringify(posted));
    assert(posted.doc_t1112a.ded === '3' && posted.doc_t1112a.lines.some(([a, d]) => a === '6126' && d === 1050) && !posted.doc_t1112a.lines.some(([a]) => a === '1261'), '伙食費稅額併入費用、不進 1261');
    assert(posted.doc_t1112b.ded === '3' && posted.doc_t1112b.lines.some(([a, d]) => a === '6118' && d === 2100) && !posted.doc_t1112b.lines.some(([a]) => a === '1261'), '電費沒有本店統編：稅額併入費用');
    assert(posted.doc_t1112c.ded === '1' && posted.doc_t1112c.lines.some(([a, d]) => a === '1261' && d === 65), '電話費有本店統編：進項稅額 65');

    // 二-4：匯入國稅局進項發票 CSV → 自動列出「國稅局有、ERP 沒入帳」與金額不符
    const einvCsv = [
      '發票號碼,發票日期,賣方統一編號,賣方名稱,買方統一編號,銷售額,稅額,總計,發票狀態',
      'QA11120001,2026/11/03,10047514,測試便當,12345675,1000,50,1050,開立',
      'QA11120003,2026/11/05,10324679,測試電信,12345675,1250,63,1313,開立',
      'QA11120004,2026/11/06,10047514,測試烘豆,12345675,2000,100,2100,開立',
      'QA11120005,2026/11/07,10324679,測試包材,12345675,500,25,525,開立',
    ].join('\r\n');
    await go('import');
    const [ch1] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="pick"]')]);
    await ch1.setFiles([{ name: '國稅局進項發票-測試.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + einvCsv, 'utf8') }]);
    await page.waitForSelector('[data-act="commit"]', { timeout: 15000 });
    assert((await page.$eval('[data-act="target"]', (el) => el.value)) === 'einvoice', '國稅局進項 CSV 判斷為電子發票（進項）');
    await page.click('[data-act="commit"]');
    await page.waitForSelector('dialog >> text=國稅局有、ERP 沒入帳的發票', { timeout: 15000 });
    const gapMsg = (await page.textContent('dialog .modal-body')).replace(/\s+/g, ' ');
    console.log('匯入後列出：', gapMsg.slice(0, 200));
    assert(/沒入帳 2 張/.test(gapMsg) && /金額不符 1 張/.test(gapMsg) && gapMsg.includes('QA11120004') && gapMsg.includes('QA11120005') && gapMsg.includes('金額 國稅局 1313／ERP 1365'), '匯入後自動列出國稅局有、ERP 沒入帳的發票');
    await shot('einvoice-gaps-after-import', false);
    await page.click('dialog a[data-go][href="#/vat?p=2026-11"]');
    await page.waitForSelector('#vat-gaps >> text=國稅局有、ERP 沒入帳：2 張');
    assert(!(await page.isVisible('dialog.modal')), '點連結後關閉清單');
    const gapView = (await page.textContent('#vat-gaps')).replace(/\s+/g, ' ');
    assert(gapView.includes('金額或稅額不符：1 張') && gapView.includes('稅額 國稅局 63／ERP 65'), '營業稅頁也看得到金額不符');
    // 直接從清單入帳
    await page.click('#vat-gaps tr[data-gap="QA11120004"] [data-act="gapPost"]');
    await page.waitForSelector('dialog [name=acc]');
    await page.selectOption('dialog [name=acc]', '1211');
    await page.click('dialog .modal-foot .btn.primary');
    await page.waitForSelector('#vat-gaps >> text=國稅局有、ERP 沒入帳：1 張');
    const vt1112 = (await page.textContent('#view')).replace(/\s+/g, ' ');
    assert(vt1112.includes('伙食費（員工餐）屬職工福利性質') && vt1112.includes('水電瓦斯費帳單沒有載明本店統編'), '401 進項清單寫出不可扣抵原因');
    await shot('vat-einvoice-gaps', false);

    // 二-3：一鍵產生申報媒體檔（進項＋銷項明細 CSV＋空白發票）
    await page.click('[data-act="mediaOut"]');
    await page.waitForSelector('dialog >> text=產生申報媒體檔');
    assert((await page.textContent('dialog #mx-prev')).includes('還沒有銷項明細'), '沒選銷項明細時說明缺什麼');
    await page.fill('dialog [name=reg]', '123456789');
    await page.fill('dialog [name=blank]', 'QZ11120050-QZ11120099\nQZ11120100');
    const salesCsv = ['發票號碼,發票日期,買方統一編號,銷售額,稅額,總計,發票狀態', 'XA11120001,2026/11/01,,,,105,開立', 'XA11120002,2026/11/02,10332598,2000,100,2100,開立', 'XA11120003,2026/11/02,,,,50,作廢'].join('\r\n');
    const [ch2] = await Promise.all([page.waitForEvent('filechooser'), page.click('dialog [data-x="sales"]')]);
    await ch2.setFiles([{ name: '銷項發票-測試.csv', mimeType: 'text/csv', buffer: Buffer.from('﻿' + salesCsv, 'utf8') }]);
    await page.waitForSelector('dialog #mx-sales >> text=本期銷項 3 筆');
    const prev = (await page.textContent('dialog #mx-prev')).replace(/\s+/g, ' ');
    console.log('媒體檔預覽：', prev.slice(0, 300));
    assert(prev.includes('51 張（2 段）') && /作廢\s*1 張/.test(prev) && !prev.includes('還沒有銷項明細'), '預覽列出空白發票與銷項');
    await shot('vat-media-export', false);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('dialog .modal-foot .btn.primary')]);
    assert(dl.suggestedFilename() === `${SHOP}.TXT`, '媒體檔檔名 ' + dl.suggestedFilename());
    const txtFile = join(OUT, dl.suggestedFilename());
    await dl.saveAs(txtFile);
    const raw = (await readFile(txtFile)).toString('latin1');
    const recs = raw.split('\r\n');
    assert(raw.endsWith('\r\n') && recs.pop() === '' && recs.every((l) => l.length === 81 && /^[\x20-\x7E]+$/.test(l)), '每筆 81 字元、CRLF');
    const byInv = Object.fromEntries(recs.map((l) => [l.slice(39, 49).trim(), l]));
    const fld = (l) => ({ fmt: l.slice(0, 2), reg: l.slice(2, 11), ym: l.slice(18, 23), buyer: l.slice(23, 31), seller: l.slice(31, 39), amount: Number(l.slice(49, 61)), tt: l[61], tax: Number(l.slice(62, 72)), ded: l[72], agg: l[79] });
    console.log('媒體檔：', recs.length, '筆；', Object.keys(byInv).join(' '));
    assert(fld(byInv.QA11120001).ded === '3' && fld(byInv.QA11120001).tax === 50 && fld(byInv.QA11120001).amount === 1000 && fld(byInv.QA11120001).reg === '123456789' && fld(byInv.QA11120001).ym === '11511', '伙食費進項：扣抵代號 3');
    assert(fld(byInv.QA11120003).ded === '1' && fld(byInv.QA11120003).tax === 65 && fld(byInv.QA11120004).ded === '1' && fld(byInv.QA11120004).seller === '10047514', '可扣抵進項：扣抵代號 1');
    assert(!byInv.BB11120002, '沒有本店統編的電費不列入媒體檔');
    assert(fld(byInv.XA11120002).buyer === '10332598' && fld(byInv.XA11120002).tax === 100 && fld(byInv.XA11120001).amount === 105 && fld(byInv.XA11120003).tt === 'F', '銷項：三聯、二聯（含稅）、作廢');
    const bl = fld(byInv.QZ11120050);
    assert(bl.fmt === '35' && bl.tt === 'D' && bl.agg === 'A' && bl.buyer === '11120099' && bl.seller === SHOP && bl.ym === '11512', '空白發票彙加：課稅別 D、訖號在買方統編欄、彙加註記 A');
    assert(fld(byInv.QZ11120100).agg === ' ' && fld(byInv.QZ11120100).tt === 'D', '單張空白發票');
    // 重新打開：稅籍編號與空白發票號碼記住了
    await page.click('[data-act="mediaOut"]');
    await page.waitForSelector('dialog >> text=產生申報媒體檔');
    assert((await page.inputValue('dialog [name=reg]')) === '123456789' && (await page.inputValue('dialog [name=blank]')).includes('QZ11120050-QZ11120099'), '稅籍編號與空白發票號碼會記住');
    await page.click('dialog .modal-foot .btn');
    await setRecognize(false, '');
  }
  // 月結：下載本月帳冊（Excel）
  await go('closing?ym=2026-09');
  {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-act="book"]')]);
    assert(dl.suggestedFilename() === '午月帳冊_2026-09.xlsx', '帳冊檔名 ' + dl.suggestedFilename());
    const file = join(OUT, dl.suggestedFilename());
    await dl.saveAs(file);
    const wb = await readXlsx(new Uint8Array(await readFile(file)));
    console.log('帳冊工作表：', wb.map((w) => `${w.name}(${w.rows.length})`).join('、'));
    assert(wb.length === 9 && wb[0].name === '日記簿' && wb.some((w) => w.name === '資產負債表'), '帳冊包含 9 張工作表');
  }
  // 日記簿篩選「缺原始憑證」
  await go('journal?ym=2026-08&src=nodoc');
  await shot('journal-nodoc', false);

  // 營運：新增原料 → 進貨 → 配方 → 庫存水位扣除 POS 耗用
  await go('inventory');
  await page.click('[data-act="addItem"]');
  const catOpts = await page.$$eval('dialog [name=category] option', (os) => os.map((o) => `${o.value}=${o.textContent.trim()}`));
  assert(catOpts.includes('juice_syrup=果汁糖漿') && catOpts.includes('tea_syrup=茶葉／粉類'), '商品分類有果汁糖漿 ' + catOpts.join('｜'));
  await page.selectOption('dialog [name=category]', 'juice_syrup');
  const glHint1217 = await page.$eval('dialog', (d) => d.textContent);
  assert(glHint1217.includes('入帳科目：1217'), '選果汁糖漿時顯示入帳科目 1217');
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

  // 供應商：基本資料＋付款條件（匯款銀行、戶名、帳號）
  await go('suppliers');
  await page.click('[data-act="addSup"]');
  await page.fill('dialog [name=short_name]', '鮮乳坊');
  await page.fill('dialog [name=name]', '鮮乳坊股份有限公司');
  await page.fill('dialog [name=tax_id]', '12345678');
  await page.fill('dialog [name=contact]', '王小明');
  await page.fill('dialog [name=mobile]', '0912-345-678');
  await page.fill('dialog [name=terms]', '月結 30 天');
  await page.fill('dialog [name=bank_branch]', '台灣銀行－城中分行');
  await page.fill('dialog [name=bank_code]', '004');
  await page.fill('dialog [name=account_name]', '鮮乳坊股份有限公司');
  await page.fill('dialog [name=account_number]', '0123456789012');
  await page.click('dialog .modal-foot .btn.primary');
  await page.waitForSelector('#sup-table table');
  const supRow = await page.textContent('#sup-table tbody tr');
  assert(supRow.includes('鮮乳坊') && supRow.includes('0123456789012'), '供應商名單含簡稱與匯款帳號：' + supRow);
  await shot('suppliers', false);

  // 進貨紀錄：新增進貨單（新品名自動建檔 + 既有品項帶入單位）→ 原物料主檔 → 進銷存
  await go('purchases');
  await page.click('[data-act="addDoc"]');
  await page.fill('dialog [name=supplier]', '鮮乳坊');
  await page.fill('dialog [name=invoice_no]', 'AB12345678');
  await page.fill('dialog [name=invoice_date]', '2026-09-05');
  const cell = (i, n) => `dialog #po-lines tr:nth-child(${i}) [name=${n}]`;
  await page.fill(cell(1, 'name'), '鮮乳 936ml');
  await page.fill(cell(1, 'unit'), '瓶');
  await page.fill(cell(1, 'qty'), '12');
  await page.fill(cell(1, 'price'), '85');
  await page.fill(cell(2, 'name'), '花季配方豆');
  await page.dispatchEvent(cell(2, 'name'), 'change');
  assert((await page.inputValue(cell(2, 'unit'))) === 'g', '既有品項帶入庫存單位');
  await page.fill(cell(2, 'qty'), '1000');
  await page.fill(cell(2, 'price'), '1.1');
  await page.press(cell(2, 'price'), 'Enter');
  assert(await page.evaluate(() => document.activeElement?.name === 'amount'), 'Enter 跳到下一格');
  const bar = await page.textContent('dialog #po-bar');
  assert(bar.includes('2,120') && bar.includes('自動建檔 1 項'), '進貨單合計與自動建檔提示：' + bar);
  await shot('purchase-editor', false);
  await page.click('dialog .modal-foot .btn.primary');
  await page.waitForFunction(() => document.querySelector('#po-body tbody')?.textContent.includes('AB12345678'), null, { timeout: 15000 });
  const poRow = await page.textContent('#po-body tbody tr');
  assert(poRow.includes('AB12345678') && poRow.includes('2,120'), '進貨單列表：' + poRow);
  await shot('purchases', false);
  await page.click('[data-act="tab"][data-tab="items"]');
  await page.waitForTimeout(300);
  const master = await page.textContent('#po-body table');
  assert(master.includes('鮮乳 936ml') && master.includes('乳品') && master.includes('DY-001'), '原物料主檔有自動建檔的鮮乳（乳品、DY-001）');
  await shot('purchases-items', false);
  await page.click('[data-act="tab"][data-tab="lines"]');
  await page.waitForTimeout(300);
  const detail = await page.textContent('#po-body table');
  assert(detail.includes('AB12345678') && detail.includes('鮮乳 936ml') && detail.includes('瓶') && detail.includes('1,020'), '進貨明細分頁：發票號碼、品名、單位、含稅金額：' + detail.slice(0, 200));
  await page.click('[data-act="tab"][data-tab="items"]');
  await page.waitForTimeout(300);
  // 原物料主檔：改包裝折合量（1 瓶＝936 ml）→ 進貨行重算成庫存單位
  await page.click('#po-body [data-act="editItem"]:not([data-id=""])');
  await page.waitForSelector('dialog [name=pack_size]');
  if ((await page.inputValue('dialog [name=name]')) !== '鮮乳 936ml') {
    await page.click('dialog [data-close]');
    const btns = await page.$$('#po-body [data-act="editItem"]');
    for (const b of btns) {
      const tr = await b.evaluateHandle((el) => el.closest('tr'));
      if ((await tr.evaluate((el) => el.textContent)).includes('鮮乳 936ml')) {
        await b.click();
        break;
      }
    }
    await page.waitForSelector('dialog [name=pack_size]');
  }
  await page.fill('dialog [name=unit]', 'ml');
  await page.fill('dialog [name=pack_size]', '936');
  await page.fill('dialog [name=safety_stock]', '5000');
  await page.click('dialog .modal-foot .btn.primary');
  await page.waitForTimeout(400);
  await go('inventory');
  const invRows = await page.$$eval('table.grid tbody tr', (trs) => trs.map((tr) => [...tr.children].map((td) => td.textContent.trim())));
  const milkRow = invRows.find((r) => r[1].includes('鮮乳 936ml'));
  assert(milkRow && milkRow[5].replace(/,/g, '') === '11232', '進貨 12 瓶 × 936 ml 折合庫存 11,232：' + JSON.stringify(milkRow));

  // 匯入中心：供應商資料、進貨紀錄（頁面帶 ?target= 固定類型）
  await page.goto(BASE + '#/import?target=suppliers');
  await page.waitForSelector('[data-act="pick"]');
  {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="pick"]')]);
    await chooser.setFiles(FX('synthetic-suppliers.csv'));
    await page.waitForSelector('[data-act="commit"]');
    assert((await page.$eval('[data-act="target"]', (el) => el.value)) === 'suppliers', '匯入類型固定為供應商');
    const prep = await page.textContent('#prep');
    assert(/新增 2 家、更新既有資料 1 家/.test(prep), '供應商匯入預覽：' + prep);
    await shot('import-suppliers');
    console.log('供應商：', await commit());
  }
  await page.goto(BASE + '#/import?target=purchases');
  await page.waitForSelector('[data-act="pick"]');
  {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="pick"]')]);
    await chooser.setFiles(FX('synthetic-purchases.csv'));
    await page.waitForSelector('[data-act="commit"]');
    const prep = await page.textContent('#prep');
    assert(/合成 2 張進貨單/.test(prep) && prep.includes('自動建檔 5 項'), '進貨匯入預覽：' + prep);
    assert((await page.$eval('[data-act="map"][data-field="qty"]', (el) => el.value)) !== '', '數量欄已自動對應');
    assert((await page.$eval('[data-act="map"][data-field="invoice_no"]', (el) => el.value)) !== '', '發票號碼欄已自動對應');
    await shot('import-purchases');
    console.log('進貨：', await commit());
  }
  await go('purchases');
  const poCount = await page.$$eval('#po-body tbody tr', (trs) => trs.length);
  assert(poCount === 4, '手動 1 張＋進銷存登記 1 筆＋匯入 2 張＝4：' + poCount);
  await go('suppliers');
  const supCount = await page.$$eval('#sup-table tbody tr', (trs) => trs.length);
  assert(supCount === 3, '供應商 3 家：' + supCount);
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

  // 安全性：IndexedDB 只有密文；上鎖 → 錯誤密碼 → 正確密碼 → 復原碼重設
  const raw1 = await rawDb();
  console.log('加密儲存：', raw1);
  assert(raw1.tables.includes('sales_lines') && raw1.tables.includes('journal_entries') && !raw1.plain, 'IndexedDB 沒有明文');
  assert(raw1.files >= 2, '憑證照片已加密保存');
  await page.click('#lock-btn');
  await page.waitForSelector('#g-unlock');
  await shot('gate-locked', false);
  await unlock('wrong-password-1');
  await page.waitForSelector('text=密碼錯誤');
  await unlock();
  await page.waitForSelector('#nav-links a');
  await page.click('#lock-btn');
  await page.waitForSelector('#g-forgot');
  await page.click('#g-forgot');
  await page.fill('#g-rec [name=code]', recovery.toLowerCase().replace(/-/g, ' '));
  await page.fill('#g-rec [name=p1]', 'NewPass-2026');
  await page.fill('#g-rec [name=p2]', 'NewPass-2026');
  await page.click('#g-rec [type=submit]');
  await page.waitForSelector('#g-code');
  const recovery2 = (await page.textContent('#g-code')).trim();
  assert(recovery2 !== recovery, '重設後換新復原碼');
  await page.check('#g-ok');
  await page.click('#g-next');
  await page.waitForSelector('#nav-links a');
  await page.click('#lock-btn');
  await unlock('NewPass-2026');
  await page.waitForSelector('#nav-links a');
  await go('journal?ym=2026-09');
  assert((await page.textContent('table.grid')).includes('POS 營收 2026-09'), '解鎖後資料仍在');

  // 加密備份 → 還原
  await go('settings');
  let backupFile;
  {
    const clicked = page.click('[data-act="backup"]');
    await page.waitForSelector('dialog [name=p1]');
    await page.fill('dialog [name=p1]', 'Backup-2026');
    await page.fill('dialog [name=p2]', 'Backup-2026');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('dialog .modal-foot .btn.primary')]);
    await clicked;
    backupFile = join(OUT, dl.suggestedFilename());
    await dl.saveAs(backupFile);
    const head = (await readFile(backupFile)).subarray(0, 8).toString();
    const body = (await readFile(backupFile)).toString('latin1');
    console.log('備份檔：', dl.suggestedFilename(), head);
    assert(/^午月ERP備份_\d{12}\.wyb$/.test(dl.suggestedFilename()), '備份檔名 ' + dl.suggestedFilename());
    assert(head === 'WUYUEBK1' && !/POS|journal_entries/.test(body), '備份檔已加密');
  }
  {
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="restore"]')]);
    await chooser.setFiles(backupFile);
    await page.waitForSelector('dialog [name=p]');
    await page.fill('dialog [name=p]', 'wrong-backup');
    await page.click('dialog .modal-foot .btn.primary');
    await page.waitForSelector('text=備份密碼錯誤');
    const [chooser2] = await Promise.all([page.waitForEvent('filechooser'), page.click('[data-act="restore"]')]);
    await chooser2.setFiles(backupFile);
    await page.waitForSelector('dialog [name=p]');
    await page.fill('dialog [name=p]', 'Backup-2026');
    await page.click('dialog .modal-foot .btn.primary');
    await page.waitForSelector('dialog >> text=覆蓋還原');
    await page.click('dialog .modal-foot .btn.danger');
    await unlock('NewPass-2026');
    await page.waitForSelector('#nav-links a');
    await go('journal?ym=2026-10');
    assert((await page.textContent('table.grid')).includes('營業稅結轉'), '還原後資料完整');
  }

  // 分頁互斥：第二個分頁解鎖後，第一個分頁自動上鎖
  {
    const page2 = await ctx.newPage();
    page2.on('pageerror', (e) => errors.push('page2 pageerror: ' + e.message));
    await page2.goto(BASE + '#/journal?ym=2026-10');
    await page2.waitForSelector('#g-unlock');
    await page2.fill('#g-unlock [name=p]', 'NewPass-2026');
    await page2.click('#g-unlock [type=submit]');
    await page2.waitForSelector('#nav-links a');
    await page.waitForSelector('#g-unlock', { timeout: 15000 });
    assert(await page.isVisible('text=另一個分頁開啟'), '舊分頁顯示已在另一個分頁開啟');
    await page2.waitForFunction(() => !document.querySelector('#view')?.textContent.includes('載入中'));
    assert((await page2.textContent('table.grid')).includes('營業稅結轉'), '新分頁資料正常');
    await page2.waitForTimeout(500);
    assert(await page2.isVisible('#nav-links a'), '新分頁沒有被鎖住');
    await page2.close();
    await unlock('NewPass-2026');
    await page.waitForSelector('#nav-links a');
  }

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
