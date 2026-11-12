// 11/12 需求 二-6、二-10：依耗用量建議安全庫存、原物料主檔匯出／匯入、盤點表匯出／匯入 → 盤點調整與期末金額
import test from 'node:test';
import assert from 'node:assert/strict';
import { theoreticalUsage, stockLevels, averageCosts, usageRates, roundSafety, suggestSafetyStock, safetySuggestions, normalizeSafetyRule, SAFETY_RULE_DEFAULT } from '../erp/js/lib/inventory.js';
import { repackMoves } from '../erp/js/lib/purchases.js';
import { itemSheet, parseItemSheet, planItemImport, resolveCategory, ITEM_HEADERS } from '../erp/js/lib/itemsio.js';
import { countSheetGroups, countSheet, parseCountSheet, planStocktake, stocktakeMoveId, COUNT_HEADERS } from '../erp/js/lib/stocktake.js';
import { makeXlsx } from '../erp/js/lib/xlsxw.js';
import { readXlsx } from '../erp/js/lib/xlsx.js';
import { addDays } from '../erp/js/lib/dates.js';

const xlsxRoundTrip = async (sheets) => readXlsx(new Uint8Array(await makeXlsx(sheets).arrayBuffer()));

// 合成資料：每天賣 10 杯拿鐵（豆 18 g、鮮奶 200 ml），9/1–9/28 共 28 天
const items = [
  { id: 'bean', sku: 'BN-001', name: '花季配方豆', category: 'beans', unit: 'g', gl_account: '1211', safety_stock: 500, reorder_qty: 1000, pack_type: '', pack_size: 1, note: '' },
  { id: 'milk', sku: 'DY-001', name: '鮮乳 936ml', category: 'dairy', unit: 'ml', gl_account: '1212', safety_stock: null, reorder_qty: null, pack_type: '瓶', pack_size: 936, note: '冷藏' },
  { id: 'cup', sku: 'PK-001', name: '紙杯 12oz', category: 'packaging', unit: '個', gl_account: '1215', safety_stock: 100, reorder_qty: null, pack_type: '', pack_size: 1, note: '' },
];
const recipes = [
  { product_id: 'latte', item_id: 'bean', qty: 18 },
  { product_id: 'latte', item_id: 'milk', qty: 200 },
];
const lines = [];
for (let d = '2026-09-01'; d <= '2026-09-28'; d = addDays(d, 1)) lines.push({ date: d, product: 'latte', qty: 10 });
const pidOf = (l) => l.product;

test('日均耗用：POS × 配方＋手動耗用與報廢，只算區間內的天數', () => {
  const usage = theoreticalUsage(lines, recipes, pidOf, { to: '2026-09-28' });
  const moves = [
    { id: 'm1', item_id: 'bean', date: '2026-09-10', type: 'consume', qty: 56 },
    { id: 'm2', item_id: 'bean', date: '2026-09-11', type: 'scrap', qty: 28 },
    { id: 'm3', item_id: 'bean', date: '2026-08-01', type: 'consume', qty: 9999 }, // 區間外
  ];
  const rates = usageRates(items, moves, usage, { asOf: '2026-09-28', lookbackDays: 28 });
  const b = rates.get('bean');
  assert.equal(b.days, 28);
  assert.equal(b.from, '2026-09-01');
  assert.equal(b.total, 28 * 180 + 56 + 28);
  assert.equal(b.avgDaily, 183);
  assert.equal(rates.get('milk').avgDaily, 2000);
  assert.equal(rates.get('cup').total, 0);
  // 銷售資料起算日晚於區間起點：只算有資料的天數
  const late = usageRates(items, [], usage, { asOf: '2026-09-28', lookbackDays: 28, dataStart: '2026-09-15' });
  assert.equal(late.get('bean').days, 14);
  assert.equal(late.get('bean').avgDaily, 180);
});

test('建議安全庫存＝日均耗用 ×（前置＋安全天數），依包裝或級距進位；資料不足不建議', () => {
  assert.deepEqual(normalizeSafetyRule({}), SAFETY_RULE_DEFAULT);
  assert.deepEqual(normalizeSafetyRule({ lookback_days: '', lead_days: '5', safety_days: 1.4 }), { lookback_days: 28, lead_days: 5, safety_days: 1 });
  assert.equal(normalizeSafetyRule({ lookback_days: 2 }).lookback_days, 7, '最少看 7 天');
  assert.equal(roundSafety(915, {}), 920, '100 以上進位到 10');
  assert.equal(roundSafety(2501, {}), 2600, '1,000 以上進位到 100');
  assert.equal(roundSafety(7.2, {}), 8);
  assert.equal(roundSafety(2500, { pack_type: '瓶', pack_size: 936 }), 2808, '有進貨包裝進位到整包（3 瓶）');
  assert.equal(roundSafety(0, {}), 0);
  const usage = theoreticalUsage(lines, recipes, pidOf, { to: '2026-09-28' });
  const s = safetySuggestions(items, [], usage, { asOf: '2026-09-28', rule: { lookback_days: 28, lead_days: 3, safety_days: 2 } });
  assert.equal(s.get('bean').value, 900, '180 g × 5 天');
  assert.equal(s.get('bean').cover, 5);
  assert.equal(s.get('milk').value, 10296, '2,000 ml × 5 天＝10,000 → 11 瓶 × 936');
  assert.equal(s.get('cup').value, null);
  assert.match(s.get('cup').reason, /資料不足/);
  const short = suggestSafetyStock(items[0], { days: 3, total: 540, avgDaily: 180 }, SAFETY_RULE_DEFAULT);
  assert.equal(short.value, null);
  assert.match(short.reason, /只有 3 天/);
  assert.equal(suggestSafetyStock(items[0], { days: 28, total: 5040, avgDaily: 180 }, { lookback_days: 28, lead_days: 0, safety_days: 0 }).value, null, '天數合計 0 不建議');
});

test('改包裝折合量：重算進貨行的庫存數量（修改品項與匯入主檔共用）', () => {
  const moves = [
    { id: 'p1', item_id: 'milk', type: 'purchase', date: '2026-09-05', qty: 11232, pack_qty: 12, unit: '瓶', amount: 1020 },
    { id: 'p2', item_id: 'milk', type: 'purchase', date: '2026-09-06', qty: 500, pack_qty: 500, unit: 'ml', amount: 50 },
    { id: 'p3', item_id: 'bean', type: 'purchase', date: '2026-09-06', qty: 1000, pack_qty: 1, unit: '包', amount: 50 },
  ];
  const milk = items[1];
  const fix = repackMoves(milk, { ...milk, pack_size: 946 }, moves);
  assert.deepEqual(fix.map((m) => [m.id, m.qty]), [['p1', 11352]], '只回傳數量有變的進貨行');
  assert.deepEqual(repackMoves(milk, { ...milk, safety_stock: 3000 }, moves), [], '沒改包裝相關欄位不重算');
});

test('原物料主檔：匯出再匯回（Excel）沒有變更；修改、空白不覆蓋、新增、錯誤列', async () => {
  const levels = new Map([['bean', { onHand: 4000 }]]);
  const sheet = itemSheet(items, { levels, suggest: new Map([['bean', { value: 900, avgDaily: 180 }], ['cup', { value: null, avgDaily: 0 }]]), accName: new Map([['1211', '原料－咖啡豆']]) });
  assert.deepEqual(sheet.rows[0], ITEM_HEADERS);
  const [wb] = await xlsxRoundTrip([sheet]);
  const beanRow = wb.rows.find((r) => r[1] === '花季配方豆');
  assert.equal(beanRow[3], '1211 原料－咖啡豆');
  assert.equal(beanRow[11], '900');
  assert.equal(wb.rows.find((r) => r[1] === '紙杯 12oz')[11], '資料不足');
  const same = planItemImport(parseItemSheet(wb.rows).records, items);
  assert.equal(same.updates.length + same.creates.length + same.errors.length, 0, '原封不動匯回不會有變更：' + JSON.stringify(same.errors));
  assert.equal(same.unchanged.length, 3);

  const rows = [
    ['物品編號', '品名', '分類', '庫存單位', '安全庫存（預警線）', '建議叫貨量', '進貨包裝', '每包裝折合', '備註'],
    ['BN-001', '花季配方豆（新包裝）', '', '', '1,200', '', '', '', '每週二叫貨'], // 用編號對到：可改品名；空白不覆蓋
    ['', '鮮乳 936ml', '', '', '3000', '6', '', '946', ''], // 用品名對到
    ['PK-001', '', '果汁糖漿', '', '', '', '', '', ''], // 改分類 → 科目跟著改
    ['', '燕麥奶 1L', '乳品', 'ml', '2000', '', '瓶', '1000', ''], // 新品項
    ['', '蜂蜜', '', '', '', '', '', '', ''], // 新品項：分類依品名判斷
    ['BN-001', '', '', '', '900', '', '', '', ''], // 同一品項第二次
    ['', '測試錯誤', '', '', 'abc', '', '', '', ''],
    ['', '錯分類', '甜點', '', '', '', '', '', ''],
    ['ZZ-404', '', '', '', '1', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '只有備註的空白列'],
  ];
  const parsed = parseItemSheet(rows);
  assert.equal(parsed.records.length, 9, '沒有編號也沒有品名的列略過');
  let n = 0;
  const plan = planItemImport(parsed.records, items, { makeId: () => `new${++n}` });
  const up = new Map(plan.updates.map((u) => [u.item.id, u]));
  const bean = up.get('bean');
  assert.equal(bean.matchedBy, 'sku');
  assert.deepEqual(bean.changes.map((c) => c.field).sort(), ['name', 'note', 'safety_stock']);
  assert.equal(bean.next.safety_stock, 1200, '千分位也認得');
  assert.equal(bean.next.reorder_qty, 1000, '空白不覆蓋');
  assert.equal(bean.next.name, '花季配方豆（新包裝）');
  const milk = up.get('milk');
  assert.equal(milk.matchedBy, 'name');
  assert.deepEqual([milk.next.safety_stock, milk.next.reorder_qty, milk.next.pack_size, milk.next.note], [3000, 6, 946, '冷藏']);
  const cup = up.get('cup');
  assert.deepEqual([cup.next.category, cup.next.gl_account], ['juice_syrup', '1217']);
  assert.deepEqual(plan.creates.map((c) => [c.item.id, c.item.sku, c.item.name, c.item.category, c.item.unit, c.item.gl_account, c.item.pack_size, c.guessed]), [
    ['new1', 'DY-002', '燕麥奶 1L', 'dairy', 'ml', '1212', 1000, false],
    ['new2', plan.creates[1].item.sku, '蜂蜜', plan.creates[1].item.category, plan.creates[1].item.unit, plan.creates[1].item.gl_account, 1, true],
  ]);
  const errs = plan.errors.map((e) => e.line);
  assert.deepEqual(errs, [7, 8, 9, 10], JSON.stringify(plan.errors));
  assert.match(plan.errors[0].msg, /同一個品項/);
  assert.match(plan.errors[1].msg, /0 以上的數字/);
  assert.match(plan.errors[2].msg, /不認得/);
  assert.match(plan.errors[3].msg, /找不到物品編號/);
  // 品名撞名
  const clash = planItemImport(parseItemSheet([['物品編號', '品名'], ['BN-001', '紙杯 12oz']]).records, items);
  assert.equal(clash.updates.length, 0);
  assert.match(clash.errors[0].msg, /同名/);
  assert.equal(resolveCategory('茶葉／粉類（1213）'), 'tea_syrup');
  assert.equal(resolveCategory('1217 原料－各項果汁糖漿'), 'juice_syrup');
  assert.equal(resolveCategory('juice_syrup'), 'juice_syrup');
  assert.equal(resolveCategory('甜點'), null);
});

// 盤點：9/1 期初＋9/5 進貨，9/1–9/28 每天賣 10 杯
const stMoves = [
  { id: 'o1', item_id: 'bean', date: '2026-09-01', type: 'opening', qty: 2000, amount: 2000 },
  { id: 'p1', item_id: 'bean', date: '2026-09-05', type: 'purchase', qty: 5000, amount: 6300, amount_ex: 6000 },
  { id: 'o2', item_id: 'milk', date: '2026-09-01', type: 'opening', qty: 60000, amount: 6000 },
  { id: 'o3', item_id: 'cup', date: '2026-09-01', type: 'opening', qty: 500, amount: 1000 },
];

test('盤點表：依科目分組、帳面數量，匯出再讀回得到盤點日與填好的數量', async () => {
  const usage = theoreticalUsage(lines, recipes, pidOf, { to: '2026-09-30' });
  const levels = stockLevels(items, stMoves, usage, { asOf: '2026-09-30' });
  const groups = countSheetGroups(items, levels);
  assert.deepEqual(groups.map((g) => [g.account, g.rows.map((r) => [r.item.id, r.book])]), [['1211', [['bean', 1960]]], ['1212', [['milk', 4000]]], ['1215', [['cup', 500]]]]);
  const sheet = countSheet(groups, { date: '2026-09-30', business: '測試咖啡', accName: new Map([['1211', '原料－咖啡豆']]) });
  assert.deepEqual(sheet.rows[3], COUNT_HEADERS);
  assert.ok(sheet.rows.some((r) => r[0] === '初盤人：' && r[2] === '複盤人：'), '有簽名欄');
  // 填數量（模擬老闆在 Excel 裡填）
  const filled = sheet.rows.map((r) => [...r]);
  const at = (id) => filled.find((r) => r[9] === id);
  at('bean')[5] = 1900;
  at('bean')[6] = 1850;
  at('bean')[8] = '開封一包';
  at('milk')[5] = '4,100';
  const [wb] = await xlsxRoundTrip([{ ...sheet, rows: filled }]);
  const parsed = parseCountSheet(wb.rows);
  assert.equal(parsed.date, '2026-09-30');
  assert.equal(parsed.skipped, 1, '紙杯沒填，略過');
  assert.deepEqual(parsed.errors, [], '科目分組列、簽名欄不是錯誤');
  // 簽名欄填了名字也不會被當成品項或數量
  const signed = [...filled.slice(0, -1), ['初盤人：王小明', '花季配方豆', '複盤人：', '', '', '12', '', '', '日期：9/30']];
  assert.equal(parseCountSheet(signed).records.length, 2);
  assert.deepEqual(parsed.records.map((r) => [r.id, r.first, r.second, r.note]), [['bean', 1900, 1850, '開封一包'], ['milk', 4100, null, '']]);
  assert.match(parseCountSheet([['品名', '數量']]).error, /標題列/);
  const bad = parseCountSheet([['品名', '初盤量'], ['花季配方豆', '一包']]);
  assert.equal(bad.records.length, 0);
  assert.match(bad.errors[0].msg, /數字/);
});

test('盤點結果 → 盤點調整（複盤優先、平均成本）、科目期末金額；重新匯入取代不重複', () => {
  const date = '2026-09-30';
  const usage = theoreticalUsage(lines, recipes, pidOf, { to: date });
  const records = [
    { line: 6, id: 'bean', sku: 'BN-001', name: '花季配方豆', first: 1900, second: 1850, note: '開封一包' },
    { line: 8, id: '', sku: '', name: '鮮乳 936ml', first: 4100, second: null, note: '' },
    { line: 9, id: 'ghost', sku: 'XX-1', name: '不存在', first: 1, second: null, note: '' },
  ];
  const plan = planStocktake({ items, moves: stMoves, usage, records, date, vatRate: 0.05, stocktakes: [{ id: '2026-09|1211', month: '2026-09', account: '1211', value: 1234, note: '手動' }] });
  const avg = averageCosts(items, stMoves, { asOf: date });
  const beanAvg = avg.get('bean').avg;
  assert.ok(Math.abs(beanAvg - 8000 / 7000) < 1e-9, '平均成本用未稅：(2,000＋6,000) ÷ 7,000 g');
  const bean = plan.lines.find((l) => l.item.id === 'bean');
  assert.deepEqual([bean.book, bean.counted, bean.diff], [1960, 1850, -110]);
  assert.equal(bean.amount, Math.round(-110 * beanAvg * 100) / 100);
  const milk = plan.lines.find((l) => l.item.id === 'milk');
  assert.deepEqual([milk.book, milk.counted, milk.diff], [4000, 4100, 100]);
  assert.equal(plan.errors.length, 1);
  assert.match(plan.errors[0].msg, /找不到/);
  assert.deepEqual(plan.moves.map((m) => [m.id, m.type, m.qty, m.date]), [[stocktakeMoveId(date, 'bean'), 'adjust', -110, date], [stocktakeMoveId(date, 'milk'), 'adjust', 100, date]]);
  assert.match(plan.moves[0].note, /盤點調整（初盤 1900／複盤 1850）：開封一包/);
  // 期末金額：盤到的品項以實盤 × 平均成本；紙杯沒盤到的 1215 不寫入
  assert.deepEqual(plan.stocktakes.map((s) => [s.id, s.value, s.note]), [['2026-09|1211', Math.round(1850 * beanAvg), '由盤點表匯入 2026-09-30'], ['2026-09|1212', Math.round(4100 * 0.1), '由盤點表匯入 2026-09-30']]);
  assert.deepEqual(plan.overwrite.map((o) => o.id), ['2026-09|1211'], '已輸入不同金額的科目要先問');
  assert.equal(plan.accounts.find((a) => a.account === '1215').countedItems, 0);
  // 套用後再匯入同一份：同樣的代號、同樣的差異（帳面不含自己上次的調整），不會重複
  const after = [...stMoves, ...plan.moves];
  const again = planStocktake({ items, moves: after, usage, records, date, vatRate: 0.05, stocktakes: plan.stocktakes });
  assert.deepEqual(again.moves.map((m) => [m.id, m.qty]), plan.moves.map((m) => [m.id, m.qty]));
  assert.equal(again.overwrite.length, 0, '金額相同不必覆蓋');
  const lv = new Map(stockLevels(items, after, usage, { asOf: date }).map((r) => [r.item.id, r]));
  assert.deepEqual([lv.get('bean').onHand, lv.get('milk').onHand], [1850, 4100], '調整後帳面＝實盤');
  // 改成和帳面一樣：刪掉上次的調整
  const zero = planStocktake({ items, moves: after, usage, records: [{ line: 6, id: 'bean', first: 1960, second: null, note: '' }], date, vatRate: 0.05 });
  assert.deepEqual([zero.moves.length, zero.removeIds], [0, [stocktakeMoveId(date, 'bean')]]);
  // 同科目沒盤到的品項以帳面價值計入
  const items2 = [...items, { id: 'bean2', sku: 'BN-002', name: '巴西豆', category: 'beans', unit: 'g', gl_account: '1211' }];
  const mv2 = [...stMoves, { id: 'o4', item_id: 'bean2', date: '2026-09-01', type: 'opening', qty: 1000, amount: 500 }];
  const p2 = planStocktake({ items: items2, moves: mv2, usage, records: records.slice(0, 1), date, vatRate: 0.05 });
  const a1211 = p2.accounts.find((a) => a.account === '1211');
  assert.deepEqual([a1211.countedItems, a1211.bookItems], [1, 1]);
  assert.equal(p2.stocktakes[0].value, Math.round(1850 * beanAvg + 500));
  // 不是月底要提醒
  const mid = planStocktake({ items, moves: stMoves, usage: theoreticalUsage(lines, recipes, pidOf, { to: '2026-09-15' }), records: records.slice(0, 1), date: '2026-09-15', vatRate: 0.05 });
  assert.ok(mid.warnings.some((w) => /不是月底/.test(w.msg)));
});
