// 財政部電子發票平台下載檔（|分隔，含「表頭=M|…」「明細=D|…」欄位定義）與一般 CSV 進項發票。

import { parseDate } from './dates.js';
import { parseAmount, round2 } from './money.js';
import { fnv1a } from './text.js';
import { classifyExpense } from './classify.js';

const FIELD = {
  date: ['發票日期', '開立日期', '日期'],
  invoice_no: ['發票號碼', '發票字軌號碼'],
  total: ['發票金額', '總金額', '金額', '總計'],
  status: ['發票狀態', '狀態'],
  seller_tax_id: ['賣方統一編號', '商店統編', '賣方統編', '銷售人統一編號'],
  seller_name: ['賣方名稱', '商店店名', '店名', '銷售人名稱'],
  buyer_tax_id: ['買方統編', '買方統一編號', '買受人統一編號'],
  carrier: ['載具名稱', '載具自訂名稱'],
  sub: ['小計', '金額'],
  item: ['品項名稱', '品名'],
};

function idx(cols, names) {
  for (const n of names) {
    const i = cols.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

export function isMofFormat(text) {
  return /表頭=M\|/.test(text) || /^M\|/m.test(text);
}

export function parseMofInvoices(text, { businessTaxId = '' } = {}) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let mCols = ['M', '載具名稱', '載具號碼', '發票日期', '商店統編', '商店店名', '發票號碼', '總金額', '發票狀態'];
  let dCols = ['D', '發票號碼', '小計', '品項名稱'];
  const invoices = new Map();
  for (const line of lines) {
    let m;
    if ((m = /^表頭=(.*)$/.exec(line))) {
      mCols = m[1].split('|').map((s) => s.trim());
      continue;
    }
    if ((m = /^明細=(.*)$/.exec(line))) {
      dCols = m[1].split('|').map((s) => s.trim());
      continue;
    }
    const parts = line.split('|').map((s) => s.trim());
    if (parts[0] === 'M') {
      const g = (names) => {
        const i = idx(mCols, names);
        return i >= 0 ? parts[i] || '' : '';
      };
      const no = g(FIELD.invoice_no);
      if (!no) continue;
      invoices.set(no, {
        invoice_no: no,
        date: parseDate(g(FIELD.date)),
        total: parseAmount(g(FIELD.total)) || 0,
        status: g(FIELD.status),
        seller_tax_id: g(FIELD.seller_tax_id),
        seller_name: g(FIELD.seller_name),
        buyer_tax_id: g(FIELD.buyer_tax_id),
        carrier: g(FIELD.carrier),
        items: [],
      });
    } else if (parts[0] === 'D') {
      const g = (names) => {
        const i = idx(dCols, names);
        return i >= 0 ? parts[i] || '' : '';
      };
      const inv = invoices.get(g(FIELD.invoice_no));
      if (inv) inv.items.push({ name: g(FIELD.item), amount: parseAmount(g(FIELD.sub)) || 0 });
    }
  }
  return [...invoices.values()].map((inv) => finalize(inv, businessTaxId));
}

// 一般 CSV（經匯入器欄位對應）
export function normalizeInvoiceRows(rawRows, { businessTaxId = '' } = {}) {
  const map = new Map();
  for (const r of rawRows) {
    const no = String(r.invoice_no || '').replace(/[\s-]/g, '').toUpperCase();
    if (!no) continue;
    let inv = map.get(no);
    if (!inv) {
      const amount = parseAmount(r.amount);
      const tax = parseAmount(r.tax);
      const total = parseAmount(r.total) ?? (amount !== null ? round2(amount + (tax || 0)) : 0);
      inv = { invoice_no: no, date: parseDate(r.date), total, amount, tax, status: r.status || '', seller_tax_id: r.seller_tax_id || '', seller_name: r.seller_name || '', buyer_tax_id: r.buyer_tax_id || '', items: [] };
      map.set(no, inv);
    }
    if (r.items) inv.items.push({ name: r.items, amount: null });
  }
  return [...map.values()].map((inv) => finalize(inv, businessTaxId));
}

function finalize(inv, businessTaxId) {
  const b2b = !!businessTaxId && inv.buyer_tax_id === businessTaxId;
  // 買方統編為本店者（三聯式／B2B）才可扣抵進項稅額
  const tax = inv.tax !== null && inv.tax !== undefined ? inv.tax : b2b ? round2(inv.total - Math.round(inv.total / 1.05)) : 0;
  const cls = classifyExpense({ vendor: inv.seller_name, items: inv.items });
  return {
    id: 'inv_' + fnv1a(inv.invoice_no + '|' + inv.date),
    ...inv,
    tax: b2b ? tax : 0,
    deductible: b2b,
    voided: /作廢|註銷|退回|折讓/.test(inv.status || ''),
    suggested_account: cls.account,
    confidence: cls.confidence,
  };
}
