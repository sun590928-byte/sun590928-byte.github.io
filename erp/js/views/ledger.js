// 分類帳：選擇科目與期間，顯示期初餘額、逐筆明細與累計餘額。

import { h, mount, bindActions, fmt, downloadCSV } from '../ui.js';
import { store } from '../store.js';
import { getAccounts, getSettings } from '../state.js';
import { generalLedger } from '../lib/ledger.js';
import { TYPE_LABELS } from '../lib/coa.js';
import { periodFields, periodState, periodHandlers, resolvePeriod, latestMonth, accountSelect, reportHead, SOURCE_LABEL, downloadWorkbook } from './_shared.js';
import { ledgerSheet } from '../lib/reportbook.js';

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  const entries = await store.all('journal_entries');
  const p = periodState(ctx.params, latestMonth(entries, settings.revenue_start));
  const f = { acc: ctx.params.acc || '' };

  async function draw() {
    const { from, to, label } = resolvePeriod(p);
    const gl = generalLedger(entries, accounts, { from, to, codes: f.acc ? [f.acc] : null });
    const head = await reportHead('分 類 帳', label);
    mount(
      root,
      h`<div class="toolbar no-print">
        ${periodFields(p)}
        <label class="field"><span>會計項目</span>${accountSelect(accounts, f.acc, 'data-act="acc"')}</label>
        <span class="spacer"></span>
        <button class="btn" data-act="print">列印</button>
        <button class="btn" data-act="xlsx">匯出 Excel</button>
        <button class="btn ghost" data-act="export">匯出 CSV</button>
      </div>
      <div class="card">${head}
        ${
          gl.size
            ? [...gl.values()].map(
                (g) => h`<div style="margin-bottom:22px;break-inside:avoid">
            <div class="row" style="margin-bottom:6px"><h3 style="font-size:15px">${g.account.code} ${g.account.name}</h3><span class="badge">${TYPE_LABELS[g.account.type] || ''}・正常餘額在${g.account.side === 'credit' ? '貸' : '借'}方</span></div>
            <div class="table-wrap"><table class="grid">
              <thead><tr><th>日期</th><th>傳票號碼</th><th>摘要</th><th class="num">借方</th><th class="num">貸方</th><th class="num">餘額</th></tr></thead>
              <tbody>
                <tr class="muted"><td></td><td></td><td>期初餘額</td><td></td><td></td><td class="num">${fmt(g.opening)}</td></tr>
                ${g.rows.map((r) => h`<tr><td>${r.date}</td><td>${r.voucher_no}</td><td>${r.memo}${r.entry.source && r.entry.source !== 'manual' ? h` <span class="muted" style="font-size:12px">（${SOURCE_LABEL[r.entry.source] || r.entry.source}）</span>` : ''}</td><td class="num">${r.debit ? fmt(r.debit) : ''}</td><td class="num">${r.credit ? fmt(r.credit) : ''}</td><td class="num">${fmt(r.balance)}</td></tr>`)}
              </tbody>
              <tfoot><tr><td></td><td></td><td>本期合計／期末餘額</td><td class="num">${fmt(g.debit)}</td><td class="num">${fmt(g.credit)}</td><td class="num">${fmt(g.closing)}</td></tr></tfoot>
            </table></div></div>`,
              )
            : h`<p class="muted">此期間沒有交易。</p>`
        }
      </div>`,
    );
    root._gl = gl;
  }

  const unbind = bindActions(root, {
    ...periodHandlers(p, ctx, draw),
    acc: (el) => {
      f.acc = el.value;
      ctx.setParams({ acc: f.acc });
      draw();
    },
    print: () => window.print(),
    xlsx: () => {
      const per = resolvePeriod(p);
      const list = f.acc ? entries.filter((e) => (e.lines || []).some((l) => l.account === f.acc)) : entries;
      downloadWorkbook(`分類帳_${per.from}_${per.to}.xlsx`, (meta) => ledgerSheet(f.acc ? list.map((e) => ({ ...e, lines: e.lines.filter((l) => l.account === f.acc) })) : list, accounts, per, { ...meta, period: per.label }));
    },
    export: () => {
      const rows = [['科目代號', '科目名稱', '日期', '傳票號碼', '摘要', '借方', '貸方', '餘額']];
      for (const g of root._gl.values()) {
        rows.push([g.account.code, g.account.name, '', '', '期初餘額', '', '', g.opening]);
        for (const r of g.rows) rows.push([g.account.code, g.account.name, r.date, r.voucher_no, r.memo, r.debit || '', r.credit || '', r.balance]);
      }
      downloadCSV(`分類帳_${resolvePeriod(p).from}_${resolvePeriod(p).to}.csv`, rows);
    },
  });
  await draw();
  return unbind;
}
