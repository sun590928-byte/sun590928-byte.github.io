// 試算表：期初、本期發生額、期末餘額（借貸兩欄），並檢查借貸平衡。

import { h, mount, bindActions, fmt, status, downloadCSV } from '../ui.js';
import { store } from '../store.js';
import { getAccounts, getSettings } from '../state.js';
import { trialBalance } from '../lib/ledger.js';
import { TYPE_LABELS } from '../lib/coa.js';
import { periodFields, periodState, periodHandlers, resolvePeriod, latestMonth, reportHead } from './_shared.js';

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  const entries = await store.all('journal_entries');
  const p = periodState(ctx.params, latestMonth(entries, settings.revenue_start));

  async function draw() {
    const { from, to, label } = resolvePeriod(p);
    const tb = trialBalance(entries, accounts, { from, to });
    const head = await reportHead('試 算 表', label);
    const m = (v) => (v ? fmt(v) : '');
    let lastType = null;
    mount(
      root,
      h`<div class="toolbar no-print">${periodFields(p)}<span class="spacer"></span>${tb.balanced ? status('good', '借貸平衡') : status('bad', '借貸不平衡，請檢查分錄')}<button class="btn" data-act="print">列印</button><button class="btn ghost" data-act="export">匯出 CSV</button></div>
      <div class="card report" style="max-width:none">${head}
        <div class="table-wrap"><table class="grid">
          <thead>
            <tr><th rowspan="2">代號</th><th rowspan="2">會計項目</th><th colspan="2" style="text-align:center">期初餘額</th><th colspan="2" style="text-align:center">本期發生額</th><th colspan="2" style="text-align:center">期末餘額</th></tr>
            <tr><th class="num">借方</th><th class="num">貸方</th><th class="num">借方</th><th class="num">貸方</th><th class="num">借方</th><th class="num">貸方</th></tr>
          </thead>
          <tbody>${tb.rows.map((r) => {
            const sec = r.type !== lastType ? h`<tr class="section"><td colspan="8">${TYPE_LABELS[r.type] || r.type}</td></tr>` : '';
            lastType = r.type;
            return h`${sec}<tr><td>${r.code}</td><td>${r.name}</td><td class="num">${m(r.openDr)}</td><td class="num">${m(r.openCr)}</td><td class="num">${m(r.periodDr)}</td><td class="num">${m(r.periodCr)}</td><td class="num">${m(r.closeDr)}</td><td class="num">${m(r.closeCr)}</td></tr>`;
          })}</tbody>
          <tfoot><tr><td></td><td>合計</td><td class="num">${fmt(tb.totals.openDr)}</td><td class="num">${fmt(tb.totals.openCr)}</td><td class="num">${fmt(tb.totals.periodDr)}</td><td class="num">${fmt(tb.totals.periodCr)}</td><td class="num">${fmt(tb.totals.closeDr)}</td><td class="num">${fmt(tb.totals.closeCr)}</td></tr></tfoot>
        </table></div>
      </div>`,
    );
    root._tb = tb;
  }

  const unbind = bindActions(root, {
    ...periodHandlers(p, ctx, draw),
    print: () => window.print(),
    export: () => {
      const tb = root._tb;
      downloadCSV(`試算表_${resolvePeriod(p).to}.csv`, [['代號', '會計項目', '期初借方', '期初貸方', '本期借方', '本期貸方', '期末借方', '期末貸方'], ...tb.rows.map((r) => [r.code, r.name, r.openDr, r.openCr, r.periodDr, r.periodCr, r.closeDr, r.closeCr]), ['', '合計', tb.totals.openDr, tb.totals.openCr, tb.totals.periodDr, tb.totals.periodCr, tb.totals.closeDr, tb.totals.closeCr]]);
    },
  });
  await draw();
  return unbind;
}
