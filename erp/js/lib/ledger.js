// 複式簿記引擎：日記簿 → 分類帳 → 試算表 → 資產負債表 / 綜合損益表。
// 分錄格式：{ id, date, voucher_no, description, source, source_ref, status, lines:[{account, debit, credit, memo, partner}] }

import { round2 } from './money.js';
import { PL_TYPES, accountMap } from './coa.js';

const CASH_CODES = new Set(['1101', '1102', '1103']);

export function entryTotals(e) {
  let debit = 0;
  let credit = 0;
  for (const l of e.lines || []) {
    debit += Number(l.debit) || 0;
    credit += Number(l.credit) || 0;
  }
  return { debit: round2(debit), credit: round2(credit) };
}

export function validateEntry(e, accMap) {
  const errs = [];
  if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) errs.push('日期格式錯誤');
  const lines = (e.lines || []).filter((l) => l.account || l.debit || l.credit);
  if (lines.length < 2) errs.push('至少需要一借一貸兩行');
  lines.forEach((l, i) => {
    if (!l.account) errs.push(`第 ${i + 1} 行未選科目`);
    else if (accMap && !accMap.has(l.account)) errs.push(`第 ${i + 1} 行科目 ${l.account} 不存在`);
    const d = Number(l.debit) || 0;
    const c = Number(l.credit) || 0;
    if (d < 0 || c < 0) errs.push(`第 ${i + 1} 行金額不可為負`);
    if (d && c) errs.push(`第 ${i + 1} 行不可同時有借方與貸方`);
    if (!d && !c) errs.push(`第 ${i + 1} 行金額為 0`);
  });
  const t = entryTotals({ lines });
  if (Math.abs(t.debit - t.credit) > 0.004) errs.push(`借貸不平衡：借 ${t.debit}／貸 ${t.credit}`);
  return errs;
}

// 依科目方向計算餘額（正數＝正常方向）
export function naturalBalance(acc, debit, credit) {
  return round2(acc && acc.side === 'credit' ? credit - debit : debit - credit);
}

export function isPosted(e) {
  return e.status !== 'void';
}

// 攤平成過帳明細並排序
export function postings(entries, { from, to } = {}) {
  const out = [];
  for (const e of entries) {
    if (!isPosted(e)) continue;
    if (from && e.date < from) continue;
    if (to && e.date > to) continue;
    (e.lines || []).forEach((l, i) => {
      if (!l.account) return;
      out.push({ entry: e, i, date: e.date, voucher_no: e.voucher_no || '', account: l.account, debit: Number(l.debit) || 0, credit: Number(l.credit) || 0, memo: l.memo || e.description || '', partner: l.partner || '' });
    });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.voucher_no < b.voucher_no ? -1 : a.voucher_no > b.voucher_no ? 1 : a.i - b.i));
  return out;
}

function sumsBy(entries, { from, to } = {}) {
  const m = new Map();
  for (const p of postings(entries, { from, to })) {
    const s = m.get(p.account) || { debit: 0, credit: 0 };
    s.debit += p.debit;
    s.credit += p.credit;
    m.set(p.account, s);
  }
  return m;
}

function dayBefore(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// 分類帳：期初、逐筆、餘額
export function generalLedger(entries, accounts, { from, to, codes } = {}) {
  const accMap = accountMap(accounts);
  const opening = from ? sumsBy(entries, { to: dayBefore(from) }) : new Map();
  const result = new Map();
  const want = codes ? new Set(codes) : null;
  for (const p of postings(entries, { from, to })) {
    if (want && !want.has(p.account)) continue;
    let g = result.get(p.account);
    if (!g) {
      const acc = accMap.get(p.account);
      const o = opening.get(p.account) || { debit: 0, credit: 0 };
      g = { account: acc || { code: p.account, name: '（未知科目）', side: 'debit' }, opening: naturalBalance(acc, o.debit, o.credit), rows: [], debit: 0, credit: 0 };
      g.running = g.opening;
      result.set(p.account, g);
    }
    g.debit = round2(g.debit + p.debit);
    g.credit = round2(g.credit + p.credit);
    g.running = round2(g.running + (g.account.side === 'credit' ? p.credit - p.debit : p.debit - p.credit));
    g.rows.push({ ...p, balance: g.running });
  }
  // 有期初餘額但本期無交易的科目
  for (const [code, o] of opening) {
    if (result.has(code) || (want && !want.has(code))) continue;
    const acc = accMap.get(code);
    const bal = naturalBalance(acc, o.debit, o.credit);
    if (Math.abs(bal) < 0.005) continue;
    result.set(code, { account: acc || { code, name: '（未知科目）', side: 'debit' }, opening: bal, rows: [], debit: 0, credit: 0, running: bal });
  }
  for (const g of result.values()) g.closing = g.running;
  return new Map([...result.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

// 試算表（期初 + 本期發生 + 期末，借貸兩欄式）
export function trialBalance(entries, accounts, { from, to } = {}) {
  const accMap = accountMap(accounts);
  const opening = from ? sumsBy(entries, { to: dayBefore(from) }) : new Map();
  const period = sumsBy(entries, { from, to });
  const codes = new Set([...opening.keys(), ...period.keys()]);
  const rows = [];
  const tot = { openDr: 0, openCr: 0, periodDr: 0, periodCr: 0, closeDr: 0, closeCr: 0 };
  for (const code of [...codes].sort()) {
    const acc = accMap.get(code) || { code, name: '（未知科目）', type: 'asset', side: 'debit' };
    const o = opening.get(code) || { debit: 0, credit: 0 };
    const p = period.get(code) || { debit: 0, credit: 0 };
    const openNet = round2(o.debit - o.credit);
    const closeNet = round2(openNet + p.debit - p.credit);
    const row = {
      code,
      name: acc.name,
      type: acc.type,
      openDr: openNet > 0 ? openNet : 0,
      openCr: openNet < 0 ? -openNet : 0,
      periodDr: round2(p.debit),
      periodCr: round2(p.credit),
      closeDr: closeNet > 0 ? closeNet : 0,
      closeCr: closeNet < 0 ? -closeNet : 0,
    };
    if (!row.openDr && !row.openCr && !row.periodDr && !row.periodCr) continue;
    for (const k of Object.keys(tot)) tot[k] = round2(tot[k] + row[k]);
    rows.push(row);
  }
  const balanced = Math.abs(tot.closeDr - tot.closeCr) < 0.01 && Math.abs(tot.periodDr - tot.periodCr) < 0.01;
  return { rows, totals: tot, balanced };
}

function balancesByType(entries, accounts, range) {
  const accMap = accountMap(accounts);
  const sums = sumsBy(entries, range);
  const list = [];
  for (const [code, s] of sums) {
    const acc = accMap.get(code) || { code, name: '（未知科目）', type: 'expense', side: 'debit' };
    list.push({ code, name: acc.name, type: acc.type, contra: !!acc.contra, grp: acc.grp, behavior: acc.behavior, tax_line: acc.tax_line, amount: naturalBalance(acc, s.debit, s.credit), net: round2(s.debit - s.credit) });
  }
  return list.sort((a, b) => (a.code < b.code ? -1 : 1));
}

// 綜合損益表（預設排除年底結帳分錄，否則損益科目會被結清為 0）
export function incomeStatement(entries, accounts, { from, to, includeClosing = false } = {}) {
  const src = includeClosing ? entries : entries.filter((e) => e.source !== 'closing');
  const rows = balancesByType(src, accounts, { from, to }).filter((r) => PL_TYPES.has(r.type));
  const pick = (type, pred = () => true) => rows.filter((r) => r.type === type && pred(r) && Math.abs(r.amount) > 0.004);
  const s = (arr) => round2(arr.reduce((t, r) => t + r.amount, 0));
  const revenue = pick('revenue', (r) => !r.contra);
  const contra = pick('revenue', (r) => r.contra);
  const grossRevenue = s(revenue);
  const contraTotal = s(contra);
  const netRevenue = round2(grossRevenue - contraTotal);
  const cogs = pick('cogs');
  const cogsTotal = s(cogs);
  const grossProfit = round2(netRevenue - cogsTotal);
  const opex = pick('expense');
  const opexTotal = s(opex);
  const operatingIncome = round2(grossProfit - opexTotal);
  const nonopIncome = pick('nonop_income');
  const nonopExpense = pick('nonop_expense');
  const pretax = round2(operatingIncome + s(nonopIncome) - s(nonopExpense));
  const tax = pick('tax');
  const netIncome = round2(pretax - s(tax));
  return {
    revenue, contra, grossRevenue, contraTotal, netRevenue,
    cogs, cogsTotal, grossProfit,
    opex, opexTotal, operatingIncome,
    nonopIncome, nonopIncomeTotal: s(nonopIncome), nonopExpense, nonopExpenseTotal: s(nonopExpense),
    pretax, tax, taxTotal: s(tax), netIncome,
    oci: 0, comprehensiveIncome: netIncome,
    grossMargin: netRevenue ? grossProfit / netRevenue : null,
    operatingMargin: netRevenue ? operatingIncome / netRevenue : null,
  };
}

// 資產負債表：本年度損益併入權益「本期損益」，以前年度未結轉者併入「累積盈虧」
export function balanceSheet(entries, accounts, { asOf, fiscalYearStart } = {}) {
  const fy = fiscalYearStart || `${asOf.slice(0, 4)}-01-01`;
  const all = balancesByType(entries, accounts, { to: asOf });
  const nz = (r) => Math.abs(r.amount) > 0.004;
  const assetsCurrent = all.filter((r) => r.type === 'asset' && r.grp !== 'noncurrent' && nz(r));
  const assetsNon = all.filter((r) => r.type === 'asset' && r.grp === 'noncurrent' && nz(r)).map((r) => (r.contra ? { ...r, amount: -r.amount } : r));
  const liabCurrent = all.filter((r) => r.type === 'liability' && r.grp !== 'noncurrent' && nz(r));
  const liabNon = all.filter((r) => r.type === 'liability' && r.grp === 'noncurrent' && nz(r));
  const equity = all.filter((r) => r.type === 'equity' && nz(r)).map((r) => (r.contra ? { ...r, amount: -r.amount } : r));
  // 含結帳分錄：已結帳年度的損益科目為 0，金額已在 3301／3201 科目中
  const priorPL = incomeStatement(entries, accounts, { to: dayBefore(fy), includeClosing: true }).netIncome;
  const currentPL = incomeStatement(entries, accounts, { from: fy, to: asOf, includeClosing: true }).netIncome;
  const s = (arr) => round2(arr.reduce((t, r) => t + r.amount, 0));
  const totalAssets = round2(s(assetsCurrent) + s(assetsNon));
  const totalLiab = round2(s(liabCurrent) + s(liabNon));
  const equityRows = [...equity];
  if (Math.abs(priorPL) > 0.004) equityRows.push({ code: '3201*', name: '累積盈虧（以前年度未結轉損益）', amount: priorPL, computed: true });
  equityRows.push({ code: '3301*', name: '本期損益（本年度至今）', amount: currentPL, computed: true });
  const totalEquity = s(equityRows);
  return {
    asOf,
    assetsCurrent, assetsNon, totalAssetsCurrent: s(assetsCurrent), totalAssetsNon: s(assetsNon), totalAssets,
    liabCurrent, liabNon, totalLiabCurrent: s(liabCurrent), totalLiabNon: s(liabNon), totalLiab,
    equity: equityRows, totalEquity,
    balanced: Math.abs(totalAssets - totalLiab - totalEquity) < 0.01,
    diff: round2(totalAssets - totalLiab - totalEquity),
  };
}

export function accountBalance(entries, accounts, code, { from, to } = {}) {
  const acc = accountMap(accounts).get(code);
  const s = sumsBy(entries, { from, to }).get(code) || { debit: 0, credit: 0 };
  return naturalBalance(acc, s.debit, s.credit);
}

// 傳票種類：借方全為現金 → 現金收入；貸方全為現金 → 現金支出；其餘 → 轉帳
export function voucherKind(e) {
  const lines = e.lines || [];
  const dr = lines.filter((l) => Number(l.debit));
  const cr = lines.filter((l) => Number(l.credit));
  if (dr.length && dr.every((l) => CASH_CODES.has(l.account)) && !cr.some((l) => CASH_CODES.has(l.account))) return '現金收入傳票';
  if (cr.length && cr.every((l) => CASH_CODES.has(l.account)) && !dr.some((l) => CASH_CODES.has(l.account))) return '現金支出傳票';
  return '轉帳傳票';
}

// 傳票號碼：民國年月 + 當月流水號，例 11509-0001
export function voucherPrefix(date) {
  return `${Number(date.slice(0, 4)) - 1911}${date.slice(5, 7)}`;
}

export function nextVoucherNo(entries, date) {
  const prefix = voucherPrefix(date) + '-';
  let max = 0;
  for (const e of entries) {
    if (e.voucher_no && e.voucher_no.startsWith(prefix)) max = Math.max(max, Number(e.voucher_no.slice(prefix.length)) || 0);
  }
  return prefix + String(max + 1).padStart(4, '0');
}

// 依日期重新編排某月傳票號（結帳前整理用）
export function renumberMonth(entries, ym) {
  const list = entries.filter((e) => e.date.startsWith(ym)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.created_at || '') < (b.created_at || '') ? -1 : 1));
  const prefix = voucherPrefix(ym + '-01') + '-';
  list.forEach((e, i) => {
    e.voucher_no = prefix + String(i + 1).padStart(4, '0');
  });
  return list;
}

// 年底結帳分錄：損益類科目歸零，差額轉入本期損益
export function closingEntry(entries, accounts, year) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const rows = balancesByType(entries.filter((e) => e.source !== 'closing' || !String(e.source_ref).startsWith(String(year))), accounts, { from, to }).filter((r) => PL_TYPES.has(r.type) && Math.abs(r.net) > 0.004);
  const lines = rows.map((r) => (r.net > 0 ? { account: r.code, debit: 0, credit: r.net, memo: '結清損益科目' } : { account: r.code, debit: -r.net, credit: 0, memo: '結清損益科目' }));
  const net = round2(rows.reduce((t, r) => t + r.net, 0)); // 借方淨額 > 0 表示淨損
  if (net > 0) lines.push({ account: '3301', debit: net, credit: 0, memo: '本期淨損' });
  else if (net < 0) lines.push({ account: '3301', debit: 0, credit: -net, memo: '本期淨利' });
  return { date: to, description: `${year - 1911} 年度結帳（損益科目結轉本期損益）`, source: 'closing', source_ref: `${year}`, lines };
}
