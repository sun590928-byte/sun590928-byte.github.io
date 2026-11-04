// 早午餐企劃：新時段加賣的損益試算、菜單成本、測試期每日紀錄與判斷、推出進度表。
// 只有計算。店家的實際數字（價格、成本、營收）存在使用者資料（settings 的 brunch_plan），這裡只放通用示範值。

import { addDays, daysBetween, weekdayIndex } from './dates.js';
import { round2 } from './money.js';

export const PLAN_ID = 'brunch_plan';

// 試算參數：拉桿的範圍與說明
export const SIM_FIELDS = [
  { key: 'people', label: '每天多出來的客人', unit: '人', min: 0, max: 40, step: 1, hint: '只算「因為這個時段才多來」的人；原本就會來、只是改點的不算' },
  { key: 'ticket', label: '每人客單（含稅）', unit: '元', min: 100, max: 800, step: 10, hint: '餐點＋飲料' },
  { key: 'cost', label: '食材成本率（成本 ÷ 含稅售價）', unit: '%', min: 10, max: 60, step: 1, hint: '有配方就看「菜單與成本」算出來的數字' },
  { key: 'fee', label: '金流手續費（平均）', unit: '%', min: 0, max: 4, step: 0.1, hint: '有人付現金，平均會比刷卡費低' },
  { key: 'hours', label: '多排的人力', unit: '小時／天', min: 0, max: 10, step: 0.25, hint: '提早開門、備料多花的時間' },
  { key: 'wage', label: '時薪（含勞健保、勞退）', unit: '元', min: 150, max: 400, step: 2, hint: '用實際薪資' },
  { key: 'waste', label: '報廢＋耗材', unit: '元／天', min: 0, max: 800, step: 10, hint: '賣不完的備料、外帶盒、紙巾' },
  { key: 'util', label: '多出來的水電', unit: '元／天', min: 0, max: 400, step: 10, hint: '提早開燈、冷氣、烤箱' },
  { key: 'lost', label: '縮短營業少掉的營收（含稅）', unit: '元／天', min: 0, max: 3000, step: 50, hint: '把晚上的時數搬到早上時，晚上少賺的' },
  { key: 'days', label: '每月天數', unit: '天', min: 1, max: 31, step: 1, hint: '只做週末約 8–9 天；每天做約 26–30 天' },
];

// 通用示範值：不是任何店的真實數字
export const DEMO_PARAMS = { people: 5, ticket: 300, cost: 32, fee: 1, hours: 0.25, wage: 230, waste: 120, util: 40, lost: 0, days: 26 };

export const SCENARIOS = [
  { key: 'A', label: 'A 營業時間不變，只加餐點', params: { people: 4, ticket: 300, cost: 32, fee: 1, hours: 0.25, wage: 230, waste: 150, util: 30, lost: 0, days: 26 } },
  { key: 'B', label: 'B 週末提早開，晚上照舊', params: { people: 6, ticket: 320, cost: 32, fee: 1, hours: 1.75, wage: 230, waste: 120, util: 80, lost: 0, days: 8 } },
  { key: 'C', label: 'C 週末提早開，也提早打烊', params: { people: 6, ticket: 320, cost: 32, fee: 1, hours: 0.25, wage: 230, waste: 120, util: 80, lost: 300, days: 8 } },
  { key: 'D', label: 'D 平日也提早開', params: { people: 3, ticket: 300, cost: 32, fee: 1, hours: 1.75, wage: 230, waste: 120, util: 80, lost: 0, days: 18 } },
];

export const DEFAULT_RULES = { stop_portions: 3, adjust_portions: 5, target_serve_min: 12, max_serve_min: 15, waste_rate: 0.15 };

const n = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function cleanParams(p = {}) {
  const out = {};
  for (const f of SIM_FIELDS) out[f.key] = Math.min(f.max, Math.max(f.min, n(p[f.key], DEMO_PARAMS[f.key])));
  return out;
}

/**
 * 每天多賺多少：營收先扣營業稅（含稅 ÷ 1＋稅率），再扣食材、金流、人力、報廢耗材、水電，以及縮短營業少掉的毛利。
 * 食材成本率是「成本 ÷ 含稅售價」，跟菜單表的算法一致。
 */
export function simulate(params, { vatRate = 0.05 } = {}) {
  const p = cleanParams(params);
  const rev = p.people * p.ticket;
  const net = rev / (1 + vatRate);
  const tax = rev - net;
  const food = (rev * p.cost) / 100;
  const fee = (rev * p.fee) / 100;
  const labor = p.hours * p.wage;
  const lostMargin = p.lost / (1 + vatRate) - (p.lost * p.cost) / 100 - (p.lost * p.fee) / 100;
  const other = p.waste + p.util + lostMargin + fee;
  const profit = net - food - labor - other;
  // 打平線：每位客人的毛利要蓋過固定支出（人力、報廢耗材、水電、少掉的毛利）
  const perGuest = p.ticket / (1 + vatRate) - (p.ticket * p.cost) / 100 - (p.ticket * p.fee) / 100;
  const fixed = labor + p.waste + p.util + lostMargin;
  const breakEven = perGuest > 0 ? Math.max(0, Math.ceil(fixed / perGuest - 1e-9)) : null;
  return {
    params: p,
    revenue: round2(rev),
    net: round2(net),
    tax: round2(tax),
    food: round2(food),
    fee: round2(fee),
    labor: round2(labor),
    wasteUtil: round2(p.waste + p.util),
    lostMargin: round2(lostMargin),
    profit: round2(profit),
    month: round2(profit * p.days),
    perGuest: round2(perGuest),
    fixed: round2(fixed),
    breakEven,
  };
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

// 菜單平均：售價、成本率、每份毛利（扣稅、食材、金流）
export function menuSummary(menu = [], { vatRate = 0.05, feePct = 1, recipeCostOf } = {}) {
  const rows = menu.filter((d) => d.active !== false).map((d) => ({ dish: d, ...dishCost(d, recipeCostOf) }));
  const priced = rows.filter((r) => r.price > 0);
  const costed = priced.filter((r) => r.cost !== null);
  const avgPrice = priced.length ? priced.reduce((t, r) => t + r.price, 0) / priced.length : 0;
  const avgRate = costed.length ? costed.reduce((t, r) => t + r.rate, 0) / costed.length : null;
  const margin = avgPrice > 0 && avgRate !== null ? avgPrice / (1 + vatRate) - avgPrice * avgRate - (avgPrice * feePct) / 100 : null;
  return { rows, count: rows.length, avgPrice: round2(avgPrice), avgRate, margin: margin === null ? null : round2(margin), missingCost: priced.length - costed.length };
}

// ─────────── 測試期每日紀錄

export const isWeekend = (ymd) => weekdayIndex(ymd) >= 5;

/**
 * 一天多賺多少（主指標）：
 * - 新客點的、原本的客人多加點的：整份毛利都算；
 * - 原本的客人把別的品項換成早午餐：只算差價的毛利；
 * - 再扣報廢和多排的人力。
 */
export function dayResult(entry, { dishMargin, costRate = 0.32, feePct = 1, wage = 230, vatRate = 0.05 } = {}) {
  const whole = n(entry.new_count) + n(entry.addon_count);
  const diffMargin = n(entry.swap_diff) / (1 + vatRate) - n(entry.swap_diff) * costRate - (n(entry.swap_diff) * feePct) / 100;
  const profit = whole * n(dishMargin) + diffMargin - n(entry.waste) - n(entry.extra_hours) * wage;
  return { profit: round2(profit), whole, portions: n(entry.portions), slow: n(entry.slowest_min) };
}

/**
 * 測試判斷（照企劃：主指標優先，份數只用來決定要調什麼）
 * - 平均每天多賺 > 0 → 過關
 * - ≤ 0、週末平均 ≥ stop_portions 份 → 換品項、立牌，再跑 2 週
 * - ≤ 0、週末平均 < stop_portions 份 → 停
 * 天數不夠（週末少於 2 天）時先不下結論。
 */
export function testVerdict(entries = [], ctx = {}, rules = DEFAULT_RULES) {
  const r = { ...DEFAULT_RULES, ...rules };
  const days = entries.filter((e) => e && e.date).map((e) => ({ ...e, ...dayResult(e, ctx), weekend: isWeekend(e.date) }));
  const avg = (arr, k) => (arr.length ? arr.reduce((t, x) => t + x[k], 0) / arr.length : null);
  const weekends = days.filter((d) => d.weekend);
  const avgProfit = avg(days, 'profit');
  const weekendPortions = avg(weekends, 'portions');
  const slowDays = days.filter((d) => d.slow > r.max_serve_min).length;
  let verdict = 'pending';
  let reason = '紀錄還不夠：至少要 2 個週末日才判斷。';
  if (weekends.length >= 2) {
    if (avgProfit > 0) {
      verdict = 'pass';
      reason = '平均每天多賺大於 0：過關，留下來。份數少的日子可以不賣。';
    } else if (weekendPortions >= r.stop_portions) {
      verdict = 'adjust';
      reason = `沒有多賺，但週末平均有 ${round2(weekendPortions)} 份：換品項、放門口立牌，再跑 2 週。`;
    } else {
      verdict = 'stop';
      reason = `沒有多賺，週末平均不到 ${r.stop_portions} 份：停，品項收掉。`;
    }
  }
  return {
    days,
    count: days.length,
    weekendCount: weekends.length,
    avgProfit: avgProfit === null ? null : round2(avgProfit),
    totalProfit: round2(days.reduce((t, d) => t + d.profit, 0)),
    weekendPortions: weekendPortions === null ? null : round2(weekendPortions),
    weekdayPortions: avg(days.filter((d) => !d.weekend), 'portions'),
    slowDays,
    verdict,
    reason,
    doorGroups: days.reduce((t, d) => t + n(d.door_groups), 0),
    surveyYes: days.reduce((t, d) => t + n(d.survey_yes), 0),
  };
}

// ─────────── POS 銷售明細對照

const toMin = (t) => {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

function matcher(keywords) {
  const keys = String(keywords || '')
    .split(/[,，、\n]/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  return (l) => keys.length > 0 && keys.some((k) => `${l.item_raw || ''} ${l.category_raw || ''} ${l.option_raw || ''}`.toLowerCase().includes(k));
}

/**
 * 每天在試賣時段（例如 11:30–13:30）的 POS 營收、訂單數，以及符合關鍵字（早午餐品名或品類）的份數。
 * 作廢、招待、報廢、調整列不算營收。
 */
export function posWindow(lines = [], { from, to, start = '11:30', end = '13:30', keywords = '' } = {}) {
  const s = toMin(start);
  const e = toMin(end);
  const hit = matcher(keywords);
  const byDate = new Map();
  for (const l of lines) {
    if (!l.date || (from && l.date < from) || (to && l.date > to) || l.is_adjustment) continue;
    const t = toMin(l.time);
    let d = byDate.get(l.date);
    if (!d) byDate.set(l.date, (d = { date: l.date, revenue: 0, windowRevenue: 0, windowOrders: new Set(), brunchQty: 0, brunchRevenue: 0 }));
    if (l.void_reason) continue;
    d.revenue += n(l.revenue);
    const inWin = t !== null && t >= s && t < e;
    if (inWin) {
      d.windowRevenue += n(l.revenue);
      d.windowOrders.add(l.order_no || `${l.date} ${l.time}`);
    }
    if (hit(l)) {
      d.brunchQty += n(l.qty, 1);
      d.brunchRevenue += n(l.revenue);
    }
  }
  return [...byDate.values()]
    .map((d) => ({ ...d, revenue: round2(d.revenue), windowRevenue: round2(d.windowRevenue), windowOrders: d.windowOrders.size, brunchRevenue: round2(d.brunchRevenue) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// ─────────── 推出進度表

export const OWNERS = ['老闆', '店長', '員工', 'Claude'];

// 範本：day 是距離開始日第幾天；推出日固定在最後一天（launch）
export const TASK_TEMPLATE = [
  { day: 0, owner: '老闆', title: '定案 3 道菜與暫定價格', done: '企劃頁「菜單與成本」有 3 道菜名＋暫定價' },
  { day: 0, owner: '老闆', title: '確認設備：有沒有爐火、烤箱一次烤幾份', done: '寫在備註；只有烤箱就照「卡關怎麼辦」第 1 條' },
  { day: 0, owner: 'Claude', title: '把企劃參數帶進 ERP、算第一版成本', done: '試算器存成「我的設定」' },
  { day: 1, owner: '店長', title: '叫貨：試做用的原料（只叫試做量）', done: '進貨紀錄有登打' },
  { day: 1, owner: '老闆', title: '試做第 1 輪：每道 2 份、計時、拍照', done: '每道出餐分鐘數＋照片' },
  { day: 2, owner: 'Claude', title: '用進貨紀錄算實際成本，建議定價', done: '每道成本率都有數字，目標 ≤ 35%' },
  { day: 2, owner: '老闆', title: '定價定案', done: '「菜單與成本」價格不再改' },
  { day: 2, owner: '老闆', title: '食品安全：食品業者登錄、產品責任險有包含現場餐點', done: '兩項都確認；沒有就先辦，不推出' },
  { day: 3, owner: 'Claude', title: '菜單卡、桌卡草稿（品名、價格、過敏原、一題問卷）', done: '印刷檔給老闆看' },
  { day: 3, owner: '老闆', title: 'Google 商家檔案菜單加這幾道（營業時間不動）', done: '商家檔案看得到' },
  { day: 4, owner: '店長', title: 'POS 加「早午餐」品類與品項', done: 'POS 點得到、出單正確' },
  { day: 4, owner: '老闆', title: '試做第 2 輪＋壓力測試（3 份餐＋3 杯飲料同時）', done: '最慢一份 ≤ 12 分；超過就照「卡關怎麼辦」' },
  { day: 5, owner: '老闆', title: '員工訓練：備料、出餐步驟、過敏原、POS 備註（新客／加點／換點）', done: '每位員工自己做過一次' },
  { day: 5, owner: '店長', title: '開班加入早午餐備料（約 15 分）', done: '開收班清單有這一項' },
  { day: 6, owner: '員工', title: '內部試賣：員工、熟客試吃，不對外', done: '問題記下來、當天改完' },
  { day: 6, owner: '店長', title: '補齊首週原料', done: '進貨紀錄有登打' },
  { day: 'launch', owner: '老闆', title: '推出：試賣時段供應，最後點餐前 30 分鐘截止', done: '收班時記第一筆每日紀錄' },
  { day: 'launch', owner: '員工', title: '收班 1 分鐘：份數、新客／加點／換點、報廢、最慢出餐、天氣', done: '「測試紀錄」有今天' },
];

export const BLOCKERS = [
  { when: '只有烤箱、一次只能烤 2 份', then: '先賣 2 道（一道不用烤的，例如優格杯），最後點餐提早 30 分鐘。' },
  { when: '沒有爐火，不能煮蛋', then: '蛋改成收班前煮好的全熟蛋，冷藏 7°C 以下、隔天用完；或拿掉蛋。' },
  { when: '壓力測試超過 12 分鐘', then: '砍一道菜，或週末把下午班提早 1 小時；不要臨場決定。' },
  { when: '食品業者登錄或產品責任險沒包含現場餐點', then: '先辦好再推出，不要先賣。' },
  { when: '成本率超過 38%', then: '調價或換配料；不要用打折撐。' },
  { when: 'POS 加品項要改程式', then: '請 Claude 改，當天測完上線。' },
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
    version: 1,
    name: '早午餐企劃',
    window: { start: '11:30', end: '13:30', last_order: '13:00' },
    params: { ...DEMO_PARAMS },
    menu: [],
    schedule: [],
    start_date: '',
    launch_date: '',
    test: { from: '', to: '', keywords: '早午餐' },
    rules: { ...DEFAULT_RULES },
    log: [],
    notes: '',
  };
}

// 讀取（含匯入的企劃檔）時補齊欄位、清掉不認得的型別
export function normalizePlan(raw) {
  const base = emptyPlan();
  if (!raw || typeof raw !== 'object') return base;
  const arr = (v) => (Array.isArray(v) ? v : []);
  return {
    ...base,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : base.name,
    window: { ...base.window, ...(raw.window || {}) },
    params: cleanParams({ ...base.params, ...(raw.params || {}) }),
    menu: arr(raw.menu)
      .filter((d) => d && typeof d.name === 'string')
      .map((d, i) => ({ id: d.id || `d${i + 1}`, name: d.name, price: n(d.price), cost: d.cost === null || d.cost === undefined || d.cost === '' ? null : n(d.cost), product_id: d.product_id || '', allergens: d.allergens || '', method: d.method || '', phase: d.phase || 1, active: d.active !== false })),
    schedule: arr(raw.schedule)
      .filter((t) => t && t.title && /^\d{4}-\d{2}-\d{2}$/.test(t.date || ''))
      .map((t, i) => ({ id: t.id || `t${i + 1}`, date: t.date, owner: t.owner || '', title: t.title, done_when: t.done_when || '', done: !!t.done, note: t.note || '' })),
    start_date: raw.start_date || '',
    launch_date: raw.launch_date || '',
    test: { ...base.test, ...(raw.test || {}) },
    rules: { ...base.rules, ...(raw.rules || {}) },
    log: arr(raw.log).filter((e) => e && /^\d{4}-\d{2}-\d{2}$/.test(e.date || '')),
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}
