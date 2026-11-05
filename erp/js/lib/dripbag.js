// 濾掛與禮盒企劃：單包成本與毛利、月試算、禮盒組合、試做到開賣的進度表、批次與效期、留樣檢查、POS 銷量對照。
// 這是公開 repo：店家的豆價、售價、包材成本不寫在程式裡，存在 settings 的 dripbag_plan，從「匯入企劃檔」或畫面上填。
// 程式裡的示範數字都是虛構的整數，不對應任何店。

import { addDays, daysBetween } from './dates.js';

export const PLAN_ID = 'dripbag_plan';
export const PLAN_KIND = 'wuyue-erp-dripbag-plan'; // 企劃檔的標記，匯入時用來擋掉別種 JSON
export const PLAN_VERSION = 1;

const n = (v, d = 0) => (v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
const blank = (v) => v === null || v === undefined || v === '';
const nonNeg = (v) => (blank(v) ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
const badNumber = (v) => !blank(v) && !(Number.isFinite(Number(v)) && Number(v) >= 0);
const round2 = (v) => Math.round(v * 100) / 100;
export const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

// ─────────── 成本參數（每包共用）

export const COST_FIELDS = [
  { key: 'grams', label: '每包豆量', unit: 'g', max: 30 },
  { key: 'grind_loss', label: '研磨損耗', unit: '%', max: 50 },
  { key: 'filter', label: '濾袋', unit: '元／個', max: 100 },
  { key: 'outer', label: '外袋', unit: '元／個', max: 100 },
  { key: 'label', label: '標籤', unit: '元／張', max: 100 },
  { key: 'wage', label: '時薪', unit: '元', max: 2000 },
  { key: 'packs_per_hour', label: '一小時包幾包', unit: '包', max: 1000, positive: true },
  { key: 'loss', label: '損耗（試喝、封壞）', unit: '%', max: 50 },
  { key: 'fee', label: '刷卡手續費', unit: '%', max: 10 },
];
export const DEMO_COSTS = { grams: 10, grind_loss: 4, filter: 2, outer: 2, label: 1, wage: 190, packs_per_hour: 30, loss: 10, fee: 2 };

export const MONTH_FIELDS = [
  { key: 'weekday_packs', label: '平日每天', unit: '包', max: 500 },
  { key: 'weekend_packs', label: '週末每天', unit: '包', max: 500 },
  { key: 'days', label: '一個月營業', unit: '天', max: 31 },
  { key: 'five_share', label: '用 5 入袋賣出的比例', unit: '%', max: 100 },
  { key: 'bag_cost', label: '5 入紙袋＋沖泡卡', unit: '元／袋', max: 500 },
  { key: 'first_order', label: '第一次購買（包材、封口機）', unit: '元', max: 1000000 },
];
export const DEMO_MONTH = { weekday_packs: 3, weekend_packs: 10, days: 30, five_share: 20, bag_cost: 10, first_order: 1000 };

export const DEFAULT_RULES = { review_days: 14, target_per_day: 5, stop_per_day: 2, soon_days: 3 };
export const CHECK_DAYS = [0, 14, 30]; // 留樣檢查：第 0、14、30 天

// 沒填或不是 0 以上的數字一律留 null（不偷偷補示範數字）；用到的計算會顯示「資料不足」
const clean = (fields, p = {}) => {
  const out = {};
  for (const f of fields) {
    const v = nonNeg(p?.[f.key]);
    out[f.key] = v === null ? null : Math.min(v, f.max);
  }
  return out;
};
export const cleanCosts = (p) => clean(COST_FIELDS, p);
export const cleanMonth = (p) => clean(MONTH_FIELDS, p);
/** 哪些欄位沒填（回傳欄位名稱） */
export const missingFields = (fields, obj) => fields.filter((f) => obj?.[f.key] === null || obj?.[f.key] === undefined).map((f) => f.label);

// ─────────── 單包成本

/**
 * 一包的成本（未稅）：豆子（每包克數＋研磨損耗）、包材、人工，再把損耗攤進去（÷(1−損耗)），最後加刷卡手續費（照含稅售價算）。
 * beanKg：熟豆每公斤未稅成本；沒有就回傳 null（不要用售價倒推）。
 */
export function packCost(sku, costs, { beanKg } = {}) {
  const c = cleanCosts(costs);
  const kg = beanKg !== undefined && beanKg !== null ? beanKg : nonNeg(sku?.bean_kg);
  if (kg === null || kg === undefined || !(c.packs_per_hour > 0)) return null; // 一小時包 0 包算不出人工，不能當 0 元
  if (missingFields(COST_FIELDS, c).length) return null; // 共用成本有欄位沒填
  const bean = (c.grams * (1 + c.grind_loss / 100) * kg) / 1000;
  const pack = c.filter + c.outer + c.label;
  const labor = c.wage / c.packs_per_hour;
  const base = bean + pack + labor;
  const lossRate = Math.min(c.loss, 90) / 100;
  const noFee = base / (1 - lossRate);
  const fee = (n(sku?.price) * c.fee) / 100;
  return { bean: round2(bean), pack: round2(pack), labor: round2(labor), loss: round2(noFee - base), noFee: round2(noFee), fee: round2(fee), total: round2(noFee + fee) };
}

/** 單包毛利：未稅售價 − 單包成本 */
export function skuMargin(sku, costs, { vatRate = 0.05, beanKg } = {}) {
  const pc = packCost(sku, costs, { beanKg });
  const net = n(sku?.price) / (1 + vatRate);
  if (!pc) return { cost: null, net: round2(net), margin: null, rate: null };
  const margin = net - pc.total;
  return { cost: pc, net: round2(net), margin: round2(margin), rate: net > 0 ? margin / net : null };
}

/** 銷售佔比：只算上架中的；都沒填就平均分 */
export function mixOf(skus = []) {
  const act = skus.filter((s) => s.active !== false);
  const sum = act.reduce((a, s) => a + n(s.mix), 0);
  return new Map(act.map((s) => [s.id, sum > 0 ? n(s.mix) / sum : 1 / act.length]));
}

/**
 * 一個月大概多少（試算，不是預測）：週末天數＝營業天數 × 2/7。
 * 毛利扣掉 5 入袋的紙袋和沖泡卡；沒有算廣告、寄送、滯銷報廢。
 */
export function monthPlan(skus = [], costs, month, { vatRate = 0.05, beanKgOf = () => undefined } = {}) {
  const m = cleanMonth(month);
  const monthMissing = missingFields(MONTH_FIELDS, m);
  for (const f of MONTH_FIELDS) if (m[f.key] === null) m[f.key] = 0;
  const weekendDays = (m.days * 2) / 7;
  const packs = m.weekday_packs * (m.days - weekendDays) + m.weekend_packs * weekendDays;
  const mix = mixOf(skus);
  let revenue = 0;
  let margin = 0;
  const missing = [];
  const rows = [];
  for (const s of skus) {
    if (!mix.has(s.id)) continue;
    const q = packs * mix.get(s.id);
    const r = skuMargin(s, costs, { vatRate, beanKg: beanKgOf(s) });
    revenue += q * n(s.price);
    if (r.margin === null) missing.push(s.name);
    else margin += q * r.margin;
    rows.push({ id: s.id, name: s.name, packs: round2(q), margin: r.margin === null ? null : round2(q * r.margin) });
  }
  const bags = ((packs * m.five_share) / 100 / 5) * m.bag_cost;
  // 有品項算不出成本時不給毛利和回本（不能把缺的成本當 0）
  const ok = !missing.length && !monthMissing.length && rows.length > 0;
  const profit = ok ? margin - bags : null;
  const perPack = ok && packs > 0 ? profit / packs : null;
  return {
    packs: round2(packs),
    revenue: round2(revenue),
    avgPrice: packs > 0 ? round2(revenue / packs) : 0,
    bags: round2(bags),
    profit: profit === null ? null : round2(profit),
    perPack: perPack === null ? null : round2(perPack),
    breakeven: perPack > 0 ? Math.ceil(m.first_order / perPack) : null,
    limited: skus.filter((s) => mix.has(s.id) && n(s.weekly_limit) > 0).map((s) => s.name),
    monthMissing,
    rows,
    missing,
  };
}

// ─────────── 禮盒

/**
 * 禮盒成本：內容物（每包用不含手續費的單包成本）、其他物品（束口袋、卡片、杯子…）、組裝人工、刷卡手續費（照禮盒售價）。
 * 直接貢獻率＝（未稅售價 − 成本）÷ 未稅售價；沒算廣告和寄送。
 */
export function giftCost(gift, skus = [], costs, { vatRate = 0.05, beanKgOf = () => undefined } = {}) {
  const c = cleanCosts(costs);
  const costMissing = missingFields(COST_FIELDS, c).length > 0;
  const byId = new Map(skus.map((s) => [s.id, s]));
  let contents = 0;
  let packs = 0;
  const missing = [];
  for (const it of gift?.items || []) {
    const q = n(it.qty);
    if (q <= 0) continue;
    const s = byId.get(it.sku_id);
    const pc = s ? packCost(s, c, { beanKg: beanKgOf(s) }) : null;
    packs += q;
    if (!pc) missing.push(s ? s.name : '已刪除的品項');
    else contents += q * pc.noFee;
  }
  const extras = (gift?.extras || []).reduce((a, x) => a + n(x.cost), 0);
  const labor = (n(gift?.minutes) / 60) * n(c.wage);
  const fee = (n(gift?.price) * n(c.fee)) / 100;
  const total = contents + extras + labor + fee;
  const net = n(gift?.price) / (1 + vatRate);
  if (costMissing && !missing.includes('共用成本')) missing.push('共用成本');
  const ok = !missing.length; // 缺內容物成本就不下結論
  return { packs, contents: round2(contents), extras: round2(extras), labor: round2(labor), fee: round2(fee), total: ok ? round2(total) : null, net: round2(net), profit: ok ? round2(net - total) : null, rate: ok && net > 0 ? (net - total) / net : null, missing };
}

// ─────────── 批次與效期

/** 有效日期＝製造日＋這批的天數（建批次時記下，之後改效期設定不會動到已經印出去的標籤） */
export const expiryOf = (b) => (isDate(b?.date) ? addDays(b.date, n(b.shelf_days)) : '');

export function batchStatus(b, day, { soonDays = DEFAULT_RULES.soon_days } = {}) {
  const exp = expiryOf(b);
  if (!exp) return { kind: 'na', left: null, expiry: '' };
  const left = daysBetween(day, exp);
  return { kind: left < 0 ? 'expired' : left <= soonDays ? 'soon' : 'ok', left, expiry: exp };
}

/** 留樣檢查清單：有留樣的批次，第 0／14／30 天各一次 */
export function sampleChecks(batches = [], day) {
  const out = [];
  for (const b of batches) {
    if (!(n(b.retained) > 0) || !isDate(b.date)) continue;
    for (const d of CHECK_DAYS) {
      const rec = (b.checks || []).find((c) => c.day === d && (c.result === 'pass' || c.result === 'fail')) || null;
      const due = addDays(b.date, d);
      out.push({ batch_id: b.id, code: b.code, day: d, due, rec, overdue: !rec && due < day });
    }
  }
  return out.sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}

/**
 * 效期能不能延長：有一批封口抽驗合格、有留樣，第 0／14／30 天都照時間檢查（檢查日 ≥ 製造日＋天數，而且不晚於今天）、
 * 全部合格、沒有任何一次不合格，而且外袋阻隔規格書已拿到。提前填的不算。
 */
export function canExtend(plan, day = '') {
  const passed = (plan.batches || []).some((b) => {
    if (!(n(b.retained) > 0) || !isDate(b.date) || b.qc !== 'pass') return false;
    const checks = b.checks || [];
    if (checks.some((c) => c.result === 'fail')) return false;
    return CHECK_DAYS.every((d) => checks.some((c) => c.day === d && c.result === 'pass' && isDate(c.date) && c.date >= addDays(b.date, d) && (!day || c.date <= day)));
  });
  return { ok: passed && !!plan.shelf?.spec_ok, passed, spec: !!plan.shelf?.spec_ok };
}

/** 新批次用的有效天數：延長過（而且證據還在）用延長後的，否則用一開始的天數 */
export const shelfDays = (plan, day = '') => (plan.shelf?.extended && canExtend(plan, day).ok ? plan.shelf.extended_days : plan.shelf?.days);

/** 留樣檢查能不能這樣記：結果要選、檢查日不能早於應檢日、不能是未來 */
export function checkEntryProblem(batch, entry, day) {
  if (!['pass', 'fail'].includes(entry.result)) return '請選結果（合格或不合格）';
  if (!isDate(entry.date)) return '請選檢查日';
  const due = addDays(batch.date, entry.day);
  if (entry.date < due) return `第 ${entry.day} 天的檢查要在 ${due} 以後才能記`;
  if (day && entry.date > day) return '檢查日不能是未來';
  return '';
}

/** 新批號：YYMMDD-流水號（同一天第幾批） */
export function nextBatchCode(batches = [], date) {
  const p = isDate(date) ? date.slice(2).replace(/-/g, '') : 'X';
  const used = new Set(batches.map((b) => b.code));
  let i = 1;
  while (used.has(`${p}-${i}`)) i++;
  return `${p}-${i}`;
}

/** 禮盒放的各款：一款只放一批，有效日期取這幾批裡最早的 */
export function earliestExpiry(batches = [], ids = []) {
  const exps = ids.map((id) => expiryOf(batches.find((b) => b.id === id))).filter(Boolean).sort();
  return exps[0] || '';
}

// ─────────── POS 銷量對照

const splitKeys = (s) =>
  String(s || '')
    .split(/[,，、\n]/)
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);

/**
 * 每天賣出幾包（品名或品類含關鍵字）、有買濾掛的單數 ÷ 全部單數（附購率）。
 * 作廢、招待、測試、調整列不算；售價 0 的不算包數。5 入在 POS 打 5 個單包，所以照數量算。
 */
export function posDrip(lines = [], { from, to, keywords = '濾掛' } = {}) {
  const keys = splitKeys(keywords);
  const byDate = new Map();
  for (const l of lines) {
    if (!l.date || (from && l.date < from) || (to && l.date > to) || l.is_adjustment || l.void_reason) continue;
    let d = byDate.get(l.date);
    if (!d) byDate.set(l.date, (d = { date: l.date, packs: 0, revenue: 0, orders: new Set(), dripOrders: new Set() }));
    const ord = l.order_no || `${l.date} ${l.time || ''}`;
    d.orders.add(ord);
    const text = `${l.item_raw || ''} ${l.category_raw || ''}`.toLowerCase();
    if (keys.length && n(l.revenue) > 0 && n(l.qty, 1) > 0 && keys.some((k) => text.includes(k))) {
      d.packs += n(l.qty, 1);
      d.revenue += n(l.revenue);
      d.dripOrders.add(ord);
    }
  }
  return [...byDate.values()]
    .map((d) => ({ date: d.date, packs: d.packs, revenue: round2(d.revenue), orders: d.orders.size, dripOrders: d.dripOrders.size, attach: d.orders.size ? d.dripOrders.size / d.orders.size : 0 }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * 開賣後的判斷：前 review_days 天（含沒營業、沒賣的日子都算進天數）過完才下結論。
 * 平均每天 ≥ target：過關；< stop：不擴大、只留主力單包；中間：調整（陳列、話術、品項）。
 */
export function salesVerdict(days = [], { launch, today: day, rules = DEFAULT_RULES } = {}) {
  if (!isDate(launch)) return { verdict: 'pending', avg: null, elapsed: 0 };
  const end = addDays(launch, rules.review_days - 1);
  const last = day < end ? day : end;
  const elapsed = last < launch ? 0 : daysBetween(launch, last) + 1;
  const packs = days.filter((d) => d.date >= launch && d.date <= last).reduce((a, d) => a + d.packs, 0);
  const avg = elapsed ? packs / elapsed : null;
  if (!elapsed) return { verdict: 'pending', avg, elapsed };
  if (day < end) return { verdict: 'collecting', avg, elapsed };
  return { verdict: avg >= rules.target_per_day ? 'pass' : avg < rules.stop_per_day ? 'stop' : 'adjust', avg, elapsed };
}

// ─────────── 進度表

export const OWNERS = ['老闆', '店長', '員工', 'Claude'];

// at：以試製日（trial）或開賣日（launch）為基準；off：前後幾天
export const TASK_TEMPLATE = [
  { at: 'trial', off: -5, owner: '老闆', title: '食品業者登錄增列「製造加工」「販售」業別；問產品責任險有沒有涵蓋自製包裝', done: '登錄送出、保險有書面答覆' },
  { at: 'trial', off: -5, owner: '老闆', title: '下單包材：濾袋（要食品接觸檢驗報告）、三層鋁箔外袋、可調時間的封口機、標籤紙、溫濕度計', done: '訂單成立；進貨紀錄有登打' },
  { at: 'trial', off: -4, owner: '店長', title: '研磨刻度：三個刻度各包 3 包，杯測選一個；跟烘豆商要原產地資料', done: '刻度寫進批次備註；原產地資料到手' },
  { at: 'trial', off: -3, owner: '店長', title: '封口測試：調加熱時間，抽驗 10 包（拉、壓、倒放）', done: '封口時間定下來、10 包全部合格' },
  { at: 'trial', off: -2, owner: '店長', title: '試包 20 包並計時；標籤依原產地資料定稿', done: '「一小時包幾包」有實際數字' },
  { at: 'trial', off: 0, owner: '店長', title: '試製批（不販售）：封口抽驗、留樣 3 包、員工試喝', done: '「批次與效期」有這批、留樣第 0 天已記' },
  { at: 'trial', off: 1, owner: '老闆', title: '三個關卡：業者登錄、產品責任險、封口與效期依據都過', done: '三關全過才往下；有效日期訂定紀錄簽名' },
  { at: 'launch', off: -1, owner: '店長', title: '正式標籤、桌卡印好；POS「產品」分類加品項並測試；包第一批販售量', done: '抽驗合格、POS 結帳正確' },
  { at: 'launch', off: 0, owner: '員工', title: '開賣：吧台陳列＋桌卡；結帳時說一句', done: '桌卡上桌、第一包賣出' },
  { at: 'launch', off: 7, owner: 'Claude', title: '第一週回顧：每天賣幾包、附購率、客人反應', done: '「銷售對照」有一週數字；決定要不要調整' },
  { at: 'trial', off: 14, owner: '店長', title: '試製批留樣第 14 天：杯測比對', done: '「留樣檢查」第 14 天已記' },
  { at: 'trial', off: 30, owner: '老闆', title: '試製批留樣第 30 天：重量、結塊、外袋、風味；外袋規格書到手才把效期改長', done: '「留樣檢查」第 30 天已記；效期決定' },
];

export const BLOCKERS = [
  { when: '食品業者登錄或產品責任險沒涵蓋自製包裝', then: '先辦好再賣；試製可以做，但不販售。' },
  { when: '封口抽驗有漏粉、封不住', then: '調加熱時間或換封口機，重新抽驗 10 包；不要先賣。' },
  { when: '留樣第 14 天明顯走味或受潮', then: '有效日期縮短，或改找代工充氮。' },
  { when: '開賣兩週平均每天不到停止線', then: '不再擴大，只留主力單包；禮盒照做。' },
  { when: '「太淡」「受潮」「漏粉」客訴 3 次以上', then: '先停賣，用同一批的留樣比對研磨度、封口和存放。' },
  { when: '同一週還有別的新品要上', then: '開賣日至少錯開一天，社群各發各的。' },
  { when: '禮盒要用的單包', then: '包好就和架上販售的分開放，不算進 POS 剩餘數量；同一個禮盒同一款只放同一批。' },
];

export function buildSchedule(trialDate, launchDate) {
  if (!isDate(trialDate) || !isDate(launchDate)) return [];
  return TASK_TEMPLATE.map((t, i) => ({
    id: `t${i + 1}`,
    date: addDays(t.at === 'launch' ? launchDate : trialDate, t.off),
    owner: t.owner,
    title: t.title,
    done_when: t.done,
    done: false,
    note: '',
  })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
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
    name: '濾掛與禮盒企劃',
    costs: { ...DEMO_COSTS },
    month: { ...DEMO_MONTH },
    skus: [],
    gifts: [],
    schedule: [],
    trial_date: '',
    launch_date: '',
    shelf: { days: 14, extended_days: 30, extended: false, spec_ok: false },
    batches: [],
    keywords: '濾掛',
    rules: { ...DEFAULT_RULES },
    notes: '',
  };
}

// 匯入與讀取共用的規則：drop＝整筆略過，fix＝欄位當成沒填
function skuIssue(s) {
  if (!s || typeof s.name !== 'string' || !s.name.trim()) return { drop: '缺名稱' };
  if (!(Number(s.price) > 0)) return { drop: `售價「${blank(s.price) ? '空白' : s.price}」不對` };
  if (badNumber(s.bean_kg)) return { fix: `熟豆成本「${s.bean_kg}」不對，當成沒填` };
  if (badNumber(s.mix)) return { fix: `銷售佔比「${s.mix}」不對，當成 0` };
  return {};
}
function giftIssue(g) {
  if (!g || typeof g.name !== 'string' || !g.name.trim()) return { drop: '缺名稱' };
  if (!(Number(g.price) > 0)) return { drop: `售價「${blank(g.price) ? '空白' : g.price}」不對` };
  const badItem = (g.items || []).some((it) => badNumber(it?.qty));
  const badExtra = (g.extras || []).some((x) => badNumber(x?.cost));
  if (badItem || badExtra) return { fix: '有數量或成本不是 0 以上的數字，當成 0' };
  return {};
}
function taskIssue(x) {
  if (!x || typeof x.title !== 'string' || !x.title.trim()) return { drop: '缺事項名稱' };
  if (!isDate(x.date)) return { drop: `日期「${x.date ?? '空白'}」不對` };
  return {};
}
function batchIssue(b) {
  if (!b || !isDate(b.date)) return { drop: `製造日「${b?.date ?? '空白'}」不對` };
  if (!(Number(b.packs) > 0)) return { drop: `包數「${blank(b?.packs) ? '空白' : b.packs}」不對` };
  if (!(Number(b.shelf_days) > 0)) return { drop: `效期天數「${blank(b?.shelf_days) ? '空白' : b.shelf_days}」不對` };
  return {};
}

const uniqueIds = (rows, prefix) => {
  const seen = new Set();
  return rows.map((x, i) => {
    let id = typeof x.id === 'string' && x.id ? x.id : `${prefix}${i + 1}`;
    while (seen.has(id)) id = `${id}_${i + 1}`;
    seen.add(id);
    return { ...x, id };
  });
};
const arr = (v) => (Array.isArray(v) ? v : []);
const str = (v, max = 400) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const CODE_MAX = 30;
export const canonCode = (v) => str(v, CODE_MAX);
const RESULTS = ['', 'pass', 'fail'];

function cleanChecks(list) {
  const by = new Map();
  for (const c of arr(list)) {
    if (!c || !CHECK_DAYS.includes(Number(c.day)) || !['pass', 'fail'].includes(c.result)) continue; // 沒有結果的不算有記
    by.set(Number(c.day), { day: Number(c.day), date: isDate(c.date) ? c.date : '', result: RESULTS.includes(c.result) ? c.result : '', note: str(c.note) });
  }
  return [...by.values()].sort((a, b) => a.day - b.day);
}

/** 讀取（含匯入）時補齊欄位、丟掉壞資料、ID 不重複；同一批號只留最後一筆 */
export function normalizePlan(raw) {
  const base = emptyPlan();
  if (!raw || typeof raw !== 'object') return base;
  const rules = {};
  for (const [k, v] of Object.entries(DEFAULT_RULES)) rules[k] = nonNeg(raw.rules?.[k]) ?? v;
  rules.review_days = rules.review_days >= 1 ? Math.round(rules.review_days) : DEFAULT_RULES.review_days;
  if (rules.stop_per_day > rules.target_per_day) rules.stop_per_day = rules.target_per_day;
  const skus = uniqueIds(
    arr(raw.skus)
      .filter((s) => !skuIssue(s).drop)
      .map((s) => ({ id: s.id, name: s.name.trim().slice(0, 60), price: nonNeg(s.price) ?? 0, bean_kg: nonNeg(s.bean_kg), mix: nonNeg(s.mix) ?? 0, item_id: typeof s.item_id === 'string' ? s.item_id : '', weekly_limit: nonNeg(s.weekly_limit), note: str(s.note), active: s.active !== false })),
    's',
  );
  const gifts = uniqueIds(
    arr(raw.gifts)
      .filter((g) => !giftIssue(g).drop)
      .map((g) => ({
        id: g.id,
        name: g.name.trim().slice(0, 60),
        price: nonNeg(g.price) ?? 0,
        minutes: nonNeg(g.minutes) ?? 0,
        items: arr(g.items)
          .filter((it) => it && typeof it.sku_id === 'string')
          .map((it) => ({ sku_id: it.sku_id, qty: nonNeg(it.qty) ?? 0 })),
        extras: arr(g.extras)
          .filter((x) => x && typeof x.name === 'string' && x.name.trim())
          .map((x) => ({ name: x.name.trim().slice(0, 60), cost: nonNeg(x.cost) ?? 0 })),
        note: str(g.note),
      })),
    'g',
  );
  const byCode = new Map();
  for (const b of arr(raw.batches)) {
    if (batchIssue(b).drop) continue;
    const row = {
      id: typeof b.id === 'string' && b.id ? b.id : '',
      code: canonCode(b.code) || nextBatchCode([...byCode.values()], b.date),
      date: b.date,
      sku_id: typeof b.sku_id === 'string' ? b.sku_id : '',
      packs: nonNeg(b.packs) ?? 0,
      purpose: ['sale', 'trial', 'gift'].includes(b.purpose) ? b.purpose : 'sale',
      shelf_days: Math.round(nonNeg(b.shelf_days)),
      retained: Math.min(nonNeg(b.retained) ?? 0, nonNeg(b.packs) ?? 0),
      grind: str(b.grind, 60),
      seal: str(b.seal, 60),
      qc: RESULTS.includes(b.qc) ? b.qc : '',
      checks: cleanChecks(b.checks),
      note: str(b.note),
    };
    if (byCode.has(row.code)) {
      // 同一批號（例如資料壞掉）：不要蓋掉前一筆，後面這筆改號保留
      let i = 2;
      while (byCode.has(`${row.code}#${i}`)) i++;
      row.code = `${row.code}#${i}`;
    }
    byCode.set(row.code, row);
  }
  const shelf = raw.shelf || {};
  const batchesOut = uniqueIds([...byCode.values()], 'b').sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const shelfOut = { days: Math.round(nonNeg(shelf.days) || base.shelf.days), extended_days: Math.round(nonNeg(shelf.extended_days) || base.shelf.extended_days), extended: false, spec_ok: !!shelf.spec_ok };
  shelfOut.extended = !!shelf.extended && canExtend({ batches: batchesOut, shelf: shelfOut }).ok; // 沒有證據的延長不收
  return {
    ...base,
    name: str(raw.name, 80) || base.name,
    // 檔案或存檔裡沒有這一組才用示範數字（第一次打開）；有這一組但缺欄位就留空
    costs: raw.costs && typeof raw.costs === 'object' ? cleanCosts(raw.costs) : { ...base.costs },
    month: raw.month && typeof raw.month === 'object' ? cleanMonth(raw.month) : { ...base.month },
    skus,
    gifts,
    schedule: uniqueIds(
      arr(raw.schedule)
        .filter((x) => !taskIssue(x).drop)
        .map((t) => ({ id: t.id, date: t.date, owner: String(t.owner || ''), title: t.title.trim(), done_when: String(t.done_when || ''), done: !!t.done, note: String(t.note || '') })),
      't',
    ),
    trial_date: isDate(raw.trial_date) ? raw.trial_date : '',
    launch_date: isDate(raw.launch_date) ? raw.launch_date : '',
    shelf: shelfOut,
    batches: batchesOut,
    keywords: typeof raw.keywords === 'string' ? raw.keywords : base.keywords,
    rules,
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

/** 匯入前檢查：errors（不能匯入）與 warnings（會被略過或當成沒填的） */
export function checkPlanFile(data) {
  const errors = [];
  const warnings = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { errors: ['檔案內容不是企劃'], warnings };
  if (data.kind !== PLAN_KIND) errors.push('不是濾掛企劃檔（缺少企劃標記）');
  if (n(data.version, 1) > PLAN_VERSION) errors.push(`企劃檔是較新的版本（${data.version}），請先更新 ERP`);
  const report = (rows, issue, label) =>
    arr(rows).forEach((x, i) => {
      const r = issue(x);
      if (r.drop) warnings.push(`${label(x, i)}：${r.drop}，會略過`);
      else if (r.fix) warnings.push(`${label(x, i)}：${r.fix}`);
    });
  report(data.skus, skuIssue, (s, i) => `品項第 ${i + 1} 個${s?.name ? `「${s.name}」` : ''}`);
  report(data.gifts, giftIssue, (g, i) => `禮盒第 ${i + 1} 個${g?.name ? `「${g.name}」` : ''}`);
  report(data.schedule, taskIssue, (x, i) => `進度表第 ${i + 1} 件${x?.title ? `「${String(x.title).slice(0, 12)}」` : ''}`);
  report(data.batches, batchIssue, (b, i) => `批次第 ${i + 1} 筆${b?.code ? `（${b.code}）` : ''}`);
  const skuIds = new Set(arr(data.skus).map((s) => s?.id));
  arr(data.gifts).forEach((g) => arr(g?.items).forEach((it) => it && !skuIds.has(it.sku_id) && warnings.push(`禮盒「${g?.name || ''}」放了找不到的品項（${it.sku_id}），成本會缺`)));
  for (const k of ['trial_date', 'launch_date']) if (data[k] && !isDate(data[k])) warnings.push(`${k === 'trial_date' ? '試製日' : '開賣日'}「${data[k]}」格式不對，當成沒填`);
  const codes = arr(data.batches).map((b) => b && canonCode(b.code)).filter(Boolean);
  const dup = [...new Set(codes.filter((c, i) => codes.indexOf(c) !== i))];
  if (dup.length) errors.push(`批號重複：${dup.join('、')}，請先在檔案裡改成不同批號`);
  arr(data.batches).forEach((b) => b && Number(b.retained) > Number(b.packs) && warnings.push(`批次${b.code ? `（${b.code}）` : ''}留樣比包數多，會改成等於包數`));
  for (const [grp, fields, label] of [['costs', COST_FIELDS, '共用成本'], ['month', MONTH_FIELDS, '月試算']]) {
    for (const f of fields) {
      const v = data[grp]?.[f.key];
      if (v === undefined) warnings.push(`${label}「${f.label}」沒有填，會留空，成本與毛利先不算`);
      else if (blank(v) || badNumber(v)) warnings.push(`${label}「${f.label}」是「${v ?? '空白'}」，不是 0 以上的數字，會留空，成本與毛利先不算`);
      else if (Number(v) > f.max) warnings.push(`${label}「${f.label}」超過上限 ${f.max}，會改成 ${f.max}`);
      else if (f.positive && !(Number(v) > 0)) warnings.push(`${label}「${f.label}」是 0，成本會算不出來`);
    }
  }
  if (data.shelf?.extended && !normalizePlan(data).shelf.extended) warnings.push('檔案說效期已延長，但沒有留樣第 30 天合格或規格書的紀錄，會改回一開始的天數');
  return { errors, warnings };
}

/**
 * 匯入企劃檔：品項、禮盒、進度表、成本參數用檔案的。
 * 批次與留樣紀錄是現場記的，預設不會被檔案刪掉或蓋掉（同一批號兩邊都有時留現有的）；replaceBatches 為真才整份換成檔案裡的。
 */
export function mergeImport(current, incoming, { replaceBatches = false } = {}) {
  if (replaceBatches) return { ...incoming };
  const mine = (current && current.batches) || [];
  const have = new Set(mine.map((b) => b.code));
  const ids = new Set(mine.map((b) => b.id));
  const add = (incoming.batches || []).filter((b) => !have.has(b.code)).map((b) => (ids.has(b.id) ? { ...b, id: `${b.id}_i` } : b));
  return { ...incoming, batches: [...mine, ...add].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) };
}

/** 匯出：企劃（不含批次、備註、勾選）可以分享；full＝完整備份 */
export function exportPlan(plan, { full = false } = {}) {
  const out = { kind: PLAN_KIND, version: PLAN_VERSION, ...plan };
  if (!full) {
    out.batches = [];
    out.notes = '';
    out.shelf = { ...out.shelf, spec_ok: false };
    out.schedule = out.schedule.map((t) => ({ ...t, done: false, note: '' }));
  }
  return out;
}

/** 熟豆每公斤成本：連到原物料就用平均進價（單位要是 g 或 kg），沒連用手填 */
export function beanKgFrom(item, avgPerUnit) {
  if (!item || !(avgPerUnit > 0)) return null;
  const u = String(item.unit || '').trim().toLowerCase();
  if (u === 'g' || u === '克' || u === '公克') return avgPerUnit * 1000;
  if (u === 'kg' || u === '公斤') return avgPerUnit;
  return null;
}
