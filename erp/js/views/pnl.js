// 營運損益（P&L_Statement）：每月總營收、固定／變動成本、營業毛利與淨利、健康度指標、損益兩平。

import { h, mount, bindActions, fmt, pct, stat, status, emptyState, downloadCSV } from '../ui.js';
import { store } from '../store.js';
import { getAccounts, getSettings, revenueLines } from '../state.js';
import { monthlyPnl, BENCHMARKS, rate } from '../lib/pnl.js';
import { eachMonth, monthEnd, daysBetween } from '../lib/dates.js';
import { columnChart } from '../charts.js';

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  const entries = await store.all('journal_entries');
  const sales = await revenueLines();
  if (!entries.length) {
    mount(root, h`<div class="card">${emptyState('還沒有帳務資料', '匯入 POS 銷售明細後會自動產生營收分錄；再記錄租金、薪資、進貨等支出（憑證歸檔或日記簿），這裡就會算出每月淨利與健康度。', h`<a class="btn primary" href="#/import">前往匯入</a>`)}</div>`);
    return;
  }
  const last = [...entries.map((e) => e.date), ...sales.map((l) => l.date)].reduce((m, d) => (d > m ? d : m), settings.revenue_start);
  const months = eachMonth(settings.revenue_start.slice(0, 7), last.slice(0, 7));
  const data = monthlyPnl(entries, accounts, months).map((m) => {
    const ms = sales.filter((l) => l.date.startsWith(m.ym) && !l.void_reason);
    const openDays = new Set(ms.map((l) => l.date)).size;
    const cups = ms.filter((l) => !l.is_adjustment).reduce((t, l) => t + l.qty, 0);
    const posRevenue = ms.reduce((t, l) => t + l.revenue, 0);
    const avgPrice = cups ? m.revenue / cups : 0;
    return { ...m, openDays, cups, posRevenue, beDaily: m.breakEven && openDays ? m.breakEven / openDays : null, beCups: m.breakEven && avgPrice ? m.breakEven / avgPrice : null, partial: m.ym === months[0] && settings.revenue_start.slice(8) !== '01' };
  });
  const cur = data[data.length - 1];

  function draw() {
    const noCogs = data.some((m) => m.revenue && !m.cogs);
    const row = (label, key, opts = {}) =>
      h`<tr class="${opts.cls || ''}"><td>${label}</td>${data.map((m) => {
        const v = typeof key === 'function' ? key(m) : m[key];
        return h`<td class="num">${v === null || v === undefined ? '—' : opts.pct ? pct(v) : fmt(Math.round(v))}</td>`;
      })}</tr>`;
    const ratioRow = (k) =>
      h`<tr><td>${BENCHMARKS[k].label}<div class="muted" style="font-size:11.5px">${BENCHMARKS[k].hint}</div></td>${data.map((m) => {
        const v = m.ratios[k];
        const r = rate(k, v);
        return h`<td class="num">${v === null ? '—' : status(r === 'good' ? 'good' : r === 'warn' ? 'warn' : r === 'bad' ? 'bad' : 'na', pct(v))}</td>`;
      })}</tr>`;
    mount(
      root,
      h`<div class="stats">
        ${stat(`${Number(cur.ym.slice(5))} 月營業收入（未稅）`, '$' + fmt(Math.round(cur.revenue)), `POS 含稅 ${fmt(Math.round(cur.posRevenue))}`, 'hero')}
        ${stat('營業毛利', '$' + fmt(Math.round(cur.grossProfit)), cur.ratios.grossMargin === null ? '' : `毛利率 ${pct(cur.ratios.grossMargin)}`)}
        ${stat('營業淨利', '$' + fmt(Math.round(cur.operatingIncome)), cur.ratios.operatingMargin === null ? '' : `淨利率 ${pct(cur.ratios.operatingMargin)}`, cur.operatingIncome >= 0 ? 'good' : 'bad')}
        ${stat('損益兩平營收', cur.breakEven ? '$' + fmt(Math.round(cur.breakEven)) : '—', cur.beDaily ? `每營業日需 ${fmt(Math.round(cur.beDaily))}（約 ${fmt(Math.ceil(cur.beCups / Math.max(1, cur.openDays)))} 份）` : '需有固定成本資料')}
      </div>
      ${noCogs ? h`<div class="callout warn" style="margin-bottom:14px"><p>有月份尚未產生「存貨與成本」分錄，營業成本為 0，毛利率會偏高。月底盤點後到 <a href="#/cost">存貨與成本</a> 產生成本分錄。</p></div>` : ''}
      ${data[0]?.partial ? h`<div class="callout" style="margin-bottom:14px"><p>${Number(data[0].ym.slice(5))} 月只從 ${settings.revenue_start} 起計算，並非完整月份。</p></div>` : ''}
      <div class="card">
        <div class="card-head"><h2>每月營運損益</h2><span class="spacer"></span><button class="btn sm ghost" data-act="export">匯出 CSV</button></div>
        <div class="table-wrap"><table class="grid">
          <thead><tr><th>項目</th>${data.map((m) => h`<th class="num">${Number(m.ym.slice(0, 4)) - 1911}/${m.ym.slice(5)}</th>`)}</tr></thead>
          <tbody>
            ${row('總營收（營業收入淨額）', 'revenue', { cls: 'total' })}
            ${row('營業成本（原物料、包材、報廢）', 'cogs')}
            ${row('營業毛利', 'grossProfit', { cls: 'total' })}
            ${row('固定成本（租金、折舊、正職薪資、保險、訂閱…）', 'fixed')}
            ${row('變動費用（水電、計時人事、手續費、招待試作…）', 'variableOpex')}
            ${row('營業淨利', 'operatingIncome', { cls: 'total' })}
            ${row('營業外收支', 'nonop')}
            ${row('本期淨利', 'netIncome', { cls: 'total' })}
            <tr class="section"><td colspan="${data.length + 1}">重點成本</td></tr>
            ${row('人事成本（薪資＋勞健保＋伙食福利）', 'labor')}
            ${row('租金', 'rent')}
            ${row('折舊攤提', 'depreciation')}
            ${row('水電瓦斯', 'utilities')}
            ${row('金流手續費／平台抽成', 'fees')}
            ${row('招待與試作成本', 'treats')}
            ${row('報廢損失', 'scrap')}
            <tr class="section"><td colspan="${data.length + 1}">財務健康度</td></tr>
            ${['grossMargin', 'foodCost', 'labor', 'prime', 'rent', 'operatingMargin'].map(ratioRow)}
            ${row('損益兩平營收', 'breakEven')}
            ${row('營業天數', 'openDays')}
            ${row('每日損益兩平營收', 'beDaily')}
          </tbody>
        </table></div>
        <p class="muted" style="font-size:12.5px;margin-top:8px">固定／變動依「會計項目」的成本性質歸類；損益兩平營收＝固定成本 ÷（1－變動成本率）。參考區間為一般咖啡館經驗值，僅供對照。</p>
      </div>
      <div class="card"><div class="card-head"><h2>每月營業收入</h2><span class="card-note">未稅，來自帳務分錄</span></div><div id="c-rev"></div></div>`,
    );
    columnChart(root.querySelector('#c-rev'), { data: data.map((m) => ({ key: m.ym, label: m.ym, short: `${Number(m.ym.slice(5))}月`, values: { rev: m.revenue } })), series: [{ key: 'rev', label: '營業收入', color: 'var(--series-1)' }], height: 200, ariaLabel: '每月營業收入' });
  }

  const unbind = bindActions(root, {
    export: () => {
      const keys = [['總營收', 'revenue'], ['營業成本', 'cogs'], ['營業毛利', 'grossProfit'], ['固定成本', 'fixed'], ['變動費用', 'variableOpex'], ['營業淨利', 'operatingIncome'], ['本期淨利', 'netIncome'], ['人事成本', 'labor'], ['租金', 'rent'], ['損益兩平營收', 'breakEven']];
      downloadCSV('營運損益.csv', [['項目', ...data.map((m) => m.ym)], ...keys.map(([l, k]) => [l, ...data.map((m) => Math.round(m[k] || 0))]), ...Object.keys(BENCHMARKS).map((k) => [BENCHMARKS[k].label, ...data.map((m) => (m.ratios[k] === null ? '' : (m.ratios[k] * 100).toFixed(1) + '%'))])]);
    },
  });
  draw();
  return unbind;
}

export { monthEnd, daysBetween };
