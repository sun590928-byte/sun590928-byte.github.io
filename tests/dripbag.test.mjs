// 濾掛與禮盒企劃：單包成本與毛利、月試算、禮盒、效期與留樣、POS 銷量對照與判斷、進度表、企劃檔檢查／讀取／匯入／匯出
// 數字都是虛構的整數，不對應任何店。
import test from 'node:test';
import assert from 'node:assert/strict';
import { packCost, skuMargin, mixOf, monthPlan, giftCost, expiryOf, batchStatus, sampleChecks, canExtend, nextBatchCode, earliestExpiry, posDrip, salesVerdict, buildSchedule, scheduleStatus, normalizePlan, checkPlanFile, mergeImport, exportPlan, emptyPlan, beanKgFrom, cleanCosts, PLAN_KIND, TASK_TEMPLATE } from '../erp/js/lib/dripbag.js';

const C = { grams: 10, grind_loss: 0, filter: 2, outer: 2, label: 1, wage: 200, packs_per_hour: 40, loss: 0, fee: 0 };
const A = { id: 'a', name: '甲', price: 105, bean_kg: 1000, mix: 50 };
const B = { id: 'b', name: '乙', price: 210, bean_kg: 2000, mix: 50 };

test('dripbag: 單包成本＝豆子＋包材＋人工，損耗攤進去，手續費照含稅售價', () => {
  const pc = packCost(A, C);
  assert.equal(pc.bean, 10);
  assert.equal(pc.pack, 5);
  assert.equal(pc.labor, 5);
  assert.equal(pc.total, 20);
  const lossy = packCost(A, { ...C, loss: 20, fee: 2, grind_loss: 10 });
  assert.equal(lossy.bean, 11);
  assert.equal(lossy.noFee, 26.25); // 21 ÷ 0.8
  assert.equal(lossy.fee, 2.1);
  assert.equal(lossy.total, 28.35);
});

test('dripbag: 沒有豆價不算成本（不從售價倒推）；毛利用未稅售價', () => {
  assert.equal(packCost({ ...A, bean_kg: null }, C), null);
  const r = skuMargin(A, C);
  assert.equal(r.net, 100);
  assert.equal(r.margin, 80);
  assert.equal(r.rate, 0.8);
  assert.equal(skuMargin({ ...A, bean_kg: null }, C).rate, null);
  assert.equal(skuMargin(A, C, { beanKg: 3000 }).cost.bean, 30); // 連到原物料的平均進價優先
});

test('dripbag: 銷售佔比只算上架中的，沒填就平均', () => {
  const m = mixOf([A, { ...B, mix: 150 }, { id: 'c', name: '丙', price: 1, active: false, mix: 999 }]);
  assert.equal(m.get('a'), 0.25);
  assert.equal(m.get('b'), 0.75);
  assert.equal(m.has('c'), false);
  const eq = mixOf([{ ...A, mix: 0 }, { ...B, mix: 0 }]);
  assert.equal(eq.get('a'), 0.5);
});

test('dripbag: 月試算（週末＝天數 × 2/7）、扣 5 入袋、回本包數', () => {
  const month = { weekday_packs: 2, weekend_packs: 9, days: 28, five_share: 50, bag_cost: 10, first_order: 1000 };
  const mp = monthPlan([A, B], C, month);
  // 平日 20 天 × 2 ＋ 週末 8 天 × 9 ＝ 112 包，甲乙各 56
  assert.equal(mp.packs, 112);
  assert.equal(mp.revenue, 56 * 105 + 56 * 210);
  // 甲每包毛利 80；乙：豆 20、包材 5、人工 5 → 30，未稅 200 → 170
  assert.equal(mp.bags, 112 * 0.5 / 5 * 10);
  assert.equal(mp.profit, 56 * 80 + 56 * 170 - 112);
  assert.equal(mp.breakeven, Math.ceil(1000 / ((56 * 250 - 112) / 112)));
  const miss = monthPlan([A, { ...B, bean_kg: null }], C, month);
  assert.deepEqual(miss.missing, ['乙']);
});

test('dripbag: 禮盒成本＝內容物（不含手續費）＋其他物品＋組裝人工＋手續費', () => {
  const g = { name: '禮', price: 525, minutes: 6, items: [{ sku_id: 'a', qty: 3 }, { sku_id: 'b', qty: 2 }, { sku_id: 'zz', qty: 1 }], extras: [{ name: '袋', cost: 30 }, { name: '卡', cost: 10 }] };
  const c = giftCost(g, [A, B], { ...C, fee: 2 });
  assert.equal(c.contents, 3 * 20 + 2 * 30);
  assert.equal(c.extras, 40);
  assert.equal(c.labor, 20);
  assert.equal(c.fee, 10.5);
  assert.equal(c.total, 120 + 40 + 20 + 10.5);
  assert.equal(c.net, 500);
  assert.equal(c.packs, 6);
  assert.deepEqual(c.missing, ['已刪除的品項']);
  assert.equal(c.rate, (500 - 190.5) / 500);
});

test('dripbag: 有效日期照批次自己的天數；過期、快到期', () => {
  const b = { id: 'x', code: 'X', date: '2026-01-01', shelf_days: 10 };
  assert.equal(expiryOf(b), '2026-01-11');
  assert.equal(batchStatus(b, '2026-01-05').kind, 'ok');
  assert.equal(batchStatus(b, '2026-01-09').kind, 'soon');
  assert.equal(batchStatus(b, '2026-01-11').left, 0);
  assert.equal(batchStatus(b, '2026-01-12').kind, 'expired');
  assert.equal(earliestExpiry([b, { id: 'y', date: '2026-01-03', shelf_days: 5 }], ['x', 'y']), '2026-01-08');
});

test('dripbag: 留樣檢查第 0／14／30 天、逾期；延長要第 30 天合格＋規格書', () => {
  const b = { id: 'x', code: 'X', date: '2026-01-01', retained: 3, checks: [{ day: 0, date: '2026-01-01', result: 'pass' }] };
  const list = sampleChecks([b, { id: 'n', code: 'N', date: '2026-01-01', retained: 0 }], '2026-01-20');
  assert.equal(list.length, 3);
  assert.deepEqual(list.map((c) => c.due), ['2026-01-01', '2026-01-15', '2026-01-31']);
  assert.deepEqual(list.map((c) => c.overdue), [false, true, false]);
  const plan = { batches: [b], shelf: { spec_ok: true } };
  assert.equal(canExtend(plan).ok, false);
  b.checks.push({ day: 30, result: 'pass' });
  assert.equal(canExtend(plan).ok, true);
  assert.equal(canExtend({ ...plan, shelf: { spec_ok: false } }).ok, false);
  b.checks[1].result = 'fail';
  assert.equal(canExtend(plan).ok, false);
});

test('dripbag: 批號 YYMMDD-流水號', () => {
  assert.equal(nextBatchCode([], '2026-03-04'), '260304-1');
  assert.equal(nextBatchCode([{ code: '260304-1' }, { code: '260304-2' }], '2026-03-04'), '260304-3');
});

test('dripbag: POS 依關鍵字算包數與附購率，作廢、調整、0 元不算', () => {
  const L = [
    { date: '2026-02-01', order_no: '1', item_raw: '測試濾掛 A', qty: 5, revenue: 500 },
    { date: '2026-02-01', order_no: '1', item_raw: '拿鐵', qty: 1, revenue: 100 },
    { date: '2026-02-01', order_no: '2', item_raw: '拿鐵', qty: 1, revenue: 100 },
    { date: '2026-02-01', order_no: '3', item_raw: '測試濾掛 A', qty: 1, revenue: 0 },
    { date: '2026-02-01', order_no: '4', item_raw: '測試濾掛 A', qty: 2, revenue: 200, void_reason: '作廢' },
    { date: '2026-02-02', order_no: '5', category_raw: '濾掛', item_raw: '乙', qty: 1, revenue: 100 },
    { date: '2026-02-02', order_no: '6', item_raw: '調整', revenue: -5, is_adjustment: true },
  ];
  const d = posDrip(L, { from: '2026-02-01', to: '2026-02-02', keywords: '濾掛' });
  assert.equal(d.length, 2);
  assert.equal(d[0].packs, 5);
  assert.equal(d[0].orders, 3);
  assert.equal(d[0].dripOrders, 1);
  assert.equal(d[1].packs, 1);
  assert.equal(posDrip(L, { keywords: '' }).reduce((a, x) => a + x.packs, 0), 0);
});

test('dripbag: 開賣後滿天數才判斷，沒資料的日子也算進天數', () => {
  const R = { review_days: 4, target_per_day: 5, stop_per_day: 2, soon_days: 3 };
  const days = [{ date: '2026-02-01', packs: 12 }, { date: '2026-02-02', packs: 8 }];
  assert.equal(salesVerdict(days, { launch: '', today: '2026-02-02', rules: R }).verdict, 'pending');
  assert.equal(salesVerdict(days, { launch: '2026-02-05', today: '2026-02-02', rules: R }).verdict, 'pending');
  const c = salesVerdict(days, { launch: '2026-02-01', today: '2026-02-02', rules: R });
  assert.equal(c.verdict, 'collecting');
  assert.equal(c.avg, 10);
  assert.equal(salesVerdict(days, { launch: '2026-02-01', today: '2026-02-04', rules: R }).verdict, 'pass'); // 20 ÷ 4 天 ＝ 5
  assert.equal(salesVerdict([{ date: '2026-02-01', packs: 4 }], { launch: '2026-02-01', today: '2026-02-09', rules: R }).verdict, 'stop'); // 4 ÷ 4 ＝ 1
  assert.equal(salesVerdict([{ date: '2026-02-01', packs: 12 }], { launch: '2026-02-01', today: '2026-02-09', rules: R }).verdict, 'adjust'); // 3
});

test('dripbag: 進度表照試製日、開賣日排，依日期排序', () => {
  const s = buildSchedule('2026-03-10', '2026-03-17');
  assert.equal(s.length, TASK_TEMPLATE.length);
  assert.equal(s[0].date, '2026-03-05');
  assert.ok(s.some((t) => t.date === '2026-03-17'));
  assert.equal(s.at(-1).date, '2026-04-09'); // 試製日＋30
  assert.deepEqual(s.map((t) => t.date), [...s.map((t) => t.date)].sort());
  assert.deepEqual(buildSchedule('', '2026-03-17'), []);
  const st = scheduleStatus([{ date: '2026-03-01', done: true }, { date: '2026-03-02', done: false, title: 'x' }], '2026-03-05');
  assert.equal(st.overdue.length, 1);
  assert.equal(st.ratio, 0.5);
});

test('dripbag: 讀取時丟掉壞資料、補 ID、同批號留最後一筆', () => {
  const p = normalizePlan({
    name: ' 測試 ',
    costs: { grams: -1, wage: 'x', fee: 99 },
    skus: [A, { name: '', price: 10 }, { name: '零元', price: 0 }, { name: '壞豆價', price: 50, bean_kg: -3 }],
    gifts: [{ name: '禮', price: 100, items: [{ sku_id: 'a', qty: -1 }], extras: [{ name: '袋', cost: 'x' }] }, { name: '沒價', price: null }],
    schedule: [{ date: '2026-02-30', title: 'x' }, { date: '2026-02-01', title: 'ok' }],
    batches: [
      { code: 'K', date: '2026-02-01', packs: 10, shelf_days: 14 },
      { code: 'K', date: '2026-02-02', packs: 20, shelf_days: 14, checks: [{ day: 7, result: 'pass' }, { day: 14, result: 'weird' }] },
      { code: 'L', date: 'bad', packs: 10, shelf_days: 14 },
      { code: 'M', date: '2026-02-03', packs: 0, shelf_days: 14 },
    ],
    trial_date: '2026-13-01',
  });
  assert.equal(p.name, '測試');
  assert.equal(p.costs.grams, cleanCosts({}).grams);
  assert.equal(p.costs.fee, 10);
  assert.deepEqual(p.skus.map((s) => s.name), ['甲', '壞豆價']);
  assert.equal(p.skus[1].bean_kg, null);
  assert.equal(p.gifts.length, 1);
  assert.equal(p.gifts[0].items[0].qty, 0);
  assert.equal(p.gifts[0].extras[0].cost, 0);
  assert.equal(p.schedule.length, 1);
  assert.equal(p.batches.length, 1);
  assert.equal(normalizePlan({ batches: [{ date: '2026-02-01', packs: 1, shelf_days: 1 }, { date: '2026-02-01', packs: 2, shelf_days: 1 }] }).batches.map((b) => b.code).join(), '260201-1,260201-2'); // 沒批號的自動補，不會互相蓋掉
  assert.equal(p.batches[0].packs, 20);
  assert.deepEqual(p.batches[0].checks, [{ day: 14, date: '', result: '', note: '' }]);
  assert.equal(p.trial_date, '');
  assert.deepEqual(normalizePlan(null), emptyPlan());
});

test('dripbag: 匯入檢查要企劃標記、版本不能比程式新，列出會略過的', () => {
  assert.ok(checkPlanFile({ skus: [] }).errors.length);
  assert.ok(checkPlanFile({ kind: PLAN_KIND, version: 99 }).errors.length);
  const c = checkPlanFile({ kind: PLAN_KIND, version: 1, skus: [A, { name: '壞', price: 0 }], gifts: [{ name: '禮', price: 10, items: [{ sku_id: 'nope', qty: 1 }] }], batches: [{ code: 'Z', date: '2026-02-30', packs: 1, shelf_days: 1 }], launch_date: '2026/01/01' });
  assert.equal(c.errors.length, 0);
  assert.equal(c.warnings.length, 4);
  assert.ok(c.warnings.some((w) => w.includes('nope')));
});

test('dripbag: 匯入預設保留現場的批次（同批號留現有），勾選才整份換；匯出企劃不含批次與勾選', () => {
  const cur = normalizePlan({ batches: [{ id: 'b1', code: 'K', date: '2026-02-01', packs: 10, shelf_days: 14 }] });
  const inc = normalizePlan({ name: '新', skus: [A], batches: [{ id: 'b1', code: 'K', date: '2026-02-01', packs: 99, shelf_days: 14 }, { id: 'b1x', code: 'N', date: '2026-01-01', packs: 5, shelf_days: 14 }] });
  const m = mergeImport(cur, inc);
  assert.equal(m.name, '新');
  assert.deepEqual(m.batches.map((b) => [b.code, b.packs]), [['N', 5], ['K', 10]]);
  assert.equal(mergeImport(cur, inc, { replaceBatches: true }).batches.find((b) => b.code === 'K').packs, 99);
  const plan = { ...inc, notes: '內部', shelf: { ...inc.shelf, spec_ok: true }, schedule: [{ id: 't', date: '2026-01-01', title: 'x', done: true, note: 'n' }] };
  const ex = exportPlan(plan);
  assert.equal(ex.kind, PLAN_KIND);
  assert.deepEqual(ex.batches, []);
  assert.equal(ex.notes, '');
  assert.equal(ex.shelf.spec_ok, false);
  assert.equal(ex.schedule[0].done, false);
  assert.equal(exportPlan(plan, { full: true }).batches.length, 2);
  // 匯出再讀回來不會掉資料
  assert.deepEqual(normalizePlan(exportPlan(plan, { full: true })).skus, plan.skus);
});

test('dripbag: 原物料單位 g／kg 才換算熟豆每公斤', () => {
  assert.equal(beanKgFrom({ unit: 'g' }, 1.2), 1200);
  assert.equal(beanKgFrom({ unit: 'kg' }, 900), 900);
  assert.equal(beanKgFrom({ unit: '包' }, 300), null);
  assert.equal(beanKgFrom({ unit: 'g' }, 0), null);
});
