// 盤點表（11/12 需求 二-10）：匯出可列印的盤點表（帳面數量、空白的初盤／複盤／差異／備註），匯入盤點結果 →
// 每個盤到的品項產生一筆「盤點調整」（實盤 − 帳面，金額＝差異 × 移動平均成本，未稅），並算出各存貨科目的期末金額
// 寫進「存貨與成本」的期末盤點（stocktakes）。同一天同一品項的盤點調整用固定代號，重新匯入會取代、不會重複。

import { INVENTORY_CATEGORIES, stockLevels, averageCosts } from './inventory.js';
import { glOfItem, sortByCategory, headerKey } from './itemsio.js';
import { round2 } from './money.js';
import { monthEnd, parseDate } from './dates.js';

export const COUNT_HEADERS = ['物品編號', '品名', '分類', '單位', '帳面數量', '初盤量', '複盤量', '差異', '備註', '系統代號（勿改）'];

export const stocktakeMoveId = (date, itemId) => `stk_${date}_${itemId}`;

/**
 * 盤點表的品項（依存貨科目分組）；停用且帳面為 0 的品項不列。
 * @param levels stockLevels 結果陣列或 Map(item_id → 列)
 * @returns [{ account, rows: [{ item, book }] }]
 */
export function countSheetGroups(items, levels) {
  const lv = levels instanceof Map ? levels : new Map((levels || []).map((r) => [r.item.id, r]));
  const groups = new Map();
  for (const it of sortByCategory(items)) {
    const book = round2(lv.get(it.id)?.onHand ?? 0);
    if (it.active === false && !book) continue;
    const acc = glOfItem(it);
    if (!groups.has(acc)) groups.set(acc, []);
    groups.get(acc).push({ item: it, book });
  }
  return [...groups.keys()].sort().map((account) => ({ account, rows: groups.get(account) }));
}

/** 盤點表工作表（makeXlsx 用）：抬頭、盤點日、標題列、依科目分組的品項、簽名欄 */
export function countSheet(groups, { date, business = '', accName = new Map() } = {}) {
  const rows = [[`${business ? business + ' ' : ''}原物料盤點表`], ['盤點日', date, '', '帳面數量＝系統推算到盤點日當天的庫存；初盤量、複盤量填實際數到的數量（有複盤以複盤為準），填好後到「原物料進銷存」按「匯入盤點結果」'], [], COUNT_HEADERS];
  const bold = [];
  for (const g of groups) {
    bold.push(rows.length);
    rows.push([`${g.account} ${accName.get(g.account) || ''}`.trim()]);
    for (const { item, book } of g.rows) rows.push([item.sku || '', item.name || '', INVENTORY_CATEGORIES[item.category]?.label || item.category || '', item.unit || '', book, '', '', '', '', item.id]);
  }
  rows.push([]);
  rows.push(['初盤人：', '', '複盤人：', '', '', '', '', '', '日期：']); // 簽名欄不放在數量欄，匯入時才不會被當成數量
  return { name: '盤點表', rows, widths: [11, 26, 12, 7, 12, 12, 12, 10, 24, 18], header: 4, bold };
}

/**
 * 讀取填好的盤點表（Excel 或 CSV 的二維陣列）。
 * @returns { date, records: [{ line, id, sku, name, first, second, note }], skipped（沒填數量的品項列數）, errors: [{ line, label, msg }], error? }
 */
export function parseCountSheet(rows) {
  const list = rows || [];
  const key = (c) => headerKey(c);
  const hi = list.slice(0, 20).findIndex((r) => (r || []).some((c) => key(c) === '品名') && (r || []).some((c) => ['初盤量', '複盤量', '初盤', '複盤'].includes(key(c))));
  if (hi < 0) return { date: '', records: [], skipped: 0, errors: [], error: '找不到盤點表的標題列（要有「品名」和「初盤量」或「複盤量」）' };
  let date = '';
  for (const r of list.slice(0, hi)) {
    const i = (r || []).findIndex((c) => key(c) === '盤點日');
    const v = i >= 0 ? parseDate(String(r[i + 1] ?? '').trim()) : null;
    if (v) date = v;
  }
  const cols = {};
  (list[hi] || []).forEach((c, i) => {
    const k = key(c);
    const f = { 系統代號: 'id', 品項代號: 'id', 物品編號: 'sku', 品名: 'name', 初盤量: 'first', 初盤: 'first', 複盤量: 'second', 複盤: 'second', 備註: 'note' }[k];
    if (f && cols[f] === undefined) cols[f] = i;
  });
  const records = [];
  const errors = [];
  let skipped = 0;
  const cell = (row, f) => (cols[f] === undefined ? '' : String(row[cols[f]] ?? '').normalize('NFKC').trim());
  const qty = (s) => {
    const t = s.replace(/[,\s]/g, '');
    if (!t) return null;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  };
  for (let r = hi + 1; r < list.length; r++) {
    const row = list[r] || [];
    if (/^初盤人/.test(String(row[0] ?? '').trim())) break; // 簽名欄以下不是品項
    const rec = { line: r + 1, id: cell(row, 'id'), sku: cell(row, 'sku'), name: cell(row, 'name'), first: qty(cell(row, 'first')), second: qty(cell(row, 'second')), note: cols.note === undefined ? '' : String(row[cols.note] ?? '').trim() };
    if (!rec.id && !rec.sku && !rec.name) continue;
    const label = rec.name || rec.sku;
    if (Number.isNaN(rec.first) || Number.isNaN(rec.second)) {
      errors.push({ line: rec.line, label, msg: `數量要是 0 以上的數字（初盤「${cell(row, 'first')}」、複盤「${cell(row, 'second')}」）` });
      continue;
    }
    if (rec.first === null && rec.second === null) {
      if (rec.id || rec.name) skipped++; // 科目分組列、簽名欄不算
      continue;
    }
    records.push(rec);
  }
  return { date, records, skipped, errors };
}

/**
 * 盤點結果 → 盤點調整異動與各科目期末金額。
 * 帳面數量不含「同一天、同一品項」上次匯入的盤點調整（重新匯入會取代它）；沒盤到的品項以帳面數量 × 平均成本計入科目合計。
 * @param usage theoreticalUsage(…, { to: date }) 的結果
 * @returns { date, ym, lines, moves（要存的盤點調整）, removeIds（差異歸零、要刪掉的舊調整）, accounts, stocktakes, overwrite, errors, warnings }
 */
export function planStocktake({ items, moves, usage, records, date, vatRate = 0.05, stocktakes = [] }) {
  const ym = date.slice(0, 7);
  const byId = new Map(items.map((i) => [i.id, i]));
  const nk = (v) => String(v || '').normalize('NFKC').trim(); // 盤點表讀進來的編號、品名已轉成半形
  const bySku = new Map(items.filter((i) => i.sku).map((i) => [nk(i.sku).toUpperCase(), i]));
  const byName = new Map();
  for (const i of items) if (!byName.has(nk(i.name))) byName.set(nk(i.name), i);
  const errors = [];
  const warnings = [];
  const counted = new Map(); // item_id → record
  for (const rec of records) {
    const it = byId.get(rec.id) || (rec.sku && bySku.get(rec.sku.toUpperCase())) || (rec.name && byName.get(rec.name)) || null;
    if (!it) {
      errors.push({ line: rec.line, label: rec.name || rec.sku, msg: '找不到這個品項（物品編號、品名都對不到），這一列略過' });
      continue;
    }
    if (counted.has(it.id)) {
      errors.push({ line: rec.line, label: it.name, msg: `和第 ${counted.get(it.id).line} 列是同一個品項，這一列略過` });
      continue;
    }
    counted.set(it.id, rec);
  }
  const own = new Set([...counted.keys()].map((id) => stocktakeMoveId(date, id)));
  const base = moves.filter((m) => !own.has(m.id));
  const levels = new Map(stockLevels(items, base, usage, { asOf: date, vatRate }).map((r) => [r.item.id, r]));
  const costs = averageCosts(items, base, { asOf: date, vatRate });
  const existingIds = new Set(moves.map((m) => m.id));
  const lines = [];
  const putMoves = [];
  const removeIds = [];
  for (const [id, rec] of counted) {
    const it = byId.get(id);
    const book = round2(levels.get(id)?.onHand ?? 0);
    const qty = rec.second ?? rec.first;
    const diff = round2(qty - book);
    const avg = costs.get(id)?.avg || 0;
    const amount = round2(diff * avg);
    lines.push({ item: it, line: rec.line, book, first: rec.first, second: rec.second, counted: qty, diff, avg, amount, value: round2(qty * avg), note: rec.note });
    if (qty > 0 && !(avg > 0)) warnings.push({ line: rec.line, msg: `「${it.name}」還沒有進貨成本（也沒有標準成本），期末金額以 0 計算` });
    const mid = stocktakeMoveId(date, id);
    if (diff !== 0) {
      const counts = [rec.first !== null ? `初盤 ${rec.first}` : '', rec.second !== null ? `複盤 ${rec.second}` : ''].filter(Boolean).join('／');
      putMoves.push({ id: mid, item_id: id, date, type: 'adjust', qty: diff, amount, note: `盤點調整（${counts}）${rec.note ? '：' + rec.note : ''}`, stocktake_date: date, first_count: rec.first, second_count: rec.second });
    } else if (existingIds.has(mid)) removeIds.push(mid);
  }
  // 各存貨科目的期末金額：盤到的以實盤數量 × 平均成本，沒盤到的以帳面價值
  const acc = new Map();
  for (const it of items) {
    const code = glOfItem(it);
    if (!acc.has(code)) acc.set(code, { account: code, value: 0, bookValue: 0, countedItems: 0, bookItems: 0 });
    const a = acc.get(code);
    const lv = levels.get(it.id);
    const bookValue = lv ? lv.value : 0;
    a.bookValue += bookValue;
    const rec = counted.get(it.id);
    if (rec) {
      a.countedItems++;
      a.value += (rec.second ?? rec.first) * (costs.get(it.id)?.avg || 0);
    } else {
      if (lv && (lv.onHand || lv.value)) a.bookItems++;
      a.value += bookValue;
    }
  }
  const accounts = [...acc.values()].sort((x, y) => (x.account < y.account ? -1 : 1)).map((a) => {
    const st = stocktakes.find((s) => s.id === `${ym}|${a.account}`);
    return { ...a, value: round2(a.value), bookValue: round2(a.bookValue), existing: st && st.value !== null && st.value !== undefined && st.value !== '' ? Number(st.value) : null, existingNote: st?.note || '' };
  });
  const rowsOut = accounts.filter((a) => a.countedItems > 0).map((a) => ({ id: `${ym}|${a.account}`, month: ym, account: a.account, value: Math.round(a.value), note: `由盤點表匯入 ${date}` }));
  const overwrite = rowsOut.filter((r) => {
    const a = accounts.find((x) => x.account === r.account);
    return a.existing !== null && a.existing !== r.value;
  });
  if (date !== monthEnd(ym)) warnings.push({ line: 0, msg: `盤點日 ${date} 不是月底：期末盤點金額會記在 ${Number(ym.slice(5))} 月，盤點日之後到月底的進貨與耗用不會算進去` });
  return { date, ym, lines, moves: putMoves, removeIds, accounts, stocktakes: rowsOut, overwrite, errors, warnings };
}
