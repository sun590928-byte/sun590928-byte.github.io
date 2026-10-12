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

// 統一發票號碼：2 碼英文字軌＋8 碼數字；公用事業（水電瓦斯電信）的載具發票為 BB＋8 碼英數
export const INVOICE_NO_RE = /^(?:[A-Z]{2}\d{8}|BB[0-9A-Z]{8})$/;
export function normalizeInvoiceNo(v) {
  return String(v ?? '').normalize('NFKC').toUpperCase().replace(/[\s-]/g, '');
}

// 進項媒體申報代號（財政部格式）
export const TAX_TYPES = { 1: '應稅', 2: '零稅率', 3: '免稅' };
export const DED_CODES = { 1: '可扣抵之進貨及費用', 2: '可扣抵之固定資產', 3: '不可扣抵之進貨及費用', 4: '不可扣抵之固定資產' };

// 收銀機發票載明本店統編、但沒有分開印稅額：稅額＝總額 ÷ 1.05 × 5%
export function impliedTax(d, taxId) {
  if (!/收銀機/.test(d.invoice_type || '') || Number(d.tax_amount) > 0 || !d.invoice_no) return null;
  if (!taxId || d.buyer_tax_id !== taxId) return null;
  const total = Number(d.amount_total) || 0;
  return total > 0 ? Math.round(total - total / 1.05) : null;
}

// 單張進項憑證可否扣抵（手動指定的扣抵代號優先）
export function deductibility(item, { taxId = '', vatMode = 'general' } = {}) {
  if (vatMode !== 'general') return { ok: false, reason: '非一般稅額營業人，不適用進項扣抵' };
  if (!item.invoice_no) return { ok: false, reason: '沒有統一發票號碼（收據不能扣抵）' };
  if (item.ded_code === '3' || item.ded_code === '4') return { ok: false, reason: `扣抵代號 ${item.ded_code}（${DED_CODES[item.ded_code]}）` };
  if (item.tax_type === '2' || item.tax_type === '3') return { ok: false, reason: `課稅別 ${item.tax_type}（${TAX_TYPES[item.tax_type]}），沒有進項稅額` };
  if (!(Number(item.tax) > 0)) return { ok: false, reason: '未載明稅額' };
  if (item.ded_code === '1' || item.ded_code === '2') return { ok: true, reason: '' };
  if (NON_DEDUCTIBLE_ACCOUNTS[item.account]) return { ok: false, reason: NON_DEDUCTIBLE_ACCOUNTS[item.account] };
  if (item.buyer_tax_id && taxId && item.buyer_tax_id !== taxId) return { ok: false, reason: `買方統編 ${item.buyer_tax_id} 不是本店` };
  if (item.invoice_type && /二聯|收據/.test(item.invoice_type)) return { ok: false, reason: `${item.invoice_type}不能扣抵` };
  if (item.deductible === false) return { ok: false, reason: '未載明本店統編（二聯式或個人載具發票）' };
  return { ok: true, reason: '' };
}

/**
 * 課稅別與扣抵代號（申報時逐張登打用）；手動指定者優先。
 * @param ok 依 deductibility() 判斷可否扣抵
 */
export function taxCodes(item, ok) {
  const asset = FIXED_ASSET_ACCOUNTS.has(item.account);
  const taxType = item.tax_type || (Number(item.tax) > 0 || /二聯|收銀機|收據/.test(item.invoice_type || '') || !item.buyer_tax_id ? '1' : '3');
  const dedCode = item.ded_code || (ok ? (asset ? '2' : '1') : asset ? '4' : '3');
  return { tax_type: taxType, ded_code: dedCode };
}

// 憑證的明細（拆分）：沒有 lines 時整張視為一行
export function docParts(d) {
  if (Array.isArray(d.lines) && d.lines.length) {
    return d.lines.map((p, i) => ({
      key: `${d.id}:${i}`,
      invoice_no: p.invoice_no || '',
      account: p.account || d.account || '',
      total: round2(Number(p.amount) || 0),
      tax: round2(Number(p.tax) || 0),
      deductible: p.deductible ?? d.deductible,
      tax_type: p.tax_type || '',
      ded_code: p.ded_code || '',
      memo: p.memo || '',
    }));
  }
  return [{ key: d.id, invoice_no: d.invoice_no || '', account: d.account || '', total: round2(Number(d.amount_total) || 0), tax: round2(Number(d.tax_amount) || 0), deductible: d.deductible, tax_type: d.tax_type || '', ded_code: d.ded_code || '', memo: '' }];
}

/**
 * 把已入帳的發票照片與電子發票整理成進項清單（同一發票號碼只算一次；拆分的憑證每張發票各一行）。
 * @returns [{ id, doc_id, source, date, invoice_no, vendor, vendor_tax_id, buyer_tax_id, invoice_type, account, use, total, tax, ex, deductible, tax_type, ded_code, entry_id }]
 */
export function inputItems(docs, einvoices) {
  const out = [];
  const seen = new Set();
  for (const d of docs) {
    if (d.status !== 'posted' || !d.entry_id || d.kind === 'payout_statement' || !d.doc_date) continue;
    for (const p of docParts(d)) {
      const key = p.invoice_no || 'doc:' + p.key;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: p.key, doc_id: d.id, source: 'doc', date: d.doc_date, invoice_no: p.invoice_no, vendor: d.vendor_name || '', vendor_tax_id: d.vendor_tax_id || '', buyer_tax_id: d.buyer_tax_id || '', invoice_type: d.invoice_type || '', account: p.account, total: p.total, tax: p.tax, deductible: p.deductible, tax_type: p.tax_type, ded_code: p.ded_code, memo: p.memo, entry_id: d.entry_id });
    }
  }
  for (const e of einvoices) {
    if (!e.entry_id || e.voided || !e.date) continue;
    const key = e.invoice_no || 'einv:' + e.id;
    if (seen.has(key)) continue;
    seen.add(key);
    const total = round2(Number(e.total) || 0);
    const tax = round2(Number(e.tax) || 0);
    out.push({ id: e.id, source: 'einv', date: e.date, invoice_no: e.invoice_no || '', vendor: e.seller_name || '', vendor_tax_id: e.seller_tax_id || '', buyer_tax_id: e.buyer_tax_id || '', invoice_type: '電子發票', account: e.account || e.suggested_account || '', total, tax, deductible: e.deductible, tax_type: e.tax_type || '', ded_code: e.ded_code || '', entry_id: e.entry_id });
  }
  for (const it of out) {
    it.use = FIXED_ASSET_ACCOUNTS.has(it.account) ? 'asset' : 'expense';
    it.ex = round2(it.total - it.tax);
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.invoice_no < b.invoice_no ? -1 : 1));
}

/**
 * 進項憑證歸屬期別：已申報期別的清單為準（含匯入的申報媒體檔發票號碼）；
 * 逾期入帳者（原期別已申報、也不在申報清單內）順延到之後第一個未申報期別。
 * @param filings tax_filings 紀錄（status: draft|filed|paid, claimed: [id], filed_inputs: [{ invoice_no }]）
 */
export function assignPeriods(items, filings) {
  const filed = new Map(filings.filter((f) => f.status === 'filed' || f.status === 'paid').map((f) => [f.id, f]));
  const claimedIn = new Map();
  const filedInv = new Map();
  for (const f of filed.values()) {
    for (const id of f.claimed || []) claimedIn.set(id, f.id);
    for (const x of f.filed_inputs || []) if (x.invoice_no) filedInv.set(x.invoice_no, f.id);
  }
  const firstOpenFrom = (k) => {
    let p = k;
    while (filed.has(p)) p = addMonths(p, 2);
    return p;
  };
  return items.map((it) => {
    const own = periodKeyOf(it.date);
    const period = claimedIn.get(it.id) || (it.invoice_no && filedInv.get(it.invoice_no)) || (filed.has(own) ? firstOpenFrom(own) : own);
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

// ─────────── 申報媒體檔（財政部「營業人進銷項資料」TXT，每列 81 字元）

export const MEDIA_FORMATS = {
  21: '進項三聯式／電子計算機發票',
  22: '進項二聯式收銀機發票／載有稅額之其他憑證',
  23: '進貨退出或折讓（三聯式）',
  24: '進貨退出或折讓（二聯式）',
  25: '進項三聯式收銀機發票／電子發票',
  26: '進項彙總',
  27: '進項彙總（其他憑證）',
  28: '海關代徵營業稅繳納證',
  29: '海關退還溢繳營業稅',
  31: '銷項三聯式',
  32: '銷項二聯式',
  33: '銷貨退回或折讓（三聯式）',
  34: '銷貨退回或折讓（二聯式）',
  35: '銷項三聯式收銀機發票／電子發票',
  36: '銷項免用發票',
  37: '銷項特種稅額',
};

/**
 * 解析申報媒體檔（Big5 或 UTF-8 先解碼成文字）。
 * 欄位：格式代號(2) 稅籍編號(9) 流水號(7) 所屬年月(5，民國) 買方統編(8) 賣方統編(8) 發票號碼(10) 銷售額(12) 課稅別(1) 稅額(10) 扣抵代號(1)…
 * 銷項的課稅別 F＝作廢、D＝空白未使用。
 * @returns {{ rows: object[], errors: string[] }}
 */
export function parseMediaFile(text) {
  const rows = [];
  const errors = [];
  String(text || '')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .forEach((line, i) => {
      if (!line.trim()) return;
      if (line.length < 73 || !/^\d{2}$/.test(line.slice(0, 2)) || !/^\d{5}$/.test(line.slice(18, 23))) {
        errors.push(`第 ${i + 1} 列格式不符（長度 ${line.length}）`);
        return;
      }
      const ym = line.slice(18, 23);
      rows.push({
        fmt: line.slice(0, 2),
        ym: `${Number(ym.slice(0, 3)) + 1911}-${ym.slice(3, 5)}`,
        buyer: line.slice(23, 31).trim(),
        seller: line.slice(31, 39).trim(),
        invoice_no: line.slice(39, 49).trim(),
        amount: Number(line.slice(49, 61)) || 0,
        tax_type: line.slice(61, 62).trim(),
        tax: Number(line.slice(62, 72)) || 0,
        ded_code: line.slice(72, 73).trim(),
      });
    });
  return { rows, errors };
}

/** 彙總媒體檔：進項（可扣抵進貨費用／固定資產、不可扣抵）、銷項（作廢、空白、B2B／B2C 估算） */
export function summarizeMedia(rows) {
  const inputs = rows.filter((r) => r.fmt[0] === '2');
  const outputs = rows.filter((r) => r.fmt[0] === '3');
  const sum = (list, k) => round2(list.reduce((t, r) => t + (r[k] || 0), 0));
  const byCode = (code) => inputs.filter((r) => r.ded_code === code);
  const live = outputs.filter((r) => r.tax_type !== 'F' && r.tax_type !== 'D');
  const b2b = live.filter((r) => r.buyer);
  const b2c = live.filter((r) => !r.buyer);
  const b2cIncl = sum(b2c, 'amount');
  const b2cEx = Math.round(b2cIncl / 1.05);
  return {
    periods: [...new Set(rows.map((r) => periodKeyOf(`${r.ym}-01`)))].sort(),
    months: [...new Set(rows.map((r) => r.ym))].sort(),
    inputs: {
      count: inputs.length,
      amount: sum(inputs, 'amount'),
      tax: sum(inputs, 'tax'),
      expense: { count: byCode('1').length, amount: sum(byCode('1'), 'amount'), tax: sum(byCode('1'), 'tax') },
      asset: { count: byCode('2').length, amount: sum(byCode('2'), 'amount'), tax: sum(byCode('2'), 'tax') },
      nonDeductible: { count: byCode('3').length + byCode('4').length, amount: round2(sum(byCode('3'), 'amount') + sum(byCode('4'), 'amount')) },
    },
    outputs: {
      count: outputs.length,
      voided: outputs.filter((r) => r.tax_type === 'F').length,
      blank: outputs.filter((r) => r.tax_type === 'D').length,
      b2b: { count: b2b.length, amount: sum(b2b, 'amount'), tax: sum(b2b, 'tax') },
      b2c: { count: b2c.length, amountIncl: b2cIncl },
      salesEx: round2(sum(b2b, 'amount') + b2cEx),
      tax: round2(sum(b2b, 'tax') + (b2cIncl - b2cEx)),
    },
  };
}

/**
 * 申報媒體檔的進項 vs 系統憑證。
 * @param filed 媒體檔進項列（格式 2x）
 * @param parts 系統憑證明細：[{ invoice_no, doc_id, status, total, tax, ex, ded_code, period, label }]
 * @returns {{ matched: {filed, part, diffs}[], filedOnly: object[], bookedOnly: object[] }}
 */
export function reconcileMedia(filed, parts, { periodKey } = {}) {
  const byInv = new Map();
  for (const p of parts) if (p.invoice_no && !byInv.has(p.invoice_no)) byInv.set(p.invoice_no, p);
  const filedNos = new Set();
  const matched = [];
  const filedOnly = [];
  for (const f of filed) {
    filedNos.add(f.invoice_no);
    const p = byInv.get(f.invoice_no);
    if (!p) {
      filedOnly.push(f);
      continue;
    }
    const diffs = [];
    if (Math.abs(p.ex - f.amount) >= 1) diffs.push(`銷售額 系統 ${p.ex}／申報 ${f.amount}`);
    const pTax = p.ded_code === '1' || p.ded_code === '2' ? p.tax : 0;
    const fTax = f.ded_code === '1' || f.ded_code === '2' ? f.tax : 0;
    if (Math.abs(pTax - fTax) >= 1) diffs.push(`可扣抵稅額 系統 ${pTax}／申報 ${fTax}`);
    if (p.ded_code && f.ded_code && p.ded_code !== f.ded_code) diffs.push(`扣抵代號 系統 ${p.ded_code}／申報 ${f.ded_code}`);
    matched.push({ filed: f, part: p, diffs });
  }
  const bookedOnly = parts.filter((p) => p.invoice_no && !filedNos.has(p.invoice_no) && p.status === 'posted' && (!periodKey || p.period === periodKey));
  return { matched, filedOnly, bookedOnly };
}
