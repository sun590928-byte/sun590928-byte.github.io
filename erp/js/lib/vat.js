// 營業稅（401）申報工作表：一般稅額營業人每兩個月一期（1–2、3–4…11–12 月），次期單月 15 日前申報。
// 銷項：POS 開立發票金額（作廢不開發票；寄杯依設定於售出或兌換時開立）與帳上銷項稅額，另可輸入電子發票平台數字核對。
// 進項：已入帳的發票照片與電子發票；只有統一發票、載明本店統編、非交際／伙食／職工福利用途者可扣抵（水電電信帳單也要有本店統編）。
// 稅額：銷項稅額 − 得扣抵進項稅額 − 上期累積留抵；溢付時固定資產進項稅額部分可申請退稅，其餘留抵。

import { round2, parseAmount } from './money.js';
import { ASSET_CATEGORIES } from './coa.js';
import { monthEnd, addMonths, parseDate } from './dates.js';
import { shiftWeekend, internalTargets } from './taxcal.js';

export { internalTargets };

export const NON_DEDUCTIBLE_ACCOUNTS = {
  6120: '交際應酬用途，依營業稅法第 19 條不得扣抵',
  6126: '伙食費（員工餐）屬職工福利性質，不得扣抵',
  6127: '職工福利用途，依營業稅法第 19 條不得扣抵',
};
// 水電瓦斯、郵電（電話、網路）帳單：載明本店統編才可扣抵（2026-11-12 老闆定）
export const UTILITY_ACCOUNTS = { 6115: '郵電費', 6118: '水電瓦斯費' };

/**
 * 依會計項目一律不可扣抵的原因（沒有則回傳空字串）：交際費、伙食費、職工福利；水電電信帳單沒有本店統編。
 * 老闆指定的扣抵代號 1、2 不受影響（由 deductibility() 先判斷）。
 */
export function nonDeductibleByRule(item, taxId = '') {
  if (NON_DEDUCTIBLE_ACCOUNTS[item.account]) return NON_DEDUCTIBLE_ACCOUNTS[item.account];
  const util = UTILITY_ACCOUNTS[item.account];
  if (util) {
    const buyer = String(item.buyer_tax_id || '').trim();
    if (!buyer) return `${util}帳單沒有載明本店統編，不可扣抵（帳單上有本店統編時，請把扣抵代號選 1）`;
    if (taxId && buyer !== taxId) return `${util}帳單的買方統編 ${buyer} 不是本店，不可扣抵`;
  }
  return '';
}
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
  // 入帳時存下的代號 3、4：有規則可說明原因（伙食費、水電沒有本店統編…）就寫原因
  if (item.ded_code === '3' || item.ded_code === '4') return { ok: false, reason: nonDeductibleByRule(item, taxId) || `扣抵代號 ${item.ded_code}（${DED_CODES[item.ded_code]}）` };
  if (item.tax_type === '2' || item.tax_type === '3') return { ok: false, reason: `課稅別 ${item.tax_type}（${TAX_TYPES[item.tax_type]}），沒有進項稅額` };
  if (!(Number(item.tax) > 0)) return { ok: false, reason: '未載明稅額' };
  if (item.ded_code === '1' || item.ded_code === '2') return { ok: true, reason: '' };
  const rule = nonDeductibleByRule(item, taxId);
  if (rule) return { ok: false, reason: rule };
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
  // 發票號碼 → 第一次出現的憑證：別張憑證（或電子發票）的同號碼不重複算；同一張憑證拆成多行、同一個發票號碼（分屬不同科目）每一行都要列
  const seen = new Map();
  for (const d of docs) {
    if (d.status !== 'posted' || !d.entry_id || d.kind === 'payout_statement' || !d.doc_date) continue;
    for (const p of docParts(d)) {
      const key = p.invoice_no || 'doc:' + p.key;
      if (seen.has(key) && seen.get(key) !== d.id) continue;
      seen.set(key, d.id);
      out.push({ id: p.key, doc_id: d.id, source: 'doc', date: d.doc_date, invoice_no: p.invoice_no, vendor: d.vendor_name || '', vendor_tax_id: d.vendor_tax_id || '', buyer_tax_id: d.buyer_tax_id || '', invoice_type: d.invoice_type || '', account: p.account, total: p.total, tax: p.tax, deductible: p.deductible, tax_type: p.tax_type, ded_code: p.ded_code, memo: p.memo, entry_id: d.entry_id });
    }
  }
  for (const e of einvoices) {
    if (!e.entry_id || e.voided || !e.date) continue;
    const key = e.invoice_no || 'einv:' + e.id;
    if (seen.has(key)) continue;
    seen.set(key, 'einv:' + e.id);
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

/**
 * 不符扣抵條件、但分錄的進項稅額（1261）比可扣抵的稅額多者（申報前檢查用）。
 * 逐行判斷：同一筆分錄（例如拆分明細的憑證，一行可扣抵、一行不可扣抵）的 1261 與「可扣抵各行稅額合計」比較，
 * 不是只看分錄有沒有 1261。
 * @param items 本期進項（含 check）；all 全部進項（同一筆分錄的其他行可能歸在別期）
 */
export function overclaimed(items, all, entries, opts = {}) {
  const byEntry = new Map(entries.map((e) => [e.id, e]));
  const okTax = new Map();
  for (const it of all) {
    if (!it.entry_id) continue;
    const t = deductibility(it, opts).ok ? Number(it.tax) || 0 : 0;
    okTax.set(it.entry_id, round2((okTax.get(it.entry_id) || 0) + t));
  }
  const book1261 = (id) => round2((byEntry.get(id)?.lines || []).reduce((t, l) => t + (l.account === '1261' ? (Number(l.debit) || 0) - (Number(l.credit) || 0) : 0), 0));
  return items.filter((x) => !x.check.ok && x.entry_id && book1261(x.entry_id) - (okTax.get(x.entry_id) || 0) >= 1);
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
 * 銷項的課稅別 F＝作廢、D＝空白未使用。第 80 位「彙加註記」A＝彙加資料：銷項的第 24–31 位是發票訖號（讀成 end_no，買方統編留空）。
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
      const row = {
        fmt: line.slice(0, 2),
        ym: `${Number(ym.slice(0, 3)) + 1911}-${ym.slice(3, 5)}`,
        buyer: line.slice(23, 31).trim(),
        seller: line.slice(31, 39).trim(),
        invoice_no: line.slice(39, 49).trim(),
        amount: Number(line.slice(49, 61)) || 0,
        tax_type: line.slice(61, 62).trim(),
        tax: Number(line.slice(62, 72)) || 0,
        ded_code: line.slice(72, 73).trim(),
      };
      // 彙加資料：銷項的買方統編欄放的是發票訖號（同字軌）
      if (line.slice(79, 80) === 'A') {
        row.agg = 'A';
        if (row.fmt[0] === '3' && /^\d{8}$/.test(row.buyer) && /^[A-Z]{2}\d{8}$/.test(row.invoice_no)) {
          row.end_no = row.invoice_no.slice(0, 2) + row.buyer;
          row.buyer = '';
        }
      }
      rows.push(row);
    });
  return { rows, errors };
}

// 彙加列代表的發票張數（起號～訖號）
const rangeCount = (r) => (r.end_no ? Number(r.end_no.slice(2)) - Number(r.invoice_no.slice(2)) + 1 : 1);

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
  const periodOf = (r) => periodKeyOf(`${r.ym}-01`);
  const periods = [...new Set(rows.map(periodOf))].sort();
  return {
    periods,
    // 申報期別：以銷項（含作廢、空白）所屬期別為準；只有進項時取最晚的一期（逾期扣抵的進項所屬年月是發票開立年月）
    period: [...new Set(outputs.map(periodOf))].sort().pop() || periods[periods.length - 1] || null,
    salesPeriods: [...new Set(outputs.map(periodOf))].sort(),
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
      voided: outputs.filter((r) => r.tax_type === 'F').reduce((t, r) => t + rangeCount(r), 0),
      blank: outputs.filter((r) => r.tax_type === 'D').reduce((t, r) => t + rangeCount(r), 0),
      blankRecords: outputs.filter((r) => r.tax_type === 'D').length,
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
  const deducted = (p) => (p.ded_code === '1' || p.ded_code === '2' ? p.tax : 0);
  const byInv = new Map();
  for (const p of parts) {
    if (!p.invoice_no) continue;
    const q = byInv.get(p.invoice_no);
    if (!q) byInv.set(p.invoice_no, { ...p, dedTax: deducted(p) });
    else if (q.doc_id && q.doc_id === p.doc_id) {
      // 同一張憑證拆成多行、同一個發票號碼：金額、稅額合計後再和申報比
      q.total = round2((q.total || 0) + (p.total || 0));
      q.ex = round2(q.ex + p.ex);
      q.tax = round2(q.tax + p.tax);
      q.dedTax = round2(q.dedTax + deducted(p));
      if (q.ded_code !== p.ded_code) q.mixed = true;
    }
  }
  // 申報檔裡同一張發票分成多筆（例如一部分可扣抵、一部分不可扣抵）也合計
  const filedBy = new Map();
  for (const f of filed) {
    const g = filedBy.get(f.invoice_no);
    if (!g) filedBy.set(f.invoice_no, { ...f, dedTax: deducted(f) });
    else {
      g.amount = round2(g.amount + f.amount);
      g.tax = round2(g.tax + f.tax);
      g.dedTax = round2(g.dedTax + deducted(f));
      if (g.ded_code !== f.ded_code) g.mixed = true;
    }
  }
  const filedNos = new Set();
  const matched = [];
  const filedOnly = [];
  for (const f of filedBy.values()) {
    filedNos.add(f.invoice_no);
    const p = byInv.get(f.invoice_no);
    if (!p) {
      filedOnly.push(f);
      continue;
    }
    const diffs = [];
    if (Math.abs(p.ex - f.amount) >= 1) diffs.push(`銷售額 系統 ${p.ex}／申報 ${f.amount}`);
    const pTax = p.dedTax;
    const fTax = f.dedTax;
    if (Math.abs(pTax - fTax) >= 1) diffs.push(`可扣抵稅額 系統 ${pTax}／申報 ${fTax}`);
    if (!p.mixed && !f.mixed && p.ded_code && f.ded_code && p.ded_code !== f.ded_code) diffs.push(`扣抵代號 系統 ${p.ded_code}／申報 ${f.ded_code}`);
    matched.push({ filed: f, part: p, diffs });
  }
  const bookedOnly = parts.filter((p) => p.invoice_no && !filedNos.has(p.invoice_no) && p.status === 'posted' && (!periodKey || p.period === periodKey));
  return { matched, filedOnly, bookedOnly };
}

// ─────────── 產生申報媒體檔（與上面的解析互為反向：產生 → parseMediaFile → 同樣的資料）
// 依財政部「營業稅電子資料申報繳稅作業要點」附件的進銷項資料格式：每筆 81 位元組，只含英數字與空白（ASCII），每筆以 CRLF 結尾。
// 1–2 格式代號、3–11 稅籍編號、12–18 流水號、19–23 資料所屬年月（民國）、24–31 買受人統編（銷項彙加＝發票訖號）、
// 32–39 銷售人統編、40–49 發票字軌號碼（起號）、50–61 銷售額、62 課稅別、63–72 營業稅額、73 扣抵代號、74–78 空白、
// 79 特種稅額稅率、80 彙加註記、81 通關方式註記。數字欄靠右補 0；文字欄靠左補空白。

export const MEDIA_RECORD_LEN = 81;
const rocYm = (ym) => String(Number(ym.slice(0, 4)) - 1911).padStart(3, '0') + ym.slice(5, 7);

/**
 * 組一筆 81 位元組的資料。
 * @param r { fmt, regNo, seq, ym: 'YYYY-MM', buyer, seller, invoice_no, amount, tax_type, tax, ded_code, agg?, end_no? }
 * @returns {{ line: string|null, error: string }}
 */
export function mediaRecord(r) {
  const fail = (error) => ({ line: null, error });
  const num = (n, len) => {
    const v = Math.round(Number(n) || 0);
    return v >= 0 && String(v).length <= len ? String(v).padStart(len, '0') : null;
  };
  const txt = (s, len) => {
    const v = String(s ?? '');
    return v.length <= len && /^[0-9A-Z ]*$/.test(v) ? v.padEnd(len, ' ') : null;
  };
  if (!/^\d{2}$/.test(r.fmt || '')) return fail(`格式代號「${r.fmt}」不對`);
  if (!/^\d{9}$/.test(r.regNo || '')) return fail('稅籍編號要 9 碼數字');
  if (!/^\d{4}-\d{2}$/.test(r.ym || '')) return fail('缺發票日期');
  const agg = r.agg === 'A' ? 'A' : ' ';
  // 銷項彙加（空白發票、連號的二聯／B2C 發票）：買受人統編欄放發票訖號的 8 碼數字
  const buyerField = agg === 'A' && r.fmt[0] === '3' ? String(r.end_no || '').slice(2) : r.buyer || '';
  const fields = [
    r.fmt,
    r.regNo,
    num(r.seq, 7),
    rocYm(r.ym),
    txt(buyerField, 8),
    txt(r.seller || '', 8),
    txt(r.invoice_no || '', 10),
    num(r.amount, 12),
    txt(r.tax_type || '', 1),
    num(r.tax, 10),
    txt(r.ded_code || '', 1),
    '     ',
    ' ',
    agg,
    ' ',
  ];
  const names = ['格式代號', '稅籍編號', '流水號', '所屬年月', '買方統編', '賣方統編', '發票號碼', '銷售額', '課稅別', '稅額', '扣抵代號'];
  const bad = fields.findIndex((v) => v === null);
  if (bad >= 0) return fail(bad === 7 || bad === 9 ? `${names[bad]}不能是負數或超過位數（退回、折讓請在申報系統另外登打）` : `${names[bad]}格式不對`);
  const line = fields.join('');
  return line.length === MEDIA_RECORD_LEN ? { line, error: '' } : fail(`長度 ${line.length} 不是 81`);
}

// 進項格式代號：三聯式 21；二聯式收銀機／載有稅額之其他憑證 22；三聯式收銀機、電子發票（含公用事業 BB 載具）25
export function inputMediaFormat(it) {
  const t = it.invoice_type || '';
  if (/三聯/.test(t) && !/收銀機/.test(t)) return '21';
  if (/二聯|其他/.test(t)) return '22';
  return '25';
}

/**
 * 進項憑證 → 媒體檔資料。只列有統一發票號碼、載明本店統編（或判斷可扣抵）的發票；收據、個人載具、二聯式不必申報。
 * @param items 營業稅頁本期進項（含 check、tax_type、ded_code）
 * @returns {{ records, skipped: {label, reason}[], problems: {label, reason}[] }}
 */
export function mediaInputRecords(items, { taxId = '' } = {}) {
  const records = [];
  const skipped = [];
  const problems = [];
  for (const it of items) {
    const label = [it.date, it.vendor, it.invoice_no].filter(Boolean).join(' ');
    if (!it.invoice_no) {
      skipped.push({ label, reason: '收據（沒有發票號碼）不列入' });
      continue;
    }
    const toShop = it.check?.ok || (!!taxId && it.buyer_tax_id === taxId);
    if (!toShop) {
      skipped.push({ label, reason: `沒有載明本店統編，不列入（${it.check?.reason || ''}）` });
      continue;
    }
    if (!INVOICE_NO_RE.test(it.invoice_no)) {
      problems.push({ label, reason: `發票號碼 ${it.invoice_no} 格式不對` });
      continue;
    }
    const seller = String(it.vendor_tax_id || '').trim();
    if (!/^\d{8}$/.test(seller)) {
      problems.push({ label, reason: '缺賣方統編（8 碼），請到憑證補上' });
      continue;
    }
    const taxType = it.tax_type || '1';
    const rec = {
      fmt: inputMediaFormat(it),
      ym: it.date.slice(0, 7),
      buyer: taxId,
      seller,
      invoice_no: it.invoice_no,
      amount: Math.round(Number(it.ex) || 0),
      tax_type: taxType,
      tax: taxType === '1' ? Math.round(Number(it.tax) || 0) : 0,
      ded_code: it.ded_code || '',
      label,
    };
    // 同一張發票拆成多行（分屬不同科目）、申報代號相同：合成一筆
    const same = records.find((r) => r.invoice_no === rec.invoice_no && r.fmt === rec.fmt && r.tax_type === rec.tax_type && r.ded_code === rec.ded_code);
    if (same) {
      same.amount += rec.amount;
      same.tax += rec.tax;
    } else records.push(rec);
  }
  // 同一張發票分成不同扣抵代號（一部分可扣抵、一部分不可）：照寫兩筆，但申報系統可能視為重複號碼
  const cautions = [];
  const nos = records.map((r) => r.invoice_no);
  for (const no of new Set(nos.filter((n, i) => nos.indexOf(n) !== i))) {
    const list = records.filter((r) => r.invoice_no === no);
    cautions.push({ label: list[0].label, reason: `同一張發票分成扣抵代號 ${list.map((r) => r.ded_code).join('、')} 共 ${list.length} 筆，申報系統若視為重複號碼，請改在申報系統登打` });
  }
  return { records, skipped, problems, cautions };
}

/** 銷項發票明細（電子發票平台／加值中心下載的 CSV，經匯入器欄位對應）→ { invoice_no, date, buyer, total, ex, tax, voided } */
export function normalizeSalesInvoices(raw) {
  const map = new Map();
  for (const r of raw) {
    const no = normalizeInvoiceNo(r.invoice_no);
    if (!no || map.has(no)) continue;
    const ex = parseAmount(r.amount);
    const tax = parseAmount(r.tax);
    const total = parseAmount(r.total) ?? (ex !== null ? round2(ex + (tax || 0)) : 0);
    map.set(no, { invoice_no: no, date: parseDate(r.date), buyer: String(r.buyer_tax_id || '').replace(/\D/g, ''), total: total || 0, ex, tax, voided: /作廢|註銷/.test(r.status || '') });
  }
  return [...map.values()];
}

/**
 * 銷項發票 → 媒體檔資料（格式 35 電子發票）。有買方統編：未稅銷售額＋稅額；沒有：含稅金額、稅額 0（與 summarizeMedia 的估算一致）；作廢：課稅別 F、金額 0。
 * @returns {{ records, outside: number, problems }}
 */
export function mediaSalesRecords(sales, { taxId = '', start = '', end = '' } = {}) {
  const records = [];
  const problems = [];
  let outside = 0;
  for (const s of sales) {
    const label = [s.date, s.invoice_no].filter(Boolean).join(' ');
    if (!s.date || (start && s.date < start) || (end && s.date > end)) {
      outside++;
      continue;
    }
    if (!/^[A-Z]{2}\d{8}$/.test(s.invoice_no)) {
      problems.push({ label, reason: `發票號碼 ${s.invoice_no} 格式不對` });
      continue;
    }
    const base = { fmt: '35', ym: s.date.slice(0, 7), seller: taxId, invoice_no: s.invoice_no, ded_code: '', label };
    if (s.voided) records.push({ ...base, buyer: '', amount: 0, tax_type: 'F', tax: 0 });
    else if (s.buyer) {
      if (!/^\d{8}$/.test(s.buyer)) {
        problems.push({ label, reason: `買方統編 ${s.buyer} 不是 8 碼` });
        continue;
      }
      const tax = s.tax ?? round2(s.total - Math.round(s.total / 1.05));
      records.push({ ...base, buyer: s.buyer, amount: Math.round(s.ex ?? s.total - tax), tax_type: '1', tax: Math.round(tax) });
    } else records.push({ ...base, buyer: '', amount: Math.round(s.total), tax_type: '1', tax: 0 });
  }
  return { records, outside, problems };
}

/**
 * 空白未使用發票號碼區間（老闆輸入；一行一段）：「AB12345650-AB12345699」「AB12345650~99」或單張「AB12345650」。
 * @returns {{ ranges: { start, end, count }[], errors: string[] }}
 */
export function parseBlankRanges(text) {
  const ranges = [];
  const errors = [];
  for (const raw of String(text || '').split(/[\r\n,;、，；]+/)) {
    const s = raw.normalize('NFKC').toUpperCase().trim();
    if (!s) continue;
    const m = /^([A-Z]{2})\s*-?\s*(\d{8})(?:\s*(?:-|~|至|到|\s)\s*(?:([A-Z]{2})\s*-?\s*)?(\d{1,8}))?$/.exec(s);
    if (!m) {
      errors.push(`看不懂「${raw.trim()}」（例：AB12345650-AB12345699）`);
      continue;
    }
    const [, trk, a, trk2, b] = m;
    if (trk2 && trk2 !== trk) {
      errors.push(`「${raw.trim()}」起訖字軌不同，請分兩行`);
      continue;
    }
    const from = Number(a);
    const to = b ? Number(a.slice(0, 8 - b.length) + b) : from;
    if (to < from) {
      errors.push(`「${raw.trim()}」訖號比起號小`);
      continue;
    }
    const clash = ranges.find((r) => r.start.slice(0, 2) === trk && !(to < Number(r.start.slice(2)) || from > Number(r.end.slice(2))));
    if (clash) {
      errors.push(`「${raw.trim()}」與 ${clash.start}–${clash.end} 重疊`);
      continue;
    }
    ranges.push({ start: trk + a, end: trk + String(to).padStart(8, '0'), count: to - from + 1 });
  }
  return { ranges, errors };
}

/** 空白發票 → 媒體檔資料：課稅別 D、金額 0；連號者彙加（彙加註記 A，訖號放在買受人統編欄） */
export function mediaBlankRecords(ranges, { taxId = '', ym, fmt = '35' } = {}) {
  return ranges.map((r) => ({ fmt, ym, buyer: '', seller: taxId, invoice_no: r.start, amount: 0, tax_type: 'D', tax: 0, ded_code: '', ...(r.count > 1 ? { agg: 'A', end_no: r.end } : {}), label: r.count > 1 ? `${r.start}–${r.end}` : r.start }));
}

/**
 * 組成整份媒體檔：依格式代號、年月、發票號碼排序，流水號從 1 起編。
 * @returns {{ text, count, errors: {label, reason}[] }} text 每筆以 CRLF 結尾
 */
export function buildMediaFile({ regNo, records }) {
  const sorted = [...records].sort((a, b) => (a.fmt + a.ym + a.invoice_no < b.fmt + b.ym + b.invoice_no ? -1 : a.fmt + a.ym + a.invoice_no > b.fmt + b.ym + b.invoice_no ? 1 : 0));
  const lines = [];
  const errors = [];
  for (const r of sorted) {
    const { line, error } = mediaRecord({ ...r, regNo, seq: lines.length + 1 });
    if (line) lines.push(line);
    else errors.push({ label: r.label || r.invoice_no || '', reason: error });
  }
  return { text: lines.map((l) => l + '\r\n').join(''), count: lines.length, errors };
}

// ─────────── 國稅局（財政部電子發票平台）進項發票 vs ERP 入帳

const INV_IN_TEXT = /[A-Z]{2}\d{8}/g;

/**
 * 列出「國稅局有、ERP 沒入帳」的進項發票與金額不符者（以發票號碼比對）。
 * ERP 入帳＝已入帳的照片憑證（含拆分明細）、電子發票本身已入帳、固定資產購置分錄、或分錄摘要寫了這個發票號碼。
 * @param invoices 匯入的進項電子發票（einvoices）
 * @returns {{ total, booked: object[], missing: { inv, pending }[], mismatch: { inv, book, diffs }[], voidedBooked: { inv, book }[] }}
 */
export function einvoiceGaps(invoices, { docs = [], assets = [], entries = [] } = {}) {
  const live = new Map(entries.filter((e) => e.status !== 'void').map((e) => [e.id, e]));
  const posted = (id) => !!id && (!entries.length || live.has(id));
  const docBook = new Map();
  const pending = new Map();
  for (const d of docs) {
    if (d.kind === 'payout_statement' || d.status === 'ignored') continue;
    const isPosted = d.status === 'posted' && posted(d.entry_id);
    for (const p of docParts(d)) {
      const no = normalizeInvoiceNo(p.invoice_no);
      if (!no) continue;
      const label = `${d.doc_date || ''} ${d.vendor_name || d.original_name || ''}`.trim();
      const q = docBook.get(no);
      if (isPosted && q?.doc_id === d.id) {
        // 同一張憑證拆成多行、同一個發票號碼：合計後再和國稅局比
        q.total = round2(q.total + p.total);
        q.tax = round2(q.tax + p.tax);
      } else if (isPosted && !q) docBook.set(no, { kind: 'doc', doc_id: d.id, entry_id: d.entry_id, total: p.total, tax: p.tax, label });
      else if (!isPosted && ['inbox', 'reviewed'].includes(d.status) && !pending.has(no)) pending.set(no, { doc_id: d.id, status: d.status, total: p.total, label });
    }
  }
  const assetBook = new Map();
  for (const a of assets) {
    const no = normalizeInvoiceNo(a.invoice_no);
    if (no && posted(a.purchase_entry_id) && !assetBook.has(no)) assetBook.set(no, { kind: 'asset', entry_id: a.purchase_entry_id, label: `固定資產「${a.name || ''}」` });
  }
  const textBook = new Map();
  for (const e of live.values()) {
    const text = [e.description, ...(e.lines || []).map((l) => l.memo)].filter(Boolean).join(' ').toUpperCase();
    for (const no of text.match(INV_IN_TEXT) || []) if (!textBook.has(no)) textBook.set(no, { kind: 'journal', entry_id: e.id, label: `分錄 ${e.voucher_no || ''} ${e.description || ''}`.trim() });
  }
  const out = { total: 0, booked: [], missing: [], mismatch: [], voidedBooked: [] };
  for (const inv of invoices) {
    const no = normalizeInvoiceNo(inv.invoice_no);
    if (!no) continue;
    const own = posted(inv.entry_id) ? { kind: 'einv', entry_id: inv.entry_id, total: round2(Number(inv.total) || 0), tax: round2(Number(inv.tax) || 0), label: '電子發票入帳' } : null;
    const book = docBook.get(no) || own || assetBook.get(no) || textBook.get(no) || null;
    if (inv.voided) {
      if (book) out.voidedBooked.push({ inv, book });
      continue;
    }
    out.total++;
    if (!book) {
      out.missing.push({ inv, pending: pending.get(no) || null });
      continue;
    }
    const diffs = [];
    if (book.total !== undefined) {
      const total = round2(Number(inv.total) || 0);
      if (Math.abs(book.total - total) >= 1) diffs.push(`金額 國稅局 ${total}／ERP ${book.total}`);
      const tax = round2(Number(inv.tax) || 0);
      if (tax > 0 && Math.abs((book.tax || 0) - tax) >= 1) diffs.push(`稅額 國稅局 ${tax}／ERP ${book.tax || 0}`);
    }
    if (diffs.length) out.mismatch.push({ inv, book, diffs });
    else out.booked.push({ inv, book });
  }
  return out;
}
