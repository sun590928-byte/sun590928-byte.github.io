// 原物料進銷存（Inventory_Ledger）：庫存水位與安全庫存預警、異動紀錄（期初／進貨／耗用／報廢／盤點）、配方（BOM）與理論成本。
// 耗用 = POS 銷售 × 配方（含老闆招待／測試）＋ 手動耗用；POS 以「報廢」作廢的品項計入報廢量。

import { h, raw, mount, bindActions, dataTable, modal, confirmBox, toast, stat, badge, status, options, fmt, pct, emptyState } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getProductIndex, getAccounts, revenueLines } from '../state.js';
import { INVENTORY_CATEGORIES, MOVE_TYPES, theoreticalUsage, averageCosts, stockLevels, productCosts } from '../lib/inventory.js';
import { CATEGORIES } from '../lib/pos.js';
import { uid } from '../lib/text.js';
import { today, daysBetween } from '../lib/dates.js';
import { round2 } from '../lib/money.js';

// 庫存狀態：[status() 種類, 文字, 排序]
const STATUS = { out: ['bad', '缺貨', 0], low: ['bad', '低於安全量', 1], watch: ['warn', '接近安全量', 2], unset: ['na', '未設安全量', 3], ok: ['good', '正常', 4] };
const SKU_PREFIX = { beans: 'BN', dairy: 'DY', tea_syrup: 'TS', bakery: 'BK', packaging: 'PK', retail: 'RT' };
const MOVE_HINT = {
  opening: '期初：營收起算日當天盤點的數量與總價值；金額留白時以標準成本計算。',
  purchase: '進貨：填訂購日可計算供應商交貨天數；良率評分記錄這批貨的品質（100＝全數可用）。',
  consume: '手動耗用：POS 銷售 × 配方已自動扣庫存，這裡只登記配方以外的用量（員工餐、試做等）。',
  scrap: '報廢：過期、打翻、品質不良而丟棄的數量。POS 上以「報廢」作廢的品項已自動計入，不必重複登記。',
  adjust: '盤點調整：實際盤點數與帳面庫存的差額，正數＝盤盈、負數＝盤虧。',
};

const fail = (msg) => {
  toast(msg, 'error');
  return false;
};
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v));
const qtyFmt = (v) => fmt(v, { blankZero: true });
const small = (text) => h`<div class="muted" style="font-size:12px">${text}</div>`;
const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant');

export function fmtUnitCost(v) {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return '$' + new Intl.NumberFormat('zh-TW', { maximumFractionDigits: Math.abs(v) < 10 ? 3 : 2 }).format(v);
}

export function itemLabel(it) {
  return `${it.sku ? it.sku + ' ' : ''}${it.name}（${it.unit || '—'}）`;
}

export function sortItems(items) {
  const order = Object.keys(INVENTORY_CATEGORIES);
  return [...items].sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || String(a.sku || a.name).localeCompare(String(b.sku || b.name), 'zh-Hant'));
}

function suggestSku(cat, items) {
  const p = SKU_PREFIX[cat] || 'IT';
  const used = items.map((i) => /^([A-Z]+)-(\d+)$/i.exec(String(i.sku || ''))).filter((m) => m && m[1].toUpperCase() === p).map((m) => Number(m[2]));
  return `${p}-${String((used.length ? Math.max(...used) : 0) + 1).padStart(3, '0')}`;
}

const statusKey = (r) => (r.status === 'ok' && !(Number(r.item.safety_stock) > 0) ? 'unset' : r.status);
const fmtDays = (v) => (v === null || v === undefined ? '—' : v <= 0 ? '0' : v < 10 ? v.toFixed(1) : fmt(Math.round(v)));

/**
 * 登記／修改一筆進銷存異動並儲存；取消回傳 null。
 * @param opts.type 指定時固定類型（採購頁只登記進貨）；opts.itemId 預選品項
 */
export async function editMove(move, { items, suppliers, type = null, itemId = null } = {}) {
  if (!items.length) {
    toast('請先到「原物料進銷存」新增原物料品項', 'error');
    return null;
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  const sorted = sortItems(items);
  const m = move ? { ...move } : { item_id: byId.has(itemId) ? itemId : sorted[0].id, date: today(), type: type || 'purchase', qty: '', amount: '', order_date: '', yield_score: '', invoice_no: '', note: '' };
  if (!move) m.supplier_id = byId.get(m.item_id)?.supplier_id || '';
  const body = h`<div class="form-grid">
      <label class="field"><span>品項</span><select name="item_id">${options(sorted.map((i) => [i.id, itemLabel(i)]), m.item_id)}</select></label>
      <label class="field"><span>類型</span><select name="type" ${type ? raw('disabled') : ''}>${options(Object.entries(MOVE_TYPES), m.type)}</select></label>
      <label class="field"><span data-date-label>日期</span><input type="date" name="date" value="${m.date || ''}"></label>
      <label class="field"><span>數量（<span data-unit></span>）</span><input type="number" name="qty" step="any" value="${m.qty ?? ''}"></label>
      <label class="field" data-for="purchase opening"><span>金額（總價）</span><input type="number" name="amount" min="0" step="any" value="${m.amount ?? ''}"></label>
      <label class="field" data-for="purchase"><span>供應商（選填）</span><select name="supplier_id">${options([['', '—'], ...[...suppliers].sort(byName).map((s) => [s.id, s.name])], m.supplier_id || '')}</select></label>
      <label class="field" data-for="purchase"><span>訂購日（算交貨天數）</span><input type="date" name="order_date" value="${m.order_date || ''}"></label>
      <label class="field" data-for="purchase"><span>良率評分（0–100）</span><input type="number" name="yield_score" min="0" max="100" step="1" value="${m.yield_score ?? ''}"></label>
      <label class="field" data-for="purchase"><span>發票號碼</span><input type="text" name="invoice_no" value="${m.invoice_no || ''}"></label>
      <label class="field" style="grid-column:1/-1"><span>備註</span><input type="text" name="note" value="${m.note || ''}"></label>
    </div>
    <p class="muted" style="font-size:12.5px;margin:10px 0 0"><span data-hint></span> <b data-price></b></p>`;
  const sync = (dlg) => {
    const get = (n) => dlg.querySelector(`[name=${n}]`).value;
    const t = get('type');
    const unit = byId.get(get('item_id'))?.unit || '單位';
    for (const el of dlg.querySelectorAll('[data-for]')) el.style.display = el.dataset.for.split(' ').includes(t) ? '' : 'none';
    dlg.querySelector('[data-date-label]').textContent = t === 'purchase' ? '到貨日' : '日期';
    dlg.querySelector('[data-unit]').textContent = unit;
    dlg.querySelector('[data-hint]').textContent = MOVE_HINT[t] || '';
    const q = num(get('qty'));
    const a = num(get('amount'));
    dlg.querySelector('[data-price]').textContent = (t === 'purchase' || t === 'opening') && q > 0 && a !== null ? `單價 ${fmtUnitCost(a / q)}／${unit}` : '';
  };
  const save = (dlg) => {
    const get = (n) => dlg.querySelector(`[name=${n}]`).value.trim();
    const t = get('type');
    const it = byId.get(get('item_id'));
    const date = get('date');
    const qty = num(get('qty'));
    if (!it) return fail('請選擇品項');
    if (!date) return fail('請輸入日期');
    if (qty === null || !Number.isFinite(qty) || qty === 0) return fail('請輸入數量');
    if (t !== 'adjust' && qty < 0) return fail('數量需為正數；盤虧請用「盤點調整」輸入負數');
    const out = { ...m, id: m.id || uid('mv_'), item_id: it.id, date, type: t, qty, amount: null, supplier_id: null, order_date: null, yield_score: null, invoice_no: '', note: get('note') };
    if (t === 'purchase' || t === 'opening') {
      const amount = num(get('amount'));
      if (amount !== null && !(amount >= 0)) return fail('金額需為 0 以上');
      if (amount === null && t === 'purchase') return fail('請輸入進貨金額（用於平均成本與單價趨勢）');
      out.amount = round2(amount ?? qty * (Number(it.std_cost) || 0));
    }
    if (t === 'purchase') {
      const od = get('order_date');
      const y = num(get('yield_score'));
      if (od && od > date) return fail('訂購日不可晚於到貨日');
      if (y !== null && !(y >= 0 && y <= 100)) return fail('良率評分需在 0–100 之間');
      Object.assign(out, { supplier_id: get('supplier_id') || null, order_date: od || null, yield_score: y, invoice_no: get('invoice_no') });
    }
    return out;
  };
  const r = await modal({
    title: move ? `修改${MOVE_TYPES[m.type] || ''}紀錄` : type === 'purchase' ? '新增採購' : '登記異動',
    body,
    actions: [{ label: '取消', value: null }, { label: '儲存', primary: true, value: save }],
    onMount: (dlg) => {
      const get = (n) => dlg.querySelector(`[name=${n}]`);
      get('item_id').addEventListener('change', () => {
        const sup = byId.get(get('item_id').value)?.supplier_id;
        if (sup && !get('supplier_id').value) get('supplier_id').value = sup;
      });
      dlg.addEventListener('input', () => sync(dlg));
      dlg.addEventListener('change', () => sync(dlg));
      sync(dlg);
    },
  });
  if (!r) return null;
  await store.put('inventory_moves', r);
  toast(`已儲存${MOVE_TYPES[r.type]}紀錄`, 'good');
  return r;
}

export async function render(root, ctx) {
  const settings = await getSettings();
  const idx = await getProductIndex();
  const lines = await revenueLines();
  const accName = new Map((await getAccounts()).map((a) => [a.code, a.name]));
  const colls = ['inventory_items', 'inventory_moves', 'recipes', 'suppliers'];
  let [items, moves, recipes, suppliers] = await Promise.all(colls.map((c) => store.all(c)));
  const f = { tab: ctx.params.tab || 'stock', asOf: ctx.params.asof || '', item: ctx.params.item || '', mtype: ctx.params.mtype || '' };
  const lastSale = lines.reduce((m, l) => (l.date > m ? l.date : m), '');
  const asOfDate = () => f.asOf || (lastSale > today() ? lastSale : today());
  const vatDiv = settings.vat_mode === 'general' ? 1.05 : 1;
  const marginOf = (price, cost) => (price > 0 && cost !== null ? (price / vatDiv - cost) / (price / vatDiv) : null);

  // 每條銷售明細對應的標準品項（快取），以及各品項平均售價（非作廢）
  const pidCache = new Map();
  const pidOf = (l) => {
    if (!pidCache.has(l)) pidCache.set(l, idx.of(l).id);
    return pidCache.get(l);
  };
  const sold = new Map();
  const unmapped = new Set();
  for (const l of lines) {
    if (l.is_adjustment || !(l.qty > 0) || l.void_reason === 'pos_void') continue;
    const pid = pidOf(l);
    if (pid.startsWith('raw:')) unmapped.add(pid);
    if (l.void_reason) continue;
    const s = sold.get(pid) || { qty: 0, revenue: 0 };
    s.qty += l.qty;
    s.revenue += l.revenue;
    sold.set(pid, s);
  }
  const priceOf = (pid) => {
    const s = sold.get(pid);
    return s && s.qty > 0 ? s.revenue / s.qty : null;
  };

  async function reload() {
    [items, moves, recipes, suppliers] = await Promise.all(colls.map((c) => store.all(c)));
    draw();
  }

  function computeLevels() {
    const asOf = asOfDate();
    const rateAsOf = lastSale && lastSale < asOf ? lastSale : asOf;
    const usage = theoreticalUsage(lines, recipes, pidOf, { to: asOf });
    let levels = stockLevels(items, moves, usage, { asOf });
    if (rateAsOf !== asOf) {
      // POS 資料落後基準日：日均耗用改以最後銷售日往前推算，避免沒有資料的天數稀釋
      const rate = new Map(stockLevels(items, moves, usage, { asOf: rateAsOf }).map((r) => [r.item.id, r.avgDaily]));
      levels = levels.map((r) => {
        const d = rate.get(r.item.id) || 0;
        return { ...r, avgDaily: d, daysCover: d > 0 ? r.onHand / d : null };
      });
    }
    return { asOf, rateAsOf, levels };
  }

  function drawStock(top, body) {
    const { asOf, rateAsOf, levels } = computeLevels();
    const rows = levels.map((r) => {
      const key = statusKey(r);
      return { ...r, id: r.item.id, sku: r.item.sku || '', name: r.item.name, category: r.item.category, unit: r.item.unit || '', safety: Number(r.item.safety_stock) || 0, key, rank: STATUS[key][2] };
    });
    const n = (k) => rows.filter((r) => r.key === k).length;
    const inRecipe = new Set(recipes.map((r) => r.item_id));
    mount(
      top,
      h`<div class="stats">
        ${stat('品項數', fmt(items.length), `${fmt(items.filter((i) => inRecipe.has(i.id)).length)} 項已用於配方`)}
        ${stat('低於安全庫存', fmt(n('low')), [n('low') ? '已低於預警線，建議叫貨' : '沒有品項低於預警線', n('watch') ? `另 ${n('watch')} 項接近` : ''].filter(Boolean).join('・'), n('low') ? 'bad' : '')}
        ${stat('缺貨', fmt(n('out')), n('out') ? '現有庫存 ≤ 0，請盡快叫貨' : '沒有缺貨品項', n('out') ? 'bad' : '')}
        ${stat('庫存總值', '$' + fmt(round2(rows.reduce((t, r) => t + r.value, 0))), `移動平均成本・${asOf}`)}
      </div>
      ${recipes.length ? '' : h`<div class="callout warn" style="margin-bottom:12px"><p>尚未設定任何配方，POS 銷售不會自動扣庫存。請到「配方（BOM）」分頁設定每個品項用了哪些原料。</p></div>`}
      <div class="callout" style="margin-bottom:16px">
        <p><b>耗用 ＝ POS 銷售份數 × 配方用量 ＋ 手動登記的耗用。</b>老闆招待、老闆測試的品項雖然金額作廢，原料確實用掉了，仍計入耗用；POS 上以「報廢」作廢的品項計入報廢量。</p>
        <p>現有庫存 ＝ 期初 ＋ 進貨 − 耗用 − 報廢 ± 盤點調整；可用天數 ＝ 現有庫存 ÷ 近 14 天日均耗用。${rateAsOf !== asOf ? `POS 銷售資料只到 ${rateAsOf}，之後的耗用尚未扣除，日均耗用以該日往前 14 天計算。` : ''}期初庫存請以營收起算日（${settings.revenue_start}）的盤點數量登記「期初」。</p>
      </div>`,
    );
    dataTable(body, {
      rows,
      exportName: `庫存水位_${asOf}.csv`,
      initialSort: { key: 'rank', dir: 1 },
      columns: [
        { key: 'sku', label: '編號' },
        { key: 'name', label: '品項', fmt: (v, r) => h`<b>${v}</b>${r.lastPurchase ? small(`最後進貨 ${r.lastPurchase.date}`) : ''}`, csv: (v) => v },
        { key: 'category', label: '分類', fmt: (v) => INVENTORY_CATEGORIES[v]?.label || v || '' },
        { key: 'unit', label: '單位' },
        { key: 'opening', label: '期初', align: 'num', fmt: qtyFmt },
        { key: 'purchased', label: '進貨', align: 'num', fmt: qtyFmt },
        { key: 'consumed', label: '耗用（POS×配方＋手動）', align: 'num', fmt: qtyFmt },
        { key: 'scrapped', label: '報廢', align: 'num', fmt: (v, r) => (v ? h`${fmt(v)}${small(`報廢率 ${pct(r.scrapRate)}`)}` : ''), csv: (v) => v || '' },
        { key: 'adjusted', label: '盤點調整', align: 'num', fmt: (v) => (v ? (v > 0 ? '+' : '') + fmt(v) : '') },
        { key: 'onHand', label: '現有庫存', align: 'num', fmt: (v) => h`<b>${fmt(v)}</b>`, csv: (v) => v },
        { key: 'safety', label: '安全庫存', align: 'num', fmt: (v) => (v ? fmt(v) : '—') },
        { key: 'daysCover', label: '可用天數', align: 'num', fmt: fmtDays },
        { key: 'avgCost', label: '平均成本', align: 'num', fmt: (v) => fmtUnitCost(v) },
        { key: 'value', label: '庫存價值', align: 'num', fmt: (v) => '$' + fmt(v) },
        {
          key: 'rank',
          label: '狀態',
          fmt: (v, r) => h`${status(STATUS[r.key][0], STATUS[r.key][1])}${(r.key === 'out' || r.key === 'low') && Number(r.item.reorder_qty) > 0 ? small(`建議叫貨 ${fmt(Number(r.item.reorder_qty))} ${r.unit}`) : ''}`,
          csv: (v, r) => STATUS[r.key][1],
        },
        { key: 'id', label: '', nosort: true, fmt: (v) => h`<span style="white-space:nowrap"><button class="btn sm" data-act="editItem" data-id="${v}">修改</button> <button class="btn sm ghost" data-act="addMove" data-id="${v}">＋異動</button></span>`, csv: () => '' },
      ],
    });
  }

  function drawMoves(body) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const supName = new Map(suppliers.map((s) => [s.id, s.name]));
    const rows = moves
      .filter((m) => (!f.item || m.item_id === f.item) && (!f.mtype || m.type === f.mtype))
      .map((m) => {
        const it = byId.get(m.item_id);
        const qty = Number(m.qty) || 0;
        const amount = num(m.amount);
        return { ...m, itemName: it?.name || '（已刪除的品項）', unit: it?.unit || '', qty, amount, unitCost: amount !== null && qty > 0 ? amount / qty : null, supplier: supName.get(m.supplier_id) || '', lead: m.order_date && m.date ? daysBetween(m.order_date, m.date) : null, yield_score: num(m.yield_score) };
      });
    mount(body, h`<p class="card-note" style="margin:0 0 10px">列出手動登記與匯入的異動；POS 銷售 × 配方的理論耗用會自動計入庫存水位，不另列在這裡。</p><div id="mv-table"></div>`);
    dataTable(body.querySelector('#mv-table'), {
      rows,
      exportName: '進銷存異動.csv',
      empty: '沒有符合的異動紀錄',
      initialSort: { key: 'date', dir: -1 },
      columns: [
        { key: 'date', label: '日期' },
        { key: 'itemName', label: '品項' },
        { key: 'type', label: '類型', fmt: (v) => badge(MOVE_TYPES[v] || v, v === 'purchase' ? 'accent' : v === 'scrap' ? 'medium' : ''), csv: (v) => MOVE_TYPES[v] || v },
        { key: 'qty', label: '數量', align: 'num', fmt: (v, r) => `${r.type === 'adjust' && v > 0 ? '+' : ''}${fmt(v)} ${r.unit}` },
        { key: 'amount', label: '金額', align: 'num', fmt: (v) => (v === null ? '' : '$' + fmt(v)) },
        { key: 'unitCost', label: '單價', align: 'num', fmt: (v) => (v === null ? '' : fmtUnitCost(v)) },
        { key: 'supplier', label: '供應商' },
        { key: 'lead', label: '交貨天數', align: 'num', fmt: (v) => (v === null ? '' : fmt(v)) },
        { key: 'yield_score', label: '良率', align: 'num', fmt: (v) => (v === null ? '' : fmt(v)) },
        { key: 'note', label: '備註' },
        { key: 'id', label: '', nosort: true, fmt: (v) => h`<span style="white-space:nowrap"><button class="btn sm" data-act="editMove" data-id="${v}">修改</button> <button class="btn sm danger" data-act="delMove" data-id="${v}">刪除</button></span>`, csv: () => '' },
      ],
    });
  }

  function drawBom(top, body) {
    if (!idx.products.length) {
      mount(body, emptyState('尚未建立標準品項', '配方要設定在標準品項上。請先到「品項整併」把 POS 上的品名合併成標準品項，再回來設定每一份用了哪些原料。', h`<a class="btn primary" href="#/products">前往品項整併</a>`));
      return;
    }
    const costs = averageCosts(items, moves, { asOf: asOfDate() });
    const perProduct = productCosts(idx.products, recipes, (id) => costs.get(id)?.avg || 0);
    const count = new Map();
    for (const r of recipes) count.set(r.product_id, (count.get(r.product_id) || 0) + 1);
    const rows = idx.products.map((p) => {
      const price = priceOf(p.id);
      const cost = perProduct.has(p.id) ? perProduct.get(p.id) : null;
      return { id: p.id, name: p.name, category: p.category, n: count.get(p.id) || 0, qty: sold.get(p.id)?.qty || 0, cost, price, margin: marginOf(price, cost) };
    });
    mount(
      top,
      h`<div class="callout" style="margin-bottom:16px"><p>配方＝每售出<b>一份</b>用掉的原料量，以原料的庫存單位計（咖啡豆 g、鮮奶 ml、杯蓋 個）；設定後 POS 每賣一份就自動扣庫存。理論成本＝Σ 用量 × 移動平均成本；毛利率以平均售價${vatDiv > 1 ? '扣除 5% 營業稅後' : ''}計算。</p>
        ${unmapped.size ? h`<p>另有 <b>${unmapped.size}</b> 個 POS 品名尚未整併到標準品項，這些銷售不會扣庫存 → <a href="#/products">前往品項整併</a></p>` : ''}</div>`,
    );
    dataTable(body, {
      rows,
      exportName: '配方成本與毛利.csv',
      initialSort: { key: 'qty', dir: -1 },
      columns: [
        { key: 'name', label: '品項', fmt: (v) => h`<b>${v}</b>`, csv: (v) => v },
        { key: 'category', label: '品類', fmt: (v) => CATEGORIES[v] || v || '' },
        { key: 'qty', label: '售出份數', align: 'num', fmt: (v) => fmt(v) },
        { key: 'n', label: '配方原料數', align: 'num', fmt: (v) => (v ? fmt(v) : status('warn', '未設定')), csv: (v) => v },
        { key: 'cost', label: '理論成本／份', align: 'num', fmt: (v) => (v === null ? '—' : fmtUnitCost(v)) },
        { key: 'price', label: '平均售價', align: 'num', fmt: (v) => (v === null ? '—' : '$' + fmt(round2(v))) },
        { key: 'margin', label: '估計毛利率', align: 'num', fmt: (v) => (v === null ? '—' : v < 0 ? status('bad', pct(v)) : pct(v)), csv: (v) => (v === null ? '' : pct(v)) },
        { key: 'id', label: '', nosort: true, fmt: (v, r) => h`<button class="btn sm ${r.n ? '' : 'primary'}" data-act="recipe" data-id="${v}">${r.n ? '修改配方' : '設定配方'}</button>`, csv: () => '' },
      ],
    });
  }

  function draw() {
    if (!items.length) {
      mount(root, h`<div class="card">${emptyState('還沒有原物料品項', '新增咖啡豆、鮮奶、杯蓋等原物料並設定安全庫存，再到「配方（BOM）」設定各品項的用量，系統就會依 POS 銷售自動推算耗用與庫存。進貨紀錄也可以從匯入中心批次匯入（會自動建立品項）。', h`<div class="row" style="justify-content:center"><button class="btn primary" data-act="addItem">＋ 新增品項</button><a class="btn" href="#/import">前往匯入中心</a></div>`)}</div>`);
      return;
    }
    const tabs = [['stock', '庫存水位'], ['moves', `異動紀錄（${fmt(moves.length)}）`], ['bom', '配方（BOM）']];
    mount(
      root,
      h`<div class="toolbar">
        ${f.tab === 'moves' ? h`<label class="field"><span>品項</span><select data-act="fItem">${options([['', '全部'], ...sortItems(items).map((i) => [i.id, i.name])], f.item)}</select></label>
          <label class="field"><span>類型</span><select data-act="fType">${options([['', '全部'], ...Object.entries(MOVE_TYPES)], f.mtype)}</select></label>` : h`<label class="field"><span>基準日</span><input type="date" value="${asOfDate()}" data-act="asof"></label>`}
        <span class="spacer"></span>
        <button class="btn primary" data-act="addItem">＋ 新增品項</button>
        <button class="btn" data-act="addMove">登記異動</button>
      </div>
      <div id="inv-top"></div>
      <div class="card">
        <div class="tabs" role="tablist">${tabs.map(([k, l]) => h`<button role="tab" aria-selected="${f.tab === k ? 'true' : 'false'}" class="${f.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`)}</div>
        <div id="inv-body"></div>
      </div>`,
    );
    const top = root.querySelector('#inv-top');
    const body = root.querySelector('#inv-body');
    if (f.tab === 'moves') drawMoves(body);
    else if (f.tab === 'bom') drawBom(top, body);
    else drawStock(top, body);
  }

  async function itemModal(item) {
    const isNew = !item;
    const it = item || { sku: '', name: '', category: 'beans', unit: INVENTORY_CATEGORIES.beans.unit, safety_stock: null, reorder_qty: null, std_cost: null, supplier_id: '', active: true };
    const used = !isNew && (moves.some((m) => m.item_id === it.id) || recipes.some((r) => r.item_id === it.id));
    const others = items.filter((x) => x.id !== it.id);
    const glHint = (cat) => (INVENTORY_CATEGORIES[cat] ? `入帳科目：${INVENTORY_CATEGORIES[cat].gl} ${accName.get(INVENTORY_CATEGORIES[cat].gl) || ''}` : '');
    const r = await modal({
      title: isNew ? '新增原物料品項' : `修改品項：${it.name}`,
      body: h`<div class="form-grid">
          <label class="field"><span>物品編號（留白自動編號）</span><input type="text" name="sku" value="${it.sku || ''}" placeholder="${suggestSku(it.category, others)}"></label>
          <label class="field"><span>品名</span><input type="text" name="name" value="${it.name || ''}" placeholder="例如：衣索比亞淺焙豆"></label>
          <label class="field"><span>分類</span><select name="category">${options(Object.entries(INVENTORY_CATEGORIES).map(([k, c]) => [k, c.label]), it.category)}</select><span data-gl>${glHint(it.category)}</span></label>
          <label class="field"><span>庫存單位</span><input type="text" name="unit" value="${it.unit || ''}" placeholder="g、ml、個"></label>
          <label class="field"><span>安全庫存（預警線）</span><input type="number" name="safety_stock" min="0" step="any" value="${it.safety_stock ?? ''}"></label>
          <label class="field"><span>建議叫貨量</span><input type="number" name="reorder_qty" min="0" step="any" value="${it.reorder_qty ?? ''}"></label>
          <label class="field"><span>標準成本（每單位，選填）</span><input type="number" name="std_cost" min="0" step="any" value="${it.std_cost ?? ''}"></label>
          <label class="field"><span>主要供應商（選填）</span><select name="supplier_id">${options([['', '—'], ...[...suppliers].sort(byName).map((s) => [s.id, s.name])], it.supplier_id || '')}</select></label>
        </div>
        <p class="muted" style="font-size:12.5px;margin:10px 0 0">庫存單位請與配方用量、進貨數量一致（咖啡豆用 g、鮮奶用 ml、杯蓋用個）。現有庫存低於安全庫存就會提醒叫貨；標準成本在還沒有進貨紀錄時當作平均成本。</p>
        ${used ? h`<p class="muted" style="font-size:12.5px;margin:6px 0 0">此品項已有異動或配方：變更單位不會換算既有數量，也無法刪除。</p>` : ''}`,
      actions: [
        ...(isNew || used ? [] : [{ label: '刪除品項', danger: true, value: 'delete' }]),
        { label: '取消', value: null },
        {
          label: '儲存',
          primary: true,
          value: (dlg) => {
            const g = (n) => dlg.querySelector(`[name=${n}]`).value.trim();
            const name = g('name');
            const category = g('category');
            if (!name) return fail('請輸入品名');
            const sku = g('sku') || suggestSku(category, others);
            if (others.some((x) => String(x.sku || '').toLowerCase() === sku.toLowerCase())) return fail(`物品編號 ${sku} 已被其他品項使用`);
            const vals = {};
            for (const k of ['safety_stock', 'reorder_qty', 'std_cost']) {
              vals[k] = num(g(k));
              if (vals[k] !== null && !(vals[k] >= 0)) return fail('安全庫存、叫貨量與成本需為 0 以上的數字');
            }
            const cat = INVENTORY_CATEGORIES[category];
            return { ...it, id: it.id || uid('it_'), sku, name, category, unit: g('unit') || cat.unit, gl_account: category !== it.category || !it.gl_account ? cat.gl : it.gl_account, ...vals, supplier_id: g('supplier_id') || null, active: it.active ?? true };
          },
        },
      ],
      onMount: (dlg) => {
        const cat = dlg.querySelector('[name=category]');
        const unit = dlg.querySelector('[name=unit]');
        let prev = cat.value;
        cat.addEventListener('change', () => {
          const u = unit.value.trim();
          if (!used && (!u || u === INVENTORY_CATEGORIES[prev]?.unit)) unit.value = INVENTORY_CATEGORIES[cat.value].unit;
          dlg.querySelector('[data-gl]').textContent = glHint(cat.value);
          dlg.querySelector('[name=sku]').placeholder = suggestSku(cat.value, others);
          prev = cat.value;
        });
      },
    });
    if (r === 'delete') {
      if (!(await confirmBox(`刪除品項「${it.name}」？`, { ok: '刪除', danger: true }))) return;
      await store.remove('inventory_items', it.id);
      toast('已刪除品項', 'good');
    } else if (r) {
      await store.put('inventory_items', r);
      toast(`已儲存「${r.name}」`, 'good');
    } else return;
    await reload();
  }

  async function recipeModal(p) {
    if (!p) return;
    const byId = new Map(items.map((i) => [i.id, i]));
    const costs = averageCosts(items, moves, { asOf: asOfDate() });
    const costOf = (id) => costs.get(id)?.avg || 0;
    const price = priceOf(p.id);
    const current = recipes.filter((r) => r.product_id === p.id);
    const itemOpts = [['', '— 選擇原料 —'], ...sortItems(items).map((i) => [i.id, itemLabel(i)])];
    const line = (r) => h`<tr><td><select name="item" aria-label="原料">${options(itemOpts, r.item_id)}</select></td><td><input class="cell num" type="number" name="qty" min="0" step="any" value="${r.qty ?? ''}" aria-label="每份用量"></td><td class="num" data-cost></td><td><button type="button" class="icon-btn" data-del aria-label="刪除此行">✕</button></td></tr>`;
    const collect = (dlg) => [...dlg.querySelectorAll('#bom-lines tr')].map((tr) => ({ tr, item_id: tr.querySelector('[name=item]').value, qty: num(tr.querySelector('[name=qty]').value) }));
    const refresh = (dlg) => {
      let total = 0;
      for (const r of collect(dlg)) {
        const c = r.item_id && r.qty > 0 ? r.qty * costOf(r.item_id) : null;
        if (c !== null) total += c;
        r.tr.querySelector('[data-cost]').textContent = c === null ? '' : fmtUnitCost(c);
      }
      const m = marginOf(price, total);
      dlg.querySelector('#bom-sum').textContent = `理論成本 ${fmtUnitCost(total)}／份　平均售價 ${price === null ? '—（尚無銷售）' : '$' + fmt(round2(price))}　估計毛利率 ${m === null ? '—' : pct(m)}`;
    };
    const r = await modal({
      title: `配方：${p.name}`,
      wide: true,
      body: h`<p class="muted" style="margin-top:0">每售出一份「${p.name}」用掉的原料量，以原料的庫存單位計；成本依目前的移動平均成本試算。</p>
        <div class="table-wrap"><table class="grid"><thead><tr><th style="width:55%">原料</th><th class="num">每份用量</th><th class="num">成本</th><th></th></tr></thead>
        <tbody id="bom-lines">${(current.length ? current : [{ item_id: '', qty: '' }]).map(line)}</tbody>
        <tfoot><tr><td colspan="4"><button type="button" class="btn sm" data-add>＋ 新增原料</button></td></tr></tfoot></table></div>
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
          const del = ev.target.closest('[data-del]');
          if (del) {
            del.closest('tr').remove();
            refresh(dlg);
          }
        });
      },
    });
    if (!r) return;
    const next = r.map((x) => ({ id: `${p.id}|${x.item_id}`, product_id: p.id, item_id: x.item_id, qty: x.qty }));
    const keep = new Set(next.map((x) => x.id));
    const drop = current.filter((x) => !keep.has(x.id)).map((x) => x.id);
    if (drop.length) await store.remove('recipes', drop);
    if (next.length) await store.put('recipes', next);
    toast(next.length ? `已儲存「${p.name}」的配方（${next.length} 項原料）` : `已清除「${p.name}」的配方`, 'good');
    await reload();
  }

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
    asof: setF('asOf', 'asof'),
    fItem: setF('item', 'item'),
    fType: setF('mtype', 'mtype'),
    addItem: () => itemModal(null),
    editItem: (el) => {
      const it = items.find((i) => i.id === el.dataset.id);
      if (it) return itemModal(it);
    },
    addMove: async (el) => {
      if (await editMove(null, { items, suppliers, itemId: el.dataset.id || f.item })) await reload();
    },
    editMove: async (el) => {
      const m = moves.find((x) => x.id === el.dataset.id);
      if (m && (await editMove(m, { items, suppliers }))) await reload();
    },
    delMove: async (el) => {
      const m = moves.find((x) => x.id === el.dataset.id);
      if (!m) return;
      const it = items.find((i) => i.id === m.item_id);
      if (!(await confirmBox(`刪除 ${m.date} 的${MOVE_TYPES[m.type] || ''}紀錄（${it?.name || '未知品項'} ${fmt(Number(m.qty) || 0)} ${it?.unit || ''}）？`, { ok: '刪除', danger: true }))) return;
      await store.remove('inventory_moves', m.id);
      toast('已刪除', 'good');
      await reload();
    },
    recipe: (el) => recipeModal(idx.byId.get(el.dataset.id)),
  });
  draw();
  return unbind;
}
