// 原物料主檔匯出／匯入 Excel、依耗用量建議安全庫存（11/12 需求 二-6）。
// 「原物料進銷存」與「進貨紀錄 → 商品類別」頁共用。

import { h, raw, modal, toast, confirmBox, pickFiles, download, fmt, status } from '../ui.js';
import { store } from '../store.js';
import { getSettings, saveSettings, getProductIndex, revenueLines, getAccounts } from '../state.js';
import { INVENTORY_CATEGORIES, theoreticalUsage, stockLevels, safetySuggestions, normalizeSafetyRule, SAFETY_MIN_DAYS } from '../lib/inventory.js';
import { itemSheet, itemHelpSheet, parseItemSheet, planItemImport, sortByCategory } from '../lib/itemsio.js';
import { repackMoves } from '../lib/purchases.js';
import { makeXlsx } from '../lib/xlsxw.js';
import { readXlsx } from '../lib/xlsx.js';
import { decodeBytes, parseCSV } from '../lib/csv.js';
import { today } from '../lib/dates.js';
import { uid } from '../lib/text.js';

const fail = (msg) => {
  toast(msg, 'error');
  return false;
};
const qty = (v) => (v === null || v === undefined || v === '' ? '—' : fmt(Number(v)));
const categoryLabel = (cat) => INVENTORY_CATEGORIES[cat]?.label || cat || '';
const daily = (v) => (v > 0 ? (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : fmt(Math.round(v))) : '0');

/**
 * 進銷存目前狀態：品項、異動、配方、到 asOf 的理論耗用，以及算日均耗用用的日期（POS 資料落後時用最後銷售日）。
 * asOf 留白＝今天（POS 資料比今天新時用最後銷售日）。
 */
export async function inventoryContext({ asOf = '' } = {}) {
  const settings = await getSettings();
  const vatRate = settings.vat_mode === 'general' ? 0.05 : 0;
  const idx = await getProductIndex();
  const lines = await revenueLines();
  const [items, moves, recipes] = await Promise.all(['inventory_items', 'inventory_moves', 'recipes'].map((c) => store.all(c)));
  let lastSale = '';
  let firstSale = '';
  for (const l of lines) {
    if (l.date > lastSale) lastSale = l.date;
    if (!firstSale || l.date < firstSale) firstSale = l.date;
  }
  const day = asOf || (lastSale > today() ? lastSale : today());
  const rateAsOf = lastSale && lastSale < day ? lastSale : day;
  const dataStart = [settings.revenue_start || '', firstSale].sort().pop();
  const pidCache = new Map();
  const pidOf = (l) => {
    if (!pidCache.has(l)) pidCache.set(l, idx.of(l).id);
    return pidCache.get(l);
  };
  const usageTo = (to) => theoreticalUsage(lines, recipes, pidOf, { to });
  const usage = usageTo(day);
  return { settings, vatRate, items, moves, recipes, lines, usage, usageTo, asOf: day, rateAsOf, dataStart };
}

export const safetyRuleOf = (settings) => normalizeSafetyRule(settings?.safety_stock_rule);

async function readTable(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (/\.xlsx$/i.test(file.name)) {
    const sheets = await readXlsx(buf);
    return sheets.filter((s) => s.state !== 'hidden').map((s) => s.rows);
  }
  if (/\.xls$/i.test(file.name)) throw new Error('舊版 .xls 讀不到，請在 Excel 另存成 .xlsx 或 CSV 再匯入');
  return [parseCSV(decodeBytes(buf).text)];
}

/** 讀第一個認得的工作表；回傳 { rows, error } */
export async function readSheetFile(file, parse) {
  let tables;
  try {
    tables = await readTable(file);
  } catch (e) {
    return { error: e.message || String(e) };
  }
  let firstErr = '';
  for (const rows of tables) {
    const res = parse(rows);
    if (!res.error) return res;
    firstErr ||= res.error;
  }
  return { error: firstErr || '檔案是空的' };
}

// ─────────── 匯出

export async function exportItems() {
  const c = await inventoryContext();
  if (!c.items.length) return toast('還沒有原物料品項可以匯出', 'error');
  const accName = new Map((await getAccounts()).map((a) => [a.code, a.name]));
  const levels = new Map(stockLevels(c.items, c.moves, c.usage, { asOf: c.asOf, vatRate: c.vatRate }).map((r) => [r.item.id, r]));
  const rule = safetyRuleOf(c.settings);
  const suggest = safetySuggestions(c.items, c.moves, c.usage, { asOf: c.rateAsOf, dataStart: c.dataStart, rule });
  download(`原物料主檔_${c.asOf}.xlsx`, makeXlsx([itemSheet(c.items, { levels, suggest, accName }), itemHelpSheet({ asOf: c.rateAsOf, rule })]));
  toast(`已匯出 ${c.items.length} 項原物料；在 Excel 改好安全庫存、叫貨量、包裝折合後，按「匯入」把檔案匯回`, 'good', 5000);
}

// ─────────── 匯入

const changeText = (ch) => {
  const v = (x) => (x === null || x === undefined || x === '' ? '（空白）' : typeof x === 'number' ? fmt(x) : x);
  return `${ch.label}：${v(ch.from)} → ${v(ch.to)}`;
};

/** 選檔 → 預覽變更 → 確認後寫入；有寫入回傳 true */
export async function importItems() {
  const [file] = await pickFiles({ accept: '.xlsx,.csv,.txt,text/csv', multiple: false });
  if (!file) return false;
  const parsed = await readSheetFile(file, parseItemSheet);
  if (parsed.error) return fail(`${file.name}：${parsed.error}`);
  const [items, moves] = await Promise.all([store.all('inventory_items'), store.all('inventory_moves')]);
  const plan = planItemImport(parsed.records, items, { makeId: () => uid('it_') });
  const { updates, creates, errors, unchanged, warnings } = plan;
  const errList = errors.length ? h`<div class="callout warn" style="margin-top:12px"><p><b>${errors.length} 列有問題，不會匯入：</b></p><ul class="plain-list">${errors.map((e) => h`<li>第 ${e.line} 列「${e.label}」：${e.msg}</li>`)}</ul></div>` : '';
  const warnList = warnings.length ? h`<ul class="plain-list" style="margin-top:8px">${warnings.map((w) => h`<li>第 ${w.line} 列：${w.msg}</li>`)}</ul>` : '';
  if (!updates.length && !creates.length) {
    await modal({ title: '匯入原物料主檔', body: h`<p>${file.name}：${unchanged.length ? `${unchanged.length} 項和系統裡一樣，` : ''}沒有需要更新的欄位。</p>${warnList}${errList}` });
    return false;
  }
  const repack = updates.filter((u) => u.changes.some((c) => ['pack_size', 'pack_type', 'unit'].includes(c.field)));
  const body = h`<p style="margin-top:0">${file.name}：<b>更新 ${updates.length} 項</b>${creates.length ? `、新品項 ${creates.length} 項` : ''}${unchanged.length ? `、沒有變更 ${unchanged.length} 項` : ''}${errors.length ? `、有問題 ${errors.length} 列` : ''}。空白的格子不會覆蓋原本的資料；目前庫存、日均耗用、建議安全庫存、入帳科目只供參考，不會匯入。</p>
    ${
      updates.length
        ? h`<div class="table-wrap"><table class="grid" id="ii-updates"><thead><tr><th>列</th><th>物品編號</th><th>品名</th><th>變更</th></tr></thead><tbody>${updates.map(
            (u) => h`<tr><td>${u.line}</td><td>${u.item.sku || ''}</td><td><b>${u.item.name}</b>${u.matchedBy === 'name' ? h`<div class="muted" style="font-size:12px">以品名對應</div>` : ''}</td><td>${u.changes.map((c) => h`<div>${changeText(c)}</div>`)}</td></tr>`,
          )}</tbody></table></div>`
        : ''
    }
    ${repack.length ? h`<p class="muted" style="font-size:12.5px">${repack.length} 項改了庫存單位、進貨包裝或折合量：會依發票上的數量重算這些品項進貨行的庫存數量（和「修改」品項時一樣）。</p>` : ''}
    ${
      creates.length
        ? h`<h3 style="font-size:15px;margin:14px 0 6px">系統裡找不到的品項</h3>
      <label class="row" style="gap:8px;align-items:center;margin-bottom:6px"><input type="checkbox" name="create" checked> 一併新增這 ${creates.length} 個品項</label>
      <div class="table-wrap"><table class="grid" id="ii-creates"><thead><tr><th>列</th><th>物品編號</th><th>品名</th><th>分類</th><th>庫存單位</th><th class="num">安全庫存</th></tr></thead><tbody>${creates.map(
        (c) => h`<tr><td>${c.line}</td><td>${c.item.sku}</td><td><b>${c.item.name}</b></td><td>${categoryLabel(c.item.category)}${c.guessed ? h`<div class="muted" style="font-size:12px">依品名判斷，請確認</div>` : ''}</td><td>${c.item.unit}</td><td class="num">${qty(c.item.safety_stock)}</td></tr>`,
      )}</tbody></table></div>`
        : ''
    }
    ${warnList}${errList}`;
  const r = await modal({
    title: '匯入原物料主檔：確認變更',
    wide: true,
    body,
    actions: [{ label: '取消', value: null }, { label: '套用', primary: true, value: (dlg) => ({ create: !!dlg.querySelector('[name=create]')?.checked }) }],
  });
  if (!r) return false;
  const newItems = r.create ? creates.map((c) => c.item) : [];
  const rows = [...updates.map((u) => u.next), ...newItems];
  if (!rows.length) return false;
  await store.put('inventory_items', rows);
  const fix = updates.flatMap((u) => repackMoves(u.item, u.next, moves));
  if (fix.length) await store.put('inventory_moves', fix);
  toast(`已匯入原物料主檔：更新 ${updates.length} 項${newItems.length ? `、新增 ${newItems.length} 項` : ''}${fix.length ? `，並依新的包裝折合量重算 ${fix.length} 行進貨` : ''}${errors.length ? `；${errors.length} 列有問題沒有匯入` : ''}`, 'good', 6000);
  return true;
}

// ─────────── 依耗用量建議安全庫存

/** 預覽各品項目前與建議的安全庫存，勾選後套用；有寫入回傳 true */
export async function suggestSafetyDialog() {
  const c = await inventoryContext();
  if (!c.items.length) return fail('還沒有原物料品項');
  const items = sortByCategory(c.items);
  let rule = safetyRuleOf(c.settings);
  let sugg = new Map();
  const compute = () => {
    sugg = safetySuggestions(items, c.moves, c.usage, { asOf: c.rateAsOf, dataStart: c.dataStart, rule });
  };
  const rowHtml = (it) => {
    const s = sugg.get(it.id);
    const cur = Number(it.safety_stock) > 0 ? Number(it.safety_stock) : null;
    const can = s.value !== null;
    const on = can && s.value !== cur;
    return h`<tr data-id="${it.id}"><td><input type="checkbox" name="pick" ${can ? '' : raw('disabled')} ${on ? raw('checked') : ''} aria-label="套用到 ${it.name}"></td><td>${it.sku || ''}</td><td><b>${it.name}</b></td><td>${it.unit || ''}</td><td class="num">${can || s.total > 0 ? daily(s.avgDaily) : '—'}</td><td class="num">${cur === null ? status('na', '未設') : fmt(cur)}</td><td class="num" data-sugg>${can ? h`<b>${fmt(s.value)}</b>` : h`<span class="muted" title="${s.reason}">資料不足</span>`}</td><td class="muted" style="font-size:12px">${can ? '' : s.reason.replace(/^資料不足：/, '')}</td></tr>`;
  };
  const summary = () => {
    const ok = [...sugg.values()].filter((s) => s.value !== null).length;
    return `建議安全庫存 ＝ 近 ${rule.lookback_days} 天日均耗用 ×（叫貨前置 ${rule.lead_days} 天 ＋ 安全 ${rule.safety_days} 天）＝ 日均耗用 × ${rule.lead_days + rule.safety_days} 天。算到 ${c.rateAsOf}，${ok} 項可以建議、${items.length - ok} 項資料不足。`;
  };
  compute();
  const r = await modal({
    title: '依耗用量建議安全庫存',
    wide: true,
    body: h`<div class="form-grid">
        <label class="field"><span>看最近幾天的耗用</span><input type="number" name="lookback_days" min="${SAFETY_MIN_DAYS}" max="365" step="1" value="${rule.lookback_days}"></label>
        <label class="field"><span>叫貨前置天數（下單到貨要幾天）</span><input type="number" name="lead_days" min="0" max="90" step="1" value="${rule.lead_days}"></label>
        <label class="field"><span>安全天數（多備幾天的量）</span><input type="number" name="safety_days" min="0" max="90" step="1" value="${rule.safety_days}"></label>
      </div>
      <p class="muted" style="font-size:12.5px;margin:10px 0">日均耗用＝（POS 銷售 × 配方用量，含老闆招待、測試與報廢）＋ 手動登記的耗用與報廢，除以天數；營收起算日之後才開始算。有進貨包裝的進位到整包，其他進位到整數（100 以上進位到 10、1,000 以上進位到 100）。銷售資料不到 ${SAFETY_MIN_DAYS} 天或這段期間沒有耗用的品項顯示「資料不足」，不會更改。</p>
      <p id="ss-sum" style="font-weight:600;margin:0 0 8px">${summary()}</p>
      <div class="row" style="gap:8px;margin-bottom:6px"><button type="button" class="btn sm" data-sel="all">全選可建議的</button><button type="button" class="btn sm" data-sel="none">全不選</button></div>
      <div class="table-wrap"><table class="grid" id="ss-table"><thead><tr><th></th><th>物品編號</th><th>品名</th><th>單位</th><th class="num">日均耗用</th><th class="num">目前安全庫存</th><th class="num">建議安全庫存</th><th>說明</th></tr></thead>
      <tbody>${items.map(rowHtml)}</tbody></table></div>`,
    onMount: (dlg) => {
      const tbody = dlg.querySelector('#ss-table tbody');
      dlg.addEventListener('input', (ev) => {
        if (!['lookback_days', 'lead_days', 'safety_days'].includes(ev.target.name)) return;
        const g = (n) => dlg.querySelector(`[name=${n}]`).value;
        rule = normalizeSafetyRule({ lookback_days: g('lookback_days'), lead_days: g('lead_days'), safety_days: g('safety_days') });
        compute();
        tbody.innerHTML = items.map((it) => String(rowHtml(it))).join('');
        dlg.querySelector('#ss-sum').textContent = summary();
      });
      dlg.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-sel]');
        if (!b) return;
        for (const x of tbody.querySelectorAll('[name=pick]:not([disabled])')) x.checked = b.dataset.sel === 'all';
      });
    },
    actions: [
      { label: '取消', value: null },
      {
        label: '套用到勾選的品項',
        primary: true,
        value: (dlg) => {
          const g = (n) => dlg.querySelector(`[name=${n}]`).value.trim();
          const v = { lookback_days: Number(g('lookback_days')), lead_days: Number(g('lead_days')), safety_days: Number(g('safety_days')) };
          if (!Number.isInteger(v.lookback_days) || v.lookback_days < SAFETY_MIN_DAYS || v.lookback_days > 365) return fail(`看最近幾天要是 ${SAFETY_MIN_DAYS}–365 的整數`);
          if (!Number.isInteger(v.lead_days) || !Number.isInteger(v.safety_days) || v.lead_days < 0 || v.safety_days < 0 || v.lead_days > 90 || v.safety_days > 90) return fail('叫貨前置天數、安全天數要是 0–90 的整數');
          if (v.lead_days + v.safety_days < 1) return fail('叫貨前置天數＋安全天數至少要 1 天');
          const picks = [...dlg.querySelectorAll('#ss-table tbody tr')].filter((tr) => tr.querySelector('[name=pick]')?.checked).map((tr) => tr.dataset.id);
          if (!picks.length) return fail('沒有勾選任何品項');
          return { rule: v, picks };
        },
      },
    ],
  });
  if (!r) return false;
  const byId = new Map(items.map((i) => [i.id, i]));
  const rows = r.picks.map((id) => ({ item: byId.get(id), s: sugg.get(id) })).filter((x) => x.item && x.s?.value !== null && x.s?.value !== undefined);
  if (!(await confirmBox(`把 ${rows.length} 項原物料的安全庫存改成建議值？（${rows.slice(0, 3).map((x) => `${x.item.name} ${fmt(x.s.value)} ${x.item.unit || ''}`).join('、')}${rows.length > 3 ? '…' : ''}）`, { ok: '套用' }))) return false;
  await store.put('inventory_items', rows.map((x) => ({ ...x.item, safety_stock: x.s.value })));
  await saveSettings({ safety_stock_rule: r.rule });
  toast(`已更新 ${rows.length} 項的安全庫存（近 ${r.rule.lookback_days} 天日均耗用 × ${r.rule.lead_days + r.rule.safety_days} 天）`, 'good', 5000);
  return true;
}
