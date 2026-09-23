// 存貨與成本：定期盤存制。本月耗用（銷貨成本）＝ 期初 ＋ 本月進貨 − 期末盤點；
// 老闆招待／測試／報廢的理論成本自銷貨成本轉出至交際費／研究發展費／存貨報廢損失。

import { h, mount, bindActions, fmt, pct, stat, toast, status } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getAccounts, getProductIndex, revenueLines, isLocked } from '../state.js';
import { accountBalance, postings, nextVoucherNo } from '../lib/ledger.js';
import { cogsJournal, mergeGenerated, COGS_ACCOUNT_BY_INVENTORY } from '../lib/autojournal.js';
import { averageCosts, productCosts, stockLevels, theoreticalUsage } from '../lib/inventory.js';
import { VOID_REASONS } from '../lib/pos.js';
import { monthEnd, addDays, today } from '../lib/dates.js';
import { round2 } from '../lib/money.js';
import { uid } from '../lib/text.js';
import { latestMonth, reportHead } from './_shared.js';

const INV = ['1211', '1212', '1213', '1214', '1215', '1216'];

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  const accName = new Map(accounts.map((a) => [a.code, a.name]));
  let [entries, stocktakes, items, moves, recipes] = await Promise.all([store.all('journal_entries'), store.all('stocktakes'), store.all('inventory_items'), store.all('inventory_moves'), store.all('recipes')]);
  const idx = await getProductIndex();
  const sales = await store.all('sales_lines');
  const f = { ym: ctx.params.ym || latestMonth(sales, settings.revenue_start) };

  async function compute() {
    const from = `${f.ym}-01`;
    const to = monthEnd(f.ym);
    const base = entries.filter((e) => !(e.source === 'cogs' && e.source_ref === f.ym));
    const rows = INV.map((code) => {
      const opening = accountBalance(base, accounts, code, { to: addDays(from, -1) });
      const ps = postings(base, { from, to }).filter((p) => p.account === code);
      const purchases = round2(ps.reduce((t, p) => t + p.debit, 0));
      const decreases = round2(ps.reduce((t, p) => t + p.credit, 0));
      const book = round2(opening + purchases - decreases);
      const st = stocktakes.find((s) => s.id === `${f.ym}|${code}`);
      return { account: code, name: accName.get(code) || code, opening, purchases, decreases, book, counted: st ? Number(st.value) : null, note: st?.note || '' };
    });
    // 理論成本（配方 × 平均進價）
    const avg = averageCosts(items, moves, { asOf: to });
    const pCost = productCosts(idx.products, recipes, (id) => avg.get(id)?.avg || 0);
    const lines = (await revenueLines({ from, to })).filter((l) => !l.is_adjustment && l.qty > 0);
    const voidCost = { boss_treat: 0, boss_test: 0, scrap: 0 };
    let theoretical = 0;
    let covered = 0;
    let revenue = 0;
    for (const l of lines) {
      const p = idx.of(l);
      const c = pCost.get(p.id);
      if (!l.void_reason) revenue += l.revenue;
      if (c === undefined) continue;
      if (l.void_reason && voidCost[l.void_reason] !== undefined) voidCost[l.void_reason] += c * l.qty;
      else if (!l.void_reason) {
        theoretical += c * l.qty;
        covered += l.revenue;
      }
    }
    for (const k of Object.keys(voidCost)) voidCost[k] = Math.round(voidCost[k]);
    // 進銷存模組的庫存價值（依科目彙總），供盤點參考
    const usage = theoreticalUsage(await revenueLines({ to }), recipes, (l) => idx.of(l).id, { to });
    const levels = stockLevels(items, moves, usage, { asOf: to });
    const invValue = {};
    for (const lv of levels) invValue[lv.item.gl_account || '1211'] = round2((invValue[lv.item.gl_account || '1211'] || 0) + lv.value);
    return { rows, voidCost, theoretical: Math.round(theoretical), covered, revenue, invValue, hasRecipes: pCost.size > 0 };
  }

  async function draw() {
    const c = await compute();
    const existing = entries.find((e) => e.source === 'cogs' && e.source_ref === f.ym);
    const used = c.rows.filter((r) => r.counted !== null).reduce((t, r) => t + (r.book - r.counted), 0);
    const food = c.rows.filter((r) => r.counted !== null && ['1211', '1212', '1213', '1214'].includes(r.account)).reduce((t, r) => t + (r.book - r.counted), 0);
    const locked = isLocked(settings, `${f.ym}-01`);
    const head = await reportHead('存貨與銷貨成本表', `${Number(f.ym.slice(0, 4)) - 1911} 年 ${Number(f.ym.slice(5))} 月`);
    mount(
      root,
      h`<div class="toolbar no-print">
        <label class="field"><span>月份</span><input type="month" value="${f.ym}" data-act="ym"></label>
        <span class="spacer"></span>
        ${Object.keys(c.invValue).length ? h`<button class="btn" data-act="fill">帶入進銷存庫存價值</button>` : ''}
        <button class="btn primary" data-act="gen" ${locked ? 'disabled' : ''}>${existing ? '更新' : '產生'}本月成本分錄</button>
        <button class="btn" data-act="print">列印</button>
      </div>
      <div class="callout no-print" style="margin-bottom:14px"><p>月底盤點後，在「期末盤點金額」輸入各類存貨的實際價值（數量 × 進價）。系統以「期初＋本月進貨－期末」計算本月耗用並轉入銷貨成本；若有配方資料，老闆招待／老闆測試／報廢的原料成本會自銷貨成本轉出到交際費、研究發展費、存貨報廢損失。</p></div>
      <div class="stats">
        ${stat('本月實際耗用', '$' + fmt(round2(used)), c.rows.some((r) => r.counted === null) ? '部分科目尚未盤點' : '全部科目已盤點')}
        ${stat('原物料成本率', c.revenue ? pct(food / (settings.vat_mode === 'general' ? c.revenue / 1.05 : c.revenue)) : '—', '食材耗用 ÷ 未稅營收')}
        ${stat('理論成本（配方）', c.hasRecipes ? '$' + fmt(c.theoretical) : '—', c.hasRecipes ? `涵蓋營收 ${pct(c.covered / (c.revenue || 1))}` : '尚未建立配方')}
        ${stat('招待／測試／報廢成本', '$' + fmt(c.voidCost.boss_treat + c.voidCost.boss_test + c.voidCost.scrap), c.hasRecipes ? '依配方估算' : '需先建立配方')}
      </div>
      <div class="card report" style="max-width:none">${head}
        <div class="table-wrap"><table class="grid">
          <thead><tr><th>存貨科目</th><th class="num">期初帳面</th><th class="num">本月進貨</th><th class="num">其他減少</th><th class="num">帳面結存</th><th class="num">期末盤點金額</th><th class="num">本月耗用</th><th>轉入</th></tr></thead>
          <tbody>${c.rows.map(
            (r) => h`<tr>
            <td>${r.account} ${r.name}</td>
            <td class="num">${fmt(r.opening)}</td><td class="num">${fmt(r.purchases)}</td><td class="num">${r.decreases ? fmt(r.decreases) : ''}</td><td class="num">${fmt(r.book)}</td>
            <td class="num"><input class="cell num" style="max-width:130px" type="number" step="1" value="${r.counted ?? ''}" data-act="count" data-acc="${r.account}" ${locked ? 'disabled' : ''} placeholder="${c.invValue[r.account] !== undefined ? '參考 ' + fmt(c.invValue[r.account]) : ''}"></td>
            <td class="num">${r.counted === null ? h`<span class="muted">未盤點</span>` : fmt(round2(r.book - r.counted))}</td>
            <td>${COGS_ACCOUNT_BY_INVENTORY[r.account]} ${accName.get(COGS_ACCOUNT_BY_INVENTORY[r.account]) || ''}</td>
          </tr>`,
          )}</tbody>
          <tfoot><tr><td>合計</td><td class="num">${fmt(c.rows.reduce((t, r) => t + r.opening, 0))}</td><td class="num">${fmt(c.rows.reduce((t, r) => t + r.purchases, 0))}</td><td class="num">${fmt(c.rows.reduce((t, r) => t + r.decreases, 0))}</td><td class="num">${fmt(c.rows.reduce((t, r) => t + r.book, 0))}</td><td class="num">${fmt(c.rows.reduce((t, r) => t + (r.counted || 0), 0))}</td><td class="num">${fmt(round2(used))}</td><td></td></tr></tfoot>
        </table></div>
        <h3 style="font-size:15px;margin:18px 0 8px">作廢品項之原料成本（自銷貨成本轉出）</h3>
        <table class="fin" style="max-width:560px">${Object.entries(c.voidCost).map(([k, v]) => h`<tr class="i"><td>${VOID_REASONS[k].label} → ${VOID_REASONS[k].costAccount} ${accName.get(VOID_REASONS[k].costAccount) || ''}</td><td class="amt">${fmt(v)}</td></tr>`)}</table>
        ${c.hasRecipes && used > 0 ? h`<p style="margin-top:12px">${Math.abs(food - c.theoretical) / Math.max(1, c.theoretical) > 0.15 ? status('warn', `實際食材耗用 ${fmt(Math.round(food))} 與理論成本 ${fmt(c.theoretical)} 差異 ${pct((food - c.theoretical) / Math.max(1, c.theoretical))}，建議檢查配方份量、未登錄的報廢或盤點誤差`) : status('good', '實際耗用與配方理論成本差異在 15% 以內')}</p>` : ''}
        ${existing ? h`<p class="muted" style="margin-top:10px">本月成本分錄：傳票 ${existing.voucher_no}（<a href="#/journal?ym=${f.ym}&src=cogs">查看</a>）</p>` : ''}
      </div>`,
    );
    root._c = c;
  }

  const unbind = bindActions(root, {
    ym: (el) => {
      if (!el.value) return;
      f.ym = el.value;
      ctx.setParams({ ym: f.ym });
      draw();
    },
    count: async (el) => {
      const id = `${f.ym}|${el.dataset.acc}`;
      if (el.value === '') await store.remove('stocktakes', id);
      else await store.put('stocktakes', { id, month: f.ym, account: el.dataset.acc, value: Number(el.value), note: '' });
      stocktakes = await store.all('stocktakes');
      draw();
    },
    fill: async () => {
      const c = root._c;
      const rows = Object.entries(c.invValue).map(([acc, v]) => ({ id: `${f.ym}|${acc}`, month: f.ym, account: acc, value: Math.round(v), note: '由進銷存帶入' }));
      await store.put('stocktakes', rows);
      stocktakes = await store.all('stocktakes');
      toast('已帶入，請核對後再產生分錄', 'good');
      draw();
    },
    gen: async () => {
      const c = root._c;
      const rows = c.rows.filter((r) => r.counted !== null).map((r) => ({ account: r.account, name: r.name, book: r.book, counted: r.counted }));
      if (!rows.length) return toast('請先輸入至少一個科目的期末盤點金額', 'error');
      const je = cogsJournal(f.ym, rows, c.voidCost);
      if (!je) return toast('帳面與盤點相同，無需分錄', 'info');
      const res = mergeGenerated(entries, [je], { source: 'cogs', lockedMonths: new Set(settings.locked_months || []), makeId: () => uid('je_'), nextNo: nextVoucherNo, scopeRefs: new Set([f.ym]) });
      if (res.upserts.length) await store.put('journal_entries', res.upserts);
      entries = await store.all('journal_entries');
      toast(res.upserts.length ? '成本分錄已更新' : '成本分錄已是最新', 'good');
      draw();
    },
    print: () => window.print(),
  });
  await draw();
  return unbind;
}

export { today };
