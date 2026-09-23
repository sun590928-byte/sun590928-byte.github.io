// 每月結帳前檢查表：系統能判斷的項目自動亮燈，其餘人工勾選，完成後可鎖定該月。

import { h, raw, mount, bindActions, status, toast, confirmBox, fmt } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getAccounts, getProductIndex, saveSettings, isLocked } from '../state.js';
import { CHECK_ITEMS } from '../lib/checklist.js';
import { trialBalance, balanceSheet } from '../lib/ledger.js';
import { dailyCardRecon } from '../lib/payments.js';
import { bookLines, autoMatch, reconciliation } from '../lib/bank.js';
import { monthEnd } from '../lib/dates.js';
import { latestMonth } from './_shared.js';

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  const [sales, entries, txs, payouts, docs, bank, stocktakes, assets] = await Promise.all(['sales_lines', 'journal_entries', 'payment_tx', 'payouts', 'documents', 'bank_lines', 'stocktakes', 'fixed_assets'].map((c) => store.all(c)));
  let checks = await store.all('checklist');
  const idx = await getProductIndex();
  const f = { ym: ctx.params.ym || latestMonth(sales, settings.revenue_start) };

  function context() {
    const ym = f.ym;
    const from = `${ym}-01`;
    const to = monthEnd(ym);
    const mLines = sales.filter((l) => l.date >= from && l.date <= to && l.date >= settings.revenue_start);
    const live = mLines.filter((l) => !l.void_reason);
    const salesDays = new Set(live.map((l) => l.date));
    const posDays = new Set(entries.filter((e) => e.source === 'pos' && e.date >= from && e.date <= to).map((e) => e.date));
    const daily = dailyCardRecon(mLines, txs.filter((t) => t.date >= from && t.date <= to));
    const mPayouts = payouts.filter((p) => p.payout_date >= from && p.payout_date <= to);
    const booked = new Set(entries.filter((e) => e.source === 'payout').map((e) => e.source_ref));
    const mDocs = docs.filter((d) => (d.doc_date || d.created_at || '').slice(0, 7) === ym);
    const gl = settings.bank_gl || '1103';
    const bLines = bank.filter((b) => b.date <= to);
    let bankRecDiff = 0;
    if (bLines.length) {
      const books = bookLines(entries, gl);
      bankRecDiff = reconciliation({ bankLines: bLines, books, matches: autoMatch(bLines, books), asOf: to }).diff;
    }
    const lastSale = mLines.reduce((m, l) => (l.date > m ? l.date : m), '');
    return {
      monthEnd: to,
      lastSaleDate: lastSale,
      unmappedProducts: new Set(live.filter((l) => !l.is_adjustment && !idx.of(l).mapped).map((l) => l.item_raw)).size,
      salesDays: salesDays.size,
      posEntryDays: [...salesDays].filter((d) => posDays.has(d)).length,
      unknownPaymentLines: live.filter((l) => l.payment === 'unknown').length,
      cardDays: daily.filter((d) => d.pos || d.ecpay).length,
      cardDiffDays: daily.filter((d) => Math.abs(d.diff) >= 1).length,
      payouts: mPayouts.length,
      payoutsUnbooked: mPayouts.filter((p) => !booked.has(p.id)).length,
      docs: mDocs.length,
      docsPending: mDocs.filter((d) => d.status === 'inbox').length,
      bankLines: bLines.filter((b) => b.date >= from).length,
      bankRecDiff,
      stocktakeDone: stocktakes.some((s) => s.month === ym),
      cogsEntry: entries.some((e) => e.source === 'cogs' && e.source_ref === ym),
      assets: assets.filter((a) => a.acquired_on && a.acquired_on <= to).length,
      depEntry: entries.some((e) => e.source === 'depreciation' && e.source_ref === ym),
      tbBalanced: trialBalance(entries, accounts, { to }).balanced,
      bsBalanced: balanceSheet(entries, accounts, { asOf: to }).balanced,
    };
  }

  function draw() {
    const c = context();
    const locked = isLocked(settings, `${f.ym}-01`);
    const rows = CHECK_ITEMS.map((it) => {
      const auto = it.auto ? it.auto(c) : null;
      const rec = checks.find((x) => x.id === `${f.ym}|${it.key}`);
      const manual = !!rec?.done;
      const done = auto === true || manual;
      return { ...it, hasAuto: !!it.auto, auto, manual, done, note: rec?.note || '' };
    });
    const doneN = rows.filter((r) => r.done).length;
    let group = null;
    mount(
      root,
      h`<div class="toolbar">
        <label class="field"><span>結帳月份</span><input type="month" value="${f.ym}" data-act="ym"></label>
        <span class="spacer"></span>
        <span>${status(doneN === rows.length ? 'good' : 'warn', `完成 ${doneN} / ${rows.length}`)}</span>
        ${locked ? h`<span class="badge high">已鎖定</span>` : h`<button class="btn primary" data-act="lock">結帳並鎖定 ${f.ym}</button>`}
      </div>
      <div class="callout" style="margin-bottom:14px"><p>「系統判斷」欄由資料自動檢查（✓ 通過、✕ 未通過、– 本月無此資料）；其餘項目完成後請勾選。建議每月 5 日前完成上月結帳，再到「申報行事曆」確認當月申報事項。</p></div>
      <div class="checklist">${rows.map((r) => {
        const head = r.group !== group ? h`<h3 style="font-size:14px;margin:10px 0 2px;color:var(--mute)">${r.group}</h3>` : '';
        group = r.group;
        const autoTxt = r.auto === true ? status('good', '系統確認') : r.auto === false ? status('bad', detail(r.key, c)) : r.hasAuto ? status('na', '本月無此資料，請人工確認') : '';
        return h`${head}<div class="check-row ${r.done ? 'ok' : ''}">
          <input type="checkbox" data-act="check" data-k="${r.key}" ${r.manual || r.auto === true ? raw('checked') : ''} ${r.auto === true || locked ? raw('disabled') : ''} aria-label="${r.title}">
          <div><div class="t">${r.title}</div>${autoTxt ? h`<div class="d">${autoTxt}</div>` : ''}</div>
          <input type="text" class="cell" style="max-width:220px" placeholder="備註" value="${r.note}" data-act="note" data-k="${r.key}" ${locked ? raw('disabled') : ''}>
        </div>`;
      })}</div>`,
    );
  }

  function detail(key, c) {
    switch (key) {
      case 'pos_imported':
        return c.lastSaleDate ? `銷售資料只到 ${c.lastSaleDate}` : '本月尚無銷售資料';
      case 'products_mapped':
        return `${c.unmappedProducts} 個品名未整併`;
      case 'pos_journal':
        return `${c.salesDays - c.posEntryDays} 天缺營收分錄（到日記簿按「同步自動分錄」）`;
      case 'unknown_payment':
        return `${c.unknownPaymentLines} 筆付款方式未指定`;
      case 'card_recon':
        return `${c.cardDiffDays} 天刷卡金額有差異`;
      case 'payouts_booked':
        return `${c.payoutsUnbooked} 筆撥款未入帳`;
      case 'photos':
        return `${c.docsPending} 張憑證待覆核`;
      case 'bank_rec':
        return `調節差異 ${fmt(c.bankRecDiff)}`;
      case 'stocktake':
        return '尚未輸入期末盤點';
      case 'cogs':
        return '尚未產生成本分錄（存貨與成本頁）';
      case 'depreciation':
        return '本月折舊分錄不存在';
      case 'tb_balanced':
        return '試算表不平衡';
      case 'bs_balanced':
        return '資產負債表不平衡';
      default:
        return '未通過';
    }
  }

  const save = async (key, patch) => {
    const id = `${f.ym}|${key}`;
    const old = checks.find((x) => x.id === id) || { id, month: f.ym, key, done: false, note: '' };
    await store.put('checklist', { ...old, ...patch, done_at: patch.done ? new Date().toISOString() : old.done_at || null });
    checks = await store.all('checklist');
  };

  const unbind = bindActions(root, {
    ym: (el) => {
      if (!el.value) return;
      f.ym = el.value;
      ctx.setParams({ ym: f.ym });
      draw();
    },
    check: async (el) => {
      await save(el.dataset.k, { done: el.checked });
      draw();
    },
    note: async (el) => {
      await save(el.dataset.k, { note: el.value });
    },
    lock: async () => {
      const c = context();
      const pending = CHECK_ITEMS.filter((it) => !(it.auto && it.auto(c) === true) && !checks.find((x) => x.id === `${f.ym}|${it.key}`)?.done).length;
      if (!(await confirmBox(pending ? `還有 ${pending} 項未完成，仍要鎖定 ${f.ym}？` : `全部完成，鎖定 ${f.ym}？鎖定後該月分錄不能再修改。`, { ok: '鎖定' }))) return;
      await saveSettings({ locked_months: [...new Set([...(settings.locked_months || []), f.ym])] });
      settings.locked_months = [...new Set([...(settings.locked_months || []), f.ym])];
      toast(`${f.ym} 已鎖定`, 'good');
      draw();
    },
  });
  draw();
  return unbind;
}
