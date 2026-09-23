// 營運損益（P&L_Statement）：由帳務分錄彙整，依科目 behavior 分固定／變動成本，並計算健康度指標。

import { incomeStatement } from './ledger.js';
import { round2 } from './money.js';
import { monthStart, monthEnd } from './dates.js';

const LABOR = new Set(['6101', '6102', '6119', '6126', '6127']);

export function periodPnl(entries, accounts, { from, to }) {
  const is = incomeStatement(entries, accounts, { from, to });
  const revenue = is.netRevenue;
  const cogs = is.cogsTotal;
  let fixed = 0;
  let variableOpex = 0;
  let labor = 0;
  let rent = 0;
  let depreciation = 0;
  let utilities = 0;
  let fees = 0;
  let treats = 0;
  for (const r of is.opex) {
    if (LABOR.has(r.code)) labor += r.amount;
    if (r.code === '6111') rent += r.amount;
    if (r.code === '6124' || r.code === '6125') depreciation += r.amount;
    if (r.code === '6118') utilities += r.amount;
    if (r.code === '6131' || r.code === '6129') fees += r.amount;
    if (r.code === '6120' || r.code === '6128') treats += r.amount;
    if (r.behavior === 'variable') variableOpex += r.amount;
    else fixed += r.amount;
  }
  const scrap = is.cogs.filter((r) => r.code === '5105').reduce((t, r) => t + r.amount, 0);
  const variable = round2(cogs + variableOpex);
  const contribution = revenue ? 1 - variable / revenue : null;
  const breakEven = contribution && contribution > 0 ? fixed / contribution : null;
  return {
    from,
    to,
    revenue,
    cogs,
    grossProfit: is.grossProfit,
    fixed: round2(fixed),
    variableOpex: round2(variableOpex),
    variable,
    opex: is.opexTotal,
    operatingIncome: is.operatingIncome,
    nonop: round2(is.nonopIncomeTotal - is.nonopExpenseTotal),
    netIncome: is.netIncome,
    labor: round2(labor),
    rent: round2(rent),
    depreciation: round2(depreciation),
    utilities: round2(utilities),
    fees: round2(fees),
    treats: round2(treats),
    scrap: round2(scrap),
    ratios: {
      grossMargin: revenue ? is.grossProfit / revenue : null,
      foodCost: revenue ? cogs / revenue : null,
      labor: revenue ? labor / revenue : null,
      prime: revenue ? (cogs + labor) / revenue : null,
      rent: revenue ? rent / revenue : null,
      operatingMargin: revenue ? is.operatingIncome / revenue : null,
      netMargin: revenue ? is.netIncome / revenue : null,
      fees: revenue ? fees / revenue : null,
    },
    breakEven,
    detail: is,
  };
}

export function monthlyPnl(entries, accounts, months) {
  return months.map((ym) => ({ ym, ...periodPnl(entries, accounts, { from: monthStart(ym), to: monthEnd(ym) }) }));
}

// 咖啡館常見參考區間（僅供對照，非標準）
export const BENCHMARKS = {
  grossMargin: { label: '毛利率', good: [0.65, 1], warn: [0.55, 0.65], hint: '咖啡館原料成本低，毛利率多在 65–75%' },
  foodCost: { label: '原物料成本率', good: [0, 0.32], warn: [0.32, 0.4], hint: '飲品 25–30%、含餐點 30–35% 常見' },
  labor: { label: '人事成本率', good: [0, 0.3], warn: [0.3, 0.38], hint: '含老闆薪資時多落在 25–35%' },
  prime: { label: '主要成本率（原料＋人事）', good: [0, 0.6], warn: [0.6, 0.68], hint: '超過 65% 獲利空間很薄' },
  rent: { label: '租金佔比', good: [0, 0.12], warn: [0.12, 0.18], hint: '一般建議低於營收 10–15%' },
  operatingMargin: { label: '營業淨利率', good: [0.1, 1], warn: [0, 0.1], hint: '小店 10–15% 已屬健康' },
};

export function rate(key, v) {
  const b = BENCHMARKS[key];
  if (!b || v === null || v === undefined) return 'na';
  if (v >= b.good[0] && v <= b.good[1]) return 'good';
  if (v >= b.warn[0] && v <= b.warn[1]) return 'warn';
  return 'bad';
}
