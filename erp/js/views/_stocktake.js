// 盤點表（11/12 需求 二-10）：列印／匯出盤點表、匯入盤點結果 → 盤點調整＋存貨與成本的期末盤點金額。
// 在「原物料進銷存」頁的工具列；「存貨與成本」頁的說明有連結過來。

import { h, modal, toast, pickFiles, download, fmt, status } from '../ui.js';
import { store } from '../store.js';
import { getAccounts, isLocked } from '../state.js';
import { INVENTORY_CATEGORIES, stockLevels } from '../lib/inventory.js';
import { countSheetGroups, countSheet, parseCountSheet, planStocktake } from '../lib/stocktake.js';
import { makeXlsx } from '../lib/xlsxw.js';
import { today, monthEnd, addMonths, fmtROC } from '../lib/dates.js';
import { round2 } from '../lib/money.js';
import { inventoryContext, readSheetFile } from './_itemsio.js';

const fail = (msg) => {
  toast(msg, 'error');
  return false;
};
const q = (v) => (v === null || v === undefined ? '' : fmt(v));
const signed = (v) => (v > 0 ? '+' : '') + fmt(v);
const money = (v) => (v < 0 ? '−$' + fmt(-v) : '$' + fmt(v));
const monthLabel = (ym) => `${Number(ym.slice(5))} 月`;

// ─────────── 盤點表：列印／匯出 Excel

export async function countSheetDialog() {
  const t = today();
  const ym = t.slice(0, 7);
  const pickDate = (dlg) => dlg.querySelector('[name=date]').value;
  const r = await modal({
    title: '盤點表（列印／匯出）',
    body: h`<div class="form-grid"><label class="field"><span>盤點日</span><input type="date" name="date" value="${t}"></label></div>
      <div class="row" style="gap:8px;margin-top:8px"><button type="button" class="btn sm" data-day="${t}">今天</button><button type="button" class="btn sm" data-day="${monthEnd(ym)}">本月月底</button><button type="button" class="btn sm" data-day="${monthEnd(addMonths(ym, -1))}">上個月底</button></div>
      <p class="muted" style="font-size:12.5px;margin:12px 0 0">盤點表依存貨科目分組，列出每個原物料的<b>帳面數量</b>（系統推算到盤點日當天：期初＋進貨－耗用－報廢±調整），以及空白的初盤量、複盤量、差異、備註欄，最下面有初盤人、複盤人、日期簽名欄。</p>
      <p class="muted" style="font-size:12.5px;margin:6px 0 0">印出來到現場數；數好的數量填進匯出的 Excel 盤點表（有複盤以複盤為準），再按「匯入盤點結果」，系統會自動產生盤點調整，並把各存貨科目的期末金額填到「存貨與成本」。</p>`,
    onMount: (dlg) =>
      dlg.addEventListener('click', (ev) => {
        const b = ev.target.closest('[data-day]');
        if (b) dlg.querySelector('[name=date]').value = b.dataset.day;
      }),
    actions: [
      { label: '取消', value: null },
      {
        label: '匯出 Excel',
        value: (dlg) => {
          const date = pickDate(dlg);
          return date ? { act: 'xlsx', date } : fail('請選擇盤點日');
        },
      },
      {
        label: '列印盤點表',
        primary: true,
        value: (dlg) => {
          const date = pickDate(dlg);
          if (!date) return fail('請選擇盤點日');
          // 在按鈕的點擊裡就開視窗，瀏覽器才不會當成彈出廣告擋掉
          const w = window.open('', '_blank');
          if (!w) return fail('瀏覽器擋住了新視窗：請允許這個網站開啟彈出視窗，或改用「匯出 Excel」');
          return { act: 'print', date, w };
        },
      },
    ],
  });
  if (!r) return;
  try {
    const c = await inventoryContext({ asOf: r.date });
    if (!c.items.length) {
      r.w?.close();
      return fail('還沒有原物料品項');
    }
    const accName = new Map((await getAccounts()).map((a) => [a.code, a.name]));
    const levels = stockLevels(c.items, c.moves, c.usage, { asOf: r.date, vatRate: c.vatRate });
    const groups = countSheetGroups(c.items, levels);
    const business = c.settings.business_name || '';
    if (r.act === 'xlsx') {
      download(`盤點表_${r.date}.xlsx`, makeXlsx([countSheet(groups, { date: r.date, business, accName })]));
      toast(`已匯出 ${r.date} 的盤點表（${groups.reduce((t2, g) => t2 + g.rows.length, 0)} 項）`, 'good');
    } else writePrint(r.w, groups, { date: r.date, business, accName });
  } catch (e) {
    r.w?.close();
    throw e;
  }
}

function writePrint(w, groups, { date, business, accName }) {
  const n = groups.reduce((t, g) => t + g.rows.length, 0);
  const html = h`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>原物料盤點表 ${date}</title><style>
@page { size: A4 portrait; margin: 12mm; }
body { font-family: "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif; color: #111; background: #fff; font-size: 12px; margin: 0; padding: 16px; }
.bar { display: flex; gap: 12px; align-items: center; margin-bottom: 14px; padding: 10px 12px; background: #f4ecdd; border-radius: 8px; font-size: 13px; }
.bar button { font: inherit; font-weight: 700; padding: 6px 18px; border: 1px solid #8a6d3b; background: #fff; border-radius: 6px; cursor: pointer; }
h1 { font-size: 18px; margin: 0 0 4px; }
.meta { margin: 0 0 10px; color: #333; }
table { width: 100%; border-collapse: collapse; }
th, td { border: 1px solid #555; padding: 5px 6px; text-align: left; vertical-align: middle; }
th { background: #eee; font-weight: 700; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
td.blank { width: 11%; }
td.note { width: 16%; }
tr.grp td { background: #f6f1e7; font-weight: 700; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; break-inside: avoid; }
.sign { display: flex; gap: 28px; margin-top: 22px; font-size: 13px; }
.sign span { flex: 1; border-bottom: 1px solid #000; padding: 0 0 20px; }
@media print { .bar { display: none; } body { padding: 0; } }
</style></head><body>
<div class="bar"><button type="button" id="print">列印</button><span>現場數好的數量填進「匯出 Excel」的盤點表，再到原物料進銷存按「匯入盤點結果」。</span></div>
<h1>${business ? business + ' ' : ''}原物料盤點表</h1>
<p class="meta">盤點日：民國 ${fmtROC(date)}（${date}）　共 ${n} 項　帳面數量＝系統推算到盤點日當天的庫存；有複盤以複盤為準</p>
<table><thead><tr><th>物品編號</th><th>品名</th><th>分類</th><th>單位</th><th class="num">帳面數量</th><th>初盤量</th><th>複盤量</th><th>差異</th><th>備註</th></tr></thead>
<tbody>${groups.map(
    (g) => h`<tr class="grp"><td colspan="9">${g.account} ${accName.get(g.account) || ''}（${g.rows.length} 項）</td></tr>${g.rows.map(
      ({ item, book }) => h`<tr><td>${item.sku || ''}</td><td>${item.name}</td><td>${INVENTORY_CATEGORIES[item.category]?.label || item.category || ''}</td><td>${item.unit || ''}</td><td class="num">${fmt(book)}</td><td class="blank"></td><td class="blank"></td><td class="blank"></td><td class="note"></td></tr>`,
    )}`,
  )}</tbody></table>
<div class="sign"><span>初盤人：</span><span>複盤人：</span><span>日期：</span></div>
</body></html>`;
  w.document.open();
  w.document.write(String(html));
  w.document.close();
  w.document.getElementById('print')?.addEventListener('click', () => w.print());
  w.focus();
  // 開好就叫出列印視窗（自動化測試時不叫，避免卡住）
  if (!navigator.webdriver) setTimeout(() => w.print(), 400);
}

// ─────────── 匯入盤點結果

/** 選檔 → 預覽（每品項帳面／初盤／複盤／採用／差異／調整金額，各科目期末金額）→ 確認後寫入；有寫入回傳 true */
export async function importCountDialog() {
  const [file] = await pickFiles({ accept: '.xlsx,.csv,.txt,text/csv', multiple: false });
  if (!file) return false;
  const parsed = await readSheetFile(file, parseCountSheet);
  if (parsed.error) return fail(`${file.name}：${parsed.error}`);
  const errBox = (errs) => (errs.length ? h`<div class="callout warn" style="margin-top:12px"><p><b>${errs.length} 列有問題，不會匯入：</b></p><ul class="plain-list">${errs.map((e) => h`<li>第 ${e.line} 列「${e.label}」：${e.msg}</li>`)}</ul></div>` : '');
  if (!parsed.records.length) {
    await modal({ title: '匯入盤點結果', body: h`<p>${file.name}：沒有任何品項填了初盤量或複盤量。</p>${errBox(parsed.errors)}` });
    return false;
  }
  const c = await inventoryContext();
  const stocktakes = await store.all('stocktakes');
  const accName = new Map((await getAccounts()).map((a) => [a.code, a.name]));
  let date = parsed.date || today();
  let plan;
  const compute = () => {
    plan = planStocktake({ items: c.items, moves: c.moves, usage: c.usageTo(date), records: parsed.records, date, vatRate: c.vatRate, stocktakes });
  };
  const view = () => {
    const locked = isLocked(c.settings, date);
    const gain = plan.lines.filter((l) => l.diff > 0).length;
    const loss = plan.lines.filter((l) => l.diff < 0).length;
    const total = round2(plan.lines.reduce((t, l) => t + l.amount, 0));
    const written = plan.accounts.filter((a) => a.countedItems > 0);
    const fromImport = plan.overwrite.every((o) => /^由盤點表匯入/.test(plan.accounts.find((a) => a.account === o.account)?.existingNote || ''));
    return h`${locked ? h`<div class="callout warn" style="margin-bottom:12px"><p><b>${plan.ym} 已關帳鎖定</b>，不能匯入這個月的盤點；請先到「月結」解除鎖定，或換一個盤點日。</p></div>` : ''}
      <p style="margin:0 0 8px"><b>盤點 ${plan.lines.length} 項</b>：盤盈 ${gain} 項、盤虧 ${loss} 項、一致 ${plan.lines.length - gain - loss} 項；調整金額合計 <b>${money(total)}</b>（未稅，差異 × 移動平均成本）。${parsed.skipped ? `另有 ${parsed.skipped} 項沒填數量，不調整。` : ''}</p>
      <div class="table-wrap"><table class="grid" id="st-lines"><thead><tr><th>物品編號</th><th>品名</th><th>單位</th><th class="num">帳面</th><th class="num">初盤</th><th class="num">複盤</th><th class="num">採用</th><th class="num">差異</th><th class="num">調整金額</th></tr></thead>
      <tbody>${plan.lines.map(
        (l) => h`<tr><td>${l.item.sku || ''}</td><td><b>${l.item.name}</b>${l.note ? h`<div class="muted" style="font-size:12px">${l.note}</div>` : ''}</td><td>${l.item.unit || ''}</td><td class="num">${fmt(l.book)}</td><td class="num">${q(l.first)}</td><td class="num">${q(l.second)}</td><td class="num"><b>${fmt(l.counted)}</b></td><td class="num">${l.diff ? (l.diff < 0 ? status('bad', signed(l.diff)) : signed(l.diff)) : '0'}</td><td class="num">${l.diff ? money(l.amount) : ''}</td></tr>`,
      )}</tbody></table></div>
      <h3 style="font-size:15px;margin:16px 0 6px">${monthLabel(plan.ym)}期末盤點金額（寫到「存貨與成本」）</h3>
      <div class="table-wrap"><table class="grid" id="st-accounts"><thead><tr><th>存貨科目</th><th class="num">盤到</th><th class="num">沒盤到（以帳面計）</th><th class="num">帳面價值</th><th class="num">期末盤點金額</th><th class="num">目前已輸入</th></tr></thead>
      <tbody>${written.map((a) => h`<tr><td>${a.account} ${accName.get(a.account) || ''}</td><td class="num">${fmt(a.countedItems)} 項</td><td class="num">${a.bookItems ? `${fmt(a.bookItems)} 項` : '—'}</td><td class="num">${money(Math.round(a.bookValue))}</td><td class="num"><b>${money(Math.round(a.value))}</b></td><td class="num">${a.existing === null ? '—' : money(a.existing)}</td></tr>`)}</tbody></table></div>
      <p class="muted" style="font-size:12.5px;margin:8px 0 0">期末盤點金額＝盤到的品項「採用數量 × 移動平均成本（未稅）」＋ 同科目沒盤到的品項以帳面數量計；這次沒有盤到任何品項的科目不會寫入。同一天重新匯入同一份盤點，會取代上次的盤點調整，不會重複。</p>
      ${plan.overwrite.length ? h`<label class="row" style="gap:8px;margin-top:10px"><input type="checkbox" name="overwrite" ${fromImport ? h`checked` : ''}> 覆蓋${monthLabel(plan.ym)}已輸入的期末盤點金額（${plan.overwrite.map((o) => { const a = plan.accounts.find((x) => x.account === o.account); return `${o.account} ${money(a.existing)} → ${money(o.value)}`; }).join('、')}）</label>` : ''}
      ${plan.warnings.length ? h`<ul class="plain-list" style="margin-top:10px">${plan.warnings.map((w) => h`<li>${w.msg}</li>`)}</ul>` : ''}
      ${errBox([...parsed.errors, ...plan.errors])}`;
  };
  compute();
  const r = await modal({
    title: '匯入盤點結果：確認',
    wide: true,
    body: h`<div class="form-grid"><label class="field"><span>盤點日（帳面數量算到這天${parsed.date ? '，已帶入盤點表上的日期' : ''}）</span><input type="date" name="date" value="${date}"></label></div><div id="st-view" style="margin-top:10px">${view()}</div>`,
    onMount: (dlg) =>
      dlg.addEventListener('change', (ev) => {
        if (ev.target.name !== 'date' || !ev.target.value) return;
        date = ev.target.value;
        compute();
        dlg.querySelector('#st-view').innerHTML = String(view());
      }),
    actions: [
      { label: '取消', value: null },
      {
        label: '產生盤點調整',
        primary: true,
        value: (dlg) => {
          if (isLocked(c.settings, date)) return fail(`${plan.ym} 已關帳鎖定，不能匯入這個月的盤點`);
          if (!plan.lines.length) return fail('沒有可以匯入的品項');
          return { overwrite: !!dlg.querySelector('[name=overwrite]')?.checked };
        },
      },
    ],
  });
  if (!r) return false;
  if (plan.moves.length) await store.put('inventory_moves', plan.moves);
  if (plan.removeIds.length) await store.remove('inventory_moves', plan.removeIds);
  const keep = new Set(r.overwrite ? [] : plan.overwrite.map((x) => x.id));
  const st = plan.stocktakes.filter((x) => !keep.has(x.id));
  if (st.length) await store.put('stocktakes', st);
  toast(`已匯入 ${date} 的盤點：調整 ${plan.moves.length} 項${st.length ? `，${monthLabel(plan.ym)}期末盤點金額寫入 ${st.length} 個科目（到「存貨與成本」產生成本分錄）` : ''}${keep.size ? `；${keep.size} 個科目保留原本輸入的金額` : ''}`, 'good', 7000);
  return true;
}
