// 原物料主檔匯出／匯入 Excel（11/12 需求 二-6）：安全庫存、叫貨量、進貨包裝與折合量可以在 Excel 裡一次改完再匯回來。
// 匯入：先用物品編號對應，再用品名（完全相同）對應；空白格不覆蓋；只改主檔欄位（品名只有用物品編號對到時才會改）；
// 對不到的列可選擇新增成新品項。目前庫存、日均耗用、建議安全庫存、入帳科目只供參考，匯入時不讀。

import { INVENTORY_CATEGORIES, suggestSku } from './inventory.js';
import { guessItemCategory } from './purchases.js';
import { normalizeText, uid } from './text.js';
import { round2 } from './money.js';

export const ITEM_HEADERS = ['物品編號', '品名', '分類', '入帳科目', '庫存單位', '安全庫存', '建議叫貨量', '進貨包裝', '每包裝折合', '目前庫存', '日均耗用', '建議安全庫存', '備註'];

// 匯入時認得的欄名（去掉空白與括號說明後比對）→ 欄位
const FIELD_OF = {
  物品編號: 'sku',
  編號: 'sku',
  sku: 'sku',
  品名: 'name',
  品項: 'name',
  分類: 'category',
  庫存單位: 'unit',
  單位: 'unit',
  安全庫存: 'safety_stock',
  建議叫貨量: 'reorder_qty',
  叫貨量: 'reorder_qty',
  進貨包裝: 'pack_type',
  每包裝折合: 'pack_size',
  每包裝折合幾個庫存單位: 'pack_size',
  包裝折合: 'pack_size',
  備註: 'note',
};

export const FIELD_LABELS = { name: '品名', category: '分類', unit: '庫存單位', safety_stock: '安全庫存', reorder_qty: '建議叫貨量', pack_type: '進貨包裝', pack_size: '每包裝折合', note: '備註' };
const NUM_FIELDS = ['safety_stock', 'reorder_qty', 'pack_size'];
const TEXT_FIELDS = ['unit', 'pack_type', 'note'];

export const headerKey = (s) =>
  normalizeText(s)
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
const cellText = (v) => (v === null || v === undefined ? '' : String(v).trim());
// 比對用（全形半形、大小寫、連續空白視為相同）；存回去的仍是原字
const skuKey = (s) => cellText(s).normalize('NFKC').toUpperCase();
const nameKey = (s) => cellText(s).normalize('NFKC').replace(/\s+/g, ' ');

const CAT_ORDER = Object.keys(INVENTORY_CATEGORIES);
export function sortByCategory(items) {
  return [...items].sort((a, b) => CAT_ORDER.indexOf(a.category) - CAT_ORDER.indexOf(b.category) || String(a.sku || a.name).localeCompare(String(b.sku || b.name), 'zh-Hant'));
}

export const glOfItem = (it) => it.gl_account || INVENTORY_CATEGORIES[it.category]?.gl || '1211';

/**
 * 原物料主檔工作表（makeXlsx 用）
 * @param levels Map(item_id → stockLevels 列)；suggest Map(item_id → suggestSafetyStock 結果)；accName Map(科目代號 → 名稱)
 */
export function itemSheet(items, { levels = new Map(), suggest = new Map(), accName = new Map() } = {}) {
  const rows = [ITEM_HEADERS];
  for (const it of sortByCategory(items)) {
    const lv = levels.get(it.id);
    const s = suggest.get(it.id);
    const gl = glOfItem(it);
    const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? '' : Number(v));
    rows.push([
      it.sku || '',
      it.name || '',
      INVENTORY_CATEGORIES[it.category]?.label || it.category || '',
      `${gl} ${accName.get(gl) || ''}`.trim(),
      it.unit || '',
      n(it.safety_stock),
      n(it.reorder_qty),
      it.pack_type || '',
      n(it.pack_size),
      lv ? round2(lv.onHand) : '',
      s ? round2(s.avgDaily) : '',
      s ? (s.value === null ? '資料不足' : s.value) : '',
      it.note || '',
    ]);
  }
  return { name: '原物料主檔', rows, widths: [11, 26, 13, 22, 9, 10, 11, 10, 11, 11, 10, 13, 24], header: 1 };
}

export function itemHelpSheet({ asOf = '', rule = null } = {}) {
  const rows = [
    ['原物料主檔匯入說明'],
    ['可以修改的欄位', '品名、分類、庫存單位、安全庫存、建議叫貨量、進貨包裝、每包裝折合、備註'],
    ['只供參考（匯入時不讀）', '入帳科目（跟著分類）、目前庫存、日均耗用、建議安全庫存'],
    ['對應方式', '先用「物品編號」對到既有品項；沒有編號或對不到時用「品名」（要完全相同）。品名只有用物品編號對到時才會改。'],
    ['空白的格子', '不會覆蓋原本的資料。要清掉備註或包裝，請到系統裡「修改」。'],
    ['新的品項', '對不到的列，匯入時可以勾選「一併新增」；物品編號留白會自動編號，分類留白會依品名判斷。'],
    ['分類可以填', Object.values(INVENTORY_CATEGORIES).map((c) => c.label).join('、')],
    ['每包裝折合', '1 個進貨包裝等於幾個庫存單位，例如 1 瓶鮮乳 ＝ 936 ml 就填 936；改了之後，這個品項的進貨數量會自動重算。'],
  ];
  if (rule) rows.push(['建議安全庫存', `近 ${rule.lookback_days} 天日均耗用 ×（叫貨前置 ${rule.lead_days} 天 ＋ 安全 ${rule.safety_days} 天），算到 ${asOf}`]);
  return { name: '說明', rows, widths: [22, 90], header: 1 };
}

/**
 * 讀取匯入的工作表（Excel 或 CSV 的二維陣列）：找到含「品名」或「物品編號」的標題列，逐列取出認得的欄位（原字串）。
 * @returns { records: [{ line, sku?, name?, category?, unit?, safety_stock?, reorder_qty?, pack_type?, pack_size?, note? }], error? }
 */
export function parseItemSheet(rows) {
  const list = rows || [];
  const hi = list.slice(0, 15).findIndex((r) => (r || []).some((c) => ['品名', '物品編號'].includes(headerKey(c))));
  if (hi < 0) return { records: [], error: '找不到標題列：第一列要有「物品編號」或「品名」' };
  const cols = new Map();
  (list[hi] || []).forEach((c, i) => {
    const f = FIELD_OF[headerKey(c)];
    if (f && !cols.has(f)) cols.set(f, i);
  });
  if (!cols.has('name') && !cols.has('sku')) return { records: [], error: '標題列要有「物品編號」或「品名」' };
  const records = [];
  for (let r = hi + 1; r < list.length; r++) {
    const row = list[r] || [];
    const rec = { line: r + 1 };
    for (const [f, i] of cols) rec[f] = cellText(row[i]);
    if (!rec.sku && !rec.name) continue;
    records.push(rec);
  }
  return { records };
}

// 分類格：分類名稱（果汁糖漿）、代號（juice_syrup）、「名稱（科目）」或科目代號（1217）都認得
export function resolveCategory(text) {
  const t = cellText(text);
  if (!t) return null;
  if (INVENTORY_CATEGORIES[t]) return t;
  const k = headerKey(t).replace(/\//g, '');
  for (const [key, c] of Object.entries(INVENTORY_CATEGORIES)) if (k && k === headerKey(c.label).replace(/\//g, '')) return key;
  const gl = /^(12\d\d)/.exec(t)?.[1];
  if (gl) {
    const hit = Object.entries(INVENTORY_CATEGORIES).find(([key, c]) => key !== 'other' && c.gl === gl);
    if (hit) return hit[0];
  }
  return null;
}

function parseNum(v) {
  const s = cellText(v).normalize('NFKC').replace(/[,\s]/g, '');
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}
const sameNum = (a, b) => (a === null || a === undefined || a === '' ? null : Number(a)) === (b === null || b === undefined || b === '' ? null : Number(b));

/**
 * 比對匯入的列與既有主檔。
 * @returns { updates: [{ line, item, next, changes: [{ field, label, from, to }], matchedBy }], creates: [{ line, item, guessed }], errors: [{ line, label, msg }], unchanged: [{ line, item }], warnings: [{ line, msg }] }
 */
export function planItemImport(records, items, { makeId = () => uid('it_') } = {}) {
  const bySku = new Map();
  const byName = new Map();
  for (const it of items) {
    if (it.sku) bySku.set(skuKey(it.sku), it);
    if (it.name && !byName.has(nameKey(it.name))) byName.set(nameKey(it.name), it);
  }
  const out = { updates: [], creates: [], errors: [], unchanged: [], warnings: [] };
  const seen = new Map(); // item.id → 第幾列
  const takenNames = new Map(items.map((it) => [nameKey(it.name), it.id]));
  const takenSkus = new Set(items.map((it) => skuKey(it.sku)).filter(Boolean));
  const created = [];
  for (const rec of records) {
    const label = rec.name || rec.sku || `第 ${rec.line} 列`;
    const err = (msg) => out.errors.push({ line: rec.line, label, msg });
    const vals = {};
    let bad = '';
    for (const f of NUM_FIELDS) {
      if (rec[f] === undefined) continue;
      const v = parseNum(rec[f]);
      if (Number.isNaN(v)) bad ||= `${FIELD_LABELS[f]}「${rec[f]}」要是 0 以上的數字`;
      else if (v !== undefined) vals[f] = f === 'pack_size' && v === 0 ? null : v;
    }
    if (bad) {
      err(bad);
      continue;
    }
    let cat;
    if (rec.category) {
      cat = resolveCategory(rec.category);
      if (!cat) {
        err(`分類「${rec.category}」不認得，可以填：${Object.values(INVENTORY_CATEGORIES).map((c) => c.label).join('、')}`);
        continue;
      }
    }
    for (const f of TEXT_FIELDS) if (rec[f]) vals[f] = rec[f];
    let item = rec.sku ? bySku.get(skuKey(rec.sku)) : null;
    let matchedBy = item ? 'sku' : '';
    if (!item && rec.name) {
      item = byName.get(nameKey(rec.name)) || null;
      if (item) matchedBy = 'name';
    }
    if (item) {
      if (seen.has(item.id)) {
        err(`和第 ${seen.get(item.id)} 列是同一個品項（${item.sku || ''} ${item.name}），這一列略過`);
        continue;
      }
      seen.set(item.id, rec.line);
      if (matchedBy === 'name' && rec.sku && skuKey(rec.sku) !== skuKey(item.sku)) out.warnings.push({ line: rec.line, msg: `物品編號 ${rec.sku} 找不到，以品名對到「${item.name}」（編號維持 ${item.sku || '空白'}）` });
      const next = { ...item };
      const changes = [];
      const set = (field, to, from = item[field]) => {
        changes.push({ field, label: FIELD_LABELS[field], from, to });
        next[field] = to;
      };
      if (matchedBy === 'sku' && rec.name && nameKey(rec.name) !== nameKey(item.name)) {
        const owner = takenNames.get(nameKey(rec.name));
        if (owner && owner !== item.id) {
          err(`品名改成「${rec.name}」會和其他品項同名`);
          continue;
        }
        takenNames.delete(nameKey(item.name));
        takenNames.set(nameKey(rec.name), item.id);
        set('name', rec.name);
      }
      if (cat && cat !== item.category) {
        set('category', cat);
        next.gl_account = INVENTORY_CATEGORIES[cat].gl;
        next.auto_category = false;
      }
      for (const f of TEXT_FIELDS) if (vals[f] !== undefined && vals[f] !== cellText(item[f])) set(f, vals[f]);
      for (const f of NUM_FIELDS) if (f in vals && !sameNum(vals[f], item[f])) set(f, vals[f]);
      if (changes.length) out.updates.push({ line: rec.line, item, next, changes, matchedBy });
      else out.unchanged.push({ line: rec.line, item });
      continue;
    }
    // 對不到既有品項：新增
    if (!rec.name) {
      err(`找不到物品編號 ${rec.sku}，也沒有品名，無法新增`);
      continue;
    }
    if (takenNames.has(nameKey(rec.name))) {
      err(`「${rec.name}」在檔案裡出現兩次`);
      continue;
    }
    if (rec.sku && takenSkus.has(skuKey(rec.sku))) {
      err(`物品編號 ${rec.sku} 在檔案裡出現兩次`);
      continue;
    }
    const guess = cat ? { category: cat, sure: true } : guessItemCategory(rec.name);
    const c = INVENTORY_CATEGORIES[guess.category];
    const sku = rec.sku || suggestSku(guess.category, [...items, ...created]);
    const it = {
      id: makeId(),
      sku,
      name: rec.name,
      category: guess.category,
      unit: vals.unit || c.unit,
      gl_account: c.gl,
      safety_stock: vals.safety_stock ?? null,
      reorder_qty: vals.reorder_qty ?? null,
      std_cost: null,
      supplier_id: null,
      pack_type: vals.pack_type || '',
      pack_size: 'pack_size' in vals ? vals.pack_size : 1,
      note: vals.note || '',
      active: true,
      auto_category: !guess.sure,
    };
    created.push(it);
    takenNames.set(nameKey(it.name), it.id);
    takenSkus.add(skuKey(sku));
    out.creates.push({ line: rec.line, item: it, guessed: !cat });
  }
  return out;
}
