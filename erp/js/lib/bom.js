// BOM 配方表：POS 賣出的品名 → 每賣出一份用掉的原料。不用先做品項整併：
// 合併過的品名以合併後的品項 id 設配方，沒合併的品名直接用 'raw:' + aliasKey(品名)（與 state.js getProductIndex().of() 相同）。
// 配方列：{ id: `${product_id}|${item_id}`, product_id, item_id, qty, product_name（設定當時的品名，顯示用） }

import { compactKey } from './text.js';
import { aliasKey } from './dedupe.js';
import { parseAmount, round2 } from './money.js';

export const recipeId = (productId, itemId) => `${productId}|${itemId}`;
export const rawProductId = (name) => 'raw:' + aliasKey(name);

// 需要配方的銷售行：排除整單折扣／服務費等調整列、POS 作廢取消、數量 ≤ 0、寄杯／儲值售出（收的是預收款，兌換時才做飲品）
// 老闆招待／測試／報廢的份數，原料確實用掉了，仍需要配方
export function needsRecipe(line, product = null) {
  if (!line || line.is_adjustment || line.void_reason === 'pos_void') return false;
  if (!(Number(line.qty) > 0)) return false;
  return (product?.category || '') !== 'prepaid';
}

/**
 * BOM 頁的列：依品項（合併過的算一個）彙總期間內的銷售與配方狀態。
 * @param lines 銷售明細（可含期間外的行：只用來判斷品名第一次出現的日期）
 * @param productOf (line) => { id, name, category, mapped }
 * @param opts.from/to 期間；opts.skip 標記「不需配方」的 product_id；opts.newSince 這天以後才第一次賣的算「新品名」
 */
export function bomRows(lines, productOf, recipes = [], { from = null, to = null, skip = [], newSince = null } = {}) {
  const count = new Map();
  for (const r of recipes) count.set(r.product_id, (count.get(r.product_id) || 0) + 1);
  const skipSet = new Set(skip);
  const firstSeen = new Map();
  const rows = new Map();
  for (const l of lines) {
    const p = productOf(l);
    if (!needsRecipe(l, p)) continue;
    if (!firstSeen.has(p.id) || l.date < firstSeen.get(p.id)) firstSeen.set(p.id, l.date);
    if ((from && l.date < from) || (to && l.date > to)) continue;
    let r = rows.get(p.id);
    if (!r) rows.set(p.id, (r = { id: p.id, name: p.name, category: p.category, mapped: !!p.mapped, spell: new Map(), qty: 0, revenue: 0, otherQty: 0, last: l.date }));
    const q = Number(l.qty) || 0;
    const sp = String(l.item_raw || '').trim();
    r.spell.set(sp, (r.spell.get(sp) || 0) + q);
    if (l.void_reason) r.otherQty += q;
    else {
      r.qty += q;
      r.revenue += Number(l.revenue) || 0;
    }
    if (l.date > r.last) r.last = l.date;
  }
  return [...rows.values()].map(({ spell, ...r }) => {
    const spellings = [...spell].sort((a, b) => b[1] - a[1]).map(([s]) => s).filter(Boolean);
    const n = count.get(r.id) || 0;
    const first = firstSeen.get(r.id);
    return { ...r, name: r.mapped ? r.name : spellings[0] || r.name, spellings, qty: round2(r.qty), revenue: round2(r.revenue), otherQty: round2(r.otherQty), first, recipeCount: n, hasRecipe: n > 0, skipped: skipSet.has(r.id), isNew: !!newSince && first >= newSince };
  });
}

// 還沒設配方（也沒標「不需配方」）的品名
export function missingRecipes(rows) {
  return rows.filter((r) => !r.hasRecipe && !r.skipped);
}

/**
 * 一批銷售裡還沒設配方的品名；seen（之前就賣過的 product_id）有給時，標出第一次出現的新品名。
 */
export function recipeGaps(lines, productOf, recipes, { skip = [], seen = null } = {}) {
  const rows = missingRecipes(bomRows(lines, productOf, recipes, { skip }));
  return rows.map((r) => ({ ...r, isNew: seen ? !seen.has(r.id) : false })).sort((a, b) => Number(b.isNew) - Number(a.isNew) || b.qty + b.otherQty - (a.qty + a.otherQty));
}

// 每個 product_id 的理論成本／份（Σ 用量 × 原料平均成本）；合併過的品項與沒合併的品名都算
export function recipeCosts(recipes, avgCostOf) {
  const out = new Map();
  for (const r of recipes) out.set(r.product_id, (out.get(r.product_id) || 0) + (Number(r.qty) || 0) * (avgCostOf(r.item_id) || 0));
  for (const [k, v] of out) out.set(k, round2(v));
  return out;
}

// 以新的原料清單取代某個品名的配方：回傳要寫入與要刪除的列
export function replaceRecipe(recipes, productId, lines, productName = '') {
  const put = lines.map((x) => ({ id: recipeId(productId, x.item_id), product_id: productId, item_id: x.item_id, qty: Number(x.qty), ...(productName ? { product_name: productName } : {}) }));
  const keep = new Set(put.map((x) => x.id));
  const remove = recipes.filter((r) => r.product_id === productId && !keep.has(r.id)).map((r) => r.id);
  return { put, remove };
}

const recipeSig = (recipes, pid) =>
  recipes
    .filter((r) => r.product_id === pid)
    .map((r) => `${r.item_id}:${Number(r.qty)}`)
    .sort()
    .join('|');

/**
 * 品項整併時的配方搬移：合併進來的原始品名（raw:）有配方、合併後的品項還沒有 → 複製到品項（原始品名的配方留著，取消合併時會恢復）；
 * 品項已有配方 → 保留品項的，kept 列出沒有套用的原始品名。
 * @returns { put: 要寫入的配方列, from: 帶過去的原始 id 或 null, kept: [沒有套用、且配方不同的原始 id] }
 */
export function planRecipeCarryOver(recipes, fromIds, toId, toName = '') {
  const has = (pid) => recipes.some((r) => r.product_id === pid);
  const sources = [...new Set(fromIds)].filter((id) => id !== toId && has(id));
  if (!sources.length) return { put: [], from: null, kept: [] };
  if (has(toId)) return { put: [], from: null, kept: sources.filter((id) => recipeSig(recipes, id) !== recipeSig(recipes, toId)) };
  const src = sources[0];
  const put = recipes.filter((r) => r.product_id === src).map((r) => ({ id: recipeId(toId, r.item_id), product_id: toId, item_id: r.item_id, qty: Number(r.qty), ...(toName ? { product_name: toName } : {}) }));
  const kept = sources.slice(1).filter((id) => recipeSig(recipes, id) !== recipeSig(recipes, src));
  return { put, from: src, kept };
}

// 匯入檔的品名 → product_id：已合併的寫法 → 品項；寫的是合併後的品項名稱 → 品項；其他 → 'raw:' 原始品名（還沒賣過的也收）
export function resolveProductId(name, { aliasToProductId = new Map(), products = [] } = {}) {
  const key = aliasKey(name);
  if (!key) return null;
  const pid = aliasToProductId.get(key);
  if (pid) return pid;
  const p = products.find((x) => aliasKey(x.name) === key);
  return p ? p.id : 'raw:' + key;
}

export const RECIPE_HEADER = ['POS 品名', '原料物品編號', '原料品名', '用量', '單位'];

// 匯出：每個品名的每項原料一列；還沒設配方的品名也列一列（原料欄空白），匯出的檔案就能當範本填
export function recipeSheetRows(entries, items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows = [RECIPE_HEADER];
  for (const e of entries) {
    if (!e.lines?.length) {
      rows.push([e.name, '', '', '', '']);
      continue;
    }
    for (const ln of e.lines) {
      const it = byId.get(ln.item_id);
      rows.push([e.name, it?.sku || '', it?.name || '（已刪除的原料）', Number(ln.qty), it?.unit || '']);
    }
  }
  return rows;
}

const headKey = (v) => compactKey(v);
function detectColumns(row) {
  const col = {};
  row.forEach((cell, i) => {
    const k = headKey(cell);
    if (!k) return;
    const isRaw = /原料|材料|物料/.test(k);
    const set = (f) => {
      if (col[f] === undefined) col[f] = i;
    };
    if (/單位/.test(k)) set('unit');
    else if (/用量|每份|數量|份量/.test(k)) set('qty');
    else if (/編號|代碼|sku|料號/.test(k)) set('sku');
    else if (isRaw) set('item');
    else if (/品名|品項|商品|產品|pos/.test(k)) set('pos');
  });
  return col;
}

/**
 * 解析配方匯入表（Excel／CSV，二維陣列）：欄位 POS 品名、原料物品編號、原料品名、用量、單位（單位只用來核對）。
 * 同一個品名的下一列 POS 品名留白，沿用上一列。原料依物品編號找，找不到再用品名找。
 * @param opts.resolveProduct (POS 品名) => product_id
 * @returns { products: [{ id, name, lines: [{ item_id, qty }] }], skipped: [{ row, reason }] } 或 { error }
 */
export function parseRecipeSheet(rows, { items = [], resolveProduct }) {
  let head = -1;
  let col = null;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const c = detectColumns(rows[i] || []);
    if (c.pos !== undefined && c.qty !== undefined && (c.sku !== undefined || c.item !== undefined)) {
      head = i;
      col = c;
      break;
    }
  }
  if (head < 0) return { error: '找不到表頭：需要「POS 品名」「用量」兩欄，以及「原料物品編號」或「原料品名」其中一欄（可以先按「匯出配方」拿範本）' };
  const bySku = new Map(items.filter((i) => String(i.sku || '').trim()).map((i) => [String(i.sku).trim().toLowerCase(), i]));
  const byName = new Map(items.map((i) => [compactKey(i.name), i]));
  const products = new Map();
  const skipped = [];
  let lastPos = '';
  for (let r = head + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const cell = (f) => (col[f] === undefined ? '' : String(row[col[f]] ?? '').trim());
    const rowNo = r + 1;
    let pos = cell('pos');
    const sku = cell('sku');
    const itemName = cell('item');
    const qtyText = cell('qty');
    const unit = cell('unit');
    if (!pos && !sku && !itemName && !qtyText) continue; // 空白列
    if (pos) lastPos = pos;
    else pos = lastPos;
    if (!sku && !itemName) {
      if (qtyText) skipped.push({ row: rowNo, reason: `「${pos || '（沒有品名）'}」這列有用量但沒有填原料` });
      continue; // 只有品名、原料空白：範本裡還沒填的品名
    }
    if (!pos) {
      skipped.push({ row: rowNo, reason: '沒有 POS 品名' });
      continue;
    }
    const it = (sku && bySku.get(sku.toLowerCase())) || (itemName && byName.get(compactKey(itemName))) || null;
    if (!it) {
      skipped.push({ row: rowNo, reason: `找不到原料「${[sku, itemName].filter(Boolean).join(' ')}」，請先到「原物料進銷存」建檔` });
      continue;
    }
    const qty = parseAmount(qtyText);
    if (qty === null || !(qty > 0)) {
      skipped.push({ row: rowNo, reason: `「${pos}」的「${it.name}」用量要填大於 0 的數字` });
      continue;
    }
    if (unit && it.unit && compactKey(unit) !== compactKey(it.unit)) {
      skipped.push({ row: rowNo, reason: `「${pos}」的「${it.name}」單位寫「${unit}」，和庫存單位「${it.unit}」不同（配方用量要用庫存單位）` });
      continue;
    }
    const pid = resolveProduct(pos);
    if (!pid) {
      skipped.push({ row: rowNo, reason: `看不懂品名「${pos}」` });
      continue;
    }
    let p = products.get(pid);
    if (!p) products.set(pid, (p = { id: pid, name: pos, lines: [] }));
    if (p.lines.some((x) => x.item_id === it.id)) {
      skipped.push({ row: rowNo, reason: `「${pos}」的「${it.name}」重複，只用第一列` });
      continue;
    }
    p.lines.push({ item_id: it.id, qty });
  }
  return { products: [...products.values()], skipped };
}
