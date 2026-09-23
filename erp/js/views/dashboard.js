// 營運儀表板：營收（8/21 起）、客單價、杯數、品類與付款結構、時段熱度、熱銷品項、作廢／招待。

import { h, mount, bindActions, stat, fmt, pct, emptyState, options, status } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getProductIndex, revenueLines } from '../state.js';
import { columnChart, barList, heatmap } from '../charts.js';
import { CATEGORIES, PAYMENT_TYPES, VOID_REASONS } from '../lib/pos.js';
import { eachDay, addDays, weekdayIndex, WEEKDAYS, today, daysBetween } from '../lib/dates.js';
import { round2 } from '../lib/money.js';

const CAT_ORDER = ['coffee', 'non_coffee', 'food', 'retail', 'other'];
const CAT_COLOR = { coffee: 'var(--series-1)', non_coffee: 'var(--series-2)', food: 'var(--series-3)', retail: 'var(--series-4)', other: 'var(--series-5)' };

export async function render(root, ctx) {
  const settings = await getSettings();
  const all = await store.all('sales_lines');
  if (!all.length) {
    mount(root, h`<div class="card">${emptyState('歡迎使用午月營運帳務系統', '第一步：到「匯入中心」拖入 POS 銷售明細 CSV。系統會自動辨識欄位、把老闆測試／招待／報廢的金額作廢，並從 ' + settings.revenue_start + ' 起計算營收。', h`<a class="btn primary" href="#/import">前往匯入</a>`)}</div>`);
    return;
  }
  const maxDate = all.reduce((m, l) => (l.date > m ? l.date : m), '');
  const state = { range: ctx.params.range || 'all' };
  const idx = await getProductIndex();

  async function draw() {
    const to = maxDate;
    const from = state.range === 'all' ? settings.revenue_start : addDays(to, -Number(state.range) + 1);
    const lines = await revenueLines({ from, to });
    const live = lines.filter((l) => !l.void_reason);
    const products = live.filter((l) => !l.is_adjustment && l.qty > 0);
    const revenue = round2(live.reduce((t, l) => t + l.revenue, 0));
    const orders = new Set(live.map((l) => l.order_no || `${l.date} ${l.time}`));
    const days = eachDay(from < settings.revenue_start ? settings.revenue_start : from, to);
    const openDays = new Set(live.map((l) => l.date)).size;
    const cups = products.filter((l) => ['coffee', 'non_coffee'].includes(idx.of(l).category)).reduce((t, l) => t + l.qty, 0);
    const voids = lines.filter((l) => l.void_reason);
    const voidByReason = {};
    for (const l of voids) {
      const r = (voidByReason[l.void_reason] ||= { qty: 0, amount: 0, count: 0 });
      r.qty += l.qty;
      r.amount += l.amount;
      r.count++;
    }
    // 前期比較（同長度）
    const span = days.length;
    const prevTo = addDays(days[0], -1);
    const prevFrom = addDays(prevTo, -span + 1);
    const prevLines = prevFrom >= settings.revenue_start ? (await revenueLines({ from: prevFrom, to: prevTo })).filter((l) => !l.void_reason) : [];
    const prevRevenue = prevLines.reduce((t, l) => t + l.revenue, 0);
    const delta = prevRevenue ? (revenue - prevRevenue) / prevRevenue : null;

    // 每日 × 品類
    const byDay = new Map(days.map((d) => [d, {}]));
    for (const l of live) {
      const d = byDay.get(l.date);
      if (!d) continue;
      const cat = l.is_adjustment ? 'other' : idx.of(l).category === 'prepaid' ? 'other' : idx.of(l).category;
      d[cat] = (d[cat] || 0) + l.revenue;
    }
    // 熱銷
    const prodMap = new Map();
    for (const l of products) {
      const p = idx.of(l);
      const x = prodMap.get(p.id) || { name: p.name, qty: 0, revenue: 0, mapped: p.mapped };
      x.qty += l.qty;
      x.revenue += l.revenue;
      prodMap.set(p.id, x);
    }
    const top = [...prodMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 12);
    // 品類、付款
    const catTotals = {};
    for (const l of live) {
      if (l.is_adjustment || l.amount < 0) continue; // 整單折扣另計，不列入品類占比
      const c = idx.of(l).category === 'prepaid' ? 'other' : idx.of(l).category;
      catTotals[c] = (catTotals[c] || 0) + l.revenue;
    }
    const payTotals = {};
    for (const l of live) payTotals[l.payment] = (payTotals[l.payment] || 0) + l.revenue;
    // 時段熱度
    const hours = [];
    for (let hh = 8; hh <= 21; hh++) hours.push(String(hh).padStart(2, '0'));
    const heat = WEEKDAYS.map(() => hours.map(() => 0));
    let hasTime = false;
    for (const l of live) {
      if (!l.time) continue;
      hasTime = true;
      const hi = hours.indexOf(l.time.slice(0, 2));
      if (hi >= 0) heat[weekdayIndex(l.date)][hi] += l.revenue;
    }
    const unmapped = new Set(products.filter((l) => !idx.of(l).mapped).map((l) => l.item_raw)).size;
    const unknownPay = live.filter((l) => l.payment === 'unknown').length;

    mount(
      root,
      h`<div class="toolbar">
        <label class="field"><span>期間</span><select data-act="range">${options(
          [
            ['all', `營收起算日（${settings.revenue_start}）至今`],
            ['7', '最近 7 天'],
            ['14', '最近 14 天'],
            ['30', '最近 30 天'],
          ],
          state.range,
        )}</select></label>
        <span class="muted" style="padding-bottom:6px">${days[0]} ～ ${to}（資料最後一天）</span>
      </div>
      ${!settings.vat_confirmed ? h`<div class="callout warn" style="margin-bottom:14px"><p>尚未確認營業稅類型（目前以「一般稅額 5% 內含」計算會計收入）。請到 <a href="#/settings">設定</a> 確認是否為小規模營業人。</p></div>` : ''}
      <div class="stats">
        ${stat('營業收入（含稅）', '$' + fmt(revenue), delta === null ? `營業 ${openDays} 天` : `較前 ${span} 天 ${delta >= 0 ? '▲' : '▼'} ${pct(Math.abs(delta))}`, delta === null ? 'hero' : delta >= 0 ? 'hero good' : 'hero bad')}
        ${stat('日均營收', '$' + fmt(Math.round(revenue / Math.max(1, openDays))), `${openDays} 個營業日`)}
        ${stat('訂單數', fmt(orders.size), `客單價 $${fmt(Math.round(revenue / Math.max(1, orders.size)))}`)}
        ${stat('飲品杯數', fmt(cups), `日均 ${fmt(Math.round(cups / Math.max(1, openDays)))} 杯`)}
        ${stat('作廢金額（招待／測試／報廢）', '$' + fmt(voids.reduce((t, l) => t + l.amount, 0)), `${fmt(voids.reduce((t, l) => t + l.qty, 0))} 份，已從營收剔除`)}
      </div>
      ${
        unmapped || unknownPay
          ? h`<div class="callout" style="margin-bottom:14px"><p>${unmapped ? h`有 <b>${unmapped}</b> 個品名尚未整併，熱銷排行可能被拆散 → <a href="#/products">前往品項整併</a>。` : ''}${unknownPay ? h` 有 <b>${unknownPay}</b> 筆付款方式無法辨識（暫列現金）。` : ''}</p></div>`
          : ''
      }
      <div class="card">
        <div class="card-head"><h2>每日營收</h2><span class="card-note">依品類堆疊；滑過長條看明細</span></div>
        <div id="c-daily"></div>
      </div>
      <div class="grid-2" style="margin-top:16px">
        <div class="card"><div class="card-head"><h2>熱銷品項</h2><span class="card-note">依營收，已套用品項整併</span></div><div id="c-top"></div></div>
        <div class="card"><div class="card-head"><h2>時段熱度</h2><span class="card-note">星期 × 小時的營收</span></div><div id="c-heat">${hasTime ? '' : h`<p class="muted">銷售明細沒有時間欄位。</p>`}</div></div>
      </div>
      <div class="grid-3" style="margin-top:16px">
        <div class="card"><div class="card-head"><h2>品類結構</h2></div><div id="c-cat"></div></div>
        <div class="card"><div class="card-head"><h2>付款方式</h2></div><div id="c-pay"></div></div>
        <div class="card"><div class="card-head"><h2>作廢／招待／報廢</h2><a class="card-note" href="#/sales?void=1">看明細</a></div>
          <table class="grid"><thead><tr><th>原因</th><th class="num">筆數</th><th class="num">份數</th><th class="num">原價值</th></tr></thead><tbody>
          ${Object.keys(VOID_REASONS).map((k) => {
            const r = voidByReason[k] || { qty: 0, amount: 0, count: 0 };
            return h`<tr><td>${VOID_REASONS[k].label}</td><td class="num">${fmt(r.count)}</td><td class="num">${fmt(r.qty)}</td><td class="num">${fmt(r.amount)}</td></tr>`;
          })}
          </tbody></table>
          <p class="muted" style="font-size:12.5px;margin-top:8px">依指示一律視為金額作廢；份數仍計入原物料耗用。</p>
        </div>
      </div>`,
    );
    const catSeries = CAT_ORDER.filter((c) => Object.values(Object.fromEntries(byDay)).some((d) => d[c])).map((c) => ({ key: c, label: CATEGORIES[c], color: CAT_COLOR[c] }));
    columnChart(root.querySelector('#c-daily'), {
      data: days.map((d) => ({ key: d, label: `${d}（${WEEKDAYS[weekdayIndex(d)]}）`, short: d.slice(5).replace('-', '/'), values: byDay.get(d) })),
      series: catSeries.length ? catSeries : [{ key: 'other', label: '營收', color: CAT_COLOR.other }],
      ariaLabel: '每日營收長條圖',
    });
    barList(root.querySelector('#c-top'), top.map((p) => ({ label: p.name, sub: `${fmt(p.qty)} 份${p.mapped ? '' : '・未整併'}`, value: p.revenue })), { format: (v) => '$' + fmt(v) });
    if (hasTime) heatmap(root.querySelector('#c-heat'), { rows: WEEKDAYS, cols: hours.map((x) => String(Number(x))), values: heat, title: (r, c) => `週${r} ${c} 點` });
    const catSum = Object.values(catTotals).reduce((a, b) => a + b, 0) || 1;
    const catItems = CAT_ORDER.filter((c) => catTotals[c] > 0).map((c) => ({ label: CATEGORIES[c], value: catTotals[c], sub: pct(catTotals[c] / catSum), color: CAT_COLOR[c] }));
    barList(root.querySelector('#c-cat'), catItems, { format: (v) => '$' + fmt(v) });
    const payItems = Object.entries(payTotals).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ label: PAYMENT_TYPES[k] || k, value: v, sub: pct(v / (revenue || 1)) }));
    barList(root.querySelector('#c-pay'), payItems, { format: (v) => '$' + fmt(v), color: 'var(--series-2)' });
  }

  const unbind = bindActions(root, {
    range: (el) => {
      state.range = el.value;
      ctx.setParams({ range: el.value });
      draw();
    },
  });
  await draw();
  return unbind;
}

export { status, daysBetween, today };
