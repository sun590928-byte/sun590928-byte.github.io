// BOM 配方表（11/12 老闆需求 二-7、二-8）：直接列出近 30 天 POS 有賣出的品名，每個品名都能設配方，不用先做品項整併；
// 可以匯入／匯出 Excel、從別的品名複製配方；還沒設配方的品名會標出來（儀表板、匯入 POS 後也會提醒）。
// 配方存在 recipes：合併過的品項用品項 id，沒合併的品名用 'raw:' + 品名（與進銷存耗用、存貨與成本的算法一致）。

import { h, raw, mount, bindActions, dataTable, modal, toast, stat, badge, status, options, fmt, pct, emptyState, pickFiles, download } from '../ui.js';
import { store } from '../store.js';
import { getSettings, saveSettings, getProductIndex } from '../state.js';
import { averageCosts } from '../lib/inventory.js';
import { CATEGORIES } from '../lib/pos.js';
import { addDays, today } from '../lib/dates.js';
import { round2 } from '../lib/money.js';
import { decodeBytes, parseCSV } from '../lib/csv.js';
import { readXlsx } from '../lib/xlsx.js';
import { makeXlsx } from '../lib/xlsxw.js';
import { bomRows, missingRecipes, recipeCosts, replaceRecipe, parseRecipeSheet, recipeSheetRows, resolveProductId } from '../lib/bom.js';
import { fmtUnitCost, itemLabel, sortItems } from './inventory.js';

const PERIODS = { 30: '近 30 天', 90: '近 90 天' };
const small = (text) => h`<div class="muted" style="font-size:12px">${text}</div>`;
const qtyText = (v) => new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 3 }).format(Number(v) || 0);
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v));
const fail = (msg) => {
  toast(msg, 'error');
  return false;
};

export async function render(root, ctx) {
  let settings = await getSettings();
  const vatRate = settings.vat_mode === 'general' ? 0.05 : 0;
  const vatDiv = 1 + vatRate;
  const sales = await store.all('sales_lines');
  let idx = await getProductIndex();
  let [items, moves, recipes] = await Promise.all(['inventory_items', 'inventory_moves', 'recipes'].map((c) => store.all(c)));
  const f = { days: ctx.params.days === 'all' || PERIODS[ctx.params.days] ? ctx.params.days : '30', missing: ctx.params.filter === 'missing', q: '' };
  const lastSale = sales.reduce((m, l) => (l.date >= settings.revenue_start && l.date > m ? l.date : m), '');
  const costDay = lastSale > today() ? lastSale : today();

  let ofCache = new Map();
  const of = (l) => {
    let p = ofCache.get(l);
    if (!p) ofCache.set(l, (p = idx.of(l)));
    return p;
  };
  let costs = averageCosts(items, moves, { asOf: costDay, vatRate });
  const costOf = (id) => costs.get(id)?.avg || 0;
  let allNames = new Map(); // 所有賣過的品名（顯示名稱、複製來源）
  let view = null;

  // 合併過又被併進別的品項的原始品名：配方暫時不用（取消合併才會恢復），不列入匯出與複製來源
  const isActive = (pid) => idx.byId.has(pid) || (String(pid).startsWith('raw:') && !idx.aliasToProductId.has(String(pid).slice(4)));
  const nameOf = (pid) => idx.byId.get(pid)?.name || allNames.get(pid)?.name || recipes.find((r) => r.product_id === pid && r.product_name)?.product_name || String(pid).replace(/^raw:/, '');
  const recipeOf = (pid) => recipes.filter((r) => r.product_id === pid);
  const itemBy = () => new Map(items.map((i) => [i.id, i]));
  const summary = (pid, byId) =>
    recipeOf(pid)
      .map((r) => `${byId.get(r.item_id)?.name || '（已刪除的原料）'} ${qtyText(r.qty)} ${byId.get(r.item_id)?.unit || ''}`.trim())
      .join('、');

  function compute() {
    const skip = settings.bom_skip || [];
    allNames = new Map(bomRows(sales, of, recipes, { from: settings.revenue_start, skip }).map((r) => [r.id, r]));
    if (!lastSale) return { rows: [], from: '', to: '' };
    const to = lastSale;
    const back = f.days === 'all' ? settings.revenue_start : addDays(to, -Number(f.days) + 1);
    const from = back > settings.revenue_start ? back : settings.revenue_start;
    const perUnit = recipeCosts(recipes, costOf);
    const rows = bomRows(sales, of, recipes, { from, to, skip, newSince: addDays(to, -13) }).map((r) => {
      const price = r.qty > 0 ? r.revenue / r.qty : null;
      const cost = r.hasRecipe ? perUnit.get(r.id) ?? 0 : null;
      return { ...r, state: r.hasRecipe ? 1 : r.skipped ? 2 : 0, price, cost, margin: price > 0 && cost !== null ? (price / vatDiv - cost) / (price / vatDiv) : null };
    });
    return { rows, from, to };
  }

  async function reload() {
    [items, moves, recipes] = await Promise.all(['inventory_items', 'inventory_moves', 'recipes'].map((c) => store.all(c)));
    settings = await getSettings();
    idx = await getProductIndex();
    ofCache = new Map();
    costs = averageCosts(items, moves, { asOf: costDay, vatRate });
    draw();
  }

  function draw() {
    view = compute();
    if (!lastSale) {
      mount(root, h`<div class="card">${emptyState('還沒有銷售資料', `先到「匯入中心」匯入 POS 銷售明細，這裡就會列出賣出的品名（營收起算日 ${settings.revenue_start} 起），每個品名都能直接設配方。`, h`<a class="btn primary" href="#/import">前往匯入</a>`)}</div>`);
      return;
    }
    const { rows, from, to } = view;
    const missing = missingRecipes(rows);
    const set = rows.filter((r) => r.hasRecipe);
    const revenue = rows.reduce((t, r) => t + r.revenue, 0);
    const covered = set.reduce((t, r) => t + r.revenue, 0);
    const q = f.q.trim().toLowerCase();
    const shown = rows.filter((r) => (!f.missing || (!r.hasRecipe && !r.skipped)) && (!q || [r.name, ...r.spellings].some((s) => s.toLowerCase().includes(q))));
    const byId = itemBy();
    mount(
      root,
      h`<div class="toolbar">
        <label class="field"><span>期間</span><select data-act="days">${options([...Object.entries(PERIODS), ['all', `營收起算日（${settings.revenue_start}）起全部`]], f.days)}</select></label>
        <label class="field"><span>搜尋品名</span><input type="search" value="${f.q}" data-act="q" data-on="input" placeholder="例如：拿鐵"></label>
        <label class="check" style="padding-bottom:6px"><input type="checkbox" data-act="missing" ${f.missing ? raw('checked') : ''}> 只看未設配方${missing.length ? h` <span class="badge medium" data-missing-count>${missing.length}</span>` : ''}</label>
        <span class="spacer"></span>
        <button class="btn" data-act="export">匯出配方（Excel）</button>
        <button class="btn" data-act="import">匯入配方</button>
      </div>
      <div class="stats">
        ${stat('期間內賣出的品名', fmt(rows.length), `${from} ～ ${to}（POS 資料最後一天）`)}
        ${stat('已設配方', fmt(set.length), revenue > 0 ? `占這段期間營收 ${pct(covered / revenue)}` : '')}
        ${stat('還沒設配方', fmt(missing.length), missing.length ? [`賣出時不會扣原物料庫存`, missing.some((r) => r.isNew) ? `其中新品名 ${missing.filter((r) => r.isNew).length} 個` : ''].filter(Boolean).join('・') : '每個品名都設好了', missing.length ? 'bad' : 'good')}
        ${stat('原物料品項', fmt(items.length), '配方從這些原料選')}
      </div>
      ${items.length ? '' : h`<div class="callout warn" style="margin-bottom:12px"><p>還沒有原物料品項，配方沒有原料可以選 → 先到 <a href="#/inventory">原物料進銷存</a> 新增，或在 <a href="#/purchases">進貨紀錄</a> 登記／匯入進貨單（沒見過的品名會自動建檔）。</p></div>`}
      <div class="callout" style="margin-bottom:12px">
        <p>配方＝每賣出<b>一份</b>用掉的原料量，以原料的庫存單位計（咖啡豆 g、鮮奶 ml、杯蓋 個）。設好後 POS 每賣一份就自動扣庫存，「存貨與成本」也會用它估理論成本；老闆招待／測試／報廢的份數一樣會扣原料。</p>
        <p><b>不用先做品項整併</b>：點品名就能直接設配方。整併過的品項只列一次，下面寫著 POS 上的各種寫法。口味相近的品名可以在配方視窗「從其他品名複製」再改用量（例如熱拿鐵 → 冰拿鐵）。</p>
        <p>匯出的 Excel 就是範本：還沒設配方的品名也會列出來，填好「原料物品編號」或「原料品名」和「用量」再按「匯入配方」；匯入只會換掉檔案裡寫到的品名。</p>
      </div>
      <div class="card"><div id="bom-table"></div></div>`,
    );
    dataTable(root.querySelector('#bom-table'), {
      rows: shown,
      pageSize: 200,
      empty: f.missing ? '這段期間賣出的品名都設好配方了' : '沒有符合的品名',
      initialSort: { key: 'qty', dir: -1 },
      rowClass: (r) => (r.state === 0 ? 'bom-missing' : ''),
      columns: [
        {
          key: 'name',
          label: 'POS 品名',
          fmt: (v, r) =>
            h`<a href="#" data-act="recipe" data-id="${r.id}" data-name="${v}"><b>${v}</b></a>${r.isNew ? h` ${badge('新品名', 'medium')}` : ''}${r.mapped ? h` ${badge('已整併', 'accent')}` : ''}${r.mapped || r.spellings.length > 1 ? small(`POS 上寫作：${r.spellings.join('、')}`) : ''}`,
        },
        { key: 'category', label: '品類', fmt: (v) => CATEGORIES[v] || v || '' },
        { key: 'qty', label: '售出份數', align: 'num', fmt: (v, r) => h`${fmt(v)}${r.otherQty ? small(`另招待／測試／報廢 ${fmt(r.otherQty)}`) : ''}` },
        { key: 'revenue', label: '營收', align: 'num', fmt: (v) => '$' + fmt(Math.round(v)) },
        { key: 'state', label: '配方', fmt: (v, r) => h`<span style="white-space:nowrap">${v === 1 ? status('good', `已設（${r.recipeCount} 項）`) : v === 2 ? status('na', '不需配方') : status('warn', '還沒設配方')}</span>` },
        { key: 'id', label: '用料（每份）', nosort: true, width: '20%', fmt: (v, r) => (r.hasRecipe ? h`<span style="font-size:13px">${summary(v, byId)}</span>` : h`<span class="muted">—</span>`) },
        { key: 'cost', label: '理論成本／份（未稅）', align: 'num', fmt: (v) => (v === null ? '—' : fmtUnitCost(v)) },
        { key: 'margin', label: '估計毛利率', align: 'num', fmt: (v) => (v === null ? '—' : v < 0 ? status('bad', pct(v)) : pct(v)) },
        {
          key: 'last',
          label: '',
          nosort: true,
          fmt: (v, r) =>
            h`<span style="white-space:nowrap"><button class="btn sm ${r.hasRecipe ? '' : 'primary'}" data-act="recipe" data-id="${r.id}" data-name="${r.name}" data-raw="${r.mapped ? '' : '1'}">${r.hasRecipe ? '修改配方' : '設定配方'}</button>${
              r.hasRecipe ? '' : r.skipped ? h` <button class="btn sm ghost" data-act="unskip" data-id="${r.id}">改回需要配方</button>` : h` <button class="btn sm ghost" data-act="skip" data-id="${r.id}" title="例如服務費、提袋等不用原料的品名">不需配方</button>`
            }</span>`,
        },
      ],
    });
  }

  async function recipeModal(pid) {
    if (!items.length) return toast('還沒有原物料品項：請先到「原物料進銷存」新增，或在「進貨紀錄」登記進貨（新品名會自動建檔）', 'error', 6000);
    const row = view.rows.find((r) => r.id === pid) || allNames.get(pid) || { id: pid, name: nameOf(pid), spellings: [], qty: 0, revenue: 0, mapped: idx.byId.has(pid) };
    const name = row.name;
    const byId = itemBy();
    const price = row.qty > 0 ? row.revenue / row.qty : null;
    const current = recipeOf(pid);
    const itemOpts = [['', '— 選擇原料 —'], ...sortItems(items).map((i) => [i.id, itemLabel(i)])];
    const sources = [...new Set(recipes.map((r) => r.product_id))]
      .filter((x) => x !== pid && isActive(x))
      .map((x) => [x, nameOf(x)])
      .sort((a, b) => a[1].localeCompare(b[1], 'zh-Hant'));
    const line = (r) =>
      h`<tr><td><select name="item" aria-label="原料">${options(itemOpts, r.item_id)}</select></td><td><input class="cell num" type="number" name="qty" min="0" step="any" value="${r.qty ?? ''}" aria-label="每份用量"></td><td data-unit class="muted"></td><td class="num" data-cost></td><td><button type="button" class="icon-btn" data-del aria-label="刪除此行">✕</button></td></tr>`;
    const collect = (dlg) => [...dlg.querySelectorAll('#bom-lines tr')].map((tr) => ({ tr, item_id: tr.querySelector('[name=item]').value, qty: num(tr.querySelector('[name=qty]').value) }));
    const refresh = (dlg) => {
      let total = 0;
      for (const r of collect(dlg)) {
        const c = r.item_id && r.qty > 0 ? r.qty * costOf(r.item_id) : null;
        if (c !== null) total += c;
        r.tr.querySelector('[data-unit]').textContent = byId.get(r.item_id)?.unit || '';
        r.tr.querySelector('[data-cost]').textContent = c === null ? '' : fmtUnitCost(c);
      }
      const m = price > 0 ? (price / vatDiv - total) / (price / vatDiv) : null;
      dlg.querySelector('#bom-sum').textContent = `理論成本 ${fmtUnitCost(total)}／份　平均售價 ${price === null ? '—（這段期間沒有售出）' : '$' + fmt(round2(price))}　估計毛利率 ${m === null ? '—' : pct(m)}`;
    };
    const r = await modal({
      title: `配方：${name}`,
      wide: true,
      body: h`<p class="muted" style="margin-top:0">每賣出一份「${name}」用掉的原料量，以原料的庫存單位計；成本依目前的移動平均成本（未稅）試算。${row.mapped || row.spellings.length > 1 ? `POS 上寫作：${row.spellings.join('、')}。` : ''}</p>
        ${
          sources.length
            ? h`<div class="row" style="gap:8px;align-items:flex-end;margin-bottom:10px"><label class="field"><span>從其他品名複製配方</span><select name="copyFrom">${options([['', '— 選擇品名 —'], ...sources], '')}</select></label><button type="button" class="btn sm" data-copy>帶入</button><span class="muted" style="font-size:12.5px">帶入後可以再改用量，按「儲存配方」才會存</span></div>`
            : ''
        }
        <div class="table-wrap"><table class="grid"><thead><tr><th style="width:50%">原料</th><th class="num">每份用量</th><th>單位</th><th class="num">成本</th><th></th></tr></thead>
        <tbody id="bom-lines">${(current.length ? current : [{ item_id: '', qty: '' }]).map(line)}</tbody>
        <tfoot><tr><td colspan="5"><button type="button" class="btn sm" data-add>＋ 新增原料</button></td></tr></tfoot></table></div>
        <p id="bom-sum" style="margin:12px 0 0;font-weight:600"></p>`,
      actions: [
        { label: '取消', value: null },
        {
          label: '儲存配方',
          primary: true,
          value: (dlg) => {
            const rows = collect(dlg).filter((x) => x.item_id || x.qty !== null);
            const seen = new Set();
            for (const x of rows) {
              if (!x.item_id) return fail('有一行沒有選擇原料');
              if (!(x.qty > 0)) return fail(`「${byId.get(x.item_id)?.name}」的每份用量需大於 0`);
              if (seen.has(x.item_id)) return fail(`「${byId.get(x.item_id)?.name}」重複了，請合併成一行`);
              seen.add(x.item_id);
            }
            return rows.map((x) => ({ item_id: x.item_id, qty: x.qty }));
          },
        },
      ],
      onMount: (dlg) => {
        refresh(dlg);
        dlg.addEventListener('input', () => refresh(dlg));
        dlg.addEventListener('change', () => refresh(dlg));
        dlg.addEventListener('click', (ev) => {
          if (ev.target.closest('[data-add]')) {
            dlg.querySelector('#bom-lines').insertAdjacentHTML('beforeend', String(line({ item_id: '', qty: '' })));
            refresh(dlg);
          }
          if (ev.target.closest('[data-copy]')) {
            const src = dlg.querySelector('[name=copyFrom]').value;
            if (!src) return toast('請先選擇要複製的品名', 'error');
            dlg.querySelector('#bom-lines').innerHTML = String(h`${recipeOf(src).map(line)}`);
            refresh(dlg);
            toast(`已帶入「${nameOf(src)}」的配方，確認用量後按「儲存配方」`, 'info');
          }
          const del = ev.target.closest('[data-del]');
          if (del) {
            del.closest('tr').remove();
            refresh(dlg);
          }
        });
      },
    });
    if (!r) return;
    const plan = replaceRecipe(recipes, pid, r, name);
    if (plan.remove.length) await store.remove('recipes', plan.remove);
    if (plan.put.length) await store.put('recipes', plan.put);
    toast(plan.put.length ? `已儲存「${name}」的配方（${plan.put.length} 項原料）` : `已清除「${name}」的配方`, 'good');
    await reload();
  }

  function exportRecipes() {
    const listed = view.rows.filter((r) => (!f.missing || (!r.hasRecipe && !r.skipped)) && (!f.q.trim() || [r.name, ...r.spellings].some((s) => s.toLowerCase().includes(f.q.trim().toLowerCase())))).sort((a, b) => b.qty - a.qty);
    const entries = listed.map((r) => ({ name: r.name, lines: recipeOf(r.id) }));
    if (!f.missing && !f.q.trim()) {
      // 期間外才賣、或還沒賣過但先設好的配方也一起匯出（整份配方的備份）
      const have = new Set(listed.map((r) => r.id));
      const others = [...new Set(recipes.map((r) => r.product_id))].filter((pid) => !have.has(pid) && isActive(pid));
      entries.push(...others.map((pid) => ({ name: nameOf(pid), lines: recipeOf(pid) })).sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant')));
    }
    if (!entries.length) return toast('沒有可以匯出的品名', 'info');
    download(`BOM配方表_${view.to}.xlsx`, makeXlsx([{ name: 'BOM配方表', rows: recipeSheetRows(entries, items), widths: [26, 14, 24, 10, 8], header: 1 }]));
    toast(`已匯出 ${entries.length} 個品名的配方`, 'good');
  }

  async function importRecipes() {
    const [file] = await pickFiles({ accept: '.xlsx,.csv,.txt', multiple: false });
    if (!file) return;
    if (/\.xls$/i.test(file.name)) return toast('舊版 .xls 請在 Excel 另存為 .xlsx 或 .csv 再匯入', 'error', 6000);
    const buf = new Uint8Array(await file.arrayBuffer());
    let rows;
    if (/\.xlsx$/i.test(file.name)) {
      const sheets = await readXlsx(buf);
      const sh = sheets.find((s) => !s.hidden && s.rows.some((r) => r.some((c) => /用量/.test(String(c))))) || sheets[0];
      rows = sh?.rows || [];
    } else rows = parseCSV(decodeBytes(buf).text);
    const res = parseRecipeSheet(rows, { items, resolveProduct: (n) => resolveProductId(n, idx) });
    if (res.error) return toast(res.error, 'error', 8000);
    const byId = itemBy();
    const sold = new Set(allNames.keys());
    const preview = res.products.map((p) => ({ ...p, name: idx.byId.get(p.id)?.name || p.name, replaces: recipes.some((r) => r.product_id === p.id), sold: sold.has(p.id) }));
    const nLines = preview.reduce((t, p) => t + p.lines.length, 0);
    const ok = await modal({
      title: `匯入配方：${file.name}`,
      wide: true,
      body: h`<p id="rcp-sum">讀到 <b>${preview.length}</b> 個品名、<b>${nLines}</b> 行原料${res.skipped.length ? h`，<b>略過 ${res.skipped.length} 列</b>（原因在下面）` : ''}。匯入後，檔案裡寫到的品名，配方會換成檔案裡的內容；沒寫到的品名不變。</p>
        ${
          preview.length
            ? h`<div class="table-wrap" style="max-height:320px"><table class="grid"><thead><tr><th>品名</th><th>用料（每份）</th><th>匯入後</th></tr></thead><tbody>${preview.map(
                (p) =>
                  h`<tr><td><b>${p.name}</b></td><td style="font-size:13px">${p.lines.map((x) => `${byId.get(x.item_id)?.name} ${qtyText(x.qty)} ${byId.get(x.item_id)?.unit || ''}`.trim()).join('、')}</td><td>${p.replaces ? status('warn', '取代現有配方') : status('good', '新設配方')}${p.sold ? '' : small('POS 目前還沒有這個品名，先存著，之後賣出就會套用')}</td></tr>`,
              )}</tbody></table></div>`
            : ''
        }
        ${res.skipped.length ? h`<div class="callout warn" style="margin-top:12px"><p><b>略過的列</b></p><ul id="rcp-skipped" style="margin:4px 0 0;padding-left:20px">${res.skipped.slice(0, 100).map((s) => h`<li>第 ${s.row} 列：${s.reason}</li>`)}</ul>${res.skipped.length > 100 ? h`<p class="muted">另有 ${res.skipped.length - 100} 列未列出</p>` : ''}</div>` : ''}`,
      actions: preview.length ? [{ label: '取消', value: false }, { label: `匯入 ${preview.length} 個品名的配方`, primary: true, value: true }] : [{ label: '關閉', value: false }],
    });
    if (!ok) return;
    const put = [];
    const remove = [];
    for (const p of preview) {
      const plan = replaceRecipe(recipes, p.id, p.lines, p.name);
      put.push(...plan.put);
      remove.push(...plan.remove);
    }
    if (remove.length) await store.remove('recipes', remove);
    if (put.length) await store.put('recipes', put);
    toast(`已匯入 ${preview.length} 個品名的配方（${nLines} 行原料）${res.skipped.length ? `，略過 ${res.skipped.length} 列` : ''}`, 'good', 6000);
    await reload();
  }

  async function setSkip(pid, on) {
    const cur = new Set(settings.bom_skip || []);
    if (on) cur.add(pid);
    else cur.delete(pid);
    settings = await saveSettings({ bom_skip: [...cur] });
    toast(on ? `「${nameOf(pid)}」標記為不需配方，不會再提醒` : `「${nameOf(pid)}」改回需要配方`, 'good');
    draw();
  }

  const unbind = bindActions(root, {
    days: (el) => {
      f.days = el.value;
      ctx.setParams({ days: f.days === '30' ? '' : f.days });
      draw();
    },
    q: (el) => {
      f.q = el.value;
      const pos = el.selectionStart;
      draw();
      const box = root.querySelector('[data-act="q"]');
      box.focus();
      box.setSelectionRange(pos, pos);
    },
    missing: (el) => {
      f.missing = el.checked;
      ctx.setParams({ filter: f.missing ? 'missing' : '' });
      draw();
    },
    recipe: (el) => recipeModal(el.dataset.id),
    skip: (el) => setSkip(el.dataset.id, true),
    unskip: (el) => setSkip(el.dataset.id, false),
    export: () => exportRecipes(),
    import: () => importRecipes(),
  });
  draw();
  return unbind;
}
