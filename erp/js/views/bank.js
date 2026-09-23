// 銀行存摺對帳：自動勾稽存摺與帳上「銀行存款」分錄，補登未入帳項目，產生銀行存款餘額調節表。

import { h, raw, mount, bindActions, dataTable, fmt, stat, status, toast, modal, options, emptyState } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getAccounts, isLocked } from '../state.js';
import { bookLines, autoMatch, reconciliation } from '../lib/bank.js';
import { nextVoucherNo } from '../lib/ledger.js';
import { monthEnd } from '../lib/dates.js';
import { uid } from '../lib/text.js';
import { accountSelect, latestMonth, reportHead } from './_shared.js';

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  let [bankLines, entries] = await Promise.all([store.all('bank_lines'), store.all('journal_entries')]);
  const acctIds = [...new Set(bankLines.map((b) => b.bank_account_id || 'main'))];
  const f = { acct: ctx.params.acct || acctIds[0] || 'main', asOf: ctx.params.asof || monthEnd(latestMonth(bankLines, settings.revenue_start)), gl: ctx.params.gl || settings.bank_gl || '1103' };

  async function draw() {
    const lines = bankLines.filter((b) => (b.bank_account_id || 'main') === f.acct).sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!lines.length) {
      mount(root, h`<div class="card">${emptyState('尚未匯入存摺明細', '從網路銀行下載交易明細（CSV 或 XLSX），到「匯入中心」選擇類型「銀行存摺明細」。系統會自動與帳上的銀行存款分錄勾稽。', h`<a class="btn primary" href="#/import">前往匯入</a>`)}</div>`);
      return;
    }
    const books = bookLines(entries, f.gl);
    const matches = autoMatch(lines, books);
    const rec = reconciliation({ bankLines: lines, books, matches, asOf: f.asOf });
    const bookByKey = new Map(books.map((b) => [b.key, b]));
    const head = await reportHead('銀行存款餘額調節表', `截至 ${f.asOf}｜帳戶 ${f.acct}｜會計項目 ${f.gl}`);
    const pendingAuto = lines.filter((b) => !b.match_key && matches.has(b.id)).length;
    const sum = (arr, k) => arr.reduce((t, x) => t + x[k], 0);
    mount(
      root,
      h`<div class="toolbar no-print">
        <label class="field"><span>存摺帳戶</span><select data-act="acct">${options(acctIds.map((a) => [a, a]), f.acct)}</select></label>
        <label class="field"><span>對應會計項目</span>${accountSelect(accounts.filter((a) => a.type === 'asset'), f.gl, 'data-act="gl"')}</label>
        <label class="field"><span>對帳截止日</span><input type="date" value="${f.asOf}" data-act="asof"></label>
        <span class="spacer"></span>
        ${pendingAuto ? h`<button class="btn primary" data-act="confirmAll">確認 ${pendingAuto} 筆自動勾稽</button>` : ''}
        <button class="btn" data-act="print">列印調節表</button>
      </div>
      <div class="stats">
        ${stat('存摺餘額', '$' + fmt(rec.bankBalance), `截至 ${f.asOf}`)}
        ${stat('帳面餘額', '$' + fmt(rec.bookBalance), `${f.gl} 銀行存款`)}
        ${stat('已勾稽', fmt(rec.matchedCount), `存摺 ${lines.filter((b) => b.date <= f.asOf).length} 筆`)}
        ${stat('調節後差異', fmt(rec.diff), Math.abs(rec.diff) < 0.5 ? '已平衡' : '需查明', Math.abs(rec.diff) < 0.5 ? 'good' : 'bad')}
      </div>
      <div class="card report" style="max-width:none">${head}
        <div class="grid-2">
          <table class="fin">
            <tr class="h"><td>存摺餘額</td><td class="amt">${fmt(rec.bankBalance)}</td></tr>
            <tr class="i"><td>加：在途存款（帳上已記、銀行未入）${rec.depositsInTransit.length} 筆</td><td class="amt">${fmt(sum(rec.depositsInTransit, 'debit'))}</td></tr>
            <tr class="i"><td>減：未兌現支出（帳上已記、銀行未扣）${rec.outstanding.length} 筆</td><td class="amt">(${fmt(sum(rec.outstanding, 'credit'))})</td></tr>
            <tr class="gt"><td>調整後存摺餘額</td><td class="amt">${fmt(rec.adjBank)}</td></tr>
          </table>
          <table class="fin">
            <tr class="h"><td>帳面餘額</td><td class="amt">${fmt(rec.bookBalance)}</td></tr>
            <tr class="i"><td>加：銀行已入、帳上未記 ${rec.bankOnlyIn.length} 筆</td><td class="amt">${fmt(sum(rec.bankOnlyIn, 'deposit'))}</td></tr>
            <tr class="i"><td>減：銀行已扣、帳上未記 ${rec.bankOnlyOut.length} 筆</td><td class="amt">(${fmt(sum(rec.bankOnlyOut, 'withdrawal'))})</td></tr>
            <tr class="gt"><td>調整後帳面餘額</td><td class="amt">${fmt(rec.adjBook)}</td></tr>
          </table>
        </div>
        <p style="margin-top:10px">${Math.abs(rec.diff) < 0.5 ? status('good', '調整後餘額一致') : status('bad', `差異 ${fmt(rec.diff)}：請檢查帳上金額是否誤植，或存摺期初餘額是否正確`)}</p>
      </div>
      <div class="card no-print"><div class="card-head"><h2>存摺明細</h2><span class="card-note">未勾稽的項目可「補登分錄」（例如利息、轉帳手續費、自動扣繳水電）</span></div><div id="bl"></div></div>
      ${rec.depositsInTransit.length || rec.outstanding.length ? h`<div class="card no-print"><div class="card-head"><h2>帳上有、存摺沒有</h2></div><div id="bo"></div></div>` : ''}`,
    );
    dataTable(root.querySelector('#bl'), {
      rows: lines,
      pageSize: 100,
      initialSort: { key: 'date', dir: 1 },
      columns: [
        { key: 'date', label: '日期' },
        { key: 'description', label: '摘要', fmt: (v, r) => [v, r.note, r.counterparty].filter(Boolean).join('｜') },
        { key: 'withdrawal', label: '支出', align: 'num', fmt: (v) => (v ? fmt(v) : '') },
        { key: 'deposit', label: '存入', align: 'num', fmt: (v) => (v ? fmt(v) : '') },
        { key: 'balance', label: '餘額', align: 'num', fmt: (v) => (v === null || v === undefined ? '' : fmt(v)) },
        {
          key: 'id',
          label: '勾稽',
          nosort: true,
          fmt: (v, r) => {
            const k = matches.get(v);
            if (k) {
              const b = bookByKey.get(k);
              return h`${status(r.match_key ? 'good' : 'warn', `${b?.voucher_no || ''} ${r.match_key ? '' : '（自動）'}`)} <button class="btn sm ghost" data-act="unmatch" data-id="${v}">取消</button>`;
            }
            return h`<button class="btn sm" data-act="book" data-id="${v}" ${isLocked(settings, r.date) ? raw('disabled') : ''}>補登分錄</button> <button class="btn sm ghost" data-act="pick" data-id="${v}">手動對應</button>`;
          },
        },
      ],
    });
    const bo = root.querySelector('#bo');
    if (bo)
      dataTable(bo, {
        rows: [...rec.depositsInTransit, ...rec.outstanding],
        columns: [
          { key: 'date', label: '日期' },
          { key: 'voucher_no', label: '傳票' },
          { key: 'memo', label: '摘要' },
          { key: 'debit', label: '借（存入）', align: 'num', fmt: (v) => (v ? fmt(v) : '') },
          { key: 'credit', label: '貸（支出）', align: 'num', fmt: (v) => (v ? fmt(v) : '') },
        ],
      });
    root._ctx = { lines, books, matches };
  }

  const unbind = bindActions(root, {
    acct: (el) => {
      f.acct = el.value;
      ctx.setParams({ acct: f.acct });
      draw();
    },
    gl: (el) => {
      f.gl = el.value;
      ctx.setParams({ gl: f.gl });
      draw();
    },
    asof: (el) => {
      f.asOf = el.value;
      ctx.setParams({ asof: f.asOf });
      draw();
    },
    print: () => window.print(),
    confirmAll: async () => {
      const { lines, matches } = root._ctx;
      const upd = lines.filter((b) => !b.match_key && matches.has(b.id)).map((b) => ({ ...b, match_key: matches.get(b.id) }));
      await store.put('bank_lines', upd);
      bankLines = await store.all('bank_lines');
      toast(`已確認 ${upd.length} 筆`, 'good');
      draw();
    },
    unmatch: async (el) => {
      const b = bankLines.find((x) => x.id === el.dataset.id);
      await store.put('bank_lines', { ...b, match_key: null, match_rejected: root._ctx.matches.get(b.id) || null });
      bankLines = await store.all('bank_lines');
      draw();
    },
    pick: async (el) => {
      const b = bankLines.find((x) => x.id === el.dataset.id);
      const { books, matches } = root._ctx;
      const used = new Set(matches.values());
      const cands = books.filter((k) => !used.has(k.key) && (b.deposit ? k.debit : k.credit) > 0).sort((x, y) => Math.abs((b.deposit || b.withdrawal) - (x.debit || x.credit)) - Math.abs((b.deposit || b.withdrawal) - (y.debit || y.credit))).slice(0, 40);
      const r = await modal({
        title: `手動對應：${b.date} ${b.description} ${fmt(b.deposit || b.withdrawal)}`,
        body: cands.length ? h`<select name="k" size="10" style="width:100%">${cands.map((k) => h`<option value="${k.key}">${k.date}｜${k.voucher_no}｜${k.memo}｜${fmt(k.debit || k.credit)}</option>`)}</select>` : h`<p class="muted">帳上沒有可對應的分錄，請改用「補登分錄」。</p>`,
        actions: [{ label: '取消', value: null }, ...(cands.length ? [{ label: '對應', primary: true, value: (d) => d.querySelector('[name=k]').value || false }] : [])],
      });
      if (!r) return;
      await store.put('bank_lines', { ...b, match_key: r });
      bankLines = await store.all('bank_lines');
      draw();
    },
    book: async (el) => {
      const b = bankLines.find((x) => x.id === el.dataset.id);
      const isDep = b.deposit > 0;
      const amount = b.deposit || b.withdrawal;
      const guess = isDep ? (/利息/.test(b.description) ? '7101' : /綠界|ecpay/i.test(b.description + b.note) ? '1111' : /line/i.test(b.description + b.note) ? '1112' : '2161') : /手續費|匯費/.test(b.description) ? '6131' : /電費|台電|水費|瓦斯/.test(b.description + b.note) ? '6118' : /電信|網路/.test(b.description + b.note) ? '6115' : /勞保|健保|勞退/.test(b.description + b.note) ? '6119' : '6199';
      const r = await modal({
        title: `補登分錄：${b.date} ${isDep ? '存入' : '支出'} ${fmt(amount)}`,
        body: h`<p class="muted">${b.description} ${b.note || ''}</p>
          <div class="form-grid"><label class="field"><span>${isDep ? '貸方（收入來源）' : '借方（支出用途）'}</span>${accountSelect(accounts, guess, 'name="acc"')}</label>
          <label class="field"><span>摘要</span><input type="text" name="desc" value="${b.description || '存摺補登'}"></label></div>`,
        actions: [{ label: '取消', value: null }, { label: '建立分錄並勾稽', primary: true, value: (d) => ({ acc: d.querySelector('[name=acc]').value, desc: d.querySelector('[name=desc]').value.trim() }) }],
      });
      if (!r || !r.acc) return;
      const e = {
        id: uid('je_'),
        date: b.date,
        description: r.desc,
        source: 'bank',
        source_ref: b.id,
        status: 'posted',
        voucher_no: nextVoucherNo(entries, b.date),
        lines: isDep ? [{ account: f.gl, debit: amount, credit: 0, memo: '' }, { account: r.acc, debit: 0, credit: amount, memo: '' }] : [{ account: r.acc, debit: amount, credit: 0, memo: '' }, { account: f.gl, debit: 0, credit: amount, memo: '' }],
        created_at: new Date().toISOString(),
      };
      await store.put('journal_entries', e);
      await store.put('bank_lines', { ...b, match_key: `${e.id}#${isDep ? 0 : 1}` });
      [bankLines, entries] = await Promise.all([store.all('bank_lines'), store.all('journal_entries')]);
      toast(`已建立 ${e.voucher_no}`, 'good');
      draw();
    },
  });
  await draw();
  return unbind;
}
