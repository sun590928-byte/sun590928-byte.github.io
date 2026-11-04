// 早午餐企劃：損益試算、打平線、菜單成本（配方優先）、每日多賺、測試判斷、POS 時段對照、進度表、企劃檔讀取
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, profitCurve, cleanParams, dishCost, menuSummary, swapMarginOf, dayResult, testVerdict, posWindow, buildSchedule, scheduleStatus, normalizePlan, emptyPlan, TASK_TEMPLATE, DEMO_PARAMS, SCENARIOS } from '../erp/js/lib/brunch.js';

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
  assert.equal(round(a.profit - b.profit), round(200 / 1.05 - 200 * 0.25 - 200 * 0.01)); // 晚上品項用自己的成本率（預設 25%）
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
  // 每份毛利只平均有成本的兩道
  assert.equal(m.margin, round((200 / 1.05 - 60 - 2 + (300 / 1.05 - 90 - 3)) / 2));
});

test('brunch: 每日多賺——新客算整張單、加點算那份、換點算毛利差、扣報廢與人力', () => {
  const ctx = { dishMargin: 120, guestMargin: 190, swapMargin: 100, costRate: 0.3, feePct: 1, wage: 230 };
  const r = dayResult({ date: '2026-11-14', new_count: 3, addon_count: 1, swap_count: 2, waste: 50, extra_hours: 1 }, ctx);
  assert.equal(r.profit, round(3 * 190 + 1 * 120 + 2 * (120 - 100) - 50 - 230));
  // 沒設被換掉的品項：退回用差價估
  const r2 = dayResult({ date: '2026-11-14', swap_count: 2, swap_diff: 40 }, { ...ctx, swapMargin: null });
  assert.equal(r2.profit, round(40 / 1.05 - 12 - 0.4));
  assert.equal(dayResult({ date: '2026-11-14', closed: true }, ctx).closed, true);
  assert.equal(swapMarginOf({ price: 200, cost: 60 }, { feePct: 1 }), round(200 / 1.05 - 60 - 2));
  assert.equal(swapMarginOf({ price: 200, cost: null }), null);
});

test('brunch: 測試判斷——期間沒結束只收資料、缺紀錄不判斷、週末天數不夠不判斷、四種結論', () => {
  const ctx = { dishMargin: 100, guestMargin: 150, swapMargin: 90, wage: 230 };
  const rules = { min_weekend_days: 2 };
  const period = { from: '2026-11-14', to: '2026-11-16', today: '2026-11-20' };
  const day = (date, e) => ({ date, ...e });
  const good = [day('2026-11-14', { new_count: 5, portions: 5 }), day('2026-11-15', { new_count: 4, portions: 4 }), day('2026-11-16', { portions: 0 })];
  assert.equal(testVerdict(good, ctx, rules, { ...period, today: '2026-11-15' }).verdict, 'collecting');
  const miss = testVerdict(good.slice(0, 2), ctx, rules, period);
  assert.equal(miss.verdict, 'pending');
  assert.deepEqual(miss.missing, ['2026-11-16']);
  assert.equal(testVerdict(good, ctx, { min_weekend_days: 8 }, period).verdict, 'pending');
  const pass = testVerdict(good, ctx, rules, period);
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.weekdayProfit, 0);
  // 公休日不算缺、也不算進平均
  const closed = testVerdict([...good.slice(0, 2), day('2026-11-16', { closed: true })], ctx, rules, period);
  assert.equal(closed.verdict, 'pass');
  assert.equal(closed.count, 2);
  // 虧錢：週末平均 < 3 停；3～5 換品項；> 5 調價成本人力
  const loss = (portions) => [day('2026-11-14', { portions, swap_count: portions, extra_hours: 2 }), day('2026-11-15', { portions, swap_count: portions, extra_hours: 2 }), day('2026-11-16', { portions: 0 })];
  assert.equal(testVerdict(loss(2), ctx, rules, period).verdict, 'stop');
  assert.equal(testVerdict(loss(4), ctx, rules, period).verdict, 'adjust');
  assert.equal(testVerdict(loss(8), ctx, rules, period).verdict, 'fix');
  assert.equal(testVerdict([day('2026-11-14', { slowest_min: 18 }), day('2026-11-15', { slowest_min: 10 })], ctx, rules, period).slowDays, 1);
});

test('brunch: POS 時段營收、時段內早午餐份數與實際銷售組合（作廢、調整、0 元不算）', () => {
  const lines = [
    { date: '2026-11-14', time: '11:40', order_no: 'A1', item_raw: '布丁法式吐司', category_raw: '早午餐', qty: 1, revenue: 220 },
    { date: '2026-11-14', time: '11:40', order_no: 'A1', item_raw: '美式', qty: 1, revenue: 120 },
    { date: '2026-11-14', time: '13:59', order_no: 'A2', item_raw: '拿鐵', qty: 1, revenue: 150 },
    { date: '2026-11-14', time: '15:10', order_no: 'A5', item_raw: '布丁法式吐司', qty: 1, revenue: 220 },
    { date: '2026-11-14', time: '12:10', order_no: 'A3', item_raw: '優格穀物杯', qty: 2, revenue: 0, void_reason: 'boss_test' },
    { date: '2026-11-14', time: '12:15', order_no: 'A6', item_raw: '優格穀物杯', qty: 1, revenue: 0 },
    { date: '2026-11-14', time: '12:20', order_no: 'A4', item_raw: '折讓', qty: 1, revenue: -10, is_adjustment: true },
    { date: '2026-11-15', time: '12:00', order_no: 'B1', item_raw: '明太子起士可頌盤', qty: 2, revenue: 480 },
  ];
  const r = posWindow(lines, { start: '11:30', end: '14:00', keywords: '早午餐', dishes: ['布丁法式吐司', '明太子起士可頌盤', '優格穀物杯'] });
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].date, r[0].windowRevenue, r[0].windowOrders, r[0].revenue, r[0].brunchQty], ['2026-11-14', 490, 3, 710, 1]);
  assert.equal(r[1].brunchQty, 2);
  assert.deepEqual([...r.mix.entries()].sort(), [['布丁法式吐司', 1], ['明太子起士可頌盤', 2]]);
  assert.equal(posWindow(lines, { from: '2026-11-15' }).length, 1);
  // 照實際組合加權：可頌盤賣得多，每份毛利往可頌盤靠
  const menu = [
    { name: '布丁法式吐司', price: 220, cost: 62 },
    { name: '明太子起士可頌盤', price: 240, cost: 85 },
  ];
  const w = menuSummary(menu, { feePct: 1, mix: r.mix });
  assert.equal(w.weighted, true);
  assert.equal(w.margin, round(((220 / 1.05 - 62 - 2.2) * 1 + (240 / 1.05 - 85 - 2.4) * 2) / 3));
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
