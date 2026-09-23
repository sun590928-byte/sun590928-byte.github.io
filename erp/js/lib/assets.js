// 固定資產折舊（平均法）。
// 預設殘值 = 成本 ÷ (耐用年數 + 1)（營所稅查核準則常用算法）；取得當月即開始提列，不滿一月以一月計。

import { ASSET_CATEGORIES } from './coa.js';
import { addMonths } from './dates.js';

export function defaultResidual(cost, life) {
  return Math.round(Number(cost) / (Number(life) + 1));
}

export function normalizeAsset(a) {
  const cat = ASSET_CATEGORIES[a.category] || ASSET_CATEGORIES.machine;
  const life = Number(a.life_years) || cat.life;
  const cost = Number(a.cost) || 0;
  const residual = a.residual === '' || a.residual === null || a.residual === undefined ? defaultResidual(cost, life) : Number(a.residual);
  return { ...a, life_years: life, cost, residual, asset_account: a.asset_account || cat.asset, accum_account: a.accum_account || cat.accum };
}

/**
 * 逐月折舊表（整數元，最後一期補足尾差）。
 * @returns [{ month, amount, accum, book }]
 */
export function schedule(asset, { until } = {}) {
  const a = normalizeAsset(asset);
  if (!a.acquired_on || a.cost <= 0) return [];
  const depreciable = Math.max(0, a.cost - a.residual);
  const months = a.life_years * 12;
  const monthly = Math.round(depreciable / months);
  const start = a.acquired_on.slice(0, 7);
  const stop = a.disposed_on ? a.disposed_on.slice(0, 7) : null;
  const out = [];
  let accum = 0;
  for (let i = 0; i < months; i++) {
    const month = addMonths(start, i);
    if (until && month > until) break;
    if (stop && month > stop) break;
    let amount = i === months - 1 ? depreciable - accum : Math.min(monthly, depreciable - accum);
    if (amount <= 0) break;
    accum += amount;
    out.push({ month, amount, accum, book: a.cost - accum });
  }
  return out;
}

export function depreciationForMonth(assets, ym) {
  const items = [];
  for (const raw of assets) {
    const a = normalizeAsset(raw);
    const row = schedule(a, { until: ym }).find((r) => r.month === ym);
    if (row) items.push({ id: a.id, name: a.name, amount: row.amount, accum: a.accum_account });
  }
  return items;
}

// 截至某月的資產摘要
export function assetSummary(assets, asOfYm) {
  return assets.map((raw) => {
    const a = normalizeAsset(raw);
    const sch = schedule(a, { until: asOfYm });
    const accum = sch.length ? sch[sch.length - 1].accum : 0;
    const full = schedule(a);
    const monthly = full.length ? full[0].amount : 0;
    const remaining = full.filter((r) => r.month > asOfYm).length;
    const thisYear = sch.filter((r) => r.month.slice(0, 4) === asOfYm.slice(0, 4)).reduce((t, r) => t + r.amount, 0);
    return { ...a, accum, book: a.cost - accum, monthly, remaining, thisYear, endMonth: full.length ? full[full.length - 1].month : null };
  });
}
