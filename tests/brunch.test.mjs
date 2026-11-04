// 早午餐企劃：損益試算、打平線、菜單成本（配方優先）、每日多賺、測試判斷、POS 時段對照、進度表、企劃檔讀取
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, profitCurve, cleanParams, dishCost, menuSummary, dayResult, testVerdict, posWindow, buildSchedule, scheduleStatus, normalizePlan, emptyPlan, TASK_TEMPLATE, DEMO_PARAMS, SCENARIOS } from '../erp/js/lib/brunch.js';

const P = { people: 4, ticket: 330, cost: 32, fee: 1, hours: 0.25, wage: 230, waste: 150, util: 30, lost: 0, days: 26 };

test('brunch: 試算扣營業稅、食材、金流、人力、報廢水電', () => {
  const s = simulate(P);
  assert.equal(s.revenue, 1320);
  assert.equal(s.net, 1257.14);
  assert.equal(s.food, 422.4);
  assert.equal(s.fee, 13.2);
  assert.equal(s.labor, 57.5);
  // 1257.14 − 422.4 − 57.5 − (150 + 30 + 13.2)
  assert.equal(s.profit, 584.04);
  assert.equal(s.month, round((1320 / 1.05 - 422.4 - 57.5 - 193.2) * 26)); // 用沒有四捨五入的每日數字乘
  // 打平線：(57.5 + 150 + 30) ÷ 每位毛利 (330/1.05 − 105.6 − 3.3)
  assert.equal(s.breakEven, 2);
});

test('brunch: 縮短營業少掉的毛利要扣、打平線跟著變', () => {
  const a = simulate({ ...P, people: 6, ticket: 340, hours: 0.25, lost: 0 });
  const b = simulate({ ...P, people: 6, ticket: 340, hours: 0.25, lost: 200 });
  assert.ok(b.profit < a.profit);
  assert.equal(round(a.profit - b.profit), round(200 / 1.05 - 200 * 0.32 - 200 * 0.01));
  assert.ok(b.breakEven >= a.breakEven);
});

test('brunch: 參數超出範圍會被夾住、缺的用示範值；平日提早開幾乎不賺', () => {
  const p = cleanParams({ people: -5, ticket: 99999, cost: 'x' });
  assert.equal(p.people, 0);
  assert.equal(p.ticket, 800);
  assert.equal(p.cost, DEMO_PARAMS.cost);
  const d = simulate(SCENARIOS.find((s) => s.key === 'D').params);
  assert.ok(Math.abs(d.profit) < 100);
});

test('brunch: 損益曲線從 0 人開始、跨過打平線後轉正', () => {
  const pts = profitCurve(P);
  assert.equal(pts[0].people, 0);
  assert.ok(pts[0].profit < 0);
  const be = simulate(P).breakEven;
  assert.ok(pts[be].profit >= 0);
  assert.ok(pts[be - 1].profit < 0);
});

test('brunch: 菜單成本有配方用配方，沒有用手填；平均成本率與每份毛利', () => {
  const recipe = (pid) => ({ p_ft: 60 })[pid];
  assert.deepEqual(dishCost({ price: 220, cost: 80, product_id: 'p_ft' }, recipe), { price: 220, cost: 60, source: 'recipe', rate: 60 / 220 });
  assert.equal(dishCost({ price: 240, cost: 85 }, recipe).source, 'manual');
  assert.equal(dishCost({ price: 180, cost: '' }, recipe).cost, null);
  const m = menuSummary(
    [
      { name: 'a', price: 200, cost: 60 },
      { name: 'b', price: 300, cost: 90 },
      { name: 'c', price: 100, cost: null },
      { name: 'd', price: 999, cost: 1, active: false },
    ],
    { feePct: 1 },
  );
  assert.equal(m.count, 3);
  assert.equal(m.avgPrice, 200);
  assert.equal(round(m.avgRate * 100), 30);
  assert.equal(m.missingCost, 1);
  assert.equal(m.margin, round(200 / 1.05 - 200 * 0.3 - 2));
});

test('brunch: 每日多賺——新客與加點算整份、換點只算差價、扣報廢與人力', () => {
  const r = dayResult({ date: '2026-11-14', new_count: 3, addon_count: 1, swap_count: 2, swap_diff: 40, waste: 50, extra_hours: 1 }, { dishMargin: 120, costRate: 0.3, feePct: 1, wage: 230 });
  assert.equal(r.whole, 4);
  assert.equal(r.profit, round(4 * 120 + (40 / 1.05 - 12 - 0.4) - 50 - 230));
});

test('brunch: 測試判斷——主指標優先、份數決定調整或停、週末不夠先不判斷', () => {
  const ctx = { dishMargin: 100, costRate: 0.3, feePct: 1, wage: 230 };
  const sat = '2026-11-14';
  const sun = '2026-11-15';
  assert.equal(testVerdict([{ date: sat, new_count: 5, portions: 5 }], ctx).verdict, 'pending');
  assert.equal(testVerdict([{ date: sat, new_count: 5, portions: 5 }, { date: sun, new_count: 4, portions: 4 }], ctx).verdict, 'pass');
  // 都是換點、又多排人力 → 虧；週末 4 份 → 調整
  const adj = testVerdict([{ date: sat, swap_count: 4, swap_diff: 40, extra_hours: 1, portions: 4 }, { date: sun, swap_count: 4, swap_diff: 40, extra_hours: 1, portions: 4 }], ctx);
  assert.equal(adj.verdict, 'adjust');
  const stop = testVerdict([{ date: sat, swap_count: 1, swap_diff: 10, extra_hours: 1, portions: 1 }, { date: sun, portions: 2, extra_hours: 1 }, { date: '2026-11-16', portions: 9, new_count: 0 }], ctx);
  assert.equal(stop.verdict, 'stop');
  assert.equal(stop.weekendPortions, 1.5);
  const slow = testVerdict([{ date: sat, slowest_min: 18 }, { date: sun, slowest_min: 10 }], ctx);
  assert.equal(slow.slowDays, 1);
});

test('brunch: POS 時段營收與早午餐份數（作廢、調整不算）', () => {
  const lines = [
    { date: '2026-11-14', time: '11:40', order_no: 'A1', item_raw: '布丁法式吐司', category_raw: '早午餐', qty: 1, revenue: 220 },
    { date: '2026-11-14', time: '11:40', order_no: 'A1', item_raw: '美式', qty: 1, revenue: 120 },
    { date: '2026-11-14', time: '13:30', order_no: 'A2', item_raw: '拿鐵', qty: 1, revenue: 150 },
    { date: '2026-11-14', time: '12:10', order_no: 'A3', item_raw: '優格穀物杯', qty: 2, revenue: 0, void_reason: 'boss_test' },
    { date: '2026-11-14', time: '12:20', order_no: 'A4', item_raw: '折讓', qty: 1, revenue: -10, is_adjustment: true },
    { date: '2026-11-15', time: '12:00', order_no: 'B1', item_raw: '明太子起士可頌盤', qty: 1, revenue: 240 },
  ];
  const r = posWindow(lines, { start: '11:30', end: '13:30', keywords: '早午餐,明太子起士可頌盤' });
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].date, r[0].windowRevenue, r[0].windowOrders, r[0].revenue, r[0].brunchQty], ['2026-11-14', 340, 1, 490, 1]);
  assert.equal(r[1].brunchQty, 1);
  assert.equal(posWindow(lines, { from: '2026-11-15' }).length, 1);
});

test('brunch: 進度表依範本攤開、推出任務放推出日、狀態算逾期與下一件', () => {
  const s = buildSchedule('2026-11-05', '2026-11-12');
  assert.equal(s.length, TASK_TEMPLATE.length);
  assert.equal(s[0].date, '2026-11-05');
  assert.ok(s.filter((t) => t.date === '2026-11-12').length >= 2);
  assert.ok(s.every((t) => t.date >= '2026-11-05' && t.date <= '2026-11-12'));
  // 推出日以外的事都在推出日之前
  assert.ok(s.filter((t) => !/推出|收班 1 分鐘/.test(t.title)).every((t) => t.date < '2026-11-12'));
  const short = buildSchedule('2026-11-10', '2026-11-12');
  assert.ok(short.every((t) => t.date >= '2026-11-10' && t.date <= '2026-11-12'));
  s[0].done = true;
  const st = scheduleStatus(s, '2026-11-07');
  assert.equal(st.done, 1);
  assert.ok(st.overdue.length > 0 && st.overdue.every((t) => t.date < '2026-11-07'));
  assert.equal(st.next.date, '2026-11-05');
});

test('brunch: 企劃檔讀取補齊欄位、丟掉壞資料', () => {
  assert.deepEqual(normalizePlan(null), emptyPlan());
  const p = normalizePlan({ name: '測試', params: { people: 9 }, menu: [{ name: '吐司', price: '220' }, { price: 1 }], schedule: [{ title: 'x', date: '2026-11-05' }, { title: 'y', date: 'bad' }], log: [{ date: '2026-11-14', portions: 3 }, { portions: 1 }] });
  assert.equal(p.name, '測試');
  assert.equal(p.params.people, 9);
  assert.equal(p.params.ticket, DEMO_PARAMS.ticket);
  assert.equal(p.menu.length, 1);
  assert.equal(p.menu[0].price, 220);
  assert.equal(p.menu[0].cost, null);
  assert.equal(p.schedule.length, 1);
  assert.equal(p.log.length, 1);
});

function round(n) {
  return Math.round(n * 100) / 100;
}
