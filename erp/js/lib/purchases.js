// 進貨紀錄（Purchase_Records）與原物料自動建檔：一張進貨單（發票）＝ 表頭 ＋ 多行品項。
// 每一行存成 inventory_moves（type: purchase），所以庫存水位、平均成本、供應商表現、單價追蹤都自動接上；
// 行裡沒見過的品名自動建成原物料品項（分類依會計科目 12XX 原料規則判斷），既有品項更新最近進貨日、含稅單價、包裝價格。
//
// 品項新增欄位：pack_type 進貨包裝（箱、瓶、包）、pack_size 每一包裝折合幾個庫存單位、last_purchase_date、last_unit_price（含稅，每進貨單位）、
//   last_price_unit、pack_price_inc／pack_price_ex（每包裝含稅／未稅價）、source_file 來源檔名、auto_category 分類是否為自動判斷、note
// 異動新增欄位：purchase_id 進貨單、invoice_date 發票日期、unit 發票上的單位、pack_qty 發票上的數量、unit_price 含稅單價、amount_ex 未稅、tax 稅額、source_file、batch_id

import { compactKey, normalizeText, uid, fnv1a } from './text.js';
import { round2, parseAmount } from './money.js';
import { parseDate } from './dates.js';
import { INVENTORY_CATEGORIES, suggestSku } from './inventory.js';
import { classifyExpense } from './classify.js';

export const VAT_RATE = 0.05;

// 會計科目 → 原料分類（1211 咖啡豆 … 1216 零售商品）
export const CATEGORY_BY_GL = {};
for (const [k, c] of Object.entries(INVENTORY_CATEGORIES)) if (k !== 'other' && !CATEGORY_BY_GL[c.gl]) CATEGORY_BY_GL[c.gl] = k;

const RETAIL_RE = /濾掛|掛耳|禮盒|周邊|耳掛|零售/;
// 咖啡館進貨常見、但費用分類規則沒涵蓋的寫法（規則找不到 12XX 科目時才用）
const EXTRA_RULES = [
  ['beans', /(?<![紅綠黃黑毛]|紅豆|綠豆)豆$|日曬|水洗|蜜處理|淺焙|中焙|深焙|中深焙|espresso|義式|曼特寧|藍山|西達摩|耶加/i],
  ['dairy', /奶$|乳$|奶油球|奶精|優格|優酪/],
  ['packaging', /杯$|蓋$|袋$|盒$|膜$|手套|紙$|吸管|杯套|提袋|封口/],
  ['tea_syrup', /茶$|粉$|糖$|漿$|醬$|蜜$|果露|濃縮|氣泡|蘇打/],
  ['bakery', /蛋糕|司康|餅乾|可頌|吐司|麵包|布丁|起司|乳酪|水果|莓$|堅果/],
];

/**
 * 自動分類：先看使用者給的提示（分類代號、名稱、科目代號或科目名稱），再依品名對應 12XX 原料科目；
 * 都判斷不出來歸「其他／待分類」並標記 sure:false。
 */
export function guessItemCategory(name, hint = '') {
  const h = normalizeText(hint);
  if (h) {
    for (const [k, c] of Object.entries(INVENTORY_CATEGORIES)) {
      if (h === k || h === normalizeText(c.label) || h === c.gl || h.startsWith(c.gl + ' ') || normalizeText(c.label).includes(h) || h.includes(normalizeText(c.label))) return { category: k, sure: true };
    }
    const gl = /^(12\d\d)/.exec(h)?.[1];
    if (gl && CATEGORY_BY_GL[gl]) return { category: CATEGORY_BY_GL[gl], sure: true };
  }
  const n = String(name || '');
  if (RETAIL_RE.test(n)) return { category: 'retail', sure: true };
  const cls = classifyExpense({ items: [n] });
  if (CATEGORY_BY_GL[cls.account]) return { category: CATEGORY_BY_GL[cls.account], sure: cls.confidence >= 0.5 };
  const extra = EXTRA_RULES.find(([, re]) => re.test(n));
  if (extra) return { category: extra[0], sure: true };
  return { category: 'other', sure: false };
}

export const unitMatches = (a, b) => !!compactKey(a) && compactKey(a) === compactKey(b);

export function findSupplier(suppliers, { name = '', taxId = '' } = {}) {
  const tid = String(taxId || '').replace(/\D/g, '');
  if (tid.length === 8) {
    const s = suppliers.find((x) => String(x.tax_id || '').trim() === tid);
    if (s) return s;
  }
  const k = compactKey(name);
  if (!k) return null;
  return suppliers.find((x) => compactKey(x.name) === k || compactKey(x.short_name) === k) || null;
}

export function findItem(items, name) {
  const k = compactKey(name);
  if (!k) return null;
  return items.find((i) => compactKey(i.name) === k) || items.find((i) => i.sku && compactKey(i.sku) === k) || null;
}

// 發票上的數量（發票單位）→ 庫存單位數量：單位＝進貨包裝時乘上每包裝折合量
export function toStockQty(item, unit, qty) {
  const q = Number(qty) || 0;
  if (!unit || unitMatches(unit, item.unit)) return q;
  if (item.pack_type && unitMatches(unit, item.pack_type)) return round2(q * (Number(item.pack_size) || 1));
  return q;
}

export const supplierLabel = (s) => (s ? s.short_name || s.name || '' : '');

/**
 * 進貨單一行的金額補齊：含稅金額、未稅、稅額、單價互推（有含稅金額優先，其次未稅＋稅額，再其次單價×數量）
 */
export function completeLine(line, { vatRate = VAT_RATE } = {}) {
  const qty = Number(line.qty);
  const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  let amount = n(line.amount);
  let amountEx = n(line.amount_ex);
  let tax = n(line.tax);
  let price = n(line.unit_price);
  if (amount === null && amountEx !== null) amount = round2(amountEx + (tax ?? round2(amountEx * vatRate)));
  if (amount === null && price !== null && qty > 0) amount = round2(price * qty);
  if (amount === null) return null;
  if (amountEx === null) {
    if (tax !== null) amountEx = round2(amount - tax);
    else {
      amountEx = round2(amount / (1 + vatRate));
      tax = round2(amount - amountEx);
    }
  } else if (tax === null) tax = round2(amount - amountEx);
  if (price === null && qty > 0) price = round2((amount / qty) * 1000) / 1000;
  return { amount, amount_ex: amountEx, tax, unit_price: price };
}

export function purchaseIdOf({ invoice_no = '', date = '', supplierKey = '', sourceFile = '' } = {}) {
  const no = compactKey(invoice_no).toUpperCase();
  if (no) return 'po_' + fnv1a(`inv|${no}`);
  return 'po_' + fnv1a(`d|${date}|${supplierKey}|${sourceFile}`);
}

function lineId(purchaseId, line, seen) {
  const base = [compactKey(line.name), compactKey(line.unit), line.qty, line.amount].join('|');
  const n = seen.get(base) || 0;
  seen.set(base, n + 1);
  return 'mv_' + fnv1a(`${purchaseId}|${base}|${n}`);
}

/**
 * 把一張進貨單寫成異動與品項更新（不碰資料庫；呼叫端負責儲存）。
 * ctx.items／ctx.suppliers 會被就地加入新建的品項與供應商，連續處理多張單時後面的單看得到前面建的。
 * @param doc { id?, supplier_id?, supplier_name?, supplier_tax_id?, invoice_no, invoice_date, date, order_date, yield_score, note, source_file, batch_id,
 *              lines: [{ name, unit, qty, unit_price, amount, amount_ex, tax, category, note }] }
 * @returns { purchaseId, moves, newItems, updatedItems, newSupplier, supplier, skipped }
 */
export function applyPurchase(doc, ctx) {
  const { items, suppliers, vatRate = VAT_RATE } = ctx;
  const skipped = [];
  let supplier = doc.supplier_id ? suppliers.find((s) => s.id === doc.supplier_id) || null : null;
  let newSupplier = null;
  if (!supplier && (doc.supplier_name || doc.supplier_tax_id)) {
    supplier = findSupplier(suppliers, { name: doc.supplier_name, taxId: doc.supplier_tax_id });
    if (!supplier && String(doc.supplier_name || '').trim()) {
      const tid = String(doc.supplier_tax_id || '').replace(/\D/g, '');
      newSupplier = { id: uid('sp_'), name: String(doc.supplier_name).trim(), short_name: '', tax_id: tid.length === 8 ? tid : '', contact: '', phone: '', mobile: '', terms: '', note: '', source_file: doc.source_file || '' };
      suppliers.push(newSupplier);
      supplier = newSupplier;
    }
  }
  const date = doc.date || doc.invoice_date;
  const purchaseId = doc.id || purchaseIdOf({ invoice_no: doc.invoice_no, date, supplierKey: supplier ? supplier.id : compactKey(doc.supplier_name), sourceFile: doc.source_file });
  const moves = [];
  const newItems = [];
  const updated = new Map();
  const seen = new Map();
  (doc.lines || []).forEach((line, i) => {
    const name = String(line.name || '').trim();
    const qty = Number(line.qty);
    if (!name) return skipped.push({ row: line._row ?? i + 1, reason: '沒有品名' });
    if (!(qty > 0)) return skipped.push({ row: line._row ?? i + 1, reason: `「${name}」數量要大於 0` });
    const money = completeLine(line, { vatRate });
    if (!money) return skipped.push({ row: line._row ?? i + 1, reason: `「${name}」沒有金額或單價` });
    const unit = String(line.unit || '').trim();
    let item = findItem(items, name) || newItems.find((x) => compactKey(x.name) === compactKey(name));
    let fresh = false;
    if (!item) {
      const g = guessItemCategory(name, line.category);
      const cat = INVENTORY_CATEGORIES[g.category];
      item = { id: uid('it_'), sku: suggestSku(g.category, [...items, ...newItems]), name, category: g.category, unit: unit || '單位', gl_account: cat.gl, safety_stock: null, reorder_qty: null, std_cost: null, supplier_id: supplier?.id || null, pack_type: unit || '', pack_size: 1, auto_category: !g.sure, source_file: doc.source_file || '', note: '', active: true };
      newItems.push(item);
      items.push(item);
      fresh = true;
    }
    const stockQty = toStockQty(item, unit, qty);
    const l = { name, unit, qty, ...money, note: String(line.note || '').trim() };
    moves.push({
      id: lineId(purchaseId, l, seen),
      purchase_id: purchaseId,
      item_id: item.id,
      date,
      type: 'purchase',
      qty: stockQty,
      pack_qty: qty,
      unit,
      unit_price: money.unit_price,
      amount: money.amount,
      amount_ex: money.amount_ex,
      tax: money.tax,
      supplier_id: supplier?.id || null,
      order_date: doc.order_date || null,
      yield_score: doc.yield_score ?? null,
      invoice_no: String(doc.invoice_no || '').trim(),
      invoice_date: doc.invoice_date || date,
      note: [l.note, doc.note].filter(Boolean).join('；'),
      source_file: doc.source_file || '',
      batch_id: doc.batch_id || null,
    });
    const touched = touchItem(updated.get(item.id) || item, l, { date, supplierId: supplier?.id, sourceFile: doc.source_file, vatRate });
    if (fresh) Object.assign(item, touched);
    else if (touched !== item) updated.set(item.id, touched);
  });
  return { purchaseId, moves, newItems, updatedItems: [...updated.values()], newSupplier, supplier, skipped };
}

// 既有品項更新最近進貨資訊（只有比目前紀錄更新或同日的進貨才覆蓋）
export function touchItem(item, line, { date, supplierId, sourceFile, vatRate = VAT_RATE }) {
  const out = { ...item };
  if (!out.supplier_id && supplierId) out.supplier_id = supplierId;
  if (date && out.last_purchase_date && date < out.last_purchase_date) return out.supplier_id === item.supplier_id ? item : out;
  out.last_purchase_date = date || out.last_purchase_date || null;
  if (line.unit_price !== null && line.unit_price !== undefined) {
    out.last_unit_price = line.unit_price;
    out.last_price_unit = line.unit || out.unit || '';
    if (!out.pack_type && line.unit) out.pack_type = line.unit;
    if (!line.unit || unitMatches(line.unit, out.pack_type)) {
      out.pack_price_inc = line.unit_price;
      out.pack_price_ex = round2(line.unit_price / (1 + vatRate));
    }
  }
  if (sourceFile) out.source_file = sourceFile;
  return out;
}

/**
 * 匯入中心用：每列一行進貨品項 → 依發票號碼（或日期＋供應商）分成進貨單，再逐張套用 applyPurchase。
 * raw 每列：{ invoice_no, invoice_date, date, order_date, supplier, supplier_tax_id, item, unit, qty, unit_price, amount, amount_ex, tax, category, yield_score, note, _row }
 */
export function normalizePurchaseRows(raw, { items, suppliers, sourceFile = '', batchId = null, vatRate = VAT_RATE } = {}) {
  const docs = new Map();
  const skipped = [];
  for (const r of raw) {
    const invoiceDate = parseDate(r.invoice_date);
    const date = parseDate(r.date) || invoiceDate;
    if (!date) {
      skipped.push({ row: r._row, reason: '缺發票日期或到貨日' });
      continue;
    }
    if (!String(r.item || '').trim()) {
      skipped.push({ row: r._row, reason: '缺品名' });
      continue;
    }
    const sup = String(r.supplier || '').trim();
    const key = purchaseIdOf({ invoice_no: r.invoice_no, date, supplierKey: compactKey(sup) || String(r.supplier_tax_id || '').replace(/\D/g, ''), sourceFile });
    let d = docs.get(key);
    if (!d) docs.set(key, (d = { invoice_no: String(r.invoice_no || '').trim(), invoice_date: invoiceDate || date, date, order_date: parseDate(r.order_date), supplier_name: sup, supplier_tax_id: r.supplier_tax_id || '', yield_score: parseAmount(r.yield_score), note: '', source_file: sourceFile, batch_id: batchId, lines: [] }));
    d.lines.push({ name: String(r.item).trim(), unit: r.unit || '', qty: parseAmount(r.qty) ?? 1, unit_price: parseAmount(r.unit_price), amount: parseAmount(r.amount), amount_ex: parseAmount(r.amount_ex), tax: parseAmount(r.tax), category: r.category || '', note: r.note || '', _row: r._row });
  }
  const out = { rows: [], skipped, newItems: [], updatedItems: new Map(), newSups: [], docs: [] };
  const ctx = { items: [...items], suppliers: [...suppliers], vatRate };
  for (const d of docs.values()) {
    const res = applyPurchase(d, ctx);
    out.rows.push(...res.moves);
    out.skipped.push(...res.skipped);
    out.newItems.push(...res.newItems);
    for (const it of res.updatedItems) {
      const prev = out.updatedItems.get(it.id);
      out.updatedItems.set(it.id, prev ? { ...prev, ...it } : it);
    }
    if (!res.moves.length) continue; // 整張單都沒有可用的行（例如都沒金額）
    if (res.newSupplier) out.newSups.push(res.newSupplier);
    out.docs.push({ ...d, id: res.purchaseId, supplier: res.supplier, lines: res.moves.length });
  }
  out.updatedItems = [...out.updatedItems.values()];
  return out;
}

/**
 * 進貨單清單：同一 purchase_id 的異動合成一張；舊資料沒有 purchase_id 時以發票號碼＋供應商分組，再沒有就每筆一張。
 */
export function groupPurchases(moves, { items = [], suppliers = [] } = {}) {
  const itemBy = new Map(items.map((i) => [i.id, i]));
  const supBy = new Map(suppliers.map((s) => [s.id, s]));
  const groups = new Map();
  for (const m of moves) {
    if (m.type !== 'purchase') continue;
    const key = m.purchase_id || (m.invoice_no ? `inv|${compactKey(m.invoice_no)}|${m.supplier_id || ''}` : `one|${m.id}`);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { id: key, purchase_id: m.purchase_id || null, date: m.date, invoice_date: m.invoice_date || m.date, invoice_no: m.invoice_no || '', supplier_id: m.supplier_id || null, order_date: m.order_date || null, yield_score: m.yield_score ?? null, source_file: m.source_file || '', lines: [], total: 0, totalEx: 0, tax: 0 }));
    g.lines.push(m);
    const amt = Number(m.amount) || 0;
    g.total = round2(g.total + amt);
    g.totalEx = round2(g.totalEx + (m.amount_ex ?? round2(amt / (1 + VAT_RATE))));
    g.tax = round2(g.total - g.totalEx);
    if (m.date > g.date) g.date = m.date;
    if (!g.supplier_id && m.supplier_id) g.supplier_id = m.supplier_id;
  }
  return [...groups.values()].map((g) => {
    const sup = supBy.get(g.supplier_id) || null;
    const names = g.lines.map((m) => itemBy.get(m.item_id)?.name || '（已刪除的品項）');
    return { ...g, supplier: sup, supplierName: supplierLabel(sup) || (g.supplier_id ? '（已刪除的供應商）' : ''), itemNames: names, summary: names.slice(0, 3).join('、') + (names.length > 3 ? `…等 ${names.length} 項` : ''), note: g.lines.map((m) => m.note).filter(Boolean)[0] || '' };
  });
}

// ───────── 供應商匯入

export const SUPPLIER_FIELDS = ['short_name', 'name', 'tax_id', 'phone', 'contact', 'mobile', 'terms', 'bank_branch', 'bank_code', 'account_name', 'account_number', 'pay_note', 'note'];

export function supplierFromRow(r) {
  const s = {};
  for (const k of SUPPLIER_FIELDS) s[k] = String(r[k] ?? '').trim();
  s.tax_id = s.tax_id.normalize('NFKC').replace(/\D/g, '');
  if (!s.name) s.name = s.short_name;
  if (!s.short_name && s.name.length <= 6) s.short_name = s.name;
  s.account_number = s.account_number.normalize('NFKC').replace(/[\s-]/g, '');
  s.bank_code = s.bank_code.normalize('NFKC').replace(/\D/g, '');
  return s;
}

// 匯入的資料蓋過既有的非空白欄位；匯入值空白時保留原值。回傳 { row, changed }
export function mergeSupplier(existing, incoming) {
  const row = { ...existing };
  let changed = false;
  for (const k of SUPPLIER_FIELDS) {
    const v = incoming[k];
    if (v && v !== (existing[k] || '')) {
      row[k] = v;
      changed = true;
    }
  }
  return { row, changed };
}

/**
 * 供應商匯入：以統編、發票抬頭或簡稱比對既有供應商；有就更新，沒有就新增。
 * @returns { rows（要寫入的）, unchanged, skipped, preview }
 */
export function normalizeSupplierRows(raw, { suppliers, batchId = null, sourceFile = '' } = {}) {
  const list = [...suppliers];
  const rows = [];
  const preview = [];
  const skipped = [];
  let unchanged = 0;
  for (const r of raw) {
    const s = supplierFromRow(r);
    if (!s.name) {
      skipped.push({ row: r._row, reason: '沒有發票抬頭或簡稱' });
      continue;
    }
    if (s.tax_id && s.tax_id.length !== 8) {
      skipped.push({ row: r._row, reason: `「${s.name}」統一編號 ${s.tax_id} 不是 8 碼` });
      continue;
    }
    const existing = findSupplier(list, { name: s.name, taxId: s.tax_id }) || findSupplier(list, { name: s.short_name });
    if (existing) {
      const { row, changed } = mergeSupplier(existing, s);
      if (!changed) {
        unchanged++;
        preview.push({ ...row, _state: 'same' });
        continue;
      }
      rows.push(row);
      preview.push({ ...row, _state: 'update' });
      Object.assign(existing, row);
    } else {
      const row = { id: uid('sp_'), ...s, batch_id: batchId, source_file: sourceFile };
      rows.push(row);
      preview.push({ ...row, _state: 'new' });
      list.push(row);
    }
  }
  return { rows, unchanged, skipped, preview };
}

// 匯入範本（CSV 文字，含一列範例）
export function templateCSV(target) {
  if (target === 'suppliers') {
    return [
      ['簡稱', '發票抬頭', '統一編號', '公司電話', '聯絡人_業務', '聯絡人手機', '付款條件', '匯款銀行-分行', '銀行代號', '戶名', '匯款帳號', '付款備註', '備註'],
      ['鮮乳坊', '鮮乳坊股份有限公司', '12345678', '02-1234-5678', '王小明', '0912-345-678', '月結 30 天', '台灣銀行-城中分行', '004', '鮮乳坊股份有限公司', '0123456789012', '匯款後 LINE 通知業務', '每週二、五配送'],
    ];
  }
  return [
    ['發票號碼', '發票日期', '到貨日', '供應商', '供應商統編', '品名', '單位', '單價', '數量', '含稅金額', '分類', '備註'],
    ['AB12345678', '2026-09-05', '2026-09-06', '鮮乳坊', '12345678', '鮮乳 936ml', '瓶', '85', '12', '1020', '乳品', ''],
    ['AB12345678', '2026-09-05', '2026-09-06', '鮮乳坊', '12345678', '燕麥奶 1L', '瓶', '110', '6', '660', '', ''],
  ];
}
