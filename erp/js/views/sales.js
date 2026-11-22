// 銷售明細與作廢：篩選查詢、作廢（老闆測試／招待／報廢）彙總、依日期／品項彙總。
// 事後作廢：每一筆或整張單可手動「標記作廢」（選原因）／「取消作廢」；已結帳鎖定的月份只改銷售明細，不重新產生 POS 營收傳票。

import { h, raw, mount, bindActions, dataTable, stat, fmt, options, toast, emptyState, confirmBox, modal } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getProductIndex, isLocked } from '../state.js';
import { VOID_REASONS, PAYMENT_TYPES, CATEGORIES, reapplyVoids, markVoid, clearVoid, MANUAL_VOID_CHOICES } from '../lib/pos.js';
import { round2 } from '../lib/money.js';
import { syncSales } from '../sync.js';

// 單號比對：#0878、0878、878 都算同一張（去掉符號與開頭的 0）；有指定日期時，POS 單號結尾是這幾碼也算
const normNo = (s) => String(s || '').replace(/[^0-9A-Za-z]/g, '').replace(/^0+/, '').toUpperCase();
function orderHit(line, tokens, withDate) {
  const no = String(line.order_no || '').trim();
  if (!no) return false;
  return tokens.some((t) => normNo(no) === normNo(t) || (withDate && t.replace(/^#/, '').length >= 3 && no.replace(/^#/, '').endsWith(t.replace(/^#/, ''))));
}

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
  let notice = null; // 標記作廢／取消作廢之後的說明（哪些月份鎖定、哪幾天的傳票重新產生）

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
        <button class="btn" data-act="voidOrders" title="POS 匯入時是有效的訂單，事後才作廢（例如測試單、已作廢發票）：輸入日期與單號標記作廢">依單號標記作廢</button>
        <button class="btn" data-act="reapply">重新套用作廢規則</button>
      </div>
      ${notice ? h`<div class="callout ${notice.tone}" id="void-notice" style="margin-bottom:12px"><p>${notice.text}</p></div>` : ''}
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
          { key: 'void_reason', label: '作廢原因', fmt: (v, r) => voidCell(v, r) },
          { key: 'note', label: '備註' },
          {
            key: '_act',
            label: '',
            nosort: true,
            csv: () => '',
            fmt: (v, r) => (r.void_reason ? h`<button class="btn sm ghost" data-act="unvoidLine" data-id="${r.id}" title="取消作廢，算回營收">取消作廢</button>` : h`<button class="btn sm" data-act="voidLine" data-id="${r.id}" title="事後作廢：選原因，可整張單一起">作廢</button>`),
          },
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

  // 作廢原因欄：手動標記的附上說明、誰、哪天；重新匯入改成作廢的也註明
  function voidCell(v, r) {
    const m = r.void_manual;
    const who = (x) => [x.note, x.by, String(x.at || '').slice(0, 10)].filter(Boolean).join('｜');
    if (!v) return m ? h`<span class="muted" style="font-size:12px">手動取消作廢｜${who(m)}</span>` : '';
    const sub = m ? `手動標記｜${who(m)}` : r.void_reimport ? `重新匯入：POS 狀態「${r.void_reimport.status || ''}」｜${String(r.void_reimport.at || '').slice(0, 10)}` : '';
    return h`${VOID_REASONS[v]?.label || v}${sub ? h`<div class="muted" style="font-size:12px">${sub}</div>` : ''}`;
  }

  // 標記作廢（mode='void'）／取消作廢（mode='clear'）的視窗：輸入日期、單號，列出找到的品項勾選
  function voidDialog({ mode = 'void', date = '', orders = '', ids = null } = {}) {
    const isVoid = mode === 'void';
    const find = (d, text) => {
      if (ids) return lines.filter((l) => ids.includes(l.id));
      const tokens = String(text || '').split(/[\s,，、;；]+/).map((t) => t.trim()).filter(Boolean);
      if (!tokens.length) return [];
      return lines.filter((l) => (!d || l.date === d) && orderHit(l, tokens, !!d)).sort((a, b) => (a.date + a.time + a.order_no < b.date + b.time + b.order_no ? -1 : 1));
    };
    const listHtml = (found) => {
      if (!found.length) return h`<p class="muted">${ids ? '' : '輸入日期與單號後，這裡會列出找到的品項。'}</p>`;
      const months = [...new Set(found.map((l) => l.date.slice(0, 7)))].sort();
      const lockedM = months.filter((m) => isLocked(settings, m + '-01'));
      const openDates = [...new Set(found.filter((l) => !isLocked(settings, l.date) && l.date >= settings.revenue_start).map((l) => l.date))].sort();
      return h`<div class="table-wrap" style="max-height:40vh"><table class="grid"><thead><tr><th></th><th>日期</th><th>時間</th><th>單號</th><th>品名</th><th class="num">數量</th><th class="num">金額</th><th>目前</th></tr></thead><tbody>
        ${found.map((l) => {
          const on = isVoid ? !l.void_reason : !!l.void_reason;
          return h`<tr data-id="${l.id}" class="${l.void_reason ? 'void' : ''}"><td><input type="checkbox" name="pick" ${on ? raw('checked') : ''} aria-label="選這一筆"></td><td>${l.date}</td><td>${l.time || ''}</td><td>${l.order_no || ''}</td><td>${l.item_raw}${l.option_raw ? `（${l.option_raw}）` : ''}</td><td class="num">${fmt(l.qty)}</td><td class="num">${fmt(l.amount)}</td><td>${l.void_reason ? VOID_REASONS[l.void_reason]?.label || l.void_reason : '有效'}</td></tr>`;
        })}</tbody></table></div>
        ${lockedM.length ? h`<div class="callout warn" style="margin-top:8px"><p>此月份（${lockedM.join('、')}）已結帳鎖定：只更新銷售明細與營運分析，POS 營收傳票不會重新產生（帳上已另外調整的分錄維持不動）。</p></div>` : ''}
        ${openDates.length ? h`<p class="muted" style="margin-top:8px;font-size:13px">${openDates.join('、')} 的 POS 營收傳票會依新的銷售明細重新產生（傳票號碼不變）。</p>` : ''}`;
    };
    const body = h`${
      ids
        ? ''
        : h`<div class="form-grid">
          <label class="field"><span>日期</span><input type="date" name="vd-date" value="${date}"></label>
          <label class="field"><span>單號（多張用逗號或空白分開，例如 0878、0879）</span><input type="text" name="vd-no" value="${orders}"></label>
        </div>`
    }
      ${isVoid ? h`<label class="field" style="margin-top:8px"><span>作廢原因</span><select name="vd-reason">${options(MANUAL_VOID_CHOICES, 'pos_void')}</select></label>` : ''}
      <label class="field" style="margin-top:8px"><span>說明（會記在這幾筆上）</span><input type="text" name="vd-note" placeholder="${isVoid ? '例如：公休測試單，綠界已作廢發票' : '例如：誤標，這張單有收款'}"></label>
      <div id="vd-list" style="margin-top:10px">${listHtml(find(date, orders))}</div>`;
    return modal({
      title: isVoid ? '標記作廢（POS 匯入後才作廢的訂單）' : '取消作廢',
      wide: true,
      body,
      onMount: (dlg) => {
        const refresh = () => {
          const d = dlg.querySelector('[name=vd-date]')?.value || '';
          const no = dlg.querySelector('[name=vd-no]')?.value || '';
          dlg.querySelector('#vd-list').innerHTML = String(listHtml(find(d, no)));
        };
        for (const n of ['vd-date', 'vd-no']) for (const ev of ['input', 'change']) dlg.querySelector(`[name=${n}]`)?.addEventListener(ev, refresh);
      },
      actions: [
        { label: '取消', value: null },
        {
          label: isVoid ? '標記作廢' : '取消作廢',
          primary: true,
          value: (dlg) => {
            const picked = [...dlg.querySelectorAll('#vd-list tr[data-id]')].filter((tr) => tr.querySelector('[name=pick]').checked).map((tr) => tr.dataset.id);
            if (!picked.length) return toast('沒有勾選任何一筆', 'error'), false;
            return { ids: picked, reason: dlg.querySelector('[name=vd-reason]')?.value || null, note: dlg.querySelector('[name=vd-note]').value.trim() };
          },
        },
      ],
    });
  }

  // 改完作廢狀態：未鎖定月份只重新產生那幾天的 POS 營收傳票；鎖定月份完全不碰傳票
  async function afterVoidChange(changed, verb) {
    const s = await getSettings();
    const lockedM = [...new Set(changed.map((l) => l.date.slice(0, 7)))].sort().filter((m) => isLocked(s, m + '-01'));
    const openDates = [...new Set(changed.filter((l) => !isLocked(s, l.date) && l.date >= s.revenue_start).map((l) => l.date))].sort();
    const parts = [`已${verb} ${fmt(changed.length)} 筆（原金額 ${fmt(round2(changed.reduce((t, l) => t + (Number(l.amount) || 0), 0)))}）。`];
    if (lockedM.length) parts.push(`此月份（${lockedM.join('、')}）已結帳鎖定：只更新銷售明細與營運分析，POS 營收傳票不會重新產生。`);
    if (openDates.length) {
      const r = await syncSales({ dates: openDates });
      parts.push(`已重新產生 ${openDates.join('、')} 的 POS 營收傳票（更新 ${r.updated} 張${r.removed ? `、移除 ${r.removed} 張` : ''}）。`);
    }
    if (changed.some((l) => l.date < s.revenue_start)) parts.push(`營收起算日 ${s.revenue_start} 以前的明細不計入帳務，沒有傳票。`);
    notice = { tone: lockedM.length ? 'warn' : 'good', text: parts.join('') };
    toast(notice.text, 'good', 8000);
  }

  const by = () => store.location?.email || '這台電腦';
  async function runVoid(opts) {
    const r = await voidDialog({ mode: 'void', ...opts });
    if (!r) return;
    const pick = lines.filter((l) => r.ids.includes(l.id));
    const upd = markVoid(pick, { reason: r.reason || 'pos_void', note: r.note, by: by() });
    await store.put('sales_lines', upd);
    lines = await store.all('sales_lines');
    await afterVoidChange(upd, '標記作廢');
    draw();
  }
  async function runClear(opts) {
    const r = await voidDialog({ mode: 'clear', ...opts });
    if (!r) return;
    const pick = lines.filter((l) => r.ids.includes(l.id) && l.void_reason);
    if (!pick.length) return toast('勾選的品項都不是作廢狀態', 'info');
    const upd = clearVoid(pick, { rules: settings.void_rules, note: r.note, by: by() });
    await store.put('sales_lines', upd);
    lines = await store.all('sales_lines');
    await afterVoidChange(upd, '取消作廢');
    draw();
  }
  // 從某一列開：有單號就帶出整張單（同日期同單號），沒有單號只處理這一列
  const fromRow = (id) => {
    const l = lines.find((x) => x.id === id);
    if (!l) return null;
    return l.order_no ? { date: l.date, orders: l.order_no } : { ids: [l.id] };
  };

  const unbind = bindActions(root, {
    voidOrders: () => runVoid({}),
    voidLine: (el) => {
      const o = fromRow(el.dataset.id);
      if (o) return runVoid(o);
    },
    unvoidLine: (el) => {
      const o = fromRow(el.dataset.id);
      if (o) return runClear(o);
    },
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
