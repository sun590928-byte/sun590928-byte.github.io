// 共用狀態：設定、會計項目、品項主檔與別名對應，以及常用的衍生資料。

import { store } from './store.js';
import { DEFAULT_ACCOUNTS } from './lib/coa.js';
import { DEFAULT_VOID_RULES, guessCategory } from './lib/pos.js';
import { aliasKey } from './lib/dedupe.js';
import { DEFAULT_TIERS } from './lib/customers.js';
import { uid } from './lib/text.js';

export const DEFAULT_SETTINGS = {
  business_name: '午月咖啡廳',
  tax_id: '',
  org_type: 'sole', // sole 獨資／合夥（商號） | company 公司
  vat_mode: 'general', // general 一般稅額（開立統一發票，5% 內含） | small 小規模（查定 1%） | none
  vat_confirmed: true, // 已確認：商號、開立統一發票、營業稅 5%
  prepaid_vat: 'sale', // 寄杯／預購：sale 收款時開立發票（依法規） | redeem 兌換時開立
  filing_self: true, // 自行申報
  filing_prep_day: 10, // 申報期限當月幾日開始準備
  filing_target_day: 12, // 申報目標完成日（法定期限前）
  revenue_start: '2026-08-21',
  cutoff_hour: 0,
  void_rules: DEFAULT_VOID_RULES,
  has_employees: true,
  pays_rent_to_individual: true,
  owns_property: false,
  has_vehicle: false,
  gross_margin_est: 0.7,
  tiers: DEFAULT_TIERS,
  locked_months: [],
  bank_gl: '1103',
  unknown_payment_account: '1105', // POS 營收付款方式不明時暫列（現金類）
  doc_pay_account: '2134', // 憑證歸檔：沒有放在付款資料夾（source_folder 空白）時的預設付款方式，先列其他應付款，入帳前可改
  fee_by_invoice: true, // 金流手續費以綠界／LINE Pay 開的發票入帳（貸 應收帳款－未撥款項），撥款分錄不另計手續費
  auto_recognize: true, // 上傳憑證後自動在瀏覽器裡辨識（QR 碼、文字），不使用外部 AI
  ocr_enabled: true, // 讀不到 QR 碼時做文字辨識（第一次使用會下載約 10 MB 的辨識資料）
  capitalize_threshold: 80000, // 設備達此金額才列固定資產，未達列 6135 雜項購置
};

let settingsCache = null;

export async function getSettings() {
  if (settingsCache) return settingsCache;
  const rows = await store.all('settings');
  const main = rows.find((r) => r.id === 'main');
  settingsCache = { ...DEFAULT_SETTINGS, ...(main?.value || {}) };
  // 2026-11 老闆決定：營業收到的現金記 1105 現金，1101 零用金-門市收銀只做找零備用金；舊設定還停在 1101 的一律視為 1105
  if (settingsCache.unknown_payment_account === '1101') settingsCache.unknown_payment_account = '1105';
  // POS 的暫列科目必須是現金類；被填成 2133／2134 等負債科目的，其實是想設「憑證的預設付款方式」→ 搬到 doc_pay_account，POS 的回到 1105
  if (/^2/.test(String(settingsCache.unknown_payment_account || ''))) {
    if (!main?.value?.doc_pay_account) settingsCache.doc_pay_account = settingsCache.unknown_payment_account;
    settingsCache.unknown_payment_account = '1105';
  }
  return settingsCache;
}

export async function saveSettings(patch) {
  const s = { ...(await getSettings()), ...patch };
  await store.put('settings', { id: 'main', value: s });
  settingsCache = s;
  return s;
}

store.on((coll) => {
  if (coll === 'settings' || coll === '*') settingsCache = null;
  if (['products', 'product_aliases', '*'].includes(coll)) productIndex = null;
});

// 首次使用：寫入咖啡業會計項目；之後版本才加入、分錄一定會用到的科目若缺少也補上
// 1105 現金（2026-11-01 營業現金）、1217 原料－果汁糖漿（2026-11-10 老闆新增的存貨科目）
const REQUIRED_CODES = ['1105', '1217'];
export async function ensureAccounts() {
  const accs = await store.all('accounts');
  if (!accs.length) {
    const rows = DEFAULT_ACCOUNTS.map((a) => ({ ...a, active: true }));
    await store.put('accounts', rows);
    return rows;
  }
  const have = new Set(accs.map((a) => a.code));
  const missing = DEFAULT_ACCOUNTS.filter((a) => REQUIRED_CODES.includes(a.code) && !have.has(a.code)).map((a) => ({ ...a, active: true }));
  if (missing.length) await store.put('accounts', missing);
  return [...accs, ...missing];
}

export async function getAccounts() {
  const accs = await store.all('accounts');
  return accs.length ? [...accs].sort((a, b) => (a.code < b.code ? -1 : 1)) : ensureAccounts();
}

// ─────────── 品項：原始名稱 → 標準品項

let productIndex = null;

export async function getProductIndex() {
  if (productIndex) return productIndex;
  const [products, aliases] = await Promise.all([store.all('products'), store.all('product_aliases')]);
  const byId = new Map(products.map((p) => [p.id, p]));
  const byAlias = new Map();
  for (const a of aliases) if (byId.has(a.product_id)) byAlias.set(a.id, byId.get(a.product_id));
  productIndex = {
    products,
    byId,
    byAlias,
    aliasToProductId: new Map(aliases.filter((a) => byId.has(a.product_id)).map((a) => [a.id, a.product_id])),
    of(line) {
      const key = aliasKey(line.item_raw);
      const p = byAlias.get(key);
      if (p) return { id: p.id, name: p.name, category: p.category || guessCategory(p.name), mapped: true };
      return { id: 'raw:' + key, name: line.item_raw, category: guessCategory(line.item_raw, line.category_raw), mapped: false };
    },
  };
  return productIndex;
}

// 合併：選定名稱建立（或沿用）標準品項，並把各原始名稱指向它
export async function mergeProducts(rawNames, { name, category, productId } = {}) {
  const idx = await getProductIndex();
  let product = productId ? idx.byId.get(productId) : null;
  if (!product) {
    product = idx.products.find((p) => p.name === name) || { id: uid('p_'), name, category, active: true };
  }
  product = { ...product, name: name || product.name, category: category || product.category || guessCategory(name), updated_at: new Date().toISOString() };
  await store.put('products', product);
  const now = new Date().toISOString();
  await store.put(
    'product_aliases',
    rawNames.map((raw) => ({ id: aliasKey(raw), raw_name: raw, product_id: product.id, updated_at: now })),
  );
  productIndex = null;
  return product;
}

export async function unmapAlias(raw) {
  await store.remove('product_aliases', aliasKey(raw));
  productIndex = null;
}

// ─────────── 銷售明細

export async function revenueLines({ from, to } = {}) {
  const s = await getSettings();
  const lines = await store.all('sales_lines');
  const start = from && from > s.revenue_start ? from : s.revenue_start;
  return lines.filter((l) => l.date >= start && (!to || l.date <= to));
}

export function isLocked(settings, date) {
  return (settings.locked_months || []).includes(date.slice(0, 7));
}
