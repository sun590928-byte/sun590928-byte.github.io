// 早午餐企劃：新時段加賣的損益試算、菜單成本、測試期每日紀錄與判斷、推出進度表。
// 只有計算。店家的實際數字（價格、成本、營收、時薪）存在使用者資料（settings 的 brunch_plan），這裡只放明顯虛構的示範值。

import { addDays, daysBetween, eachDay, weekdayIndex } from './dates.js';
import { round2 } from './money.js';

export const PLAN_ID = 'brunch_plan';
export const PLAN_KIND = 'wuyue-erp-brunch-plan'; // 企劃檔的標記，匯入時用來擋掉別種 JSON
export const PLAN_VERSION = 1;

// 試算參數：拉桿的範圍與說明
export const SIM_FIELDS = [
  { key: 'people', label: '每天多出來的客人', unit: '人', min: 0, max: 40, step: 1, hint: '只算「因為這個時段才多來」的人；原本就會來、只是改點的不算' },
  { key: 'ticket', label: '每人客單（含稅）', unit: '元', min: 100, max: 800, step: 10, hint: '餐點＋飲料' },
  { key: 'cost', label: '食材成本率（成本 ÷ 含稅售價）', unit: '%', min: 10, max: 60, step: 1, hint: '有配方就看「菜單與成本」算出來的數字' },
  { key: 'fee', label: '金流手續費（平均）', unit: '%', min: 0, max: 4, step: 0.1, hint: '有人付現金，平均會比刷卡費低' },
  { key: 'hours', label: '多排的人力', unit: '小時／天', min: 0, max: 10, step: 0.25, hint: '提早開門、備料、多一人支援的時間' },
  { key: 'wage', label: '時薪（含勞健保、勞退）', unit: '元', min: 150, max: 400, step: 2, hint: '用實際薪資' },
  { key: 'waste', label: '報廢（成本）', unit: '元／天', min: 0, max: 800, step: 10, hint: '賣不完、做壞的備料' },
  { key: 'supplies', label: '耗材', unit: '元／天', min: 0, max: 400, step: 10, hint: '外帶盒、紙巾、烘焙紙' },
  { key: 'util', label: '多出來的水電', unit: '元／天', min: 0, max: 400, step: 10, hint: '提早開燈、冷氣、烤箱' },
  { key: 'lost', label: '縮短營業少掉的營收（含稅）', unit: '元／天', min: 0, max: 3000, step: 50, hint: '把晚上的時數搬到早上時，晚上少賺的' },
  { key: 'lost_cost', label: '晚上那些品項的成本率', unit: '%', min: 10, max: 60, step: 1, hint: '晚上賣的多半是飲料甜點，成本率跟早午餐不一樣；沒有少掉營收就不影響' },
  { key: 'days', label: '每月天數', unit: '天', min: 1, max: 31, step: 1, hint: '只做週末約 8–9 天；每天做約 26–30 天' },
];

// 示範值：刻意用整數、跟任何店的實際數字無關，第一次打開時讓畫面有東西看
export const DEMO_PARAMS = { people: 5, ticket: 280, cost: 30, fee: 1.5, hours: 0.5, wage: 250, waste: 80, supplies: 40, util: 50, lost: 0, lost_cost: 30, days: 26 };

export const SCENARIOS = [
  { key: 'A', label: 'A 營業時間不變，只加餐點', params: { people: 5, ticket: 280, cost: 30, fee: 1.5, hours: 0.5, wage: 250, waste: 80, supplies: 40, util: 50, lost: 0, lost_cost: 30, days: 26 } },
  { key: 'B', label: 'B 週末提早開，晚上照舊', params: { people: 8, ticket: 300, cost: 30, fee: 1.5, hours: 2, wage: 250, waste: 100, supplies: 40, util: 100, lost: 0, lost_cost: 30, days: 8 } },
  { key: 'C', label: 'C 週末提早開，也提早打烊', params: { people: 8, ticket: 300, cost: 30, fee: 1.5, hours: 0.5, wage: 250, waste: 100, supplies: 40, util: 100, lost: 400, lost_cost: 30, days: 8 } },
  { key: 'D', label: 'D 平日也提早開', params: { people: 3, ticket: 280, cost: 30, fee: 1.5, hours: 2, wage: 250, waste: 80, supplies: 40, util: 100, lost: 0, lost_cost: 30, days: 18 } },
];

/**
 * 判斷門檻
 * - min_weekend_days：至少要幾個週末日的紀錄（4 個週末＝8 天）
 * - min_profit：過關要的「平均每天多賺」最低緩衝（元），避免只多賺幾塊錢就過關
 * - waste_rate：報廢 ÷（報廢＋賣出份數的食材成本）上限
 * - max_serve_min／max_slow_share：最慢出餐超過幾分鐘算「太慢」，這種天數最多佔幾成
 * - stop_portions／adjust_portions：虧錢時，週末平均份數 < stop 停；stop～adjust 換品項或宣傳；超過 adjust 調價、成本或人力
 */
export const DEFAULT_RULES = { min_weekend_days: 8, min_profit: 100, waste_rate: 0.15, target_serve_min: 12, max_serve_min: 15, max_slow_share: 0.1, stop_portions: 3, adjust_portions: 5 };

const n = (v, d = 0) => (v !== null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
// 日期要真的存在（2/30 這種會被 Date 自動進位，所以比對來回轉換後是否一樣）
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;
const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

export function cleanParams(p = {}) {
  const out = {};
  for (const f of SIM_FIELDS) out[f.key] = Math.min(f.max, Math.max(f.min, n(p[f.key], DEMO_PARAMS[f.key])));
  return out;
}

/**
 * 每天多賺多少：營收先扣營業稅（含稅 ÷ 1＋稅率），再扣食材、金流、人力、報廢、耗材、水電，以及縮短營業少掉的毛利。
 * 食材成本率是「成本 ÷ 含稅售價」，跟菜單表的算法一致。
 */
export function simulate(params, { vatRate = 0.05 } = {}) {
  const p = cleanParams(params);
  const rev = p.people * p.ticket;
  const net = rev / (1 + vatRate);
  const food = (rev * p.cost) / 100;
  const fee = (rev * p.fee) / 100;
  const labor = p.hours * p.wage;
  const lostMargin = lostMarginOf(p, vatRate);
  const profit = net - food - fee - labor - p.waste - p.supplies - p.util - lostMargin;
  // 打平線：每位客人的毛利要蓋過固定支出（人力、報廢、耗材、水電、少掉的毛利）
  const perGuest = unitMargin(p.ticket, (p.ticket * p.cost) / 100, { vatRate, feePct: p.fee });
  const fixed = labor + p.waste + p.supplies + p.util + lostMargin;
  const breakEven = perGuest > 0 ? Math.max(0, Math.ceil(fixed / perGuest - 1e-9)) : null;
  return {
    params: p,
    revenue: round2(rev),
    net: round2(net),
    tax: round2(rev - net),
    food: round2(food),
    fee: round2(fee),
    labor: round2(labor),
    waste: round2(p.waste),
    supplies: round2(p.supplies),
    util: round2(p.util),
    wasteUtil: round2(p.waste + p.supplies + p.util),
    lostMargin: round2(lostMargin),
    profit: round2(profit),
    month: round2(profit * p.days),
    perGuest: round2(perGuest),
    fixed: round2(fixed),
    breakEven,
  };
}

const lostMarginOf = (p, vatRate) => p.lost / (1 + vatRate) - (p.lost * p.lost_cost) / 100 - (p.lost * p.fee) / 100;

/** 測試期每天都會發生、但每日紀錄不會記的增量成本：耗材、水電、縮短營業少掉的毛利 */
export function dailyFixedOf(params, { vatRate = 0.05 } = {}) {
  const p = cleanParams(params);
  return round2(p.supplies + p.util + lostMarginOf(p, vatRate));
}

// 客人數 0…max 對應的每日多賺，畫損益平衡線用
export function profitCurve(params, { vatRate = 0.05, max = null } = {}) {
  const p = cleanParams(params);
  const s = simulate(p, { vatRate });
  const top = max ?? Math.max(10, Math.ceil(Math.max(p.people, s.breakEven ?? 0) * 1.6));
  const pts = [];
  for (let k = 0; k <= top; k++) pts.push({ people: k, profit: simulate({ ...p, people: k }, { vatRate }).profit });
  return pts;
}

// ─────────── 菜單與成本

/**
 * 一道菜的成本：有連結 ERP 品項、而且有配方，用配方 × 平均進價（未稅）；否則用手填成本。
 * @param recipeCostOf (productId) => number | undefined
 */
export function dishCost(dish, recipeCostOf = () => undefined) {
  const price = n(dish.price);
  const rc = dish.product_id ? recipeCostOf(dish.product_id) : undefined;
  const useRecipe = Number.isFinite(rc) && rc > 0;
  const cost = useRecipe ? rc : dish.cost === null || dish.cost === undefined || dish.cost === '' ? null : n(dish.cost);
  return { price, cost, source: useRecipe ? 'recipe' : cost === null ? null : 'manual', rate: cost !== null && price > 0 ? cost / price : null };
}

// 一份的毛利：扣營業稅、食材、金流
export const unitMargin = (price, cost, { vatRate = 0.05, feePct = 1 } = {}) => n(price) / (1 + vatRate) - n(cost) - (n(price) * feePct) / 100;

// 換點時被換掉的品項（例如甜點）每份毛利；價格或成本沒填就回 null，改用差價估
export function swapMarginOf(ref, opts) {
  if (!ref || !(n(ref.price) > 0) || ref.cost === null || ref.cost === undefined || ref.cost === '') return null;
  return round2(unitMargin(ref.price, ref.cost, opts));
}

/**
 * 菜單平均：售價、成本率、每份毛利、每份成本。
 * 有 mix（品名 → 實際賣出份數，來自 POS）就照實際銷售組合加權；沒有就每道平均。
 * 沒有成本的菜不拿來猜，另外回報 missingCost／soldUncosted 讓畫面提醒。
 */
export function menuSummary(menu = [], { vatRate = 0.05, feePct = 1, recipeCostOf, mix = null } = {}) {
  const rows = menu.filter((d) => d.active !== false).map((d) => ({ dish: d, ...dishCost(d, recipeCostOf) }));
  const priced = rows.filter((r) => r.price > 0);
  const costed = priced.filter((r) => r.cost !== null);
  const avgPrice = priced.length ? priced.reduce((t, r) => t + r.price, 0) / priced.length : 0;
  const avgRate = costed.length ? costed.reduce((t, r) => t + r.rate, 0) / costed.length : null;
  const sold = mix ? costed.map((r) => [r, n(mix.get(r.dish.name))]).filter(([, q]) => q > 0) : [];
  const soldQty = sold.reduce((t, [, q]) => t + q, 0);
  const weightedAvg = (fn) => (soldQty > 0 ? sold.reduce((t, [r, q]) => t + fn(r) * q, 0) / soldQty : costed.length ? costed.reduce((t, r) => t + fn(r), 0) / costed.length : null);
  const margin = weightedAvg((r) => unitMargin(r.price, r.cost, { vatRate, feePct }));
  const cost = weightedAvg((r) => r.cost);
  const soldUncosted = mix ? priced.filter((r) => r.cost === null && n(mix.get(r.dish.name)) > 0).map((r) => r.dish.name) : [];
  return {
    rows,
    count: rows.length,
    avgPrice: round2(avgPrice),
    avgRate,
    margin: margin === null ? null : round2(margin),
    avgCost: cost === null ? null : round2(cost),
    weighted: soldQty > 0,
    missingCost: priced.length - costed.length,
    soldUncosted,
  };
}

// ─────────── 測試期每日紀錄

export const isWeekend = (ymd) => weekdayIndex(ymd) >= 5;

/**
 * 一天多賺多少（主指標）：
 * - 新客（因為早午餐才來的人）：整張增量訂單的毛利（guestMargin，試算器的每位客人毛利，含飲料；是估算）；
 * - 原本的客人多加點：那份餐的毛利（dishMargin）；
 * - 原本的客人把別的品項換成早午餐：早午餐毛利 − 被換掉品項的毛利（swapMargin）；
 *   沒設被換掉的品項時，退回用「差價」估（swap_diff），會比較不準；
 * - 扣當天的報廢、多排的人力，以及每天都會有的耗材、水電、少掉的毛利（dailyFixed）。
 */
export function dayResult(entry, { dishMargin = 0, guestMargin = null, swapMargin = null, dailyFixed = 0, costRate = 0.3, feePct = 1, wage = 0, vatRate = 0.05 } = {}) {
  const guest = guestMargin === null ? n(dishMargin) : n(guestMargin);
  const swap =
    swapMargin === null || swapMargin === undefined
      ? n(entry.swap_diff) / (1 + vatRate) - n(entry.swap_diff) * costRate - (n(entry.swap_diff) * feePct) / 100
      : n(entry.swap_count) * (n(dishMargin) - n(swapMargin));
  const closed = !!entry.closed;
  const profit = closed ? 0 : n(entry.new_count) * guest + n(entry.addon_count) * n(dishMargin) + swap - n(entry.waste) - n(entry.extra_hours) * n(wage) - n(dailyFixed);
  return { profit: round2(profit), portions: n(entry.portions), waste: n(entry.waste), slow: n(entry.slowest_min), closed };
}

/**
 * 測試判斷（主指標優先，份數只用來決定要調什麼）
 * 先確認資料夠：測試期結束、期間每天都有紀錄（沒賣也要記 0；公休勾公休）、週末日數夠、食品安全已確認。
 * - 平均每天多賺 ≥ min_profit，而且報廢率、出餐太慢的天數都在門檻內 → 過關
 * - 有多賺但報廢或出餐不合格 → 先改備料或出餐流程
 * - 虧（或多賺不到 min_profit）：週末平均 < stop_portions 份 → 停；stop～adjust_portions 份 → 換品項或宣傳；超過 adjust_portions 份 → 調價、成本或人力
 */
export function testVerdict(entries = [], ctx = {}, rules = DEFAULT_RULES, { from = '', to = '', today = '', safetyOk = true } = {}) {
  const r = { ...DEFAULT_RULES, ...rules };
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const byDate = new Map();
  for (const e of entries) if (e && isDate(e.date) && inRange(e.date)) byDate.set(e.date, e); // 同一天只留最後一筆
  const all = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1)).map((e) => ({ ...e, ...dayResult(e, ctx), weekend: isWeekend(e.date) }));
  const days = all.filter((d) => !d.closed);
  const avg = (arr, k) => (arr.length ? arr.reduce((t, x) => t + x[k], 0) / arr.length : null);
  const sum = (arr, k) => arr.reduce((t, x) => t + x[k], 0);
  const weekends = days.filter((d) => d.weekend);
  const weekdays = days.filter((d) => !d.weekend);
  const avgProfit = avg(days, 'profit');
  const weekendPortions = avg(weekends, 'portions');
  const until = to && today && today < to ? today : to;
  const missing = isDate(from) && isDate(until) && from <= until ? eachDay(from, until).filter((d) => !byDate.has(d) && d < (today || '9999')) : [];
  const slowDays = days.filter((d) => d.slow > r.max_serve_min).length;
  const incomplete = [...byDate.values()].filter((e) => entryProblem(e)).map((e) => ({ date: e.date, problem: entryProblem(e) }));
  const uncosted = (ctx.soldUncosted || []).filter(Boolean);
  const slowShare = days.length ? slowDays / days.length : 0;
  const wasteTotal = sum(days, 'waste');
  const foodTotal = sum(days, 'portions') * n(ctx.dishCost);
  const wasteRate = wasteTotal + foodTotal > 0 ? wasteTotal / (wasteTotal + foodTotal) : 0;
  const fmtPct = (x) => `${Math.round(x * 100)}%`;
  let verdict = 'pending';
  let reason = '';
  if (!isDate(from) || !isDate(to)) reason = '先設定測試開始與結束日。';
  else if (today && today <= to) {
    verdict = 'collecting';
    reason = `測試進行中（到 ${to}），先看數字、不下結論${missing.length ? `；已經缺 ${missing.length} 天紀錄，沒賣也要記 0` : ''}。`;
  } else if (missing.length) reason = `還缺 ${missing.length} 天紀錄（${missing.slice(0, 3).join('、')}${missing.length > 3 ? '…' : ''}）：沒賣也要記 0，公休就勾公休。補齊才判斷。`;
  else if (incomplete.length) reason = `有 ${incomplete.length} 天紀錄不完整（${incomplete.slice(0, 2).map((x) => ` ${x.problem}`).join('；')}${incomplete.length > 2 ? '…' : ''}）：補完才判斷。`;
  else if (uncosted.length) reason = `有賣出但沒有成本的品項：${uncosted.join('、')}。補上成本前只看暫算，不下結論。`;
  else if (weekends.length < r.min_weekend_days) reason = `週末紀錄只有 ${weekends.length} 天，至少要 ${r.min_weekend_days} 天才判斷。`;
  else if (!safetyOk) reason = '食品業者登錄與產品責任險還沒確認，不能判過關。確認後勾「食品安全已確認」。';
  else if (avgProfit >= r.min_profit) {
    const problems = [];
    if (wasteRate > r.waste_rate) problems.push(`報廢率 ${fmtPct(wasteRate)} 超過 ${fmtPct(r.waste_rate)}`);
    if (slowShare > r.max_slow_share) problems.push(`出餐超過 ${r.max_serve_min} 分鐘的有 ${slowDays} 天（${fmtPct(slowShare)}）`);
    if (problems.length) {
      verdict = 'fix';
      reason = `有多賺，但${problems.join('、')}：先減少備料或簡化出餐，再跑 2 週。`;
    } else {
      verdict = 'pass';
      reason = `平均每天多賺 ${Math.round(avgProfit)} 元（門檻 ${r.min_profit} 元），報廢與出餐都在標準內：過關，留下來。份數少的日子可以不賣。`;
    }
  } else if (weekendPortions < r.stop_portions) {
    verdict = 'stop';
    reason = `沒有多賺到 ${r.min_profit} 元，週末平均不到 ${r.stop_portions} 份：停，品項收掉。`;
  } else if (weekendPortions <= r.adjust_portions) {
    verdict = 'adjust';
    reason = `沒有多賺到 ${r.min_profit} 元，週末平均 ${round2(weekendPortions)} 份（${r.stop_portions}–${r.adjust_portions} 份）：換品項、加強門口立牌與宣傳，再跑 2 週。`;
  } else {
    verdict = 'fix';
    reason = `週末平均 ${round2(weekendPortions)} 份（超過 ${r.adjust_portions} 份）卻沒有多賺到 ${r.min_profit} 元：有人點，問題在錢——調價、降成本或減人力。`;
  }
  const r2 = (v) => (v === null ? null : round2(v));
  return {
    days: all,
    count: days.length,
    closedCount: all.length - days.length,
    weekendCount: weekends.length,
    missing,
    incomplete,
    avgProfit: r2(avgProfit),
    weekendProfit: r2(avg(weekends, 'profit')),
    weekdayProfit: r2(avg(weekdays, 'profit')),
    totalProfit: round2(sum(days, 'profit')),
    weekendPortions: r2(weekendPortions),
    weekdayPortions: r2(avg(weekdays, 'portions')),
    slowDays,
    wasteRate,
    verdict,
    reason,
    doorGroups: days.reduce((t, d) => t + n(d.door_groups), 0),
    surveyYes: days.reduce((t, d) => t + n(d.survey_yes), 0),
  };
}

const blank = (v) => v === null || v === undefined || v === '';

/**
 * 一筆每日紀錄有沒有缺：有賣出（份數 > 0）就要填最慢出餐；新客＋加點＋換點要等於份數（一位新客記 1 份）。
 * 回傳問題文字；沒問題回空字串。公休日不檢查。
 */
export function entryProblem(e) {
  if (!e || e.closed) return '';
  if (blank(e.portions)) return '沒填份數';
  const portions = n(e.portions);
  if (portions > 0 && blank(e.slowest_min)) return '有賣出但沒填最慢出餐';
  const split = n(e.new_count) + n(e.addon_count) + n(e.swap_count);
  if (split !== portions) return `新客＋加點＋換點（${split}）不等於份數（${portions}）`;
  return '';
}

// ─────────── POS 銷售明細對照

const toMin = (t) => {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const splitKeys = (s) =>
  String(s || '')
    .split(/[,，、\n]/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

/**
 * 每天在試賣時段（start ≤ 時間 < end）的 POS 營收、訂單數，以及時段內早午餐的份數。
 * - 早午餐怎麼認：品名等於菜單品名（不分大小寫、去空白），或品類含關鍵字。不看規格／選項，避免加購選項被算成一份。
 * - 作廢、招待、測試、報廢（ERP 標成作廢的）和調整列不算；售價 0 的（員工餐、贈送）不算份數。
 * - mix：品名 → 份數，給實際銷售組合加權用。
 */
export function posWindow(lines = [], { from, to, start = '11:30', end = '14:00', keywords = '', dishes = [] } = {}) {
  const s = toMin(start);
  const e = toMin(end);
  const cats = splitKeys(keywords);
  const norm = (v) => String(v || '').replace(/\s+/g, '').toLowerCase();
  const names = new Map(dishes.filter(Boolean).map((d) => [norm(d), d]));
  const byDate = new Map();
  const mix = new Map();
  for (const l of lines) {
    if (!l.date || (from && l.date < from) || (to && l.date > to) || l.is_adjustment || l.void_reason) continue;
    let d = byDate.get(l.date);
    if (!d) byDate.set(l.date, (d = { date: l.date, revenue: 0, windowRevenue: 0, windowOrders: new Set(), brunchQty: 0, brunchRevenue: 0 }));
    d.revenue += n(l.revenue);
    const t = toMin(l.time);
    if (t === null || t < s || t >= e) continue;
    d.windowRevenue += n(l.revenue);
    d.windowOrders.add(l.order_no || `${l.date} ${l.time}`);
    const dish = names.get(norm(l.item_raw));
    const cat = String(l.category_raw || '').toLowerCase();
    if (n(l.revenue) > 0 && (dish || cats.some((k) => cat.includes(k)))) {
      const q = n(l.qty, 1);
      d.brunchQty += q;
      d.brunchRevenue += n(l.revenue);
      if (dish) mix.set(dish, (mix.get(dish) || 0) + q);
    }
  }
  const days = [...byDate.values()]
    .map((d) => ({ ...d, revenue: round2(d.revenue), windowRevenue: round2(d.windowRevenue), windowOrders: d.windowOrders.size, brunchRevenue: round2(d.brunchRevenue) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return Object.assign(days, { mix });
}

// ─────────── 推出進度表

export const OWNERS = ['老闆', '店長', '員工', 'Claude'];

// 範本：day 是距離開始日第幾天；推出日固定在最後一天（launch）。店長管配方、備料、驗收；老闆管定價與推不推；Claude 協助
export const TASK_TEMPLATE = [
  { day: 0, owner: '老闆', title: '定案菜色與暫定價格', done: '「菜單與成本」有菜名＋暫定價' },
  { day: 0, owner: '老闆', title: '確認設備：有沒有爐火、烤箱一次烤幾份', done: '寫在備註；只有烤箱就照「卡關怎麼辦」第 1 條' },
  { day: 0, owner: '老闆', title: '食品安全：食品業者登錄、產品責任險有包含現場餐點', done: '兩項都確認；沒有就先辦，不推出' },
  { day: 1, owner: '店長', title: '叫貨：試做用的原料（只叫試做量）', done: '進貨紀錄有登打' },
  { day: 1, owner: '店長', title: '試做第 1 輪（開店前）：每道 2 份、計時、拍照', done: '每道出餐分鐘數＋照片' },
  { day: 2, owner: '店長', title: '每道一張標準配方卡：克數、烤溫與時間、保存期限、生熟分開、每日備料上限', done: '配方卡貼在備料區' },
  { day: 2, owner: 'Claude', title: '協助：用進貨紀錄算實際成本、建議定價', done: '每道成本率都有數字，目標 ≤ 35%' },
  { day: 3, owner: '老闆', title: '定價定案', done: '價格不再改' },
  { day: 3, owner: 'Claude', title: '協助：菜單卡、桌卡草稿（品名、價格、過敏原、一題問卷）', done: '印刷檔給老闆看' },
  { day: 4, owner: '店長', title: 'POS 加「早午餐」品類與品項（先設停售）', done: 'POS 點得到、出單正確' },
  { day: 4, owner: '店長', title: '開店前壓力測試：3 份餐＋3 杯飲料同時下單', done: '最慢一份 ≤ 12 分；超過就照「卡關怎麼辦」' },
  { day: 5, owner: '老闆', title: '排首週人手：試賣時段多一人支援', done: '班表上看得到；多排的時數記進每日紀錄' },
  { day: 6, owner: '店長', title: '開店前員工訓練＋最終演練：照配方卡做一次、過敏原問答、POS 備註（新客／加點／換點）、冰箱溫度紀錄', done: '每位員工自己做過一次並通過' },
  { day: 6, owner: '老闆', title: '開店前檢查點：照原計畫推出／減為兩道／延期', done: '決定寫在備註' },
  { day: 6, owner: '店長', title: '補齊首週原料、印好菜單卡與桌卡', done: '進貨紀錄有登打、菜單卡擺好' },
  { day: 'launch', owner: '老闆', title: '推出：開賣前把菜單放上 Google 商家檔案、發一則社群', done: '第一份出餐' },
  { day: 'launch', owner: '員工', title: '收班 1 分鐘：份數、新客／加點／換點、報廢、最慢出餐、天氣（沒賣也記 0）', done: '「測試紀錄」有今天' },
];

export const BLOCKERS = [
  { when: '只有烤箱、一次只能烤 2 份', then: '先賣 2 道（一道不用烤的，例如優格杯），最後點餐提早 30 分鐘。' },
  { when: '沒有爐火，不能煮蛋', then: '蛋改成收班前煮好的全熟蛋，冷藏 7°C 以下、隔天用完；或拿掉蛋。' },
  { when: '壓力測試超過 12 分鐘', then: '砍一道菜，或試賣時段多排一人；不要臨場決定。' },
  { when: '食品業者登錄或產品責任險沒包含現場餐點', then: '先辦好再推出，不要先賣。' },
  { when: '成本率超過 38%', then: '調價或換配料；不要用打折撐。' },
  { when: '同一週還有別的新品要上（同一位店長、同一台 POS）', then: 'POS 品項一次建好、開賣日至少錯開一天，社群各發各的。' },
  { when: '推出後出餐超過 15 分鐘，或下午的熱門時段變慢', then: '當天就砍一道菜。' },
];

/** 依範本產生進度表：開始日到推出日之間平均攤開，launch 任務放推出日。 */
export function buildSchedule(startDate, launchDate) {
  const span = Math.max(0, daysBetween(startDate, launchDate));
  const lastDay = Math.max(...TASK_TEMPLATE.filter((t) => t.day !== 'launch').map((t) => t.day));
  const scale = lastDay > 0 && span > 0 ? Math.min(1, (span - 1) / lastDay) : 0;
  return TASK_TEMPLATE.map((t, i) => ({
    id: `t${i + 1}`,
    date: t.day === 'launch' ? launchDate : addDays(startDate, Math.round(t.day * scale)),
    owner: t.owner,
    title: t.title,
    done_when: t.done,
    done: false,
    note: '',
  }));
}

export function scheduleStatus(tasks = [], day) {
  const done = tasks.filter((t) => t.done).length;
  const overdue = tasks.filter((t) => !t.done && t.date < day);
  const next = [...tasks].filter((t) => !t.done).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0] || null;
  return { total: tasks.length, done, ratio: tasks.length ? done / tasks.length : 0, overdue, next };
}

// ─────────── 企劃資料

export function emptyPlan() {
  return {
    version: PLAN_VERSION,
    name: '早午餐企劃',
    window: { start: '11:30', end: '14:00', last_order: '13:30' },
    params: { ...DEMO_PARAMS },
    menu: [],
    schedule: [],
    start_date: '',
    launch_date: '',
    test: { from: '', to: '', keywords: '早午餐' },
    swap_ref: { name: '', price: null, cost: null },
    safety_ok: false,
    rules: { ...DEFAULT_RULES },
    log: [],
    notes: '',
  };
}

// 匯入與讀取共用的規則：會被丟掉的（drop）與會被改成空白的（fix）
const badNumber = (v) => !blank(v) && !(Number.isFinite(Number(v)) && Number(v) >= 0);
function menuIssue(d) {
  if (!d || typeof d.name !== 'string' || !d.name.trim()) return { drop: '缺名稱' };
  if (!(Number(d.price) > 0)) return { drop: `價格「${blank(d.price) ? '空白' : d.price}」不對` };
  if (badNumber(d.cost)) return { fix: `成本「${d.cost}」不對，當成沒填` };
  return {};
}
function taskIssue(x) {
  if (!x || typeof x.title !== 'string' || !x.title.trim()) return { drop: '缺事項名稱' };
  if (!isDate(x.date)) return { drop: `日期「${x.date ?? '空白'}」不對` };
  return {};
}
function logIssue(e) {
  if (!e || !isDate(e.date)) return { drop: `日期「${e?.date ?? '空白'}」不對` };
  const bad = LOG_NUMS.filter((k) => badNumber(e[k]));
  return bad.length ? { fix: `${bad.join('、')} 不是 0 以上的數字，當成沒填` } : {};
}

const LOG_NUMS = ['portions', 'new_count', 'addon_count', 'swap_count', 'swap_diff', 'waste', 'extra_hours', 'slowest_min', 'door_groups', 'survey_yes'];
const nonNeg = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
const uniqueIds = (rows, prefix) => {
  const seen = new Set();
  return rows.map((x, i) => {
    let id = typeof x.id === 'string' && x.id ? x.id : `${prefix}${i + 1}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    return { ...x, id };
  });
};

// 讀取（含匯入的企劃檔）時補齊欄位、丟掉壞資料：日期與時間要合法、數字不能是負的、ID 不重複、同一天的紀錄只留最後一筆
export function normalizePlan(raw) {
  const base = emptyPlan();
  if (!raw || typeof raw !== 'object') return base;
  const arr = (v) => (Array.isArray(v) ? v : []);
  const win = raw.window || {};
  const rules = {};
  for (const [k, v] of Object.entries(DEFAULT_RULES)) rules[k] = nonNeg(raw.rules?.[k]) ?? v;
  const log = new Map();
  for (const e of arr(raw.log)) {
    if (!e || !isDate(e.date)) continue;
    const row = { date: e.date, closed: !!e.closed, weather: String(e.weather || ''), event: String(e.event || ''), posted: !!e.posted, note: String(e.note || '') };
    for (const k of LOG_NUMS) row[k] = nonNeg(e[k]);
    log.set(e.date, row);
  }
  return {
    ...base,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 80) : base.name,
    window: { start: isTime(win.start) ? win.start : base.window.start, end: isTime(win.end) ? win.end : base.window.end, last_order: isTime(win.last_order) ? win.last_order : base.window.last_order },
    params: cleanParams({ ...base.params, ...(raw.params || {}) }),
    menu: uniqueIds(
      arr(raw.menu)
        .filter((d) => !menuIssue(d).drop)
        .map((d) => ({ id: d.id, name: d.name.trim(), price: nonNeg(d.price) ?? 0, cost: nonNeg(d.cost), product_id: typeof d.product_id === 'string' ? d.product_id : '', allergens: String(d.allergens || ''), method: String(d.method || ''), phase: d.phase === 2 ? 2 : 1, active: d.active !== false })),
      'd',
    ),
    schedule: uniqueIds(
      arr(raw.schedule)
        .filter((x) => !taskIssue(x).drop)
        .map((t) => ({ id: t.id, date: t.date, owner: String(t.owner || ''), title: t.title.trim(), done_when: String(t.done_when || ''), done: !!t.done, note: String(t.note || '') })),
      't',
    ),
    start_date: isDate(raw.start_date) ? raw.start_date : '',
    launch_date: isDate(raw.launch_date) ? raw.launch_date : '',
    test: { from: isDate(raw.test?.from) ? raw.test.from : '', to: isDate(raw.test?.to) ? raw.test.to : '', keywords: typeof raw.test?.keywords === 'string' ? raw.test.keywords : base.test.keywords },
    swap_ref: { name: String(raw.swap_ref?.name || ''), price: nonNeg(raw.swap_ref?.price), cost: nonNeg(raw.swap_ref?.cost) },
    safety_ok: !!raw.safety_ok,
    rules,
    log: [...log.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

/**
 * 匯入前檢查企劃檔：回傳 errors（不能匯入）與 warnings（會被略過的東西）。
 * 要有 kind 標記；版本比程式新的不收（避免舊程式把新欄位丟掉）。
 */
export function checkPlanFile(data) {
  const errors = [];
  const warnings = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { errors: ['檔案內容不是企劃'], warnings };
  if (data.kind !== PLAN_KIND) errors.push('不是早午餐企劃檔（缺少企劃標記）');
  if (n(data.version, 1) > PLAN_VERSION) errors.push(`企劃檔是較新的版本（${data.version}），請先更新 ERP`);
  const list = (v) => (Array.isArray(v) ? v : []);
  const report = (rows, issue, label) =>
    rows.forEach((x, i) => {
      const r = issue(x);
      if (r.drop) warnings.push(`${label(x, i)}：${r.drop}，會略過`);
      else if (r.fix) warnings.push(`${label(x, i)}：${r.fix}`);
    });
  report(list(data.menu), menuIssue, (d, i) => `菜單第 ${i + 1} 道${d?.name ? `「${d.name}」` : ''}`);
  report(list(data.schedule), taskIssue, (x, i) => `進度表第 ${i + 1} 件${x?.title ? `「${String(x.title).slice(0, 12)}」` : ''}`);
  report(list(data.log), logIssue, (e, i) => `每日紀錄第 ${i + 1} 筆${isDate(e?.date) ? `（${e.date}）` : ''}`);
  const dates = list(data.log).map((e) => e && e.date).filter(isDate);
  if (new Set(dates).size < dates.length) warnings.push('每日紀錄有重複的日期，同一天只留最後一筆');
  for (const k of ['start', 'end', 'last_order']) if (data.window?.[k] && !isTime(data.window[k])) warnings.push(`時段「${data.window[k]}」格式不對，改用預設`);
  if (data.swap_ref && (badNumber(data.swap_ref.price) || badNumber(data.swap_ref.cost))) warnings.push('換點對照的價格或成本不對，當成沒填');  return { errors, warnings };
}

/**
 * 匯入企劃檔：菜單、進度表、參數、測試設定用檔案的。
 * 每日紀錄是現場記的，預設不會被檔案刪掉或蓋掉（同一天兩邊都有時留現有的）；replaceLog 為真才整份換成檔案裡的。
 */
export function mergeImport(current, incoming, { replaceLog = false } = {}) {
  if (replaceLog) return { ...incoming };
  const mine = (current && current.log) || [];
  const have = new Set(mine.map((e) => e.date));
  const log = [...mine, ...(incoming.log || []).filter((e) => !have.has(e.date))].sort((a, b) => (a.date < b.date ? -1 : 1));
  return { ...incoming, log };
}

/** 匯出：template＝企劃範本（不含每日紀錄、內部備註、食品安全勾選），可以分享；full＝完整備份 */
export function exportPlan(plan, { full = false } = {}) {
  const out = { kind: PLAN_KIND, version: PLAN_VERSION, ...plan };
  if (!full) {
    out.log = [];
    out.notes = '';
    out.safety_ok = false;
    out.schedule = out.schedule.map((t) => ({ ...t, done: false, note: '' }));
  }
  return out;
}
