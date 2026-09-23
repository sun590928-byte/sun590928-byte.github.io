// 資料表定義：本機 IndexedDB 與 Supabase 共用。
// 欄位型別供 tools/gen-schema.mjs 產生 SQL；未列出的欄位存入 extra（jsonb），日後擴充不必改資料庫。

const T = 'text';
const N = 'numeric';
const D = 'date';
const B = 'boolean';
const J = 'jsonb';
const TS = 'timestamptz';

export const SCHEMA = {
  settings: { label: '系統設定', cols: { id: T, value: J } },
  import_batches: { label: '匯入批次', cols: { id: T, target: T, file_name: T, file_hash: T, encoding: T, row_count: N, added: N, skipped: N, date_from: D, date_to: D, mapping: J, imported_at: TS } },
  import_profiles: { label: '欄位對應範本', cols: { id: T, target: T, signature: T, header_index: N, mapping: J, headers: J, name: T, updated_at: TS } },
  sales_lines: {
    label: 'POS 銷售明細',
    cols: { id: T, batch_id: T, date: D, time: T, order_no: T, item_raw: T, option_raw: T, category_raw: T, qty: N, unit_price: N, gross: N, discount: N, amount: N, revenue: N, payment_raw: T, payment: T, status_raw: T, note: T, member: T, staff: T, channel: T, is_adjustment: B, void_reason: T, void_keyword: T },
    index: ['date', 'batch_id'],
  },
  products: { label: '品項主檔', cols: { id: T, name: T, category: T, price: N, active: B, note: T, updated_at: TS } },
  product_aliases: { label: '品項別名對應', cols: { id: T, raw_name: T, product_id: T, updated_at: TS } },
  product_not_same: { label: '確認非同品項', cols: { id: T, a: T, b: T, updated_at: TS } },
  payment_tx: { label: '刷卡／行動支付交易', cols: { id: T, batch_id: T, provider: T, date: D, time: T, order_no: T, provider_no: T, amount: N, fee: N, net: N, status: T, ok: B, payout_date: D, method: T, card_last4: T, note: T }, index: ['date'] },
  payouts: { label: '金流撥款', cols: { id: T, batch_id: T, provider: T, payout_date: D, gross: N, fee: N, net: N, period_from: D, period_to: D, tx_count: N, ref: T, note: T, document_id: T } },
  bank_accounts: { label: '銀行帳戶', cols: { id: T, name: T, bank: T, last4: T, gl_account: T, opening_date: D, opening_balance: N } },
  bank_lines: { label: '存摺明細', cols: { id: T, batch_id: T, bank_account_id: T, date: D, description: T, withdrawal: N, deposit: N, balance: N, note: T, counterparty: T, match_key: T }, index: ['date'] },
  accounts: { label: '會計項目', cols: { code: T, name: T, type: T, side: T, grp: T, contra: B, behavior: T, tax_line: T, hint: T, active: B }, pk: 'code' },
  journal_entries: { label: '日記簿分錄', cols: { id: T, date: D, voucher_no: T, description: T, source: T, source_ref: T, status: T, lines: J, attachments: J, created_at: TS, updated_at: TS }, index: ['date', 'source'] },
  documents: {
    label: '原始憑證',
    cols: { id: T, kind: T, status: T, storage_path: T, original_name: T, archived_name: T, mime: T, doc_date: D, vendor_name: T, vendor_tax_id: T, invoice_no: T, amount_total: N, tax_amount: N, summary: T, items: J, account: T, pay_account: T, confidence: N, ai: J, entry_id: T, einvoice_id: T, created_at: TS, updated_at: TS },
  },
  einvoices: { label: '電子發票', cols: { id: T, batch_id: T, invoice_no: T, date: D, seller_tax_id: T, seller_name: T, buyer_tax_id: T, total: N, tax: N, status: T, voided: B, deductible: B, items: J, suggested_account: T, account: T, document_id: T, entry_id: T } },
  fixed_assets: { label: '固定資產', cols: { id: T, name: T, category: T, acquired_on: D, cost: N, life_years: N, residual: N, disposed_on: D, supplier: T, note: T } },
  inventory_items: { label: '原物料品項', cols: { id: T, sku: T, name: T, category: T, unit: T, gl_account: T, safety_stock: N, reorder_qty: N, supplier_id: T, std_cost: N, active: B } },
  inventory_moves: { label: '進銷存異動', cols: { id: T, item_id: T, date: D, type: T, qty: N, amount: N, supplier_id: T, order_date: D, yield_score: N, invoice_no: T, note: T }, index: ['date'] },
  recipes: { label: '配方（BOM）', cols: { id: T, product_id: T, item_id: T, qty: N } },
  stocktakes: { label: '月底盤點', cols: { id: T, month: T, account: T, value: N, note: T } },
  suppliers: { label: '供應商', cols: { id: T, name: T, tax_id: T, contact: T, phone: T, terms: T, note: T } },
  customers: { label: '會員', cols: { id: T, member_no: T, name: T, tier: T, birthday: T, preferences: T, joined_on: D, note: T } },
  campaigns: { label: '行銷活動', cols: { id: T, name: T, type: T, start_date: D, end_date: D, keywords: T, issued_qty: N, redeemed_qty: N, marketing_cost: N, note: T } },
  checklist: { label: '月結檢查', cols: { id: T, month: T, key: T, done: B, note: T, done_at: TS } },
  tax_tasks: { label: '申報事項', cols: { id: T, done: B, note: T, done_at: TS } },
  files: { label: '憑證影像（本機）', cols: { id: T, name: T, type: T, size: N, blob: T }, localOnly: true },
};

export const COLLECTIONS = Object.keys(SCHEMA);

export function pkOf(coll) {
  return SCHEMA[coll].pk || 'id';
}
