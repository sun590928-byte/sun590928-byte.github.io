// 營業稅（401）申報工作表：一般稅額營業人每兩個月一期（1–2、3–4…11–12 月），次期單月 15 日前申報。
// 銷項：POS 開立發票金額（作廢不開發票；寄杯依設定於售出或兌換時開立）與帳上銷項稅額，另可輸入電子發票平台數字核對。
// 進項：已入帳的發票照片與電子發票；只有統一發票、載明本店統編、非交際／職工福利用途者可扣抵。
// 稅額：銷項稅額 − 得扣抵進項稅額 − 上期累積留抵；溢付時固定資產進項稅額部分可申請退稅，其餘留抵。

import { round2 } from './money.js';
import { ASSET_CATEGORIES } from './coa.js';
import { monthEnd, addMonths } from './dates.js';
import { shiftWeekend, internalTargets } from './taxcal.js';

export { internalTargets };

export const NON_DEDUCTIBLE_ACCOUNTS = {
  6120: '交際應酬用途，依營業稅法第 19 條不得扣抵',
  6127: '職工福利用途，依營業稅法第 19 條不得扣抵',
};
export const FIXED_ASSET_ACCOUNTS = new Set(Object.values(ASSET_CATEGORIES).map((c) => c.asset));

const pad = (n) => String(n).padStart(2, '0');

// 期別：以單月開頭的兩個月
export function periodKeyOf(ymd) {
  const y = Number(ymd.slice(0, 4));
  const m = Number(ymd.slice(5, 7));
  return `${y}-${pad(m % 2 === 1 ? m : m - 1)}`;
}

export function periodInfo(key) {
  const from = key;
  const to = addMonths(key, 1);
  const y = Number(key.slice(0, 4));
  const m1 = Number(key.slice(5));
  const dueMonth = addMonths(key, 2);
  const legal = `${dueMonth}-15`;
  return {
    key,
    from,
    to,
    start: `${from}-01`,
    end: monthEnd(to),
    label: `${y - 1911} 年 ${m1}–${m1 + 1} 月`,
    legal,
    due: shiftWeekend(legal),
  };
}

export function periodsBetween(fromYmd, toYmd) {
  const out = [];
  for (let k = periodKeyOf(fromYmd); k <= periodKeyOf(toYmd); k = addMonths(k, 2)) out.push(periodInfo(k));
  return out;
}

// 單張進項憑證可否扣抵
export function deductibility(item, { taxId = '', vatMode = 'general' } = {}) {
  if (vatMode !== 'general') return { ok: false, reason: '非一般稅額營業人，不適用進項扣抵' };
  if (!item.invoice_no) return { ok: false, reason: '沒有統一發票號碼（收據不能扣抵）' };
  if (!(Number(item.tax) > 0)) return { ok: false, reason: '未載明稅額' };
  if (NON_DEDUCTIBLE_ACCOUNTS[item.account]) return { ok: false, reason: NON_DEDUCTIBLE_ACCOUNTS[item.account] };
  if (item.buyer_tax_id && taxId && item.buyer_tax_id !== taxId) return { ok: false, reason: `買方統編 ${item.buyer_tax_id} 不是本店` };
  if (item.invoice_type && /二聯|收據/.test(item.invoice_type)) return { ok: false, reason: `${item.invoice_type}不能扣抵` };
  if (item.deductible === false) return { ok: false, reason: '未載明本店統編（二聯式或個人載具發票）' };
  return { ok: true, reason: '' };
}

/**
 * 把已入帳的發票照片與電子發票整理成進項清單（同一發票號碼只算一次）。
 * @returns [{ id, source, date, invoice_no, vendor, vendor_tax_id, buyer_tax_id, invoice_type, account, use, total, tax, ex, deductible, entry_id }]
 */
export function inputItems(docs, einvoices) {
  const out = [];
  const seen = new Set();
  for (const d of docs) {
    if (d.status !== 'posted' || !d.entry_id || d.kind === 'payout_statement' || !d.doc_date) continue;
    const key = d.invoice_no || 'doc:' + d.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const total = round2(Number(d.amount_total) || 0);
    const tax = round2(Number(d.tax_amount) || 0);
    out.push({ id: d.id, source: 'doc', date: d.doc_date, invoice_no: d.invoice_no || '', vendor: d.vendor_name || '', vendor_tax_id: d.vendor_tax_id || '', buyer_tax_id: d.buyer_tax_id || '', invoice_type: d.invoice_type || '', account: d.account || '', total, tax, deductible: d.deductible, entry_id: d.entry_id });
  }
  for (const e of einvoices) {
    if (!e.entry_id || e.voided || !e.date) continue;
    const key = e.invoice_no || 'einv:' + e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const total = round2(Number(e.total) || 0);
    const tax = round2(Number(e.tax) || 0);
    out.push({ id: e.id, source: 'einv', date: e.date, invoice_no: e.invoice_no || '', vendor: e.seller_name || '', vendor_tax_id: e.seller_tax_id || '', buyer_tax_id: e.buyer_tax_id || '', invoice_type: '電子發票', account: e.account || e.suggested_account || '', total, tax, deductible: e.deductible, entry_id: e.entry_id });
  }
  for (const it of out) {
    it.use = FIXED_ASSET_ACCOUNTS.has(it.account) ? 'asset' : 'expense';
    it.ex = round2(it.total - it.tax);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.invoice_no < b.invoice_no ? -1 : 1));
}

/**
 * 進項憑證歸屬期別：已申報期別的清單為準；逾期入帳者（原期別已申報）順延到之後第一個未申報期別。
 * @param filings tax_filings 紀錄（status: draft|filed|paid, claimed: [id]）
 */
export function assignPeriods(items, filings) {
  const filed = new Map(filings.filter((f) => f.status === 'filed' || f.status === 'paid').map((f) => [f.id, f]));
  const claimedIn = new Map();
  for (const f of filed.values()) for (const id of f.claimed || []) claimedIn.set(id, f.id);
  const firstOpenFrom = (k) => {
    let p = k;
    while (filed.has(p)) p = addMonths(p, 2);
    return p;
  };
  return items.map((it) => {
    const own = periodKeyOf(it.date);
    const period = claimedIn.get(it.id) || (filed.has(own) ? firstOpenFrom(own) : own);
    return { ...it, period, late: period !== own };
  });
}

// 帳上某科目在期間內的淨額（借 − 貸）；exclude 為要排除的分錄來源
export function netMovement(entries, account, { from, to, exclude = [] } = {}) {
  let n = 0;
  for (const e of entries) {
    if (e.status === 'void' || exclude.includes(e.source)) continue;
    if ((from && e.date < from) || (to && e.date > to)) continue;
    for (const l of e.lines || []) if (l.account === account) n += (Number(l.debit) || 0) - (Number(l.credit) || 0);
  }
  return round2(n);
}

/**
 * POS 開立發票基礎：作廢（招待／測試／報廢）不開發票；寄杯依設定於售出（sale）或兌換（redeem）時開立。
 * @returns { receipts 含稅, salesEx 未稅, tax, excluded: { void, redeem, prepaidSale }, voidByReason }
 */
export function posInvoiceBase(lines, { categoryOf = () => 'other', prepaidVat = 'sale' } = {}) {
  let receipts = 0;
  const excluded = { void: 0, redeem: 0, prepaidSale: 0 };
  const voidByReason = {};
  for (const l of lines) {
    const amt = Number(l.amount) || 0;
    if (l.void_reason) {
      excluded.void += amt;
      const r = (voidByReason[l.void_reason] ||= { qty: 0, amount: 0 });
      r.qty += Number(l.qty) || 0;
      r.amount += amt;
      continue;
    }
    if (prepaidVat !== 'redeem' && l.payment === 'prepaid') {
      excluded.redeem += amt;
      continue;
    }
    if (prepaidVat === 'redeem' && categoryOf(l) === 'prepaid') {
      excluded.prepaidSale += amt;
      continue;
    }
    receipts += amt;
  }
  receipts = round2(receipts);
  const salesEx = Math.round(receipts / 1.05);
  return { receipts, salesEx, tax: round2(receipts - salesEx), excluded, voidByReason };
}

/**
 * 稅額計算（401 第三段）
 * @returns { output, input, inputExpense, inputAsset, prevCf, payable, overpaid, refund, cf }
 */
export function computeTax({ output, inputExpense, inputAsset, prevCf = 0 }) {
  output = round2(output || 0);
  inputExpense = round2(inputExpense || 0);
  inputAsset = round2(inputAsset || 0);
  prevCf = round2(prevCf || 0);
  const input = round2(inputExpense + inputAsset);
  const net = round2(output - input - prevCf);
  if (net >= 0) return { output, input, inputExpense, inputAsset, prevCf, payable: net, overpaid: 0, refund: 0, cf: 0 };
  const overpaid = -net;
  const refund = Math.min(overpaid, inputAsset); // 得退稅限額：固定資產進項稅額（無零稅率銷售）
  return { output, input, inputExpense, inputAsset, prevCf, payable: 0, overpaid, refund, cf: round2(overpaid - refund) };
}

/**
 * 營業稅結轉分錄（期末日）：沖銷銷項稅額、進項稅額與上期留抵，列應付營業稅／留抵稅額／應收退稅款，尾差列營業外。
 * @param bookOutput 帳上 2131 期末貸方餘額；bookInput 帳上 1261 期末借方餘額
 */
export function settlementEntry(period, { bookOutput, bookInput, tax }) {
  const lines = [];
  const L = (account, debit, credit, memo) => (debit || credit) && lines.push({ account, debit: round2(debit), credit: round2(credit), memo });
  L('2131', bookOutput > 0 ? bookOutput : 0, bookOutput < 0 ? -bookOutput : 0, '沖轉本期銷項稅額');
  L('1261', bookInput < 0 ? -bookInput : 0, bookInput > 0 ? bookInput : 0, '沖轉本期進項稅額');
  const usedCf = tax.prevCf;
  L('1262', 0, usedCf, '上期累積留抵稅額');
  L('1262', tax.cf, 0, '本期累積留抵稅額');
  L('1151', tax.refund, 0, '應收營業稅退稅款');
  L('2132', 0, tax.payable, '本期應納營業稅');
  const dr = lines.reduce((t, l) => t + l.debit, 0);
  const cr = lines.reduce((t, l) => t + l.credit, 0);
  const diff = round2(dr - cr);
  if (Math.abs(diff) >= 0.005) lines.push(diff > 0 ? { account: '7102', debit: 0, credit: diff, memo: '營業稅尾差' } : { account: '7503', debit: -diff, credit: 0, memo: '營業稅尾差' });
  const info = periodInfo(period);
  return { date: info.end, description: `營業稅結轉（${info.label}）`, source: 'vat', source_ref: period, lines };
}
