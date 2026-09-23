// 資產負債表（截至某日）：資產＝負債＋權益，本年度損益併入權益。

import { h, mount, bindActions, fmt, status, downloadCSV } from '../ui.js';
import { store } from '../store.js';
import { getAccounts, getSettings } from '../state.js';
import { balanceSheet } from '../lib/ledger.js';
import { monthEnd } from '../lib/dates.js';
import { latestMonth, reportHead, downloadWorkbook } from './_shared.js';
import { balanceSheetRows } from '../lib/reportbook.js';

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  const entries = await store.all('journal_entries');
  let asOf = ctx.params.asof || monthEnd(latestMonth(entries, settings.revenue_start));

  async function draw() {
    const bs = balanceSheet(entries, accounts, { asOf });
    const roc = `民國 ${Number(asOf.slice(0, 4)) - 1911} 年 ${Number(asOf.slice(5, 7))} 月 ${Number(asOf.slice(8))} 日`;
    const head = await reportHead('資 產 負 債 表', roc);
    const pctOf = (v) => (bs.totalAssets ? ((v / bs.totalAssets) * 100).toFixed(1) + '%' : '');
    const items = (rows) => rows.map((r) => h`<tr class="i"><td>${r.code.replace('*', '')} ${r.name}</td><td class="amt">${fmt(r.amount)}</td><td class="pct">${pctOf(r.amount)}</td></tr>`);
    mount(
      root,
      h`<div class="toolbar no-print">
        <label class="field"><span>截至日期</span><input type="date" value="${asOf}" data-act="asof"></label>
        <span class="spacer"></span>
        ${bs.balanced ? status('good', '資產＝負債＋權益') : status('bad', `不平衡，差額 ${fmt(bs.diff)}`)}
        <button class="btn" data-act="print">列印</button><button class="btn" data-act="xlsx">匯出 Excel</button><button class="btn ghost" data-act="export">匯出 CSV</button>
      </div>
      <div class="card report">${head}
        <table class="fin">
          <tr class="h"><td>資產</td><td class="amt"></td><td class="pct">%</td></tr>
          <tr class="h"><td>流動資產</td><td></td><td></td></tr>${items(bs.assetsCurrent)}
          <tr class="t"><td>流動資產合計</td><td class="amt">${fmt(bs.totalAssetsCurrent)}</td><td class="pct">${pctOf(bs.totalAssetsCurrent)}</td></tr>
          <tr class="h"><td>非流動資產</td><td></td><td></td></tr>${items(bs.assetsNon)}
          <tr class="t"><td>非流動資產合計</td><td class="amt">${fmt(bs.totalAssetsNon)}</td><td class="pct">${pctOf(bs.totalAssetsNon)}</td></tr>
          <tr class="gt"><td>資產總計</td><td class="amt">${fmt(bs.totalAssets)}</td><td class="pct">100.0%</td></tr>
          <tr class="h"><td>負債</td><td></td><td></td></tr>
          <tr class="h"><td>流動負債</td><td></td><td></td></tr>${items(bs.liabCurrent)}
          <tr class="t"><td>流動負債合計</td><td class="amt">${fmt(bs.totalLiabCurrent)}</td><td class="pct">${pctOf(bs.totalLiabCurrent)}</td></tr>
          ${bs.liabNon.length ? h`<tr class="h"><td>非流動負債</td><td></td><td></td></tr>${items(bs.liabNon)}<tr class="t"><td>非流動負債合計</td><td class="amt">${fmt(bs.totalLiabNon)}</td><td class="pct">${pctOf(bs.totalLiabNon)}</td></tr>` : ''}
          <tr class="t"><td>負債總計</td><td class="amt">${fmt(bs.totalLiab)}</td><td class="pct">${pctOf(bs.totalLiab)}</td></tr>
          <tr class="h"><td>權益</td><td></td><td></td></tr>${items(bs.equity)}
          <tr class="t"><td>權益總計</td><td class="amt">${fmt(bs.totalEquity)}</td><td class="pct">${pctOf(bs.totalEquity)}</td></tr>
          <tr class="gt"><td>負債及權益總計</td><td class="amt">${fmt(bs.totalLiab + bs.totalEquity)}</td><td class="pct">${pctOf(bs.totalLiab + bs.totalEquity)}</td></tr>
        </table>
        <p class="muted" style="font-size:12.5px;margin-top:10px">「本期損益」為本年度 1 月 1 日至截止日之綜合損益，尚未做年底結帳分錄前由系統即時計算。</p>
      </div>`,
    );
    root._bs = bs;
  }

  const unbind = bindActions(root, {
    asof: (el) => {
      if (!el.value) return;
      asOf = el.value;
      ctx.setParams({ asof: asOf });
      draw();
    },
    print: () => window.print(),
    xlsx: () => downloadWorkbook(`資產負債表_${asOf}.xlsx`, (meta) => balanceSheetRows(entries, accounts, { asOf }, { ...meta, period: `民國 ${Number(asOf.slice(0, 4)) - 1911} 年 ${Number(asOf.slice(5, 7))} 月 ${Number(asOf.slice(8))} 日` })),
    export: () => {
      const bs = root._bs;
      const rows = [['區塊', '代號', '項目', '金額']];
      const push = (sec, list) => list.forEach((r) => rows.push([sec, r.code.replace('*', ''), r.name, r.amount]));
      push('流動資產', bs.assetsCurrent);
      push('非流動資產', bs.assetsNon);
      rows.push(['', '', '資產總計', bs.totalAssets]);
      push('流動負債', bs.liabCurrent);
      push('非流動負債', bs.liabNon);
      rows.push(['', '', '負債總計', bs.totalLiab]);
      push('權益', bs.equity);
      rows.push(['', '', '權益總計', bs.totalEquity]);
      downloadCSV(`資產負債表_${asOf}.csv`, rows);
    },
  });
  await draw();
  return unbind;
}
