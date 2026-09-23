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
  org_type: 'sole', // sole 獨資／合夥 | company 公司
  vat_mode: 'general', // general 一般稅額（5% 內含） | small 小規模（查定 1%） | none
  vat_confirmed: false,
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
  unknown_payment_account: '1101',
};

let settingsCache = null;

export async function getSettings() {
  if (settingsCache) return settingsCache;
  const rows = await store.all('settings');
  const main = rows.find((r) => r.id === 'main');
  settingsCache = { ...DEFAULT_SETTINGS, ...(main?.value || {}) };
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

// 首次使用：寫入咖啡業會計項目
export async function ensureAccounts() {
  const accs = await store.all('accounts');
  if (accs.length) return accs;
  const rows = DEFAULT_ACCOUNTS.map((a) => ({ ...a, active: true }));
  await store.put('accounts', rows);
  return rows;
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
