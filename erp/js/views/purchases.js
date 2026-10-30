// 進貨紀錄（Purchase_Records）：登記或匯入進貨單（發票）→ 沒見過的品名自動建成原物料（分類依 12XX 原料科目）
// → 載入原物料進銷存 → 原物料主檔設安全庫存、進貨包裝折合量 → 配方（BOM）設用量 → POS 銷售自動扣庫存。
// 每一行進貨存成 inventory_moves（type: purchase）；同一張進貨單的行共用 purchase_id。

import { h, mount, bindActions, dataTable, modal, confirmBox, toast, stat, badge, status, options, fmt, pct, emptyState, downloadCSV } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getAccounts } from '../state.js';
import { INVENTORY_CATEGORIES, priceHistory } from '../lib/inventory.js';
import { applyPurchase, groupPurchases, supplierLabel, findItem, findSupplier, guessItemCategory, completeLine, templateCSV, VAT_RATE } from '../lib/purchases.js';
import { fmtUnitCost, itemLabel, sortItems, editItem, stockSnapshot } from './inventory.js';
import { lineChart } from '../charts.js';
import { uid } from '../lib/text.js';
import { today, daysBetween } from '../lib/dates.js';
import { round2 } from '../lib/money.js';

const fail = (msg) => {
  toast(msg, 'error');
  return false;
};
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(String(v).replace(/,/g, '')));
const small = (text) => h`<div class="muted" style="font-size:12px">${text}</div>`;
const oneDec = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? fmt(v) : v.toFixed(1));
const change = (x) => (x === null || x === undefined ? '—' : x > 0 ? `▲ ${pct(x)}` : x < 0 ? `▼ ${pct(-x)}` : '持平');
const changeTone = (x) => (x > 0 ? 'bad' : x < 0 ? 'good' : '');
const money = (v) => (v === null || v === undefined ? '' : '$' + fmt(v));
const catOpts = Object.entries(INVENTORY_CATEGORIES).map(([k, c]) => [k, `${c.label}（${c.gl}）`]);

/**
 * 新增／修改一張進貨單（表頭＋多行）並儲存；取消回傳 null。
 * group 為 groupPurchases 的一張單（修改時）；items／suppliers 為目前主檔。
 */
export async function editPurchaseDoc(group, { items, suppliers, vatRate = VAT_RATE, supplierId = '' }) {
  const sup0 = group ? suppliers.find((s) => s.id === group.supplier_id) : suppliers.find((s) => s.id === supplierId);
  const head = group
    ? { supplier: supplierLabel(sup0) || '', invoice_no: group.invoice_no || '', invoice_date: group.invoice_date || group.date, date: group.date, order_date: group.order_date || '', yield_score: group.yield_score ?? '', note: group.note || '' }
    : { supplier: supplierLabel(sup0) || '', invoice_no: '', invoice_date: today(), date: today(), order_date: '', yield_score: '', note: '' };
  const itemBy = new Map(items.map((i) => [i.id, i]));
  const startLines = group
    ? group.lines.map((m) => {
        const it = itemBy.get(m.item_id);
        return { name: it?.name || '', unit: m.unit || it?.unit || '', qty: m.pack_qty ?? m.qty, unit_price: m.unit_price ?? (m.qty > 0 ? round2(m.amount / m.qty) : ''), amount: m.amount, category: it?.category || '' };
      })
    : [];
  const row = (p = {}) => h`<tr>
      <td><input class="cell" name="name" list="po-items" value="${p.name || ''}" placeholder="品名（新品名會自動建檔）" style="min-width:200px" autocomplete="off" aria-label="品名"></td>
      <td><input class="cell" name="unit" value="${p.unit || ''}" placeholder="瓶／包／kg" style="width:72px" autocomplete="off" aria-label="單位"></td>
      <td><input class="cell num" name="qty" inputmode="decimal" value="${p.qty ?? ''}" style="width:70px" autocomplete="off" aria-label="數量"></td>
      <td><input class="cell num" name="price" inputmode="decimal" value="${p.unit_price ?? ''}" style="width:86px" autocomplete="off" aria-label="含稅單價"></td>
      <td><input class="cell num" name="amount" inputmode="decimal" value="${p.amount ?? ''}" style="width:96px" autocomplete="off" aria-label="含稅金額"></td>
      <td><select name="cat" class="cell" aria-label="分類">${options(catOpts, p.category || 'other')}</select></td>
      <td><button type="button" class="icon-btn" data-del aria-label="刪除此行">✕</button></td>
    </tr>`;
  const collect = (dlg) =>
    [...dlg.querySelectorAll('#po-lines tr')]
      .map((tr, i) => {
        const v = (n) => tr.querySelector(`[name=${n}]`).value.trim();
        return { n: i + 1, tr, name: v('name'), unit: v('unit'), qty: num(v('qty')), unit_price: num(v('price')), amount: num(v('amount')), category: v('cat') };
      })
      .filter((p) => p.name || p.qty !== null || p.amount !== null);
  const refresh = (dlg) => {
    const list = collect(dlg);
    let total = 0;
    const fresh = [];
    for (const p of list) {
      const m = completeLine(p, { vatRate });
      if (m) total += m.amount;
      const it = findItem(items, p.name);
      const sel = p.tr.querySelector('[name=cat]');
      if (it) {
        sel.value = it.category;
        sel.disabled = true;
        sel.title = `既有品項 ${itemLabel(it)}（分類到原物料主檔修改）`;
      } else {
        sel.disabled = false;
        sel.title = '';
        if (p.name && !fresh.includes(p.name)) fresh.push(p.name);
      }
    }
    total = round2(total);
    const ex = round2(total / (1 + vatRate));
    dlg.querySelector('#po-bar').innerHTML = String(h`<p><b>合計 $${fmt(total)}</b>（未稅 $${fmt(ex)}、稅 $${fmt(round2(total - ex))}）・${fmt(list.length)} 行${fresh.length ? h`　<span class="badge accent">自動建檔 ${fresh.length} 項：${fresh.join('、')}</span>` : ''}</p>`);
  };
  const cellsOf = (dlg) => [...dlg.querySelectorAll('#po-lines input, #po-lines select')];
  const addRow = (dlg) => {
    dlg.querySelector('#po-lines').insertAdjacentHTML('beforeend', String(row()));
    return dlg.querySelector('#po-lines tr:last-child input');
  };
  // 選到既有品項：帶入上次的單位、含稅單價；數量×單價自動算金額（金額欄手動改過就不再覆蓋）
  const fillFromItem = (tr) => {
    const it = findItem(items, tr.querySelector('[name=name]').value);
    if (!it) return;
    const unit = tr.querySelector('[name=unit]');
    const price = tr.querySelector('[name=price]');
    if (!unit.value.trim()) unit.value = it.pack_type || it.unit || '';
    if (!price.value.trim() && it.last_unit_price !== null && it.last_unit_price !== undefined) price.value = it.last_unit_price;
  };
  const autoAmount = (tr) => {
    const amount = tr.querySelector('[name=amount]');
    if (amount.dataset.manual) return;
    const q = num(tr.querySelector('[name=qty]').value);
    const p = num(tr.querySelector('[name=price]').value);
    amount.value = q !== null && p !== null ? round2(q * p) : '';
  };
  const r = await modal({
    title: group ? `修改進貨單${group.invoice_no ? `：${group.invoice_no}` : ''}` : '新增進貨單',
    wide: true,
    body: h`<div class="form-grid">
        <label class="field"><span>供應商（打簡稱或抬頭；新名稱會自動建立）</span><input type="text" name="supplier" list="po-sups" value="${head.supplier}" autocomplete="off"></label>
        <label class="field"><span>發票號碼</span><input type="text" name="invoice_no" value="${head.invoice_no}" placeholder="AB12345678" autocomplete="off"></label>
        <label class="field"><span>發票日期</span><input type="date" name="invoice_date" value="${head.invoice_date || ''}"></label>
        <label class="field"><span>到貨日</span><input type="date" name="date" value="${head.date || ''}"></label>
        <label class="field"><span>訂購日（算交貨天數）</span><input type="date" name="order_date" value="${head.order_date || ''}"></label>
        <label class="field"><span>良率評分（0–100）</span><input type="number" name="yield_score" min="0" max="100" step="1" value="${head.yield_score ?? ''}"></label>
        <label class="field" style="grid-column:1/-1"><span>備註</span><input type="text" name="note" value="${head.note}" autocomplete="off"></label>
      </div>
      <p class="muted" style="margin:12px 0 6px">每一行一個品項：品名、單位、數量、含稅單價、含稅金額（數量 × 單價自動算，可改）。沒見過的品名會自動建成原物料並依品名判斷分類；按 Enter 跳下一格，最後一格再按會新增一行。</p>
      <div class="table-wrap"><table class="grid"><thead><tr><th>品名</th><th>單位</th><th class="num">數量</th><th class="num">含稅單價</th><th class="num">含稅金額</th><th>分類（12XX 原料）</th><th></th></tr></thead>
        <tbody id="po-lines">${(startLines.length ? startLines : [{}]).map(row)}${startLines.length ? '' : row()}</tbody>
        <tfoot><tr><td colspan="7"><button type="button" class="btn sm" data-add>＋ 新增一行</button></td></tr></tfoot></table></div>
      <datalist id="po-items">${sortItems(items).map((i) => h`<option value="${i.name}">${itemLabel(i)}</option>`)}</datalist>
      <datalist id="po-sups">${suppliers.map((s) => h`<option value="${supplierLabel(s)}">${s.name && s.short_name && s.name !== s.short_name ? s.name : ''}</option>`)}</datalist>
      <div id="po-bar" class="callout" style="margin-top:10px"></div>`,
    onMount: (dlg) => {
      const inv = dlg.querySelector('[name=invoice_date]');
      const arrive = dlg.querySelector('[name=date]');
      let arriveTouched = !!group;
      inv.addEventListener('change', () => {
        if (!arriveTouched) arrive.value = inv.value;
      });
      arrive.addEventListener('input', () => (arriveTouched = true));
      for (const tr of dlg.querySelectorAll('#po-lines tr')) if (tr.querySelector('[name=amount]').value) tr.querySelector('[name=amount]').dataset.manual = '1';
      dlg.addEventListener('input', (ev) => {
        const tr = ev.target.closest('#po-lines tr');
        if (tr) {
          if (ev.target.name === 'amount') {
            if (ev.target.value.trim()) ev.target.dataset.manual = '1';
            else delete ev.target.dataset.manual;
          } else if (ev.target.name === 'qty' || ev.target.name === 'price') autoAmount(tr);
          if (ev.target.name === 'name') {
            const it = findItem(items, ev.target.value);
            if (!it) {
              const sel = tr.querySelector('[name=cat]');
              sel.value = guessItemCategory(ev.target.value).category;
            }
          }
        }
        refresh(dlg);
      });
      dlg.addEventListener('change', (ev) => {
        const tr = ev.target.closest('#po-lines tr');
        if (tr && ev.target.name === 'name') {
          fillFromItem(tr);
          autoAmount(tr);
        }
        refresh(dlg);
      });
      dlg.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' || ev.isComposing || !ev.target.closest?.('#po-lines')) return;
        ev.preventDefault();
        const cells = cellsOf(dlg);
        const next = cells[cells.indexOf(ev.target) + 1] || addRow(dlg);
        next.focus();
        next.select?.();
      });
      dlg.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-add]')) addRow(dlg).focus();
        const del = ev.target.closest('[data-del]');
        if (del) {
          del.closest('tr').remove();
          refresh(dlg);
        }
      });
      refresh(dlg);
    },
    actions: [
      { label: '取消', value: null },
      {
        label: group ? '儲存進貨單' : '登記進貨',
        primary: true,
        value: (dlg) => {
          const g = (n) => dlg.querySelector(`[name=${n}]`).value.trim();
          const list = collect(dlg);
          const invoiceDate = g('invoice_date');
          const date = g('date') || invoiceDate;
          if (!date) return fail('請輸入發票日期或到貨日');
          if (!list.length) return fail('至少要有一行品項');
          for (const p of list) {
            if (!p.name) return fail(`第 ${p.n} 行沒有品名`);
            if (!(p.qty > 0)) return fail(`第 ${p.n} 行「${p.name}」的數量要大於 0`);
            if (p.amount === null && p.unit_price === null) return fail(`第 ${p.n} 行「${p.name}」要填含稅單價或含稅金額`);
          }
          const od = g('order_date');
          if (od && od > date) return fail('訂購日不可晚於到貨日');
          const y = num(g('yield_score'));
          if (y !== null && !(y >= 0 && y <= 100)) return fail('良率評分需在 0–100 之間');
          const supText = g('supplier');
          const sup = findSupplier(suppliers, { name: supText });
          return { supplier_id: sup?.id || null, supplier_name: sup ? '' : supText, invoice_no: g('invoice_no').normalize('NFKC').toUpperCase(), invoice_date: invoiceDate || date, date, order_date: od || null, yield_score: y, note: g('note'), lines: list.map(({ n, tr, ...p }) => p) };
        },
      },
    ],
  });
  if (!r) return null;
  const ctx = { items: [...items], suppliers: [...suppliers], vatRate };
  const res = applyPurchase({ ...r, id: group?.purchase_id || uid('po_'), source_file: group?.source_file || '' }, ctx);
  if (res.skipped.length) return fail(res.skipped[0].reason);
  if (res.newItems.length) await store.put('inventory_items', res.newItems);
  if (res.updatedItems.length) await store.put('inventory_items', res.updatedItems);
  if (res.newSupplier) await store.put('suppliers', res.newSupplier);
  if (group) await store.remove('inventory_moves', group.lines.map((m) => m.id));
  await store.put('inventory_moves', res.moves);
  toast(`已${group ? '更新' : '登記'}進貨單（${res.moves.length} 行${res.newItems.length ? `，自動建檔 ${res.newItems.length} 項原物料` : ''}${res.newSupplier ? `，新供應商「${res.newSupplier.name}」` : ''}）`, 'good', 6000);
  return res;
}

export async function render(root, ctx) {
  const settings = await getSettings();
  const vatRate = settings.vat_mode === 'general' ? VAT_RATE : 0;
  const accName = new Map((await getAccounts()).map((a) => [a.code, a.name]));
  const f = { tab: ctx.params.tab || 'docs', sup: ctx.params.sup || '', q: ctx.params.q || '', item: ctx.params.item || '' };
  let snap, suppliers, items, moves, recipes;

  async function load() {
    [snap, suppliers] = await Promise.all([stockSnapshot(), store.all('suppliers')]);
    ({ items, moves, recipes } = snap);
  }
  async function reload() {
    await load();
    draw();
  }

  function drawDocs(top, body) {
    const groups = groupPurchases(moves, { items, suppliers });
    const q = f.q.trim().toLowerCase();
    const rows = groups
      .filter((g) => (!f.sup || g.supplier_id === f.sup) && (!q || g.invoice_no.toLowerCase().includes(q) || g.itemNames.some((n) => n.toLowerCase().includes(q)) || g.supplierName.toLowerCase().includes(q)))
      .map((g) => ({ ...g, n: g.lines.length, lead: g.order_date ? daysBetween(g.order_date, g.date) : null, source: g.source_file || '手動登記' }));
    const ym = today().slice(0, 7);
    const thisMonth = groups.filter((g) => g.date.startsWith(ym));
    const autoItems = items.filter((i) => i.auto_category).length;
    mount(
      top,
      h`<div class="stats">
        ${stat('進貨單', fmt(groups.length), `${fmt(moves.filter((m) => m.type === 'purchase').length)} 行進貨`)}
        ${stat('進貨總額（含稅）', '$' + fmt(round2(groups.reduce((t, g) => t + g.total, 0))), '全部期間')}
        ${stat('本月進貨', '$' + fmt(round2(thisMonth.reduce((t, g) => t + g.total, 0))), `${fmt(thisMonth.length)} 張`)}
        ${stat('原物料品項', fmt(items.length), autoItems ? `${fmt(autoItems)} 項分類待確認` : '分類都已確認', autoItems ? 'warn' : '')}
      </div>
      <div class="callout" style="margin-bottom:16px"><p><b>進貨 → 庫存 → 配方 → 自動扣庫存：</b>登記或匯入進貨單後，沒見過的品名會自動建成原物料（分類依會計科目 12XX 原料規則判斷），每一行進貨直接載入「原物料進銷存」；在「原物料主檔」分頁設定安全庫存與進貨包裝折合量，到 <a href="#/inventory?tab=bom">配方（BOM）</a> 設定每份品項的用量後，POS 每賣一份就自動扣庫存。</p></div>`,
    );
    dataTable(body, {
      rows,
      exportName: '進貨單.csv',
      empty: '沒有符合的進貨單',
      initialSort: { key: 'date', dir: -1 },
      columns: [
        { key: 'date', label: '到貨日', fmt: (v, r) => h`${v}${r.invoice_date && r.invoice_date !== v ? small(`發票 ${r.invoice_date}`) : ''}`, csv: (v) => v },
        { key: 'invoice_no', label: '發票號碼', fmt: (v) => v || '—' },
        { key: 'supplierName', label: '供應商', fmt: (v) => v || '—' },
        { key: 'summary', label: '品項' },
        { key: 'n', label: '行數', align: 'num', fmt: (v) => fmt(v) },
        { key: 'total', label: '含稅金額', align: 'num', fmt: (v, r) => h`<b>$${fmt(v)}</b>${small(`未稅 $${fmt(r.totalEx)}`)}`, csv: (v) => v },
        { key: 'lead', label: '交貨天數', align: 'num', fmt: (v) => oneDec(v) },
        { key: 'yield_score', label: '良率', align: 'num', fmt: (v) => oneDec(v) },
        { key: 'source', label: '來源', fmt: (v) => h`<span class="muted" style="font-size:12px">${v}</span>`, csv: (v) => v },
        { key: 'id', label: '', nosort: true, fmt: (v) => h`<span style="white-space:nowrap"><button class="btn sm" data-act="editDoc" data-id="${v}">修改</button> <button class="btn sm danger" data-act="delDoc" data-id="${v}">刪除</button></span>`, csv: () => '' },
      ],
    });
  }

  function drawItems(top, body) {
    const supBy = new Map(suppliers.map((s) => [s.id, s]));
    const inRecipe = new Map();
    for (const r of recipes) inRecipe.set(r.item_id, (inRecipe.get(r.item_id) || 0) + 1);
    const lastBuy = new Map();
    for (const m of moves) if (m.type === 'purchase' && (!lastBuy.has(m.item_id) || m.date > lastBuy.get(m.item_id))) lastBuy.set(m.item_id, m.date);
    const rows = sortItems(items).map((it) => {
      const lv = snap.levels.get(it.id);
      const avgCost = lv?.avgCost ?? 0;
      const last = [it.last_purchase_date, lastBuy.get(it.id)].filter(Boolean).sort().pop() || '';
      return { ...it, id: it.id, onHand: lv?.onHand ?? 0, avgCost, last, recipes: inRecipe.get(it.id) || 0, supplier: supplierLabel(supBy.get(it.supplier_id)), stock: lv?.status || 'ok', pack: it.pack_type ? `${it.pack_type}${Number(it.pack_size) > 0 && Number(it.pack_size) !== 1 ? ` ＝ ${fmt(Number(it.pack_size))} ${it.unit}` : ''}` : '' };
    });
    const low = rows.filter((r) => r.stock === 'low' || r.stock === 'out').length;
    const noSafety = rows.filter((r) => !(Number(r.safety_stock) > 0)).length;
    const autoItems = rows.filter((r) => r.auto_category).length;
    mount(
      top,
      h`<div class="stats">
        ${stat('原物料品項', fmt(rows.length), `${fmt(rows.filter((r) => r.recipes).length)} 項已用於配方`)}
        ${stat('分類待確認', fmt(autoItems), autoItems ? '自動建檔時依品名判斷，請點「修改」確認' : '都已確認', autoItems ? 'warn' : '')}
        ${stat('未設安全庫存', fmt(noSafety), noSafety ? '點「修改」設定預警線' : '都已設定', noSafety ? 'warn' : '')}
        ${stat('低於安全庫存／缺貨', fmt(low), low ? '建議叫貨' : '庫存正常', low ? 'bad' : '')}
      </div>
      <div class="callout" style="margin-bottom:16px"><p>物品編號、品名、單位、含稅單價、進貨包裝與每包裝價格由進貨單自動帶入；成本／單位＝移動平均成本（庫存單位）。進貨單上的單位若是「箱、瓶、包」等包裝，請在「修改」設定每一包裝折合幾個庫存單位（例：1 瓶 ＝ 936 ml），庫存與配方就以庫存單位計算。</p></div>`,
    );
    dataTable(body, {
      rows,
      exportName: '原物料主檔.csv',
      columns: [
        { key: 'sku', label: '物品編號' },
        { key: 'name', label: '品名', fmt: (v, r) => h`<b>${v}</b>${r.auto_category ? h` ${badge('分類待確認', 'medium')}` : ''}`, csv: (v) => v },
        { key: 'unit', label: '單位' },
        { key: 'onHand', label: '現有數量', align: 'num', fmt: (v, r) => h`${fmt(v)}${r.stock === 'out' || r.stock === 'low' ? small(status('bad', r.stock === 'out' ? '缺貨' : '低於安全量')) : ''}`, csv: (v) => v },
        { key: 'last_unit_price', label: '含稅單價', align: 'num', fmt: (v, r) => (v === null || v === undefined ? '—' : h`${fmtUnitCost(v)}${small(`每 ${r.last_price_unit || r.unit || '單位'}`)}`), csv: (v) => v ?? '' },
        { key: 'avgCost', label: '成本／單位', align: 'num', fmt: (v, r) => h`${fmtUnitCost(v)}${small(`每 ${r.unit || '單位'}`)}`, csv: (v) => v },
        { key: 'supplier', label: '主要供應商', fmt: (v) => v || '—' },
        { key: 'pack', label: '進貨包裝', fmt: (v) => v || '—' },
        { key: 'pack_price_ex', label: '未稅價／包裝', align: 'num', fmt: (v) => (v === null || v === undefined ? '—' : fmtUnitCost(v)) },
        { key: 'pack_price_inc', label: '含稅價／包裝', align: 'num', fmt: (v) => (v === null || v === undefined ? '—' : fmtUnitCost(v)) },
        { key: 'last', label: '最近進貨日', fmt: (v) => v || '—' },
        { key: 'safety_stock', label: '安全庫存', align: 'num', fmt: (v, r) => (Number(v) > 0 ? `${fmt(Number(v))} ${r.unit}` : status('na', '未設')), csv: (v) => v ?? '' },
        { key: 'recipes', label: '用於配方', align: 'num', fmt: (v) => (v ? fmt(v) : h`<a href="#/inventory?tab=bom" class="muted">去設定</a>`), csv: (v) => v },
        { key: 'category', label: '自動分類', fmt: (v) => `${INVENTORY_CATEGORIES[v]?.label || v || ''}（${INVENTORY_CATEGORIES[v]?.gl || ''}）` },
        { key: 'source_file', label: '來源檔名', fmt: (v) => h`<span class="muted" style="font-size:12px">${v || '手動'}</span>`, csv: (v) => v || '' },
        { key: 'note', label: '備註' },
        { key: 'id', label: '', nosort: true, fmt: (v) => h`<span style="white-space:nowrap"><button class="btn sm" data-act="editItem" data-id="${v}">修改</button> <a class="btn sm ghost" href="#/purchases?tab=price&amp;item=${v}">單價</a></span>`, csv: () => '' },
      ],
    });
  }

  function drawPrice(top, body) {
    const purchases = moves.filter((m) => m.type === 'purchase');
    const supById = new Map(suppliers.map((s) => [s.id, s]));
    const supName = (id) => supplierLabel(supById.get(id)) || '未指定供應商';
    const buys = new Map();
    for (const m of purchases) if (Number(m.qty) > 0) buys.set(m.item_id, (buys.get(m.item_id) || 0) + 1);
    const tracked = sortItems(items.filter((i) => buys.has(i.id)));
    if (!tracked.length) {
      mount(top, '');
      mount(body, emptyState('還沒有進貨紀錄', '登記或匯入進貨單後，就能看到各原料每批單價的變化。'));
      return;
    }
    const sel = tracked.some((i) => i.id === f.item) ? f.item : [...tracked].sort((a, b) => buys.get(b.id) - buys.get(a.id))[0].id;
    const item = items.find((i) => i.id === sel);
    const unit = item.unit || '單位';
    const hist = priceHistory(moves, sel);
    const s = hist.stats;
    const pts = hist.points;
    const at = (v) => pts.find((p) => p.unitCost === v);
    const where = (p) => (p ? `${p.date}・${supName(p.supplier_id)}` : '');
    mount(
      top,
      h`<div class="toolbar" style="margin-bottom:12px">
        <label class="field"><span>原料</span><select data-act="item">${options(tracked.map((i) => [i.id, `${i.name}（${buys.get(i.id)} 筆）`]), sel)}</select></label>
        <span class="spacer"></span>
        <span class="muted" style="font-size:13px">單價＝含稅金額 ÷ 庫存單位數量，依到貨日排列；上漲以 ▲ 表示</span>
      </div>
      <div class="stats">
        ${stat('最新單價', fmtUnitCost(s.latest), `每 ${unit}・${where(pts[pts.length - 1])}`)}
        ${stat('較上次', change(s.changeVsPrev), pts.length > 1 ? `上次 ${fmtUnitCost(pts[pts.length - 2].unitCost)}（${pts[pts.length - 2].date}）` : '只有一筆進貨', changeTone(s.changeVsPrev))}
        ${stat('較首次', change(s.changeVsFirst), `首次 ${fmtUnitCost(pts[0].unitCost)}（${pts[0].date}）`, changeTone(s.changeVsFirst))}
        ${stat('平均', fmtUnitCost(s.avg), `${fmt(pts.length)} 筆進貨`)}
        ${stat('最低', fmtUnitCost(s.min), where(at(s.min)))}
        ${stat('最高', fmtUnitCost(s.max), where(at(s.max)))}
      </div>
      <div id="price-chart"></div>`,
    );
    lineChart(top.querySelector('#price-chart'), { points: pts.map((p) => ({ label: p.date, value: p.unitCost, sub: `${supName(p.supplier_id)}・${fmt(p.qty)} ${unit}` })), format: fmtUnitCost, ariaLabel: `${item.name} 每${unit}採購單價走勢` });
    dataTable(body, {
      rows: purchases
        .filter((m) => m.item_id === sel && Number(m.qty) > 0)
        .map((m) => {
          const qty = Number(m.qty);
          const unitCost = (Number(m.amount) || 0) / qty;
          return { id: m.id, date: m.date, supplier: supName(m.supplier_id), qty, packQty: m.pack_qty && m.unit ? `${fmt(Number(m.pack_qty))} ${m.unit}` : '', unitCost, diff: s.avg ? (unitCost - s.avg) / s.avg : null, amount: Number(m.amount) || 0, invoice_no: m.invoice_no || '', purchase_id: m.purchase_id || '' };
        }),
      exportName: `採購單價_${item.name}.csv`,
      initialSort: { key: 'date', dir: -1 },
      columns: [
        { key: 'date', label: '到貨日' },
        { key: 'supplier', label: '供應商' },
        { key: 'qty', label: `數量（${unit}）`, align: 'num', fmt: (v, r) => h`${fmt(v)}${r.packQty ? small(r.packQty) : ''}`, csv: (v) => v },
        { key: 'unitCost', label: `單價／${unit}`, align: 'num', fmt: (v) => fmtUnitCost(v) },
        { key: 'diff', label: '與平均差', align: 'num', fmt: (v) => (v === null ? '—' : `${v > 0 ? '+' : ''}${pct(v)}`) },
        { key: 'amount', label: '含稅金額', align: 'num', fmt: (v) => money(v) },
        { key: 'invoice_no', label: '發票號碼' },
      ],
    });
  }

  function draw() {
    const hasPurchases = moves.some((m) => m.type === 'purchase');
    const importBtns = h`<a class="btn" href="#/import?target=purchases">從匯入中心匯入</a><button class="btn ghost" data-act="template">下載匯入範本</button>`;
    if (!hasPurchases && !items.length) {
      mount(root, h`<div class="card">${emptyState('還沒有進貨紀錄', '按「新增進貨單」輸入發票上的品名、單位、數量、單價，或把進貨明細 CSV／Excel 丟進匯入中心。沒見過的品名會自動建成原物料並載入進銷存，再設定安全庫存與配方，POS 銷售就會自動扣庫存。', h`<div class="row" style="justify-content:center"><button class="btn primary" data-act="addDoc">＋ 新增進貨單</button>${importBtns}</div>`)}</div>`);
      return;
    }
    const tabs = [['docs', '進貨單'], ['items', `原物料主檔（${fmt(items.length)}）`], ['price', '單價追蹤']];
    mount(
      root,
      h`<div class="toolbar">
        <button class="btn primary" data-act="addDoc">＋ 新增進貨單</button>
        ${importBtns}
        ${f.tab === 'docs' ? h`<label class="field"><span>供應商</span><select data-act="fSup">${options([['', '全部'], ...suppliers.map((s) => [s.id, supplierLabel(s)])], f.sup)}</select></label><label class="field"><span>搜尋</span><input type="search" value="${f.q}" data-act="fQ" placeholder="品名、發票號碼" style="width:160px"></label>` : ''}
        <span class="spacer"></span>
        <a class="btn ghost" href="#/suppliers">供應商</a>
        <a class="btn ghost" href="#/inventory">原物料進銷存</a>
      </div>
      <div id="po-top"></div>
      <div class="card">
        <div class="tabs" role="tablist">${tabs.map(([k, l]) => h`<button role="tab" aria-selected="${f.tab === k ? 'true' : 'false'}" class="${f.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`)}</div>
        <div id="po-body"></div>
      </div>`,
    );
    const top = root.querySelector('#po-top');
    const body = root.querySelector('#po-body');
    if (f.tab === 'items') drawItems(top, body);
    else if (f.tab === 'price') drawPrice(top, body);
    else drawDocs(top, body);
  }

  const groupOf = (id) => groupPurchases(moves, { items, suppliers }).find((g) => g.id === id);
  const setF = (k, param) => (el) => {
    f[k] = el.value;
    ctx.setParams({ [param]: el.value });
    draw();
  };
  const unbind = bindActions(root, {
    tab: (el) => {
      f.tab = el.dataset.tab;
      ctx.setParams({ tab: f.tab });
      draw();
    },
    fSup: setF('sup', 'sup'),
    fQ: setF('q', 'q'),
    item: setF('item', 'item'),
    addDoc: async () => {
      if (await editPurchaseDoc(null, { items, suppliers, vatRate, supplierId: f.sup })) await reload();
    },
    editDoc: async (el) => {
      const g = groupOf(el.dataset.id);
      if (g && (await editPurchaseDoc(g, { items, suppliers, vatRate }))) await reload();
    },
    delDoc: async (el) => {
      const g = groupOf(el.dataset.id);
      if (!g) return;
      if (!(await confirmBox(`刪除 ${g.date} 的進貨單（${g.invoice_no || g.summary}，${g.lines.length} 行，$${fmt(g.total)}）？已自動建檔的原物料會保留。`, { ok: '刪除', danger: true }))) return;
      await store.remove('inventory_moves', g.lines.map((m) => m.id));
      toast('已刪除進貨單', 'good');
      await reload();
    },
    editItem: async (el) => {
      const it = items.find((i) => i.id === el.dataset.id);
      if (it && (await editItem(it, { items, moves, recipes, suppliers, accName }))) await reload();
    },
    template: () => downloadCSV('進貨紀錄範本.csv', templateCSV('purchases')),
  });
  await load();
  draw();
  return unbind;
}
