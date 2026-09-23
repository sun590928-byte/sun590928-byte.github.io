// 銷售明細與作廢：篩選查詢、作廢（老闆測試／招待／報廢）彙總、依日期／品項彙總。

import { h, mount, bindActions, dataTable, stat, fmt, options, toast, emptyState, confirmBox } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getProductIndex } from '../state.js';
import { VOID_REASONS, PAYMENT_TYPES, CATEGORIES, reapplyVoids } from '../lib/pos.js';
import { round2 } from '../lib/money.js';
import { syncSales } from '../sync.js';

export async function render(root, ctx) {
  const settings = await getSettings();
  let lines = await store.all('sales_lines');
  if (!lines.length) {
    mount(root, h`<div class="card">${emptyState('沒有銷售明細', '先匯入 POS 銷售明細。', h`<a class="btn primary" href="#/import">前往匯入</a>`)}</div>`);
    return;
  }
  const idx = await getProductIndex();
  const maxDate = lines.reduce((m, l) => (l.date > m ? l.date : m), '');
  const f = {
    from: ctx.params.from || settings.revenue_start,
    to: ctx.params.to || maxDate,
    q: ctx.params.q || '',
    pay: ctx.params.pay || '',
    void: ctx.params.void || '',
    view: ctx.params.view || 'lines',
  };

  function filtered() {
    const q = f.q.trim().toLowerCase();
    return lines.filter((l) => {
      if (f.from && l.date < f.from) return false;
      if (f.to && l.date > f.to) return false;
      if (f.pay && l.payment !== f.pay) return false;
      if (f.void === '1' && !l.void_reason) return false;
      if (f.void === '0' && l.void_reason) return false;
      if (f.void && f.void.length > 1 && l.void_reason !== f.void) return false;
      if (q && !`${l.item_raw} ${idx.of(l).name} ${l.option_raw} ${l.note} ${l.order_no} ${l.member}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function draw() {
    const rows = filtered();
    const live = rows.filter((l) => !l.void_reason);
    const voids = rows.filter((l) => l.void_reason);
    const beforeStart = f.from < settings.revenue_start;
    mount(
      root,
      h`<div class="toolbar">
        <label class="field"><span>起</span><input type="date" value="${f.from}" data-act="f" data-k="from"></label>
        <label class="field"><span>迄</span><input type="date" value="${f.to}" data-act="f" data-k="to"></label>
        <label class="field"><span>付款</span><select data-act="f" data-k="pay">${options([['', '全部'], ...Object.entries(PAYMENT_TYPES)], f.pay)}</select></label>
        <label class="field"><span>作廢</span><select data-act="f" data-k="void">${options([['', '全部'], ['0', '只看有效'], ['1', '只看作廢'], ...Object.entries(VOID_REASONS).map(([k, v]) => [k, v.label])], f.void)}</select></label>
        <label class="field"><span>搜尋（品名、選項、備註、單號、會員）</span><input type="search" value="${f.q}" data-act="f" data-k="q" data-on="change"></label>
        <span class="spacer"></span>
        <button class="btn" data-act="reapply">重新套用作廢規則</button>
      </div>
      ${beforeStart ? h`<div class="callout warn" style="margin-bottom:12px"><p>查詢期間包含營收起算日 ${settings.revenue_start} 以前的資料，這些資料不計入帳務營收。</p></div>` : ''}
      <div class="stats">
        ${stat('有效營收', '$' + fmt(round2(live.reduce((t, l) => t + l.revenue, 0))), `${fmt(live.length)} 筆明細`)}
        ${stat('數量', fmt(live.filter((l) => !l.is_adjustment).reduce((t, l) => t + l.qty, 0)), '份（不含作廢）')}
        ${stat('作廢原價值', '$' + fmt(voids.reduce((t, l) => t + l.amount, 0)), `${fmt(voids.length)} 筆・${fmt(voids.reduce((t, l) => t + l.qty, 0))} 份`)}
        ${stat('折扣', '$' + fmt(live.reduce((t, l) => t + (l.discount || 0) + (l.amount < 0 ? -l.amount : 0), 0)), '含整單折扣列')}
      </div>
      <div class="card">
        <div class="tabs">${[
          ['lines', '明細'],
          ['voids', '作廢彙總'],
          ['byday', '依日期'],
          ['byproduct', '依品項'],
        ].map(([k, l]) => h`<button class="${f.view === k ? 'on' : ''}" data-act="view" data-v="${k}">${l}</button>`)}</div>
        <div id="tbl"></div>
      </div>`,
    );
    const el = root.querySelector('#tbl');
    if (f.view === 'lines') {
      dataTable(el, {
        rows,
        pageSize: 100,
        exportName: `銷售明細_${f.from}_${f.to}.csv`,
        rowClass: (r) => (r.void_reason ? 'void' : r.date < settings.revenue_start ? 'muted' : ''),
        columns: [
          { key: 'date', label: '日期' },
          { key: 'time', label: '時間' },
          { key: 'order_no', label: '單號' },
          { key: 'item_raw', label: 'POS 品名' },
          { key: 'std', label: '標準品項', sort: (r) => idx.of(r).name, fmt: (v, r) => (idx.of(r).mapped ? idx.of(r).name : '') },
          { key: 'option_raw', label: '選項' },
          { key: 'qty', label: '數量', align: 'num' },
          { key: 'amount', label: '金額', align: 'num', fmt: (v) => fmt(v) },
          { key: 'revenue', label: '計入營收', align: 'num', fmt: (v) => fmt(v) },
          { key: 'payment', label: '付款', fmt: (v, r) => r.payment_raw || PAYMENT_TYPES[v] },
          { key: 'void_reason', label: '作廢原因', fmt: (v) => (v ? VOID_REASONS[v].label : '') },
          { key: 'note', label: '備註' },
        ],
      });
    } else if (f.view === 'voids') {
      const map = new Map();
      for (const l of voids) {
        const p = idx.of(l);
        const k = `${l.void_reason}|${p.id}`;
        const x = map.get(k) || { reason: l.void_reason, name: p.name, qty: 0, amount: 0, count: 0, dates: new Set() };
        x.qty += l.qty;
        x.amount += l.amount;
        x.count++;
        x.dates.add(l.date);
        map.set(k, x);
      }
      dataTable(el, {
        rows: [...map.values()].map((x) => ({ ...x, days: x.dates.size })),
        exportName: '作廢彙總.csv',
        empty: '此期間沒有作廢品項',
        initialSort: { key: 'amount', dir: -1 },
        columns: [
          { key: 'reason', label: '原因', fmt: (v) => VOID_REASONS[v].label },
          { key: 'name', label: '品項' },
          { key: 'count', label: '筆數', align: 'num' },
          { key: 'qty', label: '份數', align: 'num' },
          { key: 'days', label: '天數', align: 'num' },
          { key: 'amount', label: '原價值（已作廢）', align: 'num', fmt: (v) => fmt(v) },
        ],
      });
    } else if (f.view === 'byday') {
      const map = new Map();
      for (const l of rows) {
        const x = map.get(l.date) || { date: l.date, revenue: 0, orders: new Set(), qty: 0, voidAmt: 0, card: 0, cash: 0, other: 0 };
        if (l.void_reason) x.voidAmt += l.amount;
        else {
          x.revenue += l.revenue;
          x.orders.add(l.order_no || l.time);
          if (!l.is_adjustment) x.qty += l.qty;
          if (l.payment === 'cash') x.cash += l.revenue;
          else if (l.payment === 'card') x.card += l.revenue;
          else x.other += l.revenue;
        }
        map.set(l.date, x);
      }
      dataTable(el, {
        rows: [...map.values()].map((x) => ({ ...x, orders: x.orders.size, avg: x.orders.size ? x.revenue / x.orders.size : 0 })),
        exportName: '每日營收.csv',
        initialSort: { key: 'date', dir: 1 },
        columns: [
          { key: 'date', label: '日期' },
          { key: 'revenue', label: '營收', align: 'num', fmt: (v) => fmt(v) },
          { key: 'orders', label: '單數', align: 'num' },
          { key: 'avg', label: '客單價', align: 'num', fmt: (v) => fmt(Math.round(v)) },
          { key: 'qty', label: '份數', align: 'num' },
          { key: 'cash', label: '現金', align: 'num', fmt: (v) => fmt(v) },
          { key: 'card', label: '刷卡', align: 'num', fmt: (v) => fmt(v) },
          { key: 'other', label: '其他支付', align: 'num', fmt: (v) => fmt(v) },
          { key: 'voidAmt', label: '作廢', align: 'num', fmt: (v) => fmt(v) },
        ],
      });
    } else {
      const map = new Map();
      for (const l of rows) {
        if (l.is_adjustment) continue;
        const p = idx.of(l);
        const x = map.get(p.id) || { name: p.name, category: p.category, qty: 0, revenue: 0, voidQty: 0, mapped: p.mapped };
        if (l.void_reason) x.voidQty += l.qty;
        else {
          x.qty += l.qty;
          x.revenue += l.revenue;
        }
        map.set(p.id, x);
      }
      const total = [...map.values()].reduce((t, x) => t + x.revenue, 0) || 1;
      dataTable(el, {
        rows: [...map.values()].map((x) => ({ ...x, share: x.revenue / total, avg: x.qty ? x.revenue / x.qty : 0 })),
        exportName: '品項銷售.csv',
        initialSort: { key: 'revenue', dir: -1 },
        columns: [
          { key: 'name', label: '品項', fmt: (v, r) => (r.mapped ? v : h`${v} <span class="badge low">未整併</span>`) },
          { key: 'category', label: '品類', fmt: (v) => CATEGORIES[v] || v },
          { key: 'qty', label: '份數', align: 'num' },
          { key: 'revenue', label: '營收', align: 'num', fmt: (v) => fmt(v) },
          { key: 'share', label: '占比', align: 'num', fmt: (v) => (v * 100).toFixed(1) + '%' },
          { key: 'avg', label: '平均單價', align: 'num', fmt: (v) => fmt(Math.round(v)) },
          { key: 'voidQty', label: '作廢份數', align: 'num', fmt: (v) => (v ? fmt(v) : '') },
        ],
      });
    }
  }

  const unbind = bindActions(root, {
    f: (el) => {
      f[el.dataset.k] = el.value;
      ctx.setParams({ [el.dataset.k]: el.value });
      draw();
    },
    view: (el) => {
      f.view = el.dataset.v;
      ctx.setParams({ view: f.view });
      draw();
    },
    reapply: async () => {
      if (!(await confirmBox('依「設定」頁目前的作廢關鍵字，重新判斷全部銷售明細？'))) return;
      const all = await store.all('sales_lines');
      const copy = all.map((l) => ({ ...l }));
      const changed = reapplyVoids(copy, settings.void_rules);
      const diff = copy.filter((l, i) => l.void_reason !== all[i].void_reason);
      if (diff.length) await store.put('sales_lines', diff);
      lines = await store.all('sales_lines');
      await syncSales();
      toast(`已重新套用，${changed} 筆狀態改變`, 'good');
      draw();
    },
  });
  draw();
  return unbind;
}
