// 會員消費輪廓（Customer_Profiles）與行銷活動成效（Campaign_ROI）。

import { round2 } from './money.js';
import { daysBetween, addDays } from './dates.js';
import { normalizeText } from './text.js';

export const DEFAULT_TIERS = [
  { name: '一般', min: 0 },
  { name: '銀卡', min: 1500 },
  { name: '金卡', min: 5000 },
  { name: '黑卡', min: 12000 },
];

// 手機號碼只留數字；其他會員編號去空白
export function memberKey(raw) {
  const s = String(raw ?? '').normalize('NFKC').trim();
  if (!s) return '';
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 8 && digits.length >= s.replace(/[\s-]/g, '').length - 1) return digits.replace(/^886/, '0');
  return s.replace(/\s+/g, '');
}

export function maskMember(key) {
  if (/^09\d{8}$/.test(key)) return `${key.slice(0, 4)}-***-${key.slice(7)}`;
  return key;
}

const PREF_WORDS = ['燕麥奶', '豆漿', '低脂', '無糖', '微糖', '半糖', '少冰', '去冰', '熱', '淺焙', '中焙', '深焙', '濃一點', '加濃', '減冰', '常溫'];

function segmentOf(p) {
  if (p.recency > 60) return '流失風險';
  if (p.recency > 30) return '沉睡中';
  if (p.firstDaysAgo <= 30 && p.visits <= 2) return '新客';
  if (p.recency <= 14 && p.visits90 >= 6) return '忠實常客';
  if (p.recency <= 30 && p.visits90 >= 3) return '穩定回訪';
  return '一般';
}

export function tierOf(spend, tiers = DEFAULT_TIERS) {
  let t = tiers[0];
  for (const x of tiers) if (spend >= x.min) t = x;
  const next = tiers.find((x) => x.min > spend);
  return { tier: t.name, next: next ? { name: next.name, gap: round2(next.min - spend) } : null };
}

/**
 * @param lines 銷售明細（建議已篩選營收期間）
 * @param customers 會員主檔 [{ member_no, name, tier, birthday, preferences, note }]
 * @param productNameOf (line) => 標準品名
 */
export function buildProfiles(lines, customers, { asOf, tiers = DEFAULT_TIERS, productNameOf = (l) => l.item_raw } = {}) {
  const master = new Map(customers.map((c) => [memberKey(c.member_no), c]));
  const map = new Map();
  for (const l of lines) {
    const key = memberKey(l.member);
    if (!key) continue;
    let p = map.get(key);
    if (!p) map.set(key, (p = { key, orders: new Set(), dates: new Set(), spend: 0, first: l.date, last: l.date, items: new Map(), prefs: new Map(), hours: new Map(), voidQty: 0 }));
    if (l.void_reason) {
      p.voidQty += l.qty;
      continue;
    }
    p.orders.add(l.order_no || `${l.date} ${l.time}`);
    p.dates.add(l.date);
    p.spend += l.revenue;
    if (l.date < p.first) p.first = l.date;
    if (l.date > p.last) p.last = l.date;
    if (!l.is_adjustment) {
      const n = productNameOf(l);
      p.items.set(n, (p.items.get(n) || 0) + l.qty);
    }
    const optText = normalizeText(`${l.option_raw} ${l.note}`);
    for (const w of PREF_WORDS) if (optText.includes(w)) p.prefs.set(w, (p.prefs.get(w) || 0) + 1);
    if (l.time) {
      const h = l.time.slice(0, 2);
      p.hours.set(h, (p.hours.get(h) || 0) + 1);
    }
  }
  const since90 = addDays(asOf, -89);
  const out = [];
  for (const p of map.values()) {
    const m = master.get(p.key) || {};
    const visits = p.dates.size;
    const visits90 = [...p.dates].filter((d) => d >= since90).length;
    const ordersN = p.orders.size;
    const spend = round2(p.spend);
    const activeDays = Math.max(30, daysBetween(p.first, asOf) + 1);
    const perMonth = (visits / activeDays) * 30;
    const avgTicket = ordersN ? spend / ordersN : 0;
    const t = tierOf(spend, tiers);
    const prof = {
      key: p.key,
      name: m.name || '',
      tier: m.tier || t.tier,
      nextTier: t.next,
      visits,
      visits90,
      orders: ordersN,
      spend,
      avgTicket,
      first: p.first,
      last: p.last,
      recency: daysBetween(p.last, asOf),
      firstDaysAgo: daysBetween(p.first, asOf),
      perMonth,
      ltv12: round2(avgTicket * perMonth * 12),
      topItems: [...p.items.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3),
      prefs: [...p.prefs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((x) => x[0]),
      prefNote: m.preferences || '',
      favHour: [...p.hours.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null,
      birthday: m.birthday || '',
      voidQty: p.voidQty,
    };
    prof.segment = segmentOf(prof);
    out.push(prof);
  }
  // 只在主檔、尚未消費的會員
  for (const [key, m] of master) {
    if (map.has(key) || !key) continue;
    out.push({ key, name: m.name || '', tier: m.tier || tiers[0].name, nextTier: null, visits: 0, visits90: 0, orders: 0, spend: 0, avgTicket: 0, first: null, last: null, recency: null, firstDaysAgo: null, perMonth: 0, ltv12: 0, topItems: [], prefs: [], prefNote: m.preferences || '', favHour: null, birthday: m.birthday || '', segment: '尚未消費', voidQty: 0 });
  }
  return out.sort((a, b) => b.spend - a.spend);
}

// 自動化行銷觸發清單
export function marketingTriggers(profiles, { asOf } = {}) {
  const month = asOf.slice(5, 7);
  return {
    winBack: profiles.filter((p) => p.visits >= 3 && p.recency !== null && p.recency > 30 && p.recency <= 90),
    nearTier: profiles.filter((p) => p.nextTier && p.nextTier.gap <= Math.max(300, p.avgTicket * 2) && p.recency !== null && p.recency <= 60),
    birthday: profiles.filter((p) => p.birthday && String(p.birthday).normalize('NFKC').replace(/\D/g, '').slice(-4, -2) === month),
    newcomers: profiles.filter((p) => p.segment === '新客'),
  };
}

// ─────────── 行銷活動成效

export const CAMPAIGN_TYPES = { prepaid: '寄杯', discount: '時段／折扣', bundle: '組合／買一送一', points: '集點', social: '社群／廣告', other: '其他' };

function orderKey(l) {
  return l.order_no || `${l.date} ${l.time || ''} ${l.member || ''}`;
}

/**
 * @param c { start, end, type, keywords, issued_qty, redeemed_qty, marketing_cost }
 * @param firstVisit Map(memberKey → 首次消費日)
 */
export function campaignStats(c, lines, { firstVisit = new Map(), grossMargin = 0.7 } = {}) {
  const kws = String(c.keywords || '')
    .split(/[,，、\s]+/)
    .map((k) => normalizeText(k))
    .filter(Boolean);
  const inRange = lines.filter((l) => (!c.start_date || l.date >= c.start_date) && (!c.end_date || l.date <= c.end_date));
  const hit = (l) => {
    if (!kws.length) return false;
    const t = normalizeText(`${l.item_raw} ${l.option_raw} ${l.note} ${l.payment_raw} ${l.channel}`);
    return kws.some((k) => t.includes(k));
  };
  const matched = inRange.filter((l) => !l.void_reason && hit(l));
  const orders = new Set(matched.map(orderKey));
  const basket = inRange.filter((l) => !l.void_reason && orders.has(orderKey(l)));
  const revenue = round2(basket.reduce((t, l) => t + l.revenue, 0));
  const discount = round2(basket.reduce((t, l) => t + (l.discount || 0) + (l.amount < 0 ? -l.amount : 0), 0));
  const redeemedAuto = c.type === 'prepaid' ? inRange.filter((l) => l.payment === 'prepaid').reduce((t, l) => t + l.qty, 0) : matched.reduce((t, l) => t + l.qty, 0);
  const issued = Number(c.issued_qty) || 0;
  const redeemed = c.redeemed_qty !== '' && c.redeemed_qty !== undefined && c.redeemed_qty !== null ? Number(c.redeemed_qty) : redeemedAuto;
  const newMembers = new Set();
  for (const l of matched) {
    const k = memberKey(l.member);
    if (k && firstVisit.get(k) && firstVisit.get(k) >= (c.start_date || '0000') && firstVisit.get(k) <= (c.end_date || '9999') && firstVisit.get(k) === l.date) newMembers.add(k);
  }
  const cost = round2(discount + (Number(c.marketing_cost) || 0));
  const profit = revenue * grossMargin - cost;
  return {
    orders: orders.size,
    matchedQty: matched.reduce((t, l) => t + l.qty, 0),
    revenue,
    discount,
    cost,
    issued,
    redeemed,
    redemptionRate: issued ? redeemed / issued : null,
    newCustomers: newMembers.size,
    cac: newMembers.size ? cost / newMembers.size : null,
    roi: cost ? profit / cost : null,
    avgBasket: orders.size ? revenue / orders.size : 0,
  };
}

export function firstVisits(lines) {
  const m = new Map();
  for (const l of lines) {
    const k = memberKey(l.member);
    if (!k || l.void_reason) continue;
    if (!m.has(k) || l.date < m.get(k)) m.set(k, l.date);
  }
  return m;
}
