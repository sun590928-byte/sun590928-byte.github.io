// 綜合損益表：營業收入 → 營業成本 → 營業毛利 → 營業費用 → 營業淨利 → 營業外 → 稅前 → 本期淨利 → 綜合損益。

import { h, mount, bindActions, fmt, downloadCSV } from '../ui.js';
import { store } from '../store.js';
import { getAccounts, getSettings } from '../state.js';
import { incomeStatement } from '../lib/ledger.js';
import { periodFields, periodState, periodHandlers, resolvePeriod, latestMonth, reportHead } from './_shared.js';

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  const entries = await store.all('journal_entries');
  const p = periodState(ctx.params, latestMonth(entries, settings.revenue_start));

  async function draw() {
    const { from, to, label } = resolvePeriod(p);
    const is = incomeStatement(entries, accounts, { from, to });
    const head = await reportHead('綜 合 損 益 表', label);
    const base = is.netRevenue || 1;
    const pc = (v) => {
      if (!is.netRevenue) return '';
      const p = Math.round((v / base) * 1000) / 10;
      return (Object.is(p, -0) || p === 0 ? 0 : p).toFixed(1) + '%';
    };
    const items = (rows) => rows.map((r) => h`<tr class="i"><td>${r.code} ${r.name}</td><td class="amt">${fmt(r.amount)}</td><td class="pct">${pc(r.amount)}</td></tr>`);
    const neg = (rows) => rows.map((r) => h`<tr class="i"><td>減：${r.name}</td><td class="amt">(${fmt(r.amount)})</td><td class="pct">${pc(-r.amount)}</td></tr>`);
    mount(
      root,
      h`<div class="toolbar no-print">${periodFields(p)}<span class="spacer"></span><button class="btn" data-act="print">列印</button><button class="btn ghost" data-act="export">匯出 CSV</button></div>
      <div class="card report">${head}
        <table class="fin">
          <tr class="h"><td>營業收入</td><td class="amt"></td><td class="pct">%</td></tr>
          ${items(is.revenue)}${neg(is.contra)}
          <tr class="t"><td>營業收入淨額</td><td class="amt">${fmt(is.netRevenue)}</td><td class="pct">100.0%</td></tr>
          <tr class="h"><td>營業成本</td><td></td><td></td></tr>${items(is.cogs)}
          <tr class="t"><td>營業成本合計</td><td class="amt">${fmt(is.cogsTotal)}</td><td class="pct">${pc(is.cogsTotal)}</td></tr>
          <tr class="t"><td>營業毛利</td><td class="amt">${fmt(is.grossProfit)}</td><td class="pct">${pc(is.grossProfit)}</td></tr>
          <tr class="h"><td>營業費用</td><td></td><td></td></tr>${items(is.opex)}
          <tr class="t"><td>營業費用合計</td><td class="amt">${fmt(is.opexTotal)}</td><td class="pct">${pc(is.opexTotal)}</td></tr>
          <tr class="t"><td>營業淨利（淨損）</td><td class="amt">${fmt(is.operatingIncome)}</td><td class="pct">${pc(is.operatingIncome)}</td></tr>
          ${is.nonopIncome.length || is.nonopExpense.length ? h`<tr class="h"><td>營業外收入及支出</td><td></td><td></td></tr>${items(is.nonopIncome)}${neg(is.nonopExpense)}` : ''}
          <tr class="t"><td>稅前淨利（淨損）</td><td class="amt">${fmt(is.pretax)}</td><td class="pct">${pc(is.pretax)}</td></tr>
          ${is.tax.length ? neg(is.tax) : ''}
          <tr class="t"><td>本期淨利（淨損）</td><td class="amt">${fmt(is.netIncome)}</td><td class="pct">${pc(is.netIncome)}</td></tr>
          <tr class="i"><td>其他綜合損益</td><td class="amt">${fmt(is.oci)}</td><td class="pct"></td></tr>
          <tr class="gt"><td>本期綜合損益總額</td><td class="amt">${fmt(is.comprehensiveIncome)}</td><td class="pct">${pc(is.comprehensiveIncome)}</td></tr>
        </table>
        <p class="muted" style="font-size:12.5px;margin-top:10px">營業收入依設定之營業稅類型${settings.vat_mode === 'general' ? '以未稅金額（含稅 ÷ 1.05）入帳' : '以含稅金額入帳'}；老闆測試、老闆招待、報廢之品項不計收入。</p>
      </div>`,
    );
    root._is = is;
  }

  const unbind = bindActions(root, {
    ...periodHandlers(p, ctx, draw),
    print: () => window.print(),
    export: () => {
      const is = root._is;
      const rows = [['項目', '金額']];
      const push = (list) => list.forEach((r) => rows.push([`${r.code} ${r.name}`, r.amount]));
      push(is.revenue);
      is.contra.forEach((r) => rows.push([`減：${r.name}`, -r.amount]));
      rows.push(['營業收入淨額', is.netRevenue]);
      push(is.cogs);
      rows.push(['營業毛利', is.grossProfit]);
      push(is.opex);
      rows.push(['營業淨利', is.operatingIncome]);
      push(is.nonopIncome);
      is.nonopExpense.forEach((r) => rows.push([`減：${r.name}`, -r.amount]));
      rows.push(['稅前淨利', is.pretax], ['本期淨利', is.netIncome], ['本期綜合損益總額', is.comprehensiveIncome]);
      downloadCSV(`綜合損益表_${resolvePeriod(p).from}_${resolvePeriod(p).to}.csv`, rows);
    },
  });
  await draw();
  return unbind;
}
