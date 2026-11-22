// POS 銷售明細正規化：日期、金額、付款方式、作廢規則（老闆測試／老闆招待／報廢）。
// 規則：命中作廢規則的品項「金額一律作廢」（營收計 0），但保留數量，供原物料耗用與招待成本分析。

import { parseDateTime } from './dates.js';
import { parseAmount, round2 } from './money.js';
import { normalizeText, fnv1a } from './text.js';

export const VOID_REASONS = {
  boss_test: { label: '老闆測試', costAccount: '6128', tone: 'info' },
  boss_treat: { label: '老闆招待', costAccount: '6120', tone: 'info' },
  scrap: { label: '報廢', costAccount: '5105', tone: 'warn' },
  pos_void: { label: 'POS 作廢／取消', costAccount: null, tone: 'mute' },
};

// 預設只抓使用者指定的三種字樣；「測試」「招待」等寬鬆字可在設定頁自行加入
export const DEFAULT_VOID_RULES = [
  { reason: 'boss_test', keywords: ['老闆測試'] },
  { reason: 'boss_treat', keywords: ['老闆招待'] },
  { reason: 'scrap', keywords: ['報廢'] },
  { reason: 'pos_void', keywords: ['作廢', '已作廢', '取消', '已取消', '退貨', '退款', '已退款', 'void', 'voided', 'cancel', 'cancelled', 'canceled', 'refund', 'refunded'], statusOnly: true },
];

export const PAYMENT_TYPES = {
  cash: '現金',
  card: '信用卡（綠界）',
  linepay: 'LINE Pay',
  jkopay: '街口支付',
  taiwanpay: '台灣Pay',
  mobile: '其他行動支付',
  ecard: '電子票證（悠遊卡/一卡通）',
  transfer: '轉帳匯款',
  prepaid: '寄杯／儲值扣抵',
  platform: '外送平台',
  voucher: '禮券',
  unknown: '未指定',
};

const PAY_RULES = [
  ['prepaid', /寄杯|儲值|預付|點數折抵|會員卡扣/],
  ['linepay', /line\s*pay|linepay|連加/i],
  ['jkopay', /街口|jko/i],
  ['platform', /uber|foodpanda|熊貓|外送|panda|你訂|nidin|foodomo/i],
  ['ecard', /悠遊|一卡通|ipass|icash|easycard|電子票證/i],
  ['taiwanpay', /台灣\s*pay|twpay|taiwan\s*pay/i],
  ['mobile', /全支付|pi\s*錢包|pi拍錢包|全盈|apple\s*pay|google\s*pay|samsung\s*pay|行動支付|掃碼/i],
  ['card', /信用卡|刷卡|綠界|ecpay|visa|master|jcb|銀聯|credit|card|聯合信用卡|nccc/i],
  ['transfer', /轉帳|匯款|atm|transfer/i],
  ['voucher', /禮券|禮物卡|gift/i],
  ['cash', /現金|cash|零錢/i],
];

export function normalizePayment(raw) {
  const s = normalizeText(raw);
  if (!s) return 'unknown';
  for (const [k, re] of PAY_RULES) if (re.test(s)) return k;
  return 'unknown';
}

// 品類推測：零售 → 甜點輕食 → 咖啡（強關鍵字）→ 非咖啡 → 拿鐵類 → 其他
const CAT_RULES = {
  retail: /咖啡豆|豆子|熟豆|生豆|掛耳|濾掛|耳掛|磅|\d+\s*g\b|\d+\s*克|禮盒|周邊|馬克杯|隨行杯|帆布袋|明信片|貼紙|商品/i,
  food: /蛋糕|巴斯克|起司|乳酪|司康|scone|餅乾|可頌|吐司|三明治|貝果|鹹派|派|塔|布丁|甜點|瑪德蓮|費南雪|布朗尼|磅蛋糕|千層|提拉米蘇|鬆餅|戚風|馬芬|輕食|沙拉|點心|cake|cookie|toast|sandwich|bagel/i,
  coffee: /咖啡|美式|濃縮|espresso|手沖|冷萃|冰釀|摩卡|卡布|瑪奇朵|澳白|馥列白|dirty|髒髒|維也納|阿法奇朵|affogato|americano|latte|cappuccino|mocha|macchiato|flat\s*white|cold\s*brew|pour\s*over|hand\s*drip|coffee|single\s*origin|單品|花季|西西里/i,
  non_coffee: /茶|抹茶|焙茶|可可|巧克力|鮮奶|牛奶|氣泡|蘇打|果汁|檸檬|柳橙|通寧|優格|奶昔|tea|matcha|hojicha|cocoa|chocolate|milk|soda|juice|lemon|tonic|smoothie/i,
  coffee_weak: /拿鐵|latte/i,
};

export const CATEGORIES = {
  coffee: '咖啡飲品',
  non_coffee: '非咖啡飲品',
  food: '甜點輕食',
  retail: '咖啡豆與零售',
  prepaid: '寄杯／儲值（預收）',
  other: '其他',
};

export function guessCategory(name, rawCategory = '') {
  const s = normalizeText(`${name} ${rawCategory}`);
  if (/寄杯|儲值|預購/.test(s) && !/兌換|扣抵/.test(s)) return 'prepaid';
  if (CAT_RULES.retail.test(s)) return 'retail';
  if (CAT_RULES.food.test(s)) return 'food';
  if (CAT_RULES.coffee.test(s)) return 'coffee';
  if (CAT_RULES.non_coffee.test(s)) return 'non_coffee';
  if (CAT_RULES.coffee_weak.test(s)) return 'coffee';
  return 'other';
}

const SUMMARY_ROW = /^(合計|總計|小計|總和|total|subtotal|grand\s*total|本頁合計)$/i;
const ADJUST_ITEM = /^(折扣|優惠|折讓|整單折扣|訂單折扣|抹零|零頭|服務費|discount|service\s*charge)/i;

export function detectVoid(line, rules = DEFAULT_VOID_RULES) {
  const fields = {
    item: normalizeText(line.item_raw),
    option: normalizeText(line.option_raw),
    note: normalizeText(line.note),
    payment: normalizeText(line.payment_raw),
    status: normalizeText(line.status_raw),
    channel: normalizeText(line.channel),
    category: normalizeText(line.category_raw),
  };
  for (const rule of rules) {
    const kws = (rule.keywords || []).map((k) => normalizeText(k)).filter(Boolean);
    if (!kws.length) continue;
    const scope = rule.statusOnly ? [fields.status] : Object.values(fields);
    for (const text of scope) {
      if (!text) continue;
      for (const kw of kws) if (text.includes(kw)) return { reason: rule.reason, keyword: kw };
    }
  }
  return null;
}

// 從品名拆出「x2」「*3」這類數量（POS 無數量欄時）
function splitQtyFromName(name) {
  const m = /^(.*?)\s*[xX×*]\s*(\d{1,3})$/.exec(name);
  if (m && m[1].trim()) return { name: m[1].trim(), qty: Number(m[2]) };
  return { name, qty: null };
}

/**
 * 將匯入器取出的原始列轉為標準銷售明細。
 * @returns {{ lines: object[], skipped: {row:number, reason:string}[] }}
 */
export function normalizeSales(rawRows, { rules = DEFAULT_VOID_RULES, batchId = '', cutoffHour = 0 } = {}) {
  const lines = [];
  const skipped = [];
  const orderCtx = new Map();
  let lastCtx = null;
  for (const r of rawRows) {
    let item = String(r.item ?? '').trim();
    const lead = [r.item, r.datetime, r.date, r.order_no].map((x) => String(x ?? '').replace(/\s/g, '')).find(Boolean) || '';
    if (SUMMARY_ROW.test(lead)) {
      skipped.push({ row: r._row, reason: '合計列' });
      continue;
    }
    if (!item) {
      skipped.push({ row: r._row, reason: '無品項名稱' });
      continue;
    }
    const orderNo = String(r.order_no ?? '').trim();
    let dt = parseDateTime(r.datetime) || parseDateTime(`${r.date ?? ''} ${r.time ?? ''}`.trim());
    if (dt && !dt.time && r.time) {
      const t = parseDateTime(`2000-01-01 ${r.time}`);
      if (t) dt = { date: dt.date, time: t.time };
    }
    // 同一張單的後續品項常留白日期／付款：沿用同單資料
    const ctx = orderNo ? orderCtx.get(orderNo) : null;
    if (!dt && ctx) dt = { date: ctx.date, time: ctx.time };
    if (!dt && !orderNo && lastCtx && !r.datetime && !r.date) dt = { date: lastCtx.date, time: lastCtx.time };
    if (!dt) {
      skipped.push({ row: r._row, reason: '日期無法辨識' });
      continue;
    }
    let date = dt.date;
    if (cutoffHour > 0 && dt.time && Number(dt.time.slice(0, 2)) < cutoffHour) {
      const d = new Date(date + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      date = d.toISOString().slice(0, 10);
    }
    let qty = parseAmount(r.qty);
    if (qty === null) {
      const sp = splitQtyFromName(item);
      if (sp.qty !== null) {
        item = sp.name;
        qty = sp.qty;
      }
    }
    if (qty === null) qty = 1;
    const unitPrice = parseAmount(r.unit_price);
    let amount = parseAmount(r.amount);
    const discountRaw = parseAmount(r.discount);
    const discount = discountRaw === null ? 0 : Math.abs(discountRaw);
    if (amount === null) amount = unitPrice !== null ? round2(unitPrice * qty - discount) : null;
    if (amount === null) {
      skipped.push({ row: r._row, reason: '金額無法辨識' });
      continue;
    }
    const gross = unitPrice !== null ? round2(unitPrice * qty) : round2(amount + discount);
    const paymentRaw = String(r.payment ?? '').trim() || ctx?.payment_raw || '';
    const line = {
      batch_id: batchId,
      date,
      time: dt.time,
      order_no: orderNo,
      item_raw: item,
      option_raw: String(r.option ?? '').trim(),
      category_raw: String(r.category ?? '').trim(),
      qty,
      unit_price: unitPrice,
      gross,
      discount,
      amount,
      payment_raw: paymentRaw,
      payment: normalizePayment(paymentRaw),
      status_raw: String(r.status ?? '').trim() || ctx?.status_raw || '',
      note: String(r.note ?? '').trim(),
      member: String(r.member ?? '').trim() || ctx?.member || '',
      staff: String(r.staff ?? '').trim(),
      channel: String(r.channel ?? '').trim(),
      is_adjustment: ADJUST_ITEM.test(item) || (amount < 0 && !unitPrice),
    };
    const v = detectVoid(line, rules);
    line.void_reason = v ? v.reason : null;
    line.void_keyword = v ? v.keyword : null;
    line.revenue = v ? 0 : amount;
    lines.push(line);
    const newCtx = { date: line.date, time: line.time, payment_raw: line.payment_raw, status_raw: line.status_raw, member: line.member };
    if (orderNo && !ctx) orderCtx.set(orderNo, newCtx);
    lastCtx = newCtx;
  }
  assignLineKeys(lines);
  return { lines, skipped };
}

// 行鍵：同內容的第 n 次出現。重複匯入重疊期間時可自動略過已存在的品項列
export function assignLineKeys(lines) {
  const seen = new Map();
  for (const l of lines) {
    const base = [l.date, l.time, l.order_no, l.item_raw, l.option_raw, l.qty, l.amount, l.payment_raw].join('|');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    l.id = 's_' + fnv1a(base) + fnv1a(base + '#' + n).slice(0, 6) + '_' + n;
  }
  return lines;
}

// 作廢規則重新套用（使用者在設定頁改關鍵字後）
// 在銷售明細手動「標記作廢／取消作廢」過的品項（void_manual）照手動的，不被規則蓋掉
export function reapplyVoids(lines, rules) {
  let changed = 0;
  for (const l of lines) {
    if (l.void_manual) continue;
    const v = detectVoid(l, rules);
    const reason = v ? v.reason : null;
    if (reason !== l.void_reason) changed++;
    l.void_reason = reason;
    l.void_keyword = v ? v.keyword : null;
    l.revenue = reason ? 0 : l.amount;
  }
  return changed;
}

// ── 事後作廢（POS 匯入時是「已完成」，之後才在 POS／綠界作廢）
// 手動標記可選的原因與說明：訂單作廢不算營收、也不扣原料；老闆測試／招待／報廢不算營收，原料成本照原規則轉到對應科目
export const MANUAL_VOID_CHOICES = [
  ['pos_void', '訂單作廢（POS 作廢、測試單、取消）：不算營收，不扣原料'],
  ['boss_test', '老闆測試：不算營收，原料成本轉研究發展費'],
  ['boss_treat', '老闆招待：不算營收，原料成本轉交際費'],
  ['scrap', '報廢：不算營收，原料成本轉報廢損失'],
];

const logOf = (l, item) => [...(Array.isArray(l.void_log) ? l.void_log : []), item];

/**
 * 手動標記作廢：記下原因、說明、誰、什麼時候（void_manual），並留紀錄（void_log）。
 * 之後「重新套用作廢規則」不會改掉手動標記的。回傳改好的新物件，不改原本的。
 */
export function markVoid(lines, { reason, note = '', by = '', at = new Date().toISOString() }) {
  if (!VOID_REASONS[reason]) throw new Error('作廢原因不正確');
  return lines.map((l) => ({
    ...l,
    void_reason: reason,
    void_keyword: '手動標記',
    revenue: 0,
    void_manual: { reason, note, by, at },
    void_log: logOf(l, { at, by, action: 'void', reason, note, from: l.void_reason || null }),
  }));
}

/**
 * 取消作廢：照作廢規則本來就不算作廢的，回到依規則判斷（拿掉手動標記）；
 * 規則會判成作廢的（例如 POS 狀態是「已作廢」），記成手動「不作廢」，免得重新套用規則又被改回去。
 */
export function clearVoid(lines, { rules = DEFAULT_VOID_RULES, note = '', by = '', at = new Date().toISOString() } = {}) {
  return lines.map((l) => {
    const { void_manual, ...rest } = l;
    const auto = detectVoid(rest, rules);
    const out = { ...rest, void_reason: null, void_keyword: null, revenue: l.amount, void_log: logOf(l, { at, by, action: 'clear', reason: null, note, from: l.void_reason || null }) };
    if (auto) out.void_manual = { reason: null, note, by, at };
    return out;
  });
}

// 重新匯入時比對同一筆：同日期、同單號、同品名、同選項、同數量（金額、付款、狀態可能已經改了）
const voidMatchKey = (l) => [l.date, String(l.order_no || '').trim(), l.item_raw, l.option_raw || '', l.qty].join('|');

/**
 * 重新匯入 POS 銷售明細：已經匯入過的訂單，POS 狀態變成作廢（或其他作廢規則命中）時，更新那一筆，不當成重複略過。
 * 手動標記／取消作廢過的不動（照老闆手動的）。
 * @returns {{ updates: object[], consumed: Set<string> }} updates＝要更新的既有明細；consumed＝新檔裡已由既有明細代表、不要再新增的列 id
 */
export function planVoidUpdates(incoming, existing, { batchId = '', at = new Date().toISOString() } = {}) {
  const byId = new Map(existing.map((l) => [l.id, l]));
  const byKey = new Map();
  for (const l of existing) {
    if (!String(l.order_no || '').trim()) continue;
    const k = voidMatchKey(l);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(l);
  }
  const used = new Set();
  const updates = [];
  const consumed = new Set();
  for (const n of incoming) {
    if (!n.void_reason) continue;
    let old = byId.get(n.id);
    if (old && used.has(old.id)) old = null;
    if (!old && String(n.order_no || '').trim()) old = (byKey.get(voidMatchKey(n)) || []).find((l) => !used.has(l.id)) || null;
    if (!old) continue;
    used.add(old.id);
    if (old.id !== n.id) consumed.add(n.id);
    if (old.void_reason || old.void_manual) continue;
    updates.push({
      ...old,
      status_raw: n.status_raw || old.status_raw,
      void_reason: n.void_reason,
      void_keyword: n.void_keyword,
      revenue: 0,
      void_reimport: { at, batch_id: batchId, status: n.status_raw || '' },
      void_log: logOf(old, { at, by: '重新匯入', action: 'void', reason: n.void_reason, note: n.status_raw ? `重新匯入時 POS 狀態為「${n.status_raw}」` : `重新匯入時命中作廢規則「${n.void_keyword || ''}」`, from: null }),
    });
  }
  return { updates, consumed };
}

export function inRevenuePeriod(line, settings) {
  const start = settings?.revenue_start || '2026-08-21';
  return line.date >= start && (!settings?.revenue_end || line.date <= settings.revenue_end);
}
