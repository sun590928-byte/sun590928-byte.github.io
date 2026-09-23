// 金流對帳：POS 刷卡 ↔ 綠界刷卡明細（逐日、逐筆）↔ 撥款明細 ↔ 存摺入帳；LINE Pay 等行動支付撥款登錄。

import { h, mount, bindActions, dataTable, stat, fmt, pct, options, toast, modal, status, emptyState, confirmBox } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getAccounts } from '../state.js';
import { dailyCardRecon, matchCardOrders, payoutRecon, matchPayoutsToBank, inTransit } from '../lib/payments.js';
import { accountBalance } from '../lib/ledger.js';
import { PROVIDERS } from '../lib/autojournal.js';
import { round2 } from '../lib/money.js';
import { fnv1a } from '../lib/text.js';
import { today } from '../lib/dates.js';
import { syncPayouts } from '../sync.js';

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  let [lines, txs, payouts, bankLines, entries] = await Promise.all([store.all('sales_lines'), store.all('payment_tx'), store.all('payouts'), store.all('bank_lines'), store.all('journal_entries')]);
  const maxDate = [...lines.map((l) => l.date), ...txs.map((t) => t.date)].reduce((m, d) => (d > m ? d : m), settings.revenue_start);
  const f = { from: ctx.params.from || settings.revenue_start, to: ctx.params.to || maxDate, tab: ctx.params.tab || 'daily' };

  function draw() {
    const L = lines.filter((l) => l.date >= f.from && l.date <= f.to);
    const T = txs.filter((t) => t.date >= f.from && t.date <= f.to);
    const P = payouts.filter((p) => p.payout_date >= f.from && p.payout_date <= f.to);
    const daily = dailyCardRecon(L, T);
    const posCard = round2(daily.reduce((t, d) => t + d.pos, 0));
    const ecTotal = round2(daily.reduce((t, d) => t + d.ecpay, 0));
    const fees = round2(daily.reduce((t, d) => t + d.fee, 0));
    const diffDays = daily.filter((d) => Math.abs(d.diff) >= 1);
    const transit = inTransit(lines.filter((l) => l.date >= settings.revenue_start), payouts.filter((p) => p.payout_date >= settings.revenue_start), { asOf: f.to });
    const ledger1111 = accountBalance(entries, accounts, '1111', { to: f.to });
    const posLinePay = round2(L.filter((l) => l.payment === 'linepay' && !l.void_reason).reduce((t, l) => t + l.amount, 0));
    mount(
      root,
      h`<div class="toolbar">
        <label class="field"><span>起</span><input type="date" value="${f.from}" data-act="f" data-k="from"></label>
        <label class="field"><span>迄</span><input type="date" value="${f.to}" data-act="f" data-k="to"></label>
        <span class="spacer"></span>
        <button class="btn" data-act="addPayout">＋ 登錄撥款（LINE Pay 等）</button>
        <a class="btn ghost" href="#/import">匯入綠界檔案</a>
      </div>
      ${!txs.length ? h`<div class="callout warn" style="margin-bottom:14px"><p>尚未匯入「綠界刷卡明細」。請到匯入中心拖入 <b>綠界刷卡明細-*.csv</b> 與 <b>綠界刷卡撥款明細-*.csv</b>；行動支付撥款明細（JPG）可在「憑證歸檔」以 AI 辨識，或按右上「登錄撥款」手動輸入。</p></div>` : ''}
      <div class="stats">
        ${stat('POS 刷卡營收', '$' + fmt(posCard), `${daily.filter((d) => d.pos).length} 天`)}
        ${stat('綠界成功交易', '$' + fmt(ecTotal), `差異 ${fmt(round2(ecTotal - posCard))}`, Math.abs(ecTotal - posCard) >= 1 ? 'bad' : 'good')}
        ${stat('金流手續費', '$' + fmt(fees), ecTotal ? `費率 ${pct(fees / ecTotal, 2)}` : '')}
        ${stat('刷卡在途款（未撥款）', '$' + fmt(transit.pending), `帳上 1111 餘額 ${fmt(ledger1111)}`)}
        ${stat('POS LINE Pay 營收', '$' + fmt(posLinePay), `撥款 ${fmt(round2(P.filter((p) => p.provider === 'linepay').reduce((t, p) => t + p.gross, 0)))}`)}
      </div>
      <div class="card">
        <div class="tabs">${[
          ['daily', `每日刷卡核對${diffDays.length ? `（${diffDays.length} 天有差異）` : ''}`],
          ['orders', '逐筆比對'],
          ['payout', '撥款核對'],
          ['bank', '撥款 ↔ 存摺'],
          ['list', `撥款紀錄（${P.length}）`],
        ].map(([k, l]) => h`<button class="${f.tab === k ? 'on' : ''}" data-act="tab" data-t="${k}">${l}</button>`)}</div>
        <div id="body"></div>
      </div>`,
    );
    const body = root.querySelector('#body');
    if (f.tab === 'daily') {
      dataTable(body, {
        rows: daily,
        exportName: `每日刷卡核對_${f.from}_${f.to}.csv`,
        initialSort: { key: 'date', dir: 1 },
        empty: '此期間沒有刷卡資料',
        columns: [
          { key: 'date', label: '日期' },
          { key: 'pos', label: 'POS 刷卡', align: 'num', fmt: (v) => fmt(v) },
          { key: 'posOrders', label: 'POS 單數', align: 'num' },
          { key: 'ecpay', label: '綠界交易', align: 'num', fmt: (v) => fmt(v) },
          { key: 'ecpayCount', label: '綠界筆數', align: 'num' },
          { key: 'failed', label: '失敗/退款', align: 'num', fmt: (v) => (v ? fmt(v) : '') },
          { key: 'fee', label: '手續費', align: 'num', fmt: (v) => fmt(v) },
          { key: 'diff', label: '差異', align: 'num', fmt: (v) => (Math.abs(v) < 1 ? status('good', '0') : status('bad', fmt(v))) },
        ],
      });
    } else if (f.tab === 'orders') {
      const m = matchCardOrders(L.filter((l) => !l.void_reason), T);
      mount(body, h`<p class="muted">以訂單編號（POS 單號 = 綠界廠商訂單編號時）或「同日同金額」配對。已配對 ${fmt(m.matches.length)} 筆。</p><div class="grid-2"><div><h3 style="font-size:14px;margin-bottom:6px">綠界有、POS 沒有（${m.unmatchedTx.length}）</h3><div id="ut"></div></div><div><h3 style="font-size:14px;margin-bottom:6px">POS 刷卡、綠界沒有（${m.unmatchedPos.length}）</h3><div id="up"></div></div></div>`);
      dataTable(body.querySelector('#ut'), { rows: m.unmatchedTx, pageSize: 50, empty: '全部配對', columns: [{ key: 'date', label: '日期' }, { key: 'time', label: '時間' }, { key: 'order_no', label: '訂單' }, { key: 'amount', label: '金額', align: 'num', fmt: (v) => fmt(v) }] });
      dataTable(body.querySelector('#up'), { rows: m.unmatchedPos, pageSize: 50, empty: '全部配對', columns: [{ key: 'date', label: '日期' }, { key: 'time', label: '時間' }, { key: 'order_no', label: '單號' }, { key: 'amount', label: '金額', align: 'num', fmt: (v) => fmt(v) }] });
    } else if (f.tab === 'payout') {
      const rows = payoutRecon(txs, P).map((r) => ({ ...r.payout, expectedNet: r.expectedNet, expectedCount: r.expectedCount, diff: r.diff }));
      dataTable(body, {
        rows,
        empty: '沒有綠界撥款資料',
        exportName: '撥款核對.csv',
        columns: [
          { key: 'payout_date', label: '撥款日' },
          { key: 'gross', label: '交易總額', align: 'num', fmt: (v) => fmt(v) },
          { key: 'fee', label: '手續費', align: 'num', fmt: (v) => fmt(v) },
          { key: 'net', label: '撥款金額', align: 'num', fmt: (v) => fmt(v) },
          { key: 'expectedNet', label: '明細推算應撥', align: 'num', fmt: (v) => (v === null ? '—' : fmt(v)) },
          { key: 'expectedCount', label: '交易筆數', align: 'num' },
          { key: 'diff', label: '差異', align: 'num', fmt: (v) => (v === null ? status('na', '明細無此撥款日') : Math.abs(v) < 1 ? status('good', '0') : status('bad', fmt(v))) },
        ],
      });
    } else if (f.tab === 'bank') {
      const rows = matchPayoutsToBank(P, bankLines).map((r) => ({ ...r.payout, bankDate: r.bank?.date || '', bankDesc: r.bank?.description || '', found: !!r.bank }));
      mount(body, h`${!bankLines.length ? h`<div class="callout warn" style="margin-bottom:10px"><p>尚未匯入銀行存摺明細，無法核對入帳。</p></div>` : ''}<div id="pb"></div>`);
      dataTable(body.querySelector('#pb'), {
        rows,
        empty: '沒有撥款資料',
        columns: [
          { key: 'payout_date', label: '撥款日' },
          { key: 'provider', label: '金流', fmt: (v) => PROVIDERS[v] || v },
          { key: 'net', label: '撥款金額', align: 'num', fmt: (v) => fmt(v) },
          { key: 'bankDate', label: '存摺入帳日' },
          { key: 'bankDesc', label: '存摺摘要' },
          { key: 'found', label: '狀態', fmt: (v) => (v ? status('good', '已入帳') : status('warn', '存摺找不到')) },
        ],
      });
    } else {
      dataTable(body, {
        rows: P,
        empty: '沒有撥款紀錄',
        initialSort: { key: 'payout_date', dir: -1 },
        columns: [
          { key: 'payout_date', label: '撥款日' },
          { key: 'provider', label: '金流', fmt: (v) => PROVIDERS[v] || v },
          { key: 'period_from', label: '交易期間', fmt: (v, r) => (v ? `${v} ～ ${r.period_to || ''}` : '') },
          { key: 'gross', label: '交易總額', align: 'num', fmt: (v) => fmt(v) },
          { key: 'fee', label: '手續費', align: 'num', fmt: (v) => fmt(v) },
          { key: 'net', label: '撥款金額', align: 'num', fmt: (v) => fmt(v) },
          { key: 'ref', label: '編號／備註', fmt: (v, r) => [v, r.note].filter(Boolean).join('｜') },
          { key: 'id', label: '', nosort: true, fmt: (v) => h`<button class="btn sm danger" data-act="delPayout" data-id="${v}">刪除</button>` },
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
    tab: (el) => {
      f.tab = el.dataset.t;
      ctx.setParams({ tab: f.tab });
      draw();
    },
    addPayout: async () => {
      const r = await modal({
        title: '登錄撥款',
        body: h`<div class="form-grid">
          <label class="field"><span>金流</span><select name="provider">${options(Object.entries(PROVIDERS), 'linepay')}</select></label>
          <label class="field"><span>撥款日</span><input type="date" name="payout_date" value="${today()}"></label>
          <label class="field"><span>交易總額</span><input type="number" name="gross" step="1"></label>
          <label class="field"><span>手續費</span><input type="number" name="fee" step="1"></label>
          <label class="field"><span>撥款金額（實際入帳）</span><input type="number" name="net" step="1"></label>
          <label class="field"><span>交易期間起</span><input type="date" name="period_from"></label>
          <label class="field"><span>交易期間迄</span><input type="date" name="period_to"></label>
          <label class="field"><span>撥款編號／備註</span><input type="text" name="ref"></label>
        </div><p class="muted" style="font-size:12.5px">交易總額或撥款金額擇一即可，另一個由手續費推算。</p>`,
        actions: [
          { label: '取消', value: null },
          {
            label: '儲存',
            primary: true,
            value: (d) => {
              const g = (n) => d.querySelector(`[name=${n}]`).value;
              const fee = Math.abs(Number(g('fee')) || 0);
              let gross = Number(g('gross')) || 0;
              let net = Number(g('net')) || 0;
              if (!g('payout_date') || (!gross && !net)) {
                toast('請填撥款日與金額', 'error');
                return false;
              }
              if (!net) net = round2(gross - fee);
              if (!gross) gross = round2(net + fee);
              const provider = g('provider');
              const ref = g('ref').trim();
              return { id: 'po_' + fnv1a([provider, g('payout_date'), ref, gross, net, fee].join('|')), provider, payout_date: g('payout_date'), gross, fee, net, period_from: g('period_from') || null, period_to: g('period_to') || null, ref, note: '手動登錄' };
            },
          },
        ],
      });
      if (!r) return;
      await store.put('payouts', r);
      payouts = await store.all('payouts');
      await syncPayouts();
      entries = await store.all('journal_entries');
      toast('已登錄並產生撥款入帳分錄', 'good');
      draw();
    },
    delPayout: async (el) => {
      if (!(await confirmBox('刪除這筆撥款紀錄？對應的入帳分錄也會移除。', { danger: true, ok: '刪除' }))) return;
      await store.remove('payouts', el.dataset.id);
      payouts = await store.all('payouts');
      await syncPayouts();
      entries = await store.all('journal_entries');
      draw();
    },
  });
  if (!lines.length && !txs.length && !payouts.length) {
    mount(root, h`<div class="card">${emptyState('還沒有金流資料', '匯入 POS 銷售明細與綠界刷卡明細、撥款明細後，這裡會逐日核對刷卡金額、手續費與撥款入帳。', h`<a class="btn primary" href="#/import">前往匯入</a>`)}</div>`);
    return unbind;
  }
  draw();
  return unbind;
}
