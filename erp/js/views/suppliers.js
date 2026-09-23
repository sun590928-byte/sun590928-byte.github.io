// 採購與供應商（Supplier_Costs）：供應商的採購次數與金額、交貨天數（穩定度）、良率評分，以及各原料每批採購單價的波動，協助控制進貨成本。

import { h, mount, bindActions, dataTable, modal, confirmBox, toast, stat, options, fmt, pct, emptyState } from '../ui.js';
import { store } from '../store.js';
import { supplierStats, priceHistory } from '../lib/inventory.js';
import { lineChart } from '../charts.js';
import { uid } from '../lib/text.js';
import { daysBetween } from '../lib/dates.js';
import { round2 } from '../lib/money.js';
import { editMove, fmtUnitCost, sortItems } from './inventory.js';

const fail = (msg) => {
  toast(msg, 'error');
  return false;
};
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v));
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const oneDec = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? fmt(v) : v.toFixed(1));
const change = (x) => (x === null || x === undefined ? '—' : x > 0 ? `▲ ${pct(x)}` : x < 0 ? `▼ ${pct(-x)}` : '持平');
const changeTone = (x) => (x > 0 ? 'bad' : x < 0 ? 'good' : '');

export async function render(root, ctx) {
  const colls = ['suppliers', 'inventory_items', 'inventory_moves'];
  let [suppliers, items, moves] = await Promise.all(colls.map((c) => store.all(c)));
  const f = { item: ctx.params.item || '' };

  async function reload() {
    [suppliers, items, moves] = await Promise.all(colls.map((c) => store.all(c)));
    draw();
  }

  function draw() {
    const purchases = moves.filter((m) => m.type === 'purchase');
    const supById = new Map(suppliers.map((s) => [s.id, s]));
    const supName = (id) => supById.get(id)?.name || '未指定供應商';
    const importNote = h`<div class="callout" style="margin-bottom:16px"><p>採購紀錄也可以到 <a href="#/import">匯入中心</a> 選擇類型「進貨／採購紀錄」批次匯入（到貨日、訂購日、供應商、品項、數量、單價或金額、良率評分），尚未建立的供應商與原物料品項會自動新增。</p></div>`;
    if (!suppliers.length && !purchases.length) {
      mount(
        root,
        h`${importNote}<div class="card">${emptyState('還沒有供應商與採購紀錄', '新增供應商後，每次進貨記下訂購日、到貨日、金額與良率，就能比較各供應商的交貨穩定度，並追蹤原料單價波動、控制進貨成本。', h`<div class="row" style="justify-content:center"><button class="btn primary" data-act="addSup">＋ 新增供應商</button><button class="btn" data-act="addPurchase">＋ 新增採購</button></div>`)}</div>`,
      );
      return;
    }
    const noSup = purchases.filter((m) => !supById.has(m.supplier_id)).length;
    const leads = purchases.filter((m) => m.order_date && m.date).map((m) => daysBetween(m.order_date, m.date));
    const yields = purchases.map((m) => num(m.yield_score)).filter((y) => Number.isFinite(y) && y > 0);

    // 單價追蹤：只列有進貨的原料，預設採購次數最多者
    const buys = new Map();
    for (const m of purchases) if (Number(m.qty) > 0) buys.set(m.item_id, (buys.get(m.item_id) || 0) + 1);
    const tracked = sortItems(items.filter((i) => buys.has(i.id)));
    const sel = tracked.some((i) => i.id === f.item) ? f.item : [...tracked].sort((a, b) => buys.get(b.id) - buys.get(a.id))[0]?.id || '';
    const item = items.find((i) => i.id === sel);
    const unit = item?.unit || '單位';
    const hist = sel ? priceHistory(moves, sel) : { points: [], stats: null };
    const s = hist.stats;
    const pts = hist.points;
    const at = (v) => pts.find((p) => p.unitCost === v);
    const where = (p) => (p ? `${p.date}・${supName(p.supplier_id)}` : '');

    mount(
      root,
      h`<div class="toolbar">
        <button class="btn primary" data-act="addPurchase">＋ 新增採購</button>
        <button class="btn" data-act="addSup">＋ 新增供應商</button>
        <span class="spacer"></span>
        <a class="btn ghost" href="#/inventory?tab=moves&amp;mtype=purchase">所有採購明細</a>
      </div>
      ${importNote}
      <div class="stats">
        ${stat('供應商', fmt(suppliers.length), noSup ? `${fmt(noSup)} 筆採購未指定供應商` : '')}
        ${stat('採購總額', '$' + fmt(round2(purchases.reduce((t, m) => t + (Number(m.amount) || 0), 0))), `${fmt(purchases.length)} 筆進貨`)}
        ${stat('平均交貨天數', oneDec(avg(leads)), leads.length ? `最長 ${fmt(Math.max(...leads))} 天・${fmt(leads.length)} 筆有訂購日` : '進貨時填訂購日即可計算')}
        ${stat('平均良率', oneDec(avg(yields)), yields.length ? `${fmt(yields.length)} 筆有評分（0–100）` : '進貨時可填 0–100 評分')}
      </div>
      <div class="card">
        <div class="card-head"><h2>供應商表現</h2><span class="card-note">交貨天數＝訂購日到到貨日；良率為每批進貨的品質評分（100＝全數可用）</span></div>
        <div id="sup-table"></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>採購單價追蹤</h2><span class="card-note">單價＝金額 ÷ 數量，依到貨日排列；上漲以 ▲ 表示</span></div>
        ${
          tracked.length
            ? h`<div class="toolbar" style="margin-bottom:12px">
                <label class="field"><span>原料</span><select data-act="item">${options(tracked.map((i) => [i.id, `${i.name}（${buys.get(i.id)} 筆）`]), sel)}</select></label>
                <span class="spacer"></span>
                <button class="btn sm" data-act="addPurchase" data-id="${sel}">＋ 新增這項原料的採購</button>
              </div>
              <div class="stats">
                ${stat('最新單價', fmtUnitCost(s.latest), `每 ${unit}・${where(pts[pts.length - 1])}`)}
                ${stat('較上次', change(s.changeVsPrev), pts.length > 1 ? `上次 ${fmtUnitCost(pts[pts.length - 2].unitCost)}（${pts[pts.length - 2].date}）` : '只有一筆進貨', changeTone(s.changeVsPrev))}
                ${stat('較首次', change(s.changeVsFirst), `首次 ${fmtUnitCost(pts[0].unitCost)}（${pts[0].date}）`, changeTone(s.changeVsFirst))}
                ${stat('平均', fmtUnitCost(s.avg), `${fmt(pts.length)} 筆進貨`)}
                ${stat('最低', fmtUnitCost(s.min), where(at(s.min)))}
                ${stat('最高', fmtUnitCost(s.max), where(at(s.max)))}
              </div>
              <div id="price-chart"></div>
              <div id="price-table" style="margin-top:14px"></div>`
            : emptyState('還沒有採購紀錄', '按「新增採購」登記進貨，或到匯入中心匯入「進貨／採購紀錄」，就能看到各原料每批單價的變化。')
        }
      </div>`,
    );

    dataTable(root.querySelector('#sup-table'), {
      rows: supplierStats(suppliers, items, moves).map((x) => ({ id: x.supplier.id, name: x.supplier.name || '', sub: [x.supplier.contact, x.supplier.phone, x.supplier.terms].filter(Boolean).join('・'), count: x.count, total: x.total, items: x.items.join('、'), avgLead: x.avgLead, maxLead: x.maxLead, avgYield: x.avgYield, last: x.last || '' })),
      empty: '還沒有供應商，按「新增供應商」建立',
      exportName: '供應商表現.csv',
      initialSort: { key: 'total', dir: -1 },
      columns: [
        { key: 'name', label: '供應商', fmt: (v, r) => h`<b>${v}</b>${r.sub ? h`<div class="muted" style="font-size:12px">${r.sub}</div>` : ''}`, csv: (v) => v },
        { key: 'count', label: '採購次數', align: 'num', fmt: (v) => fmt(v) },
        { key: 'total', label: '採購總額', align: 'num', fmt: (v) => '$' + fmt(v) },
        { key: 'items', label: '品項' },
        { key: 'avgLead', label: '平均交貨天數', align: 'num', fmt: (v) => oneDec(v) },
        { key: 'maxLead', label: '最長交貨天數', align: 'num', fmt: (v) => oneDec(v) },
        { key: 'avgYield', label: '平均良率', align: 'num', fmt: (v) => oneDec(v) },
        { key: 'last', label: '最後採購', fmt: (v) => v || '—' },
        { key: 'id', label: '', nosort: true, fmt: (v, r) => h`<span style="white-space:nowrap"><button class="btn sm" data-act="editSup" data-id="${v}">修改</button>${r.count ? '' : h` <button class="btn sm danger" data-act="delSup" data-id="${v}">刪除</button>`}</span>`, csv: () => '' },
      ],
    });

    if (!pts.length) return;
    lineChart(root.querySelector('#price-chart'), { points: pts.map((p) => ({ label: p.date, value: p.unitCost, sub: `${supName(p.supplier_id)}・${fmt(p.qty)} ${unit}` })), format: fmtUnitCost, ariaLabel: `${item.name} 每${unit}採購單價走勢` });
    dataTable(root.querySelector('#price-table'), {
      rows: purchases
        .filter((m) => m.item_id === sel && Number(m.qty) > 0)
        .map((m) => {
          const qty = Number(m.qty);
          const unitCost = (Number(m.amount) || 0) / qty;
          return { id: m.id, date: m.date, supplier: supName(m.supplier_id), qty, unitCost, diff: s.avg ? (unitCost - s.avg) / s.avg : null, amount: Number(m.amount) || 0, lead: m.order_date ? daysBetween(m.order_date, m.date) : null, yield_score: num(m.yield_score), invoice_no: m.invoice_no || '', note: m.note || '' };
        }),
      exportName: `採購單價_${item.name}.csv`,
      initialSort: { key: 'date', dir: -1 },
      columns: [
        { key: 'date', label: '到貨日' },
        { key: 'supplier', label: '供應商' },
        { key: 'qty', label: `數量（${unit}）`, align: 'num', fmt: (v) => fmt(v) },
        { key: 'unitCost', label: '單價', align: 'num', fmt: (v) => fmtUnitCost(v) },
        { key: 'diff', label: '與平均差', align: 'num', fmt: (v) => (v === null ? '—' : `${v > 0 ? '+' : ''}${pct(v)}`) },
        { key: 'amount', label: '金額', align: 'num', fmt: (v) => '$' + fmt(v) },
        { key: 'lead', label: '交貨天數', align: 'num', fmt: (v) => oneDec(v) },
        { key: 'yield_score', label: '良率', align: 'num', fmt: (v) => oneDec(v) },
        { key: 'invoice_no', label: '發票號碼' },
        { key: 'note', label: '備註' },
        { key: 'id', label: '', nosort: true, fmt: (v) => h`<span style="white-space:nowrap"><button class="btn sm" data-act="editPurchase" data-id="${v}">修改</button> <button class="btn sm danger" data-act="delPurchase" data-id="${v}">刪除</button></span>`, csv: () => '' },
      ],
    });
  }

  async function editSupplier(sup) {
    const x = sup || { name: '', tax_id: '', contact: '', phone: '', terms: '', note: '' };
    const r = await modal({
      title: sup ? `修改供應商：${x.name}` : '新增供應商',
      body: h`<div class="form-grid">
          <label class="field"><span>供應商名稱</span><input type="text" name="name" value="${x.name || ''}" placeholder="例如：○○咖啡生豆行"></label>
          <label class="field"><span>統一編號（選填）</span><input type="text" name="tax_id" value="${x.tax_id || ''}" inputmode="numeric" maxlength="8"></label>
          <label class="field"><span>聯絡人</span><input type="text" name="contact" value="${x.contact || ''}"></label>
          <label class="field"><span>電話</span><input type="text" name="phone" value="${x.phone || ''}" inputmode="tel"></label>
          <label class="field"><span>付款條件</span><input type="text" name="terms" value="${x.terms || ''}" placeholder="例如：月結 30 天、貨到付款"></label>
          <label class="field" style="grid-column:1/-1"><span>備註</span><input type="text" name="note" value="${x.note || ''}" placeholder="例如：每週二、五配送；最低訂購量 5 kg"></label>
        </div>`,
      actions: [
        { label: '取消', value: null },
        {
          label: '儲存',
          primary: true,
          value: (dlg) => {
            const g = (n) => dlg.querySelector(`[name=${n}]`).value.trim();
            const name = g('name');
            const taxId = g('tax_id').normalize('NFKC');
            if (!name) return fail('請輸入供應商名稱');
            if (suppliers.some((o) => o.id !== x.id && String(o.name || '').trim() === name)) return fail('已有同名的供應商');
            if (taxId && !/^\d{8}$/.test(taxId)) return fail('統一編號應為 8 位數字');
            return { ...x, id: x.id || uid('sp_'), name, tax_id: taxId, contact: g('contact'), phone: g('phone'), terms: g('terms'), note: g('note') };
          },
        },
      ],
    });
    if (!r) return;
    await store.put('suppliers', r);
    toast(`已儲存「${r.name}」`, 'good');
    await reload();
  }

  const unbind = bindActions(root, {
    item: (el) => {
      f.item = el.value;
      ctx.setParams({ item: el.value });
      draw();
    },
    addSup: () => editSupplier(null),
    editSup: (el) => {
      const sup = suppliers.find((x) => x.id === el.dataset.id);
      if (sup) return editSupplier(sup);
    },
    delSup: async (el) => {
      const sup = suppliers.find((x) => x.id === el.dataset.id);
      if (!sup) return;
      if (moves.some((m) => m.supplier_id === sup.id)) return toast('這個供應商已有採購紀錄，無法刪除', 'error');
      if (!(await confirmBox(`刪除供應商「${sup.name}」？`, { ok: '刪除', danger: true }))) return;
      await store.remove('suppliers', sup.id);
      toast('已刪除供應商', 'good');
      await reload();
    },
    addPurchase: async (el) => {
      const m = await editMove(null, { items, suppliers, type: 'purchase', itemId: el.dataset.id || f.item });
      if (!m) return;
      f.item = m.item_id;
      ctx.setParams({ item: m.item_id });
      await reload();
    },
    editPurchase: async (el) => {
      const m = moves.find((x) => x.id === el.dataset.id);
      if (m && (await editMove(m, { items, suppliers, type: 'purchase' }))) await reload();
    },
    delPurchase: async (el) => {
      const m = moves.find((x) => x.id === el.dataset.id);
      if (!m) return;
      if (!(await confirmBox(`刪除 ${m.date} 的採購紀錄（${items.find((i) => i.id === m.item_id)?.name || '未知品項'}，$${fmt(Number(m.amount) || 0)}）？`, { ok: '刪除', danger: true }))) return;
      await store.remove('inventory_moves', m.id);
      toast('已刪除採購紀錄', 'good');
      await reload();
    },
  });
  draw();
  return unbind;
}
