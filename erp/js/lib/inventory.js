// 原物料進銷存（Inventory_Ledger）：進貨、耗用（POS × 配方）、報廢、盤點調整、安全庫存預警。
// 品項：{ id, sku, name, unit, category, gl_account, safety_stock, reorder_qty, supplier_id, pack_type, pack_size, last_purchase_date, last_unit_price … }（進貨相關欄位見 lib/purchases.js）
// 異動：{ id, item_id, date, type: 'opening'|'purchase'|'consume'|'scrap'|'adjust', qty, amount（含稅）, amount_ex（未稅）, tax, supplier_id, order_date, yield_score, note }
// 配方：{ product_id, item_id, qty }（每售出一份產品的耗用量）

import { round2 } from './money.js';
import { addDays, daysBetween } from './dates.js';

export const INVENTORY_CATEGORIES = {
  beans: { label: '咖啡豆', gl: '1211', unit: 'g' },
  dairy: { label: '乳品', gl: '1212', unit: 'ml' },
  tea_syrup: { label: '茶葉／粉類', gl: '1213', unit: 'g' },
  juice_syrup: { label: '果汁糖漿', gl: '1217', unit: 'ml' },
  bakery: { label: '甜點輕食原料', gl: '1214', unit: 'g' },
  packaging: { label: '包材耗材', gl: '1215', unit: '個' },
  retail: { label: '零售商品', gl: '1216', unit: '包' },
  other: { label: '其他／待分類', gl: '1215', unit: '個' },
};

const SKU_PREFIX = { beans: 'BN', dairy: 'DY', tea_syrup: 'TS', juice_syrup: 'JS', bakery: 'BK', packaging: 'PK', retail: 'RT', other: 'OT' };

// 存貨科目（存貨與成本頁的列）：固定的 1211–1217，加上會計項目裡其他 121X 資產科目（之後新增的會自動出現），
// 以及品項、分錄、盤點用到的 121X 科目（停用的科目還有餘額也要列出來）
const INV_BASE = ['1211', '1212', '1213', '1214', '1215', '1216', '1217'];
const INV_RE = /^121\d$/;
export function inventoryAccounts(accounts = [], { items = [], entries = [], stocktakes = [] } = {}) {
  const codes = new Set(INV_BASE);
  for (const a of accounts) if (INV_RE.test(a.code) && a.active !== false) codes.add(a.code);
  for (const it of items) if (INV_RE.test(it.gl_account || '')) codes.add(it.gl_account);
  for (const e of entries) for (const l of e.lines || []) if (INV_RE.test(l.account || '')) codes.add(l.account);
  for (const st of stocktakes) if (INV_RE.test(st.account || '')) codes.add(st.account);
  return [...codes].sort();
}

// 物品編號：分類字首 + 流水號（BN-001、DY-002…）
export function suggestSku(cat, items) {
  const p = SKU_PREFIX[cat] || 'IT';
  const used = items.map((i) => /^([A-Z]+)-(\d+)$/i.exec(String(i.sku || ''))).filter((m) => m && m[1].toUpperCase() === p).map((m) => Number(m[2]));
  return `${p}-${String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0')}`;
}

export const MOVE_TYPES = { opening: '期初', purchase: '進貨', consume: '耗用', scrap: '報廢', adjust: '盤點調整' };

/**
 * 由銷售明細 × 配方推算理論耗用；作廢原因為「報廢」者計入報廢量，其餘（含老闆招待、測試）計入耗用。
 * @param productIdOf (line) => product_id
 * @returns Map(item_id → { consume, scrap, byDate: Map(date → qty), byReason: {boss_treat, boss_test, scrap} })
 */
export function theoreticalUsage(lines, recipes, productIdOf, { from, to } = {}) {
  const byProduct = new Map();
  for (const r of recipes) {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push(r);
  }
  const usage = new Map();
  for (const l of lines) {
    if (from && l.date < from) continue;
    if (to && l.date > to) continue;
    if (l.void_reason === 'pos_void' || l.is_adjustment || l.qty <= 0) continue;
    const rec = byProduct.get(productIdOf(l));
    if (!rec) continue;
    for (const r of rec) {
      const q = r.qty * l.qty;
      let u = usage.get(r.item_id);
      if (!u) usage.set(r.item_id, (u = { consume: 0, scrap: 0, byDate: new Map(), byReason: { boss_treat: 0, boss_test: 0, scrap: 0 } }));
      if (l.void_reason === 'scrap') u.scrap += q;
      else u.consume += q;
      if (l.void_reason && u.byReason[l.void_reason] !== undefined) u.byReason[l.void_reason] += q;
      u.byDate.set(l.date, (u.byDate.get(l.date) || 0) + q);
    }
  }
  return usage;
}

const DEFAULT_VAT_RATE = 0.05;

/**
 * 進貨成本一律用未稅金額：一般稅額營業人的進項稅額已記在 1261 進項稅額去扣抵，不是原料成本（用含稅算，成本與庫存價值會多約 5%）。
 * 進貨紀錄有 amount_ex（未稅）就用它；舊資料只有含稅金額的以 ÷(1＋稅率) 推算；期初登記的金額本來就是成本。
 */
export function purchaseCost(m, vatRate = DEFAULT_VAT_RATE) {
  const amt = Number(m.amount) || 0;
  if (m.type !== 'purchase') return amt;
  const ex = m.amount_ex === null || m.amount_ex === undefined || m.amount_ex === '' ? NaN : Number(m.amount_ex);
  if (Number.isFinite(ex)) return ex;
  return vatRate > 0 ? amt / (1 + vatRate) : amt;
}

// 移動加權平均成本（依日期序；未稅）
export function averageCosts(items, moves, { asOf, vatRate = DEFAULT_VAT_RATE } = {}) {
  const res = new Map();
  const sorted = [...moves].filter((m) => !asOf || m.date <= asOf).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const it of items) res.set(it.id, { qty: 0, value: 0, avg: Number(it.std_cost) || 0 });
  for (const m of sorted) {
    const s = res.get(m.item_id);
    if (!s) continue;
    const q = Number(m.qty) || 0;
    if (m.type === 'purchase' || m.type === 'opening') {
      const amt = purchaseCost(m, vatRate);
      s.qty += q;
      s.value += amt;
      if (s.qty > 0) s.avg = s.value / s.qty;
    } else {
      const out = m.type === 'adjust' ? -q : q; // adjust: 正數＝盤盈
      s.qty -= out;
      s.value -= out * s.avg;
      if (s.qty <= 0) {
        s.qty = Math.max(0, s.qty);
        s.value = 0;
      }
    }
  }
  return res;
}

/**
 * 庫存水位：期初 + 進貨 − 耗用 − 報廢 ± 調整；耗用 = 手動耗用 + 理論耗用（POS×配方）
 */
export function stockLevels(items, moves, usage, { asOf, lookbackDays = 14, vatRate = DEFAULT_VAT_RATE } = {}) {
  const costs = averageCosts(items, moves, { asOf, vatRate });
  const from = asOf ? addDays(asOf, -lookbackDays + 1) : null;
  return items.map((it) => {
    const mv = moves.filter((m) => m.item_id === it.id && (!asOf || m.date <= asOf));
    const sumType = (t) => round2(mv.filter((m) => m.type === t).reduce((a, m) => a + (Number(m.qty) || 0), 0));
    const u = usage.get(it.id) || { consume: 0, scrap: 0, byDate: new Map() };
    const opening = sumType('opening');
    const purchased = sumType('purchase');
    const consumed = round2(sumType('consume') + u.consume);
    const scrapped = round2(sumType('scrap') + u.scrap);
    const adjusted = sumType('adjust');
    const onHand = round2(opening + purchased - consumed - scrapped + adjusted);
    let recent = 0;
    if (from) {
      for (const [d, q] of u.byDate) if (d >= from && d <= asOf) recent += q;
      for (const m of mv) if (m.type === 'consume' && m.date >= from) recent += Number(m.qty) || 0;
    }
    const avgDaily = from ? recent / lookbackDays : 0;
    const c = costs.get(it.id) || { avg: 0 };
    const safety = Number(it.safety_stock) || 0;
    const lastPurchase = mv.filter((m) => m.type === 'purchase').sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    return {
      item: it,
      opening,
      purchased,
      consumed,
      scrapped,
      adjusted,
      onHand,
      avgCost: c.avg,
      value: round2(Math.max(0, onHand) * c.avg),
      avgDaily,
      daysCover: avgDaily > 0 ? onHand / avgDaily : null,
      status: onHand <= 0 ? 'out' : safety && onHand <= safety ? 'low' : safety && onHand <= safety * 1.5 ? 'watch' : 'ok',
      scrapRate: consumed + scrapped > 0 ? scrapped / (consumed + scrapped) : 0,
      lastPurchase,
    };
  });
}

// ─────────── 依耗用量建議安全庫存（11/12 需求 二-6）
// 建議安全庫存 ＝ 近 N 天日均耗用 ×（叫貨前置天數 ＋ 安全天數）；日均耗用＝（POS 銷售 × 配方，含招待／測試／報廢）＋ 手動登記的耗用與報廢，÷ 天數
export const SAFETY_RULE_DEFAULT = { lookback_days: 28, lead_days: 3, safety_days: 2 };
export const SAFETY_MIN_DAYS = 7; // 銷售資料少於 7 天就不建議（資料不足）

const intIn = (v, d, lo, hi) => {
  if (v === null || v === undefined || String(v).trim() === '') return d;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
export function normalizeSafetyRule(r = {}) {
  const x = r || {};
  return { lookback_days: intIn(x.lookback_days, SAFETY_RULE_DEFAULT.lookback_days, SAFETY_MIN_DAYS, 365), lead_days: intIn(x.lead_days, SAFETY_RULE_DEFAULT.lead_days, 0, 90), safety_days: intIn(x.safety_days, SAFETY_RULE_DEFAULT.safety_days, 0, 90) };
}

/**
 * 各品項近 lookbackDays 天（到 asOf，含當天）的耗用量與日均耗用；dataStart（銷售資料起算日）晚於區間起點時只算有資料的天數。
 * @returns Map(item_id → { from, to, days, total, avgDaily })
 */
export function usageRates(items, moves, usage, { asOf, lookbackDays = SAFETY_RULE_DEFAULT.lookback_days, dataStart = '' } = {}) {
  let from = addDays(asOf, -lookbackDays + 1);
  if (dataStart && dataStart > from) from = dataStart;
  const days = from > asOf ? 0 : daysBetween(from, asOf) + 1;
  const res = new Map(items.map((it) => [it.id, { from, to: asOf, days, total: 0, avgDaily: 0 }]));
  for (const [id, u] of usage || []) {
    const r = res.get(id);
    if (r) for (const [d, q] of u.byDate || []) if (d >= from && d <= asOf) r.total += q;
  }
  for (const m of moves) {
    if (m.type !== 'consume' && m.type !== 'scrap') continue;
    const r = res.get(m.item_id);
    if (r && m.date >= from && m.date <= asOf) r.total += Number(m.qty) || 0;
  }
  for (const r of res.values()) {
    r.total = round2(r.total);
    r.avgDaily = r.days > 0 ? r.total / r.days : 0;
  }
  return res;
}

// 進位：有進貨包裝（每包裝折合 > 1）進位到整包；其他進位到整數（100 以上到 10、1,000 以上到 100）
export function roundSafety(raw, item = {}) {
  if (!(raw > 0)) return 0;
  const pack = Number(item.pack_size) || 0;
  if (item.pack_type && pack > 1) return round2(Math.ceil(raw / pack - 1e-9) * pack);
  const step = raw >= 1000 ? 100 : raw >= 100 ? 10 : 1;
  return Math.ceil(raw / step - 1e-9) * step;
}

/** 單一品項的建議安全庫存；資料不足時 value 為 null 並附原因 */
export function suggestSafetyStock(item, rate, rule = SAFETY_RULE_DEFAULT) {
  const r = normalizeSafetyRule(rule);
  const cover = r.lead_days + r.safety_days;
  const base = { value: null, raw: null, avgDaily: rate?.avgDaily || 0, days: rate?.days || 0, total: rate?.total || 0, cover };
  if (!rate || rate.days < SAFETY_MIN_DAYS) return { ...base, reason: `資料不足：銷售資料只有 ${rate?.days || 0} 天（至少要 ${SAFETY_MIN_DAYS} 天）` };
  if (!(rate.total > 0)) return { ...base, reason: `資料不足：近 ${rate.days} 天沒有耗用（請確認配方）` };
  if (cover <= 0) return { ...base, reason: '叫貨前置天數＋安全天數至少要 1 天' };
  const raw = rate.avgDaily * cover;
  return { ...base, raw, value: roundSafety(raw, item), reason: '' };
}

/** 全部品項的建議安全庫存：Map(item_id → suggestSafetyStock 結果) */
export function safetySuggestions(items, moves, usage, { asOf, dataStart = '', rule = SAFETY_RULE_DEFAULT } = {}) {
  const r = normalizeSafetyRule(rule);
  const rates = usageRates(items, moves, usage, { asOf, lookbackDays: r.lookback_days, dataStart });
  return new Map(items.map((it) => [it.id, suggestSafetyStock(it, rates.get(it.id), r)]));
}

// 產品理論成本（配方 × 平均成本）
export function productCosts(products, recipes, avgCostOf) {
  const out = new Map();
  for (const p of products) {
    const rec = recipes.filter((r) => r.product_id === p.id);
    if (!rec.length) continue;
    out.set(p.id, round2(rec.reduce((t, r) => t + r.qty * (avgCostOf(r.item_id) || 0), 0)));
  }
  return out;
}

// 供應商表現（Supplier_Costs）：單價波動、交貨天數、良率
export function supplierStats(suppliers, items, moves) {
  const purchases = moves.filter((m) => m.type === 'purchase');
  const itemName = new Map(items.map((i) => [i.id, i.name]));
  return suppliers.map((s) => {
    const ps = purchases.filter((m) => m.supplier_id === s.id);
    const lead = ps.filter((m) => m.order_date && m.date).map((m) => daysBetween(m.order_date, m.date));
    const yields = ps.map((m) => Number(m.yield_score)).filter((x) => Number.isFinite(x) && x > 0);
    const total = round2(ps.reduce((t, m) => t + (Number(m.amount) || 0), 0));
    const itemsBought = [...new Set(ps.map((m) => itemName.get(m.item_id)).filter(Boolean))];
    return {
      supplier: s,
      count: ps.length,
      total,
      items: itemsBought,
      avgLead: lead.length ? lead.reduce((a, b) => a + b, 0) / lead.length : null,
      maxLead: lead.length ? Math.max(...lead) : null,
      avgYield: yields.length ? yields.reduce((a, b) => a + b, 0) / yields.length : null,
      last: ps.map((m) => m.date).sort().pop() || null,
    };
  });
}

export function priceHistory(moves, itemId) {
  const ps = moves
    .filter((m) => m.type === 'purchase' && m.item_id === itemId && Number(m.qty) > 0)
    .map((m) => ({ date: m.date, supplier_id: m.supplier_id, qty: Number(m.qty), unitCost: (Number(m.amount) || 0) / Number(m.qty) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!ps.length) return { points: [], stats: null };
  const costs = ps.map((p) => p.unitCost);
  const latest = costs[costs.length - 1];
  const prev = costs.length > 1 ? costs[costs.length - 2] : null;
  return {
    points: ps,
    stats: {
      min: Math.min(...costs),
      max: Math.max(...costs),
      avg: costs.reduce((a, b) => a + b, 0) / costs.length,
      latest,
      changeVsPrev: prev ? (latest - prev) / prev : null,
      changeVsFirst: costs[0] ? (latest - costs[0]) / costs[0] : null,
    },
  };
}
