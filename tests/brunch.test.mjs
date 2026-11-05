// 早午餐企劃：損益試算、打平線、菜單成本（配方優先、銷售組合加權）、每日多賺、測試判斷、POS 時段對照、進度表、企劃檔檢查／讀取／匯入／匯出
// 數字都是虛構的整數，不對應任何店。
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, profitCurve, cleanParams, dailyFixedOf, dishCost, menuSummary, swapMarginOf, dayResult, entryProblem, testVerdict, posWindow, buildSchedule, scheduleStatus, normalizePlan, checkPlanFile, mergeImport, exportPlan, emptyPlan, TASK_TEMPLATE, DEMO_PARAMS, SCENARIOS, PLAN_KIND } from '../erp/js/lib/brunch.js';

const P = { people: 10, ticket: 200, cost: 25, fee: 2, hours: 1, wage: 200, waste: 50, supplies: 30, util: 20, lost: 0, lost_cost: 20, days: 20 };
const round = (n) => Math.round(n * 100) / 100;

test('brunch: 試算扣營業稅、食材、金流、人力、報廢、耗材、水電', () => {
  const s = simulate(P);
  assert.equal(s.revenue, 2000);
  assert.equal(s.net, round(2000 / 1.05));
  assert.equal(s.food, 500);
  assert.equal(s.fee, 40);
  assert.equal(s.labor, 200);
  assert.equal(s.wasteUtil, 100);
  const profit = 2000 / 1.05 - 500 - 40 - 200 - 50 - 30 - 20;
  assert.equal(s.profit, round(profit));
  assert.equal(s.month, round(profit * 20));
  // 打平線：(200 + 50 + 30 + 20) ÷ 每位毛利 (200/1.05 − 50 − 4)
  const per = 200 / 1.05 - 50 - 4;
  assert.equal(s.perGuest, round(per));
  assert.equal(s.breakEven, Math.ceil(300 / per));
});

test('brunch: 縮短營業少掉的毛利用晚上品項自己的成本率，也算進每天固定增量', () => {
  const a = simulate({ ...P, lost: 0 });
  const b = simulate({ ...P, lost: 300 });
  const lost = 300 / 1.05 - 300 * 0.2 - 300 * 0.02;
  assert.equal(round(a.profit - b.profit), round(lost));
  assert.ok(b.breakEven >= a.breakEven);
  assert.equal(dailyFixedOf({ ...P, lost: 300 }), round(30 + 20 + lost));
  assert.equal(dailyFixedOf(P), 50);
});

test('brunch: 參數超出範圍會被夾住、缺的用示範值；示範值不是午月的數字', () => {
  const p = cleanParams({ people: -5, ticket: 99999, cost: 'x' });
  assert.equal(p.people, 0);
  assert.equal(p.ticket, 800);
  assert.equal(p.cost, DEMO_PARAMS.cost);
  for (const params of [DEMO_PARAMS, ...SCENARIOS.map((s) => s.params)]) {
    assert.notEqual(params.wage, 230);
    assert.notEqual(params.cost, 32);
  }
  // 平日也提早開（情境 D）不划算
  assert.ok(simulate(SCENARIOS.find((s) => s.key === 'D').params).profit < 0);
});

test('brunch: 損益曲線從 0 人開始、跨過打平線後轉正', () => {
  const pts = profitCurve(P);
  const be = simulate(P).breakEven;
  assert.equal(pts[0].people, 0);
  assert.ok(pts[0].profit < 0);
  assert.ok(pts[be].profit >= 0);
  assert.ok(pts[be - 1].profit < 0);
});

test('brunch: 菜單成本有配方用配方、沒有用手填；平均成本率、每份毛利、每份成本', () => {
  const recipe = (pid) => ({ p_a: 40 })[pid];
  assert.deepEqual(dishCost({ price: 200, cost: 80, product_id: 'p_a' }, recipe), { price: 200, cost: 40, source: 'recipe', rate: 0.2 });
  assert.equal(dishCost({ price: 200, cost: 70 }, recipe).source, 'manual');
  assert.equal(dishCost({ price: 100, cost: '' }, recipe).cost, null);
  const menu = [
    { name: 'a', price: 200, cost: 60 },
    { name: 'b', price: 300, cost: 90 },
    { name: 'c', price: 100, cost: null },
    { name: 'd', price: 999, cost: 1, active: false },
  ];
  const m = menuSummary(menu, { feePct: 1 });
  assert.equal(m.count, 3);
  assert.equal(m.avgPrice, 200);
  assert.equal(round(m.avgRate * 100), 30);
  assert.equal(m.missingCost, 1);
  assert.equal(m.margin, round((200 / 1.05 - 60 - 2 + (300 / 1.05 - 90 - 3)) / 2));
  assert.equal(m.avgCost, 75);
  // 照實際銷售組合加權；有賣出但沒成本的要回報
  const w = menuSummary(menu, { feePct: 1, mix: new Map([['a', 1], ['b', 3], ['c', 2]]) });
  assert.equal(w.weighted, true);
  assert.equal(w.margin, round(((200 / 1.05 - 60 - 2) * 1 + (300 / 1.05 - 90 - 3) * 3) / 4));
  assert.equal(w.avgCost, round((60 + 90 * 3) / 4));
  assert.deepEqual(w.soldUncosted, ['c']);
});

test('brunch: 每日多賺——新客算整張單、加點算那份、換點算毛利差、扣報廢、人力與每天固定增量', () => {
  const ctx = { dishMargin: 120, guestMargin: 190, swapMargin: 100, dailyFixed: 50, costRate: 0.3, feePct: 1, wage: 200 };
  const r = dayResult({ date: '2026-11-14', new_count: 3, addon_count: 1, swap_count: 2, waste: 40, extra_hours: 1 }, ctx);
  assert.equal(r.profit, round(3 * 190 + 120 + 2 * 20 - 40 - 200 - 50));
  // 沒設被換掉的品項：退回用差價估
  const r2 = dayResult({ date: '2026-11-14', swap_count: 2, swap_diff: 40 }, { ...ctx, swapMargin: null, dailyFixed: 0 });
  assert.equal(r2.profit, round(40 / 1.05 - 12 - 0.4));
  // 公休日不算錢
  assert.deepEqual([dayResult({ date: '2026-11-14', closed: true, new_count: 9 }, ctx).closed, dayResult({ date: '2026-11-14', closed: true, new_count: 9 }, ctx).profit], [true, 0]);
  assert.equal(swapMarginOf({ price: 200, cost: 60 }, { feePct: 1 }), round(200 / 1.05 - 60 - 2));
  assert.equal(swapMarginOf({ price: 200, cost: null }), null);
});

test('brunch: 判斷——期間沒結束只收資料、缺紀錄或週末不夠或食品安全沒確認都不判', () => {
  const ctx = { dishMargin: 100, dishCost: 50, guestMargin: 150, swapMargin: 90, dailyFixed: 0, wage: 200 };
  const rules = { min_weekend_days: 2 };
  const period = { from: '2026-11-14', to: '2026-11-16', today: '2026-11-20' };
  const good = [
    { date: '2026-11-14', new_count: 5, portions: 5, slowest_min: 10 },
    { date: '2026-11-15', new_count: 4, portions: 4, slowest_min: 10 },
    { date: '2026-11-16', portions: 0 },
  ];
  assert.equal(testVerdict(good, ctx, rules, { ...period, today: '2026-11-15' }).verdict, 'collecting');
  const miss = testVerdict(good.slice(0, 2), ctx, rules, period);
  assert.equal(miss.verdict, 'pending');
  assert.deepEqual(miss.missing, ['2026-11-16']);
  assert.equal(testVerdict(good, ctx, { min_weekend_days: 8 }, period).verdict, 'pending');
  assert.equal(testVerdict(good, ctx, rules, { ...period, safetyOk: false }).verdict, 'pending');
  const pass = testVerdict(good, ctx, rules, period);
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.weekdayProfit, 0);
  // 公休不算缺、不算進平均；同一天重複的紀錄只算一次
  const closed = testVerdict([...good.slice(0, 2), { date: '2026-11-16', closed: true }, { date: '2026-11-15', new_count: 4, portions: 4, slowest_min: 10 }], ctx, rules, period);
  assert.equal(closed.verdict, 'pass');
  assert.equal(closed.count, 2);
});

test('brunch: 判斷——多賺不到門檻、報廢率、出餐太慢、份數分流', () => {
  const ctx = { dishMargin: 100, dishCost: 50, guestMargin: 150, swapMargin: 90, dailyFixed: 0, wage: 200 };
  const rules = { min_weekend_days: 2 };
  const period = { from: '2026-11-14', to: '2026-11-15', today: '2026-11-20' };
  const twoDays = (e) => [{ date: '2026-11-14', ...e }, { date: '2026-11-15', ...e }];
  // 只多賺幾塊錢：不過關（份數 2 → 停）
  assert.equal(testVerdict(twoDays({ portions: 1, addon_count: 1, extra_hours: 0.45, slowest_min: 10 }), ctx, rules, period).verdict, 'stop');
  // 有賺但報廢太多 → 先調整
  const waste = testVerdict(twoDays({ portions: 6, new_count: 6, waste: 200, slowest_min: 10 }), ctx, rules, period);
  assert.equal(waste.verdict, 'fix');
  assert.match(waste.reason, /報廢率/);
  // 有賺但每天都出餐太慢 → 先調整
  const slow = testVerdict(twoDays({ portions: 6, new_count: 6, slowest_min: 18 }), ctx, rules, period);
  assert.equal(slow.verdict, 'fix');
  assert.match(slow.reason, /出餐/);
  // 虧：週末 4 份 → 換品項；超過 5 份 → 調價成本人力
  assert.equal(testVerdict(twoDays({ portions: 4, swap_count: 4, extra_hours: 2, slowest_min: 10 }), ctx, rules, period).verdict, 'adjust');
  const fix = testVerdict(twoDays({ portions: 8, swap_count: 8, extra_hours: 2, slowest_min: 10 }), ctx, rules, period);
  assert.equal(fix.verdict, 'fix');
  assert.match(fix.reason, /超過 5 份/);
});

test('brunch: POS 時段營收、時段內份數與銷售組合（品名精準比對、不看選項，作廢、調整、0 元不算）', () => {
  const lines = [
    { date: '2026-11-14', time: '11:40', order_no: 'A1', item_raw: '測試吐司', category_raw: '早午餐', qty: 1, revenue: 200 },
    { date: '2026-11-14', time: '11:40', order_no: 'A1', item_raw: '美式', option_raw: '早午餐加購', qty: 1, revenue: 100 },
    { date: '2026-11-14', time: '13:59', order_no: 'A2', item_raw: '拿鐵', qty: 1, revenue: 150 },
    { date: '2026-11-14', time: '15:10', order_no: 'A5', item_raw: '測試吐司', qty: 1, revenue: 200 },
    { date: '2026-11-14', time: '12:10', order_no: 'A3', item_raw: '測試優格', qty: 2, revenue: 0, void_reason: 'boss_test' },
    { date: '2026-11-14', time: '12:15', order_no: 'A6', item_raw: '測試優格', qty: 1, revenue: 0 },
    { date: '2026-11-14', time: '12:20', order_no: 'A4', item_raw: '折讓', qty: 1, revenue: -10, is_adjustment: true },
    { date: '2026-11-15', time: '12:00', order_no: 'B1', item_raw: ' 測試 可頌盤', qty: 2, revenue: 480 },
    { date: '2026-11-15', time: '12:05', order_no: 'B2', item_raw: '測試可頌盤沙拉', qty: 1, revenue: 50 },
  ];
  const r = posWindow(lines, { start: '11:30', end: '14:00', keywords: '早午餐', dishes: ['測試吐司', '測試可頌盤', '測試優格'] });
  assert.equal(r.length, 2);
  assert.deepEqual([r[0].date, r[0].windowRevenue, r[0].windowOrders, r[0].revenue, r[0].brunchQty], ['2026-11-14', 450, 3, 650, 1]);
  assert.equal(r[1].brunchQty, 2); // 「測試可頌盤沙拉」不是同一道
  assert.deepEqual([...r.mix.entries()].sort(), [['測試可頌盤', 2], ['測試吐司', 1]]);
  assert.equal(posWindow(lines, { from: '2026-11-15' }).length, 1);
});

test('brunch: 進度表依範本攤開、推出任務放推出日、狀態算逾期與下一件', () => {
  const s = buildSchedule('2026-11-05', '2026-11-12');
  assert.equal(s.length, TASK_TEMPLATE.length);
  assert.equal(s[0].date, '2026-11-05');
  assert.ok(s.filter((t) => t.date === '2026-11-12').length >= 2);
  assert.ok(s.every((t) => t.date >= '2026-11-05' && t.date <= '2026-11-12'));
  assert.ok(s.filter((t) => !/^推出|收班 1 分鐘/.test(t.title)).every((t) => t.date < '2026-11-12'));
  assert.ok(buildSchedule('2026-11-10', '2026-11-12').every((t) => t.date >= '2026-11-10' && t.date <= '2026-11-12'));
  s[0].done = true;
  const st = scheduleStatus(s, '2026-11-07');
  assert.equal(st.done, 1);
  assert.ok(st.overdue.length > 0 && st.overdue.every((t) => t.date < '2026-11-07'));
  assert.equal(st.next.date, '2026-11-05');
});

test('brunch: 企劃讀取丟掉壞資料（日期、時間、負數、重複 ID、重複日期）', () => {
  assert.deepEqual(normalizePlan(null), emptyPlan());
  const p = normalizePlan({
    name: '測試',
    window: { start: '25:00', end: '14:00' },
    params: { people: 9 },
    menu: [{ id: 'x', name: '吐司', price: '220' }, { id: 'x', name: '可頌', price: 100, cost: -5 }, { price: 1 }],
    schedule: [{ title: 'x', date: '2026-11-05' }, { title: 'y', date: '2026-13-40' }],
    log: [{ date: '2026-11-14', portions: 3 }, { date: '2026-11-14', portions: 5, waste: -1 }, { portions: 1 }],
    rules: { min_profit: -1, waste_rate: 0.2 },
  });
  assert.equal(p.window.start, '11:30');
  assert.equal(p.window.end, '14:00');
  assert.equal(p.params.people, 9);
  assert.equal(p.params.ticket, DEMO_PARAMS.ticket);
  assert.deepEqual(p.menu.map((d) => [d.id, d.name, d.price, d.cost]), [['x', '吐司', 220, null], ['x_2', '可頌', 100, null]]);
  assert.equal(p.schedule.length, 1);
  assert.deepEqual(p.log.map((e) => [e.date, e.portions, e.waste]), [['2026-11-14', 5, null]]);
  assert.equal(p.rules.min_profit, 100);
  assert.equal(p.rules.waste_rate, 0.2);
});

test('brunch: 企劃檔檢查——要有標記、版本不能比程式新、壞資料列出來', () => {
  assert.deepEqual(checkPlanFile({ kind: PLAN_KIND, version: 1, menu: [] }).errors, []);
  assert.ok(checkPlanFile({ menu: [] }).errors.length);
  assert.ok(checkPlanFile({ kind: 'wuyue-erp-backup' }).errors.length);
  assert.match(checkPlanFile({ kind: PLAN_KIND, version: 2 }).errors.join(), /較新/);
  assert.ok(checkPlanFile([1, 2]).errors.length);
  const w = checkPlanFile({ kind: PLAN_KIND, menu: [{ name: 'a', price: -1 }], log: [{ date: '2026-11-14' }, { date: '2026-11-14' }, { date: 'x' }], window: { start: '9點' } }).warnings.join('｜');
  assert.match(w, /菜單第 1 道「a」：價格「-1」不對，會略過/);
  assert.match(w, /每日紀錄第 3 筆：日期「x」不對，會略過/);
  assert.match(w, /重複的日期/);
  assert.match(w, /9點/);
});

test('brunch: 匯入預設保留現場的每日紀錄；勾選才整份換掉', () => {
  const current = normalizePlan({ name: '舊', menu: [{ name: 'a', price: 100 }], log: [{ date: '2026-11-12', portions: 4 }, { date: '2026-11-13', portions: 2 }] });
  const incoming = normalizePlan({ name: '新', menu: [{ name: 'b', price: 200 }], log: [{ date: '2026-11-13', portions: 99 }, { date: '2026-11-11', portions: 1 }] });
  const m = mergeImport(current, incoming);
  assert.equal(m.name, '新');
  assert.equal(m.menu[0].name, 'b');
  assert.deepEqual(m.log.map((e) => [e.date, e.portions]), [['2026-11-11', 1], ['2026-11-12', 4], ['2026-11-13', 2]]);
  assert.equal(mergeImport(current, normalizePlan({ name: '空', menu: [{ name: 'c', price: 1 }], log: [] })).log.length, 2);
  assert.deepEqual(mergeImport(current, incoming, { replaceLog: true }).log.map((e) => e.date), ['2026-11-11', '2026-11-13']);
});

test('brunch: 匯出企劃不帶每日紀錄、備註、勾選；完整備份全部帶', () => {
  const plan = normalizePlan({ name: 'x', notes: '內部', safety_ok: true, menu: [{ name: 'a', price: 1 }], schedule: [{ title: 't', date: '2026-11-05', done: true, note: '店長說' }], log: [{ date: '2026-11-14', portions: 3 }] });
  const t = exportPlan(plan);
  assert.equal(t.kind, PLAN_KIND);
  assert.deepEqual([t.log.length, t.notes, t.safety_ok, t.schedule[0].done, t.schedule[0].note], [0, '', false, false, '']);
  const f = exportPlan(plan, { full: true });
  assert.deepEqual([f.log.length, f.notes, f.safety_ok, f.schedule[0].done], [1, '內部', true, true]);
  // 匯出再讀回來一樣
  assert.deepEqual(normalizePlan(JSON.parse(JSON.stringify(f))), plan);
});

test('brunch: 紀錄不完整不判斷——有賣沒填出餐、份數對不上、有賣出但沒成本', () => {
  assert.equal(entryProblem({ date: '2026-11-14', portions: 3, new_count: 3, slowest_min: 9 }), '');
  assert.equal(entryProblem({ date: '2026-11-14', portions: 0 }), '');
  assert.equal(entryProblem({ date: '2026-11-14', closed: true }), '');
  assert.match(entryProblem({ date: '2026-11-14' }), /份數/);
  assert.match(entryProblem({ date: '2026-11-14', portions: 3, new_count: 3 }), /最慢出餐/);
  assert.match(entryProblem({ date: '2026-11-14', portions: 3, new_count: 1, slowest_min: 9 }), /不等於份數/);
  const ctx = { dishMargin: 100, dishCost: 50, guestMargin: 150, swapMargin: 90, dailyFixed: 0, wage: 200 };
  const period = { from: '2026-11-14', to: '2026-11-15', today: '2026-11-20' };
  const ok = [{ date: '2026-11-14', portions: 5, new_count: 5, slowest_min: 9 }, { date: '2026-11-15', portions: 4, new_count: 4, slowest_min: 9 }];
  assert.equal(testVerdict(ok, ctx, { min_weekend_days: 2 }, period).verdict, 'pass');
  const bad = testVerdict([ok[0], { date: '2026-11-15', portions: 4, new_count: 4 }], ctx, { min_weekend_days: 2 }, period);
  assert.equal(bad.verdict, 'pending');
  assert.deepEqual(bad.incomplete.map((x) => x.date), ['2026-11-15']);
  const unc = testVerdict(ok, { ...ctx, soldUncosted: ['測試優格'] }, { min_weekend_days: 2 }, period);
  assert.equal(unc.verdict, 'pending');
  assert.match(unc.reason, /測試優格/);
});

test('brunch: 匯入檢查跟讀取用同一套規則——說會略過的真的略過、說當成沒填的真的變空白', () => {
  const data = { kind: PLAN_KIND, menu: [{ name: 'a', price: 0 }, { name: 'b', price: 100, cost: -3 }, { name: 'c', price: 120, cost: 30 }], schedule: [{ title: 't', date: '2026-02-30' }], log: [{ date: '2026-11-14', portions: -1, waste: 'x' }], swap_ref: { price: 100, cost: -1 } };
  const w = checkPlanFile(data).warnings.join('｜');
  const p = normalizePlan(data);
  assert.match(w, /「a」：價格「0」不對，會略過/);
  assert.match(w, /「b」：成本「-3」不對，當成沒填/);
  assert.match(w, /進度表第 1 件「t」：日期「2026-02-30」不對/);
  assert.match(w, /portions、waste 不是 0 以上的數字/);
  assert.match(w, /換點對照/);
  assert.deepEqual(p.menu.map((d) => [d.name, d.cost]), [['b', null], ['c', 30]]);
  assert.equal(p.schedule.length, 0);
  assert.deepEqual([p.log[0].portions, p.log[0].waste], [null, null]);
  assert.equal(p.swap_ref.cost, null);
});