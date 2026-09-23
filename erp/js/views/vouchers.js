// 傳票列印：單張（?id=）或整月（?ym=），依傳票種類（現金收入／現金支出／轉帳）套版。

import { h, mount, bindActions, fmt, options } from '../ui.js';
import { store } from '../store.js';
import { getAccounts, getSettings } from '../state.js';
import { accountMap } from '../lib/coa.js';
import { voucherKind, entryTotals } from '../lib/ledger.js';
import { latestMonth, SOURCE_LABEL } from './_shared.js';
import { docLabel } from '../attach.js';

export async function render(root, ctx) {
  const settings = await getSettings();
  const accMap = accountMap(await getAccounts());
  const entries = await store.all('journal_entries');
  const docs = new Map((await store.all('documents')).map((d) => [d.id, d]));
  const f = { id: ctx.params.id || '', ym: ctx.params.ym || latestMonth(entries, settings.revenue_start), kind: ctx.params.kind || '', src: ctx.params.src || '' };

  function draw() {
    let list;
    if (f.id) list = entries.filter((e) => e.id === f.id);
    else list = entries.filter((e) => e.date.startsWith(f.ym) && (!f.kind || voucherKind(e) === f.kind) && (!f.src || e.source === f.src)).sort((a, b) => ((a.voucher_no || '') < (b.voucher_no || '') ? -1 : 1));
    const months = [...new Set(entries.map((e) => e.date.slice(0, 7)))].sort().reverse();
    mount(
      root,
      h`<div class="toolbar no-print">
        ${f.id ? h`<a class="btn" href="#/vouchers?ym=${list[0]?.date.slice(0, 7) || f.ym}">← 改印整月</a>` : h`
        <label class="field"><span>月份</span><select data-act="ym">${options(months.map((m) => [m, `${Number(m.slice(0, 4)) - 1911} 年 ${Number(m.slice(5))} 月`]), f.ym)}</select></label>
        <label class="field"><span>傳票種類</span><select data-act="kind">${options([['', '全部'], ['現金收入傳票', '現金收入傳票'], ['現金支出傳票', '現金支出傳票'], ['轉帳傳票', '轉帳傳票']], f.kind)}</select></label>
        <label class="field"><span>來源</span><select data-act="src">${options([['', '全部'], ...Object.entries(SOURCE_LABEL)], f.src)}</select></label>`}
        <span class="spacer"></span>
        <span class="muted">共 ${list.length} 張</span>
        <button class="btn primary" data-act="print">列印</button>
      </div>
      <div>${list.map((e, i) => voucher(e, i === list.length - 1))}</div>`,
    );
  }

  function voucher(e, last) {
    const t = entryTotals(e);
    const kind = voucherKind(e);
    return h`<div class="voucher ${last ? '' : ''}">
      <div class="vh"><div class="vco">${settings.business_name}${settings.tax_id ? `（統編 ${settings.tax_id}）` : ''}</div><div class="vt">${kind}</div><div class="vco">第 ${e.voucher_no} 號</div></div>
      <div class="vmeta"><span>日期：民國 ${Number(e.date.slice(0, 4)) - 1911} 年 ${Number(e.date.slice(5, 7))} 月 ${Number(e.date.slice(8))} 日</span><span>摘要：${e.description}</span><span>來源：${SOURCE_LABEL[e.source] || e.source}</span></div>
      <table>
        <thead><tr><th style="width:90px">科目代號</th><th>會計項目</th><th>說明</th><th class="amt">借方金額</th><th class="amt">貸方金額</th></tr></thead>
        <tbody>${e.lines.map((l) => h`<tr><td>${l.account}</td><td>${accMap.get(l.account)?.name || ''}</td><td>${l.memo || ''}</td><td class="amt">${l.debit ? fmt(l.debit) : ''}</td><td class="amt">${l.credit ? fmt(l.credit) : ''}</td></tr>`)}</tbody>
        <tfoot><tr><td colspan="3" style="text-align:right">合計</td><td class="amt">${fmt(t.debit)}</td><td class="amt">${fmt(t.credit)}</td></tr></tfoot>
      </table>
      <div class="vatt">附件：${(e.attachments || []).length} 張${(e.attachments || []).length ? `（${e.attachments.map((id) => { const d = docs.get(id); return d?.archived_name || docLabel(d); }).join('；')}）` : ''}</div>
      <div class="sign"><div>負責人</div><div>主辦會計</div><div>覆核</div><div>製單</div></div>
    </div>`;
  }

  const unbind = bindActions(root, {
    ym: (el) => {
      f.ym = el.value;
      ctx.setParams({ ym: f.ym });
      draw();
    },
    kind: (el) => {
      f.kind = el.value;
      draw();
    },
    src: (el) => {
      f.src = el.value;
      draw();
    },
    print: () => window.print(),
  });
  draw();
  return unbind;
}
