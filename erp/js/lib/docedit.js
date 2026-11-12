// 日記簿「修改」憑證產生的分錄：直接改課稅別、扣抵代號、拆分明細（2026-11-12 老闆需求 二-1）。
// 存檔時先改憑證，再用跟「入帳並歸檔」同一套規則（documentJournal）重新產生分錄；
// 401 進項清單直接讀憑證，所以會跟著變。已申報的期別不自動改申報紀錄，只提醒。

import { round2 } from './money.js';
import { documentJournal } from './autojournal.js';
import { deductibility, taxCodes, docParts, periodKeyOf, periodInfo, normalizeInvoiceNo, INVOICE_NO_RE, TAX_TYPES, DED_CODES, FIXED_ASSET_ACCOUNTS } from './vat.js';

const DEDUCTIBLE_CODES = new Set(['1', '2']);

/**
 * 分錄的來源憑證：分錄是「憑證」入帳產生的（source=document），憑證還在、已入帳、而且連到這張分錄。
 * 電子發票入帳（source_ref 是電子發票）、憑證已刪除或已改連到別張分錄時回傳 null（改用一般分錄編輯）。
 */
export function sourceDocumentOf(entry, docs) {
  if (!entry || entry.source !== 'document' || !entry.source_ref) return null;
  const d = (docs || []).find((x) => x.id === entry.source_ref);
  if (!d || d.status !== 'posted' || d.entry_id !== entry.id || d.kind === 'payout_statement') return null;
  return d;
}

/**
 * 一行的可否扣抵與申報代號。扣抵代號有填就以代號為準（1、2 可扣抵，仍要有發票號碼、稅額、課稅別應稅；3、4 不可扣抵）；
 * 沒填才依憑證的「三聯式／本店統編」與科目規則判斷（與入帳時相同）。
 * conflict：代號填可扣抵，但規則上不能扣抵的原因（存檔會擋）。
 */
export function checkRow(doc, row, { taxId = '', vatMode = 'general' } = {}) {
  const ded_code = String(row.ded_code || '');
  const item = {
    invoice_no: row.invoice_no || '',
    account: row.account || '',
    tax: round2(Number(row.tax) || 0),
    tax_type: String(row.tax_type || ''),
    ded_code,
    buyer_tax_id: doc.buyer_tax_id || '',
    invoice_type: doc.invoice_type || '',
    deductible: ded_code ? undefined : (row.deductible ?? doc.deductible),
  };
  const ded = deductibility(item, { taxId, vatMode });
  const ok = item.deductible !== false && ded.ok;
  return { ok, reason: ok ? '' : ded.reason, ...taxCodes(item, ok), conflict: DEDUCTIBLE_CODES.has(ded_code) && !ok ? ded.reason : '' };
}

/** 編輯畫面的明細列（沒拆分的憑證＝一列；說明欄是憑證摘要）。代號沒填的帶入目前自動判斷的結果。 */
export function docEditRows(doc, opts = {}) {
  const split = Array.isArray(doc.lines) && doc.lines.length > 0;
  return docParts(doc).map((p) => {
    const c = checkRow(doc, { ...p, deductible: p.deductible }, opts);
    return { invoice_no: p.invoice_no || '', account: p.account || '', amount: p.total, tax: p.tax, tax_type: p.tax_type || c.tax_type, ded_code: p.ded_code || c.ded_code, memo: split ? p.memo || '' : doc.summary || '' };
  });
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? round2(n) : NaN;
};

function cleanRow(r) {
  return {
    invoice_no: normalizeInvoiceNo(r.invoice_no),
    account: String(r.account || '').trim(),
    amount: num(r.amount),
    tax: r.tax === '' || r.tax === null || r.tax === undefined ? 0 : num(r.tax),
    tax_type: String(r.tax_type || '').trim(),
    ded_code: String(r.ded_code || '').trim(),
    memo: String(r.memo || '').trim(),
  };
}

/** 畫面上還沒填的空白列（略過，不算一行） */
export function isBlankRow(r) {
  const c = cleanRow(r);
  return !(c.account || c.amount || c.tax || c.invoice_no || c.memo);
}

/**
 * 套用修改：回傳新的憑證、重新產生的分錄（documentJournal）、每行的扣抵判斷與改了哪些地方。
 * @param edit { rows: [{ invoice_no, account, amount（含稅）, tax, tax_type, ded_code, memo }], pay_account, date }
 * @param opts { taxId, vatMode, payAccount（預設付款方式）, accounts: Set<代號>,
 *               takenInvoiceNos: Set（別張憑證／電子發票已入帳的發票號碼）, linkedInvoiceNo（連著的電子發票號碼，要保留） }
 * @returns {{ errors: string[], doc?, journal?, checks?, changes? }}
 */
export function applyDocEdit(doc, edit = {}, opts = {}) {
  const rows = (edit.rows || []).filter((r) => !isBlankRow(r)).map(cleanRow);
  const errors = [];
  const total = round2(Number(doc.amount_total) || 0);
  const hadNos = new Set(docParts(doc).map((p) => p.invoice_no).filter(Boolean));
  if (!rows.length) errors.push('至少要有一行明細');
  const checks = rows.map((r) => checkRow(doc, r, opts));
  rows.forEach((r, i) => {
    const n = rows.length > 1 ? `第 ${i + 1} 行` : '';
    if (!r.account) errors.push(`${n}沒有會計項目`);
    else if (opts.accounts && !opts.accounts.has(r.account)) errors.push(`${n}會計項目 ${r.account} 不存在`);
    if (Number.isNaN(r.amount) || Number.isNaN(r.tax)) errors.push(`${n}金額或稅額不是數字`);
    else {
      if (!r.amount) errors.push(`${n}含稅金額是 0`);
      if (r.tax < 0 || (r.amount > 0 && r.tax > r.amount)) errors.push(`${n}稅額 ${r.tax} 不合理`);
    }
    if (r.invoice_no && !INVOICE_NO_RE.test(r.invoice_no)) errors.push(`${n}發票號碼 ${r.invoice_no} 格式不對（2 碼英文＋8 碼數字）`);
    else if (r.invoice_no && !hadNos.has(r.invoice_no) && opts.takenInvoiceNos?.has(r.invoice_no)) errors.push(`${n}發票號碼 ${r.invoice_no} 已經由別張憑證入帳，同一張發票不能入帳兩次`);
    if (r.tax_type && !TAX_TYPES[r.tax_type]) errors.push(`${n}課稅別只能是 ${Object.keys(TAX_TYPES).join('、')}`);
    if (r.ded_code && !DED_CODES[r.ded_code]) errors.push(`${n}扣抵代號只能是 ${Object.keys(DED_CODES).join('、')}`);
    else if (checks[i].conflict) errors.push(`${n}扣抵代號 ${r.ded_code} 是「可扣抵」，但${checks[i].conflict}：請改成 ${r.ded_code === '2' ? '4' : '3'}（不可扣抵），或補上發票號碼與稅額`);
  });
  const sum = round2(rows.reduce((t, r) => t + (Number.isNaN(r.amount) ? 0 : r.amount), 0));
  if (rows.length && Math.abs(sum - total) >= 1) errors.push(`明細合計 ${sum} 與憑證金額 ${total} 不符（差 ${round2(sum - total)}）`);
  if (opts.linkedInvoiceNo && rows.length && !rows.some((r) => r.invoice_no === opts.linkedInvoiceNo)) errors.push(`這張憑證連著電子發票 ${opts.linkedInvoiceNo}，明細裡要保留這個發票號碼`);
  if (errors.length) return { errors, checks, sum, total };

  const next = { ...doc, pay_account: edit.pay_account || doc.pay_account, doc_date: edit.date || doc.doc_date };
  if (rows.length === 1) {
    const [r] = rows;
    const [c] = checks;
    Object.assign(next, { lines: null, invoice_no: r.invoice_no || null, account: r.account, tax_amount: r.tax ? r.tax : doc.tax_amount === 0 ? 0 : null, tax_type: c.tax_type, ded_code: c.ded_code, deductible: c.ok, summary: r.memo });
  } else {
    const nos = [...new Set(rows.map((r) => r.invoice_no).filter(Boolean))];
    Object.assign(next, {
      lines: rows.map((r, i) => ({ invoice_no: r.invoice_no, account: r.account, amount: r.amount, tax: r.tax, tax_type: checks[i].tax_type, ded_code: checks[i].ded_code, deductible: checks[i].ok, memo: r.memo })),
      invoice_no: nos[0] || doc.invoice_no || null,
      account: doc.account || rows[0].account,
      tax_amount: round2(rows.reduce((t, r) => t + r.tax, 0)),
    });
  }
  const journal = documentJournal(next, { deductible: next.lines?.length ? next.deductible : checks[0].ok, payAccount: opts.payAccount || '2134' });
  if (!journal) return { errors: ['重新產生分錄失敗：缺金額或會計項目'], checks, sum, total };
  return { errors: [], doc: next, journal, checks, sum, total, changes: describeChanges(doc, next, opts) };
}

const show = (v) => (v === null || v === undefined || v === '' ? '（空白）' : String(v));

/** 改了哪些地方（寫進憑證的修改紀錄、存檔提示）。代號沒填的舊憑證以當時自動判斷的結果比較。 */
export function describeChanges(before, after, opts = {}) {
  const out = [];
  const pb = docEditRows(before, opts);
  const pa = docEditRows(after, opts);
  if (pb.length !== pa.length) out.push(pa.length > 1 ? `拆分明細 ${pb.length} 行 → ${pa.length} 行` : `取消拆分（${pb.length} 行 → 1 行）`);
  const fields = [['invoice_no', '發票號碼'], ['account', '會計項目'], ['amount', '金額'], ['tax', '稅額'], ['tax_type', '課稅別'], ['ded_code', '扣抵代號'], ['memo', pa.length > 1 ? '說明' : '摘要']];
  pa.forEach((p, i) => {
    const q = pb[i];
    if (!q) return out.push(`新增第 ${i + 1} 行：${p.account} ${p.amount}${p.tax ? `（稅 ${p.tax}）` : ''} 扣抵代號 ${p.ded_code}`);
    const tag = pa.length > 1 ? `第 ${i + 1} 行` : '';
    for (const [k, label] of fields) if (String(q[k] ?? '') !== String(p[k] ?? '')) out.push(`${tag}${label} ${show(q[k])} → ${show(p[k])}`);
  });
  for (let i = pa.length; i < pb.length; i++) out.push(`刪除第 ${i + 1} 行：${pb[i].account} ${pb[i].amount}`);
  if ((before.pay_account || '') !== (after.pay_account || '')) out.push(`付款方式 ${show(before.pay_account)} → ${show(after.pay_account)}`);
  if ((before.doc_date || '') !== (after.doc_date || '')) out.push(`日期 ${show(before.doc_date)} → ${show(after.doc_date)}`);
  return out;
}

/** 分錄內容是否相同（只比科目與借貸金額，說明不算）：用來提醒「這張分錄手動改過，存檔會依憑證重新產生」 */
export function sameLines(a = [], b = []) {
  const key = (ls) => ls.map((l) => `${l.account}|${round2(Number(l.debit) || 0)}|${round2(Number(l.credit) || 0)}`).sort().join(';');
  return key(a) === key(b);
}

/**
 * 會受影響的已申報 401 期別：憑證日期（改前、改後）所屬期別已申報，或已申報紀錄的扣抵清單、媒體檔進項列了這張憑證。
 * @param docs [改前, 改後]
 * @param filings tax_filings
 */
export function filedPeriodsFor(docs, filings) {
  const filed = (filings || []).filter((f) => f.status === 'filed' || f.status === 'paid');
  const hits = new Map();
  for (const d of docs) {
    if (!d?.doc_date) continue;
    const own = periodKeyOf(d.doc_date);
    const nos = new Set(docParts(d).map((p) => p.invoice_no).filter(Boolean));
    const mine = (k) => k === d.id || String(k).startsWith(d.id + ':');
    for (const f of filed) {
      if (f.id === own || (f.claimed || []).some(mine) || (f.filed_inputs || []).some((x) => x.invoice_no && nos.has(x.invoice_no))) hits.set(f.id, f);
    }
  }
  return [...hits.values()].sort((a, b) => (a.id < b.id ? -1 : 1)).map((f) => ({ id: f.id, label: periodInfo(f.id).label, status: f.status, filed_on: f.filed_on || '' }));
}

/** 憑證裡固定資產科目（15xx）的未稅取得成本（依科目分組，與入帳時自動建立固定資產相同算法） */
export function assetGroups(d) {
  const groups = new Map();
  const split = Array.isArray(d.lines) && d.lines.length > 0;
  for (const p of docParts(d)) {
    if (!FIXED_ASSET_ACCOUNTS.has(p.account)) continue;
    const g = groups.get(p.account) || { cost: 0, tax: 0, invoices: [] };
    const t = (split ? p.deductible : d.deductible) ? p.tax : 0;
    g.cost = round2(g.cost + p.total - t);
    g.tax = round2(g.tax + t);
    if (p.invoice_no) g.invoices.push(p.invoice_no);
    groups.set(p.account, g);
  }
  return groups;
}
