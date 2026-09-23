// 原物料進銷存（Inventory_Ledger）：進貨、耗用（POS × 配方）、報廢、盤點調整、安全庫存預警。
// 品項：{ id, sku, name, unit, category, gl_account, safety_stock, reorder_qty, supplier_id }
// 異動：{ id, item_id, date, type: 'opening'|'purchase'|'consume'|'scrap'|'adjust', qty, amount, supplier_id, order_date, yield_score, note }
// 配方：{ product_id, item_id, qty }（每售出一份產品的耗用量）

import { round2 } from './money.js';
import { addDays, daysBetween } from './dates.js';

export const INVENTORY_CATEGORIES = {
  beans: { label: '咖啡豆', gl: '1211', unit: 'g' },
  dairy: { label: '乳品', gl: '1212', unit: 'ml' },
  tea_syrup: { label: '茶葉／粉類／糖漿', gl: '1213', unit: 'g' },
  bakery: { label: '甜點輕食原料', gl: '1214', unit: 'g' },
  packaging: { label: '包材耗材', gl: '1215', unit: '個' },
  retail: { label: '零售商品', gl: '1216', unit: '包' },
};

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

// 移動加權平均成本（依日期序）
export function averageCosts(items, moves, { asOf } = {}) {
  const res = new Map();
  const sorted = [...moves].filter((m) => !asOf || m.date <= asOf).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const it of items) res.set(it.id, { qty: 0, value: 0, avg: Number(it.std_cost) || 0 });
  for (const m of sorted) {
    const s = res.get(m.item_id);
    if (!s) continue;
    const q = Number(m.qty) || 0;
    if (m.type === 'purchase' || m.type === 'opening') {
      const amt = Number(m.amount) || 0;
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
export function stockLevels(items, moves, usage, { asOf, lookbackDays = 14 } = {}) {
  const costs = averageCosts(items, moves, { asOf });
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
