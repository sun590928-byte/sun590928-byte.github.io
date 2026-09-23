// 日記簿：依日期列出所有分錄；新增／修改／刪除、自動分錄同步、期初開帳、月份鎖定。

import { h, raw, mount, bindActions, fmt, options, toast, confirmBox, modal, badge, downloadCSV, emptyState } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getAccounts, saveSettings, isLocked } from '../state.js';
import { accountMap } from '../lib/coa.js';
import { entryTotals, voucherKind, nextVoucherNo, renumberMonth, closingEntry } from '../lib/ledger.js';
import { addDays, monthEnd } from '../lib/dates.js';
import { uid } from '../lib/text.js';
import { syncAll, describeSync } from '../sync.js';
import { editEntry, SOURCE_LABEL, AUTO_SOURCES, latestMonth, accountSelect } from './_shared.js';

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  const accMap = accountMap(accounts);
  let entries = await store.all('journal_entries');
  const f = { ym: ctx.params.ym || latestMonth(entries, settings.revenue_start), src: ctx.params.src || '', q: ctx.params.q || '' };

  function list() {
    const q = f.q.trim().toLowerCase();
    return entries
      .filter((e) => (f.ym === 'all' || e.date.startsWith(f.ym)) && (!f.src || e.source === f.src) && (!q || `${e.voucher_no} ${e.description} ${(e.lines || []).map((l) => `${l.account} ${accMap.get(l.account)?.name || ''} ${l.memo}`).join(' ')}`.toLowerCase().includes(q)))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.voucher_no || '') < (b.voucher_no || '') ? -1 : 1));
  }

  function draw() {
    const rows = list();
    const months = [...new Set(entries.map((e) => e.date.slice(0, 7)))].sort().reverse();
    if (!months.includes(f.ym) && f.ym !== 'all') months.unshift(f.ym);
    const locked = f.ym !== 'all' && isLocked(settings, f.ym + '-01');
    let tdr = 0;
    let tcr = 0;
    for (const e of rows) {
      const t = entryTotals(e);
      tdr += t.debit;
      tcr += t.credit;
    }
    mount(
      root,
      h`<div class="toolbar">
        <label class="field"><span>月份</span><select data-act="ym">${options([['all', '全部'], ...months.map((m) => [m, `${Number(m.slice(0, 4)) - 1911} 年 ${Number(m.slice(5))} 月`])], f.ym)}</select></label>
        <label class="field"><span>來源</span><select data-act="src">${options([['', '全部'], ...Object.entries(SOURCE_LABEL)], f.src)}</select></label>
        <label class="field"><span>搜尋</span><input type="search" value="${f.q}" data-act="q" placeholder="傳票號、摘要、科目"></label>
        <span class="spacer"></span>
        <button class="btn primary" data-act="add" ${locked ? raw('disabled') : ''}>＋ 新增分錄</button>
        <button class="btn" data-act="sync">同步自動分錄</button>
        <button class="btn" data-act="opening">期初開帳</button>
      </div>
      ${locked ? h`<div class="callout good" style="margin-bottom:12px"><p>此月份已結帳鎖定。<button class="btn sm" data-act="unlock">解除鎖定</button></p></div>` : ''}
      <div class="card">
        <div class="card-head">
          <h2>日記簿</h2><span class="card-note">${fmt(rows.length)} 張傳票・借方 ${fmt(tdr)}・貸方 ${fmt(tcr)} ${Math.abs(tdr - tcr) < 0.01 ? '（平衡）' : '（不平衡！）'}</span>
          <span class="spacer"></span>
          ${f.ym !== 'all' && !locked ? h`<button class="btn sm" data-act="renumber">依日期重新編號</button><button class="btn sm" data-act="lock">結帳並鎖定本月</button>` : ''}
          ${f.ym !== 'all' && f.ym.endsWith('-12') ? h`<button class="btn sm" data-act="closing">產生年底結帳分錄</button>` : ''}
          <button class="btn sm ghost" data-act="export">匯出 CSV</button>
          ${f.ym !== 'all' ? h`<a class="btn sm ghost" href="#/vouchers?ym=${f.ym}">列印本月傳票</a>` : ''}
        </div>
        ${
          rows.length
            ? h`<div class="table-wrap"><table class="grid">
            <thead><tr><th>日期</th><th>傳票號碼</th><th>會計項目</th><th>摘要／說明</th><th class="num">借方</th><th class="num">貸方</th><th></th></tr></thead>
            <tbody>${rows.map((e) => {
              const n = e.lines.length;
              return e.lines.map(
                (l, i) => h`<tr class="${i === 0 ? '' : 'sub'}">
                ${i === 0 ? h`<td rowspan="${n}">${e.date}</td><td rowspan="${n}"><b>${e.voucher_no}</b><div class="muted" style="font-size:12px">${voucherKind(e)}</div>${badge(SOURCE_LABEL[e.source] || e.source, AUTO_SOURCES.has(e.source) ? 'accent' : '')}</td>` : ''}
                <td>${l.credit ? raw('<span class="indent"></span>') : ''}${l.account} ${accMap.get(l.account)?.name || '（未知科目）'}</td>
                <td>${i === 0 ? h`<b>${e.description}</b>${l.memo ? h`<div class="muted">${l.memo}</div>` : ''}` : l.memo}</td>
                <td class="num">${l.debit ? fmt(l.debit) : ''}</td><td class="num">${l.credit ? fmt(l.credit) : ''}</td>
                ${i === 0 ? h`<td rowspan="${n}" style="white-space:nowrap"><button class="btn sm" data-act="edit" data-id="${e.id}">${AUTO_SOURCES.has(e.source) ? '檢視' : '修改'}</button> <a class="btn sm ghost" href="#/vouchers?id=${e.id}">列印</a>${!AUTO_SOURCES.has(e.source) && !isLocked(settings, e.date) ? h` <button class="btn sm danger" data-act="del" data-id="${e.id}">刪除</button>` : ''}</td>` : ''}
              </tr>`,
              );
            })}</tbody></table></div>`
            : emptyState('這個月份還沒有分錄', '匯入 POS 銷售明細後會自動產生每日營收分錄；也可以按「新增分錄」手動記帳，或先做「期初開帳」。')
        }
      </div>`,
    );
  }

  const reload = async () => {
    entries = await store.all('journal_entries');
    draw();
  };

  const unbind = bindActions(root, {
    ym: (el) => {
      f.ym = el.value;
      ctx.setParams({ ym: f.ym });
      draw();
    },
    src: (el) => {
      f.src = el.value;
      ctx.setParams({ src: f.src });
      draw();
    },
    q: (el) => {
      f.q = el.value;
      draw();
    },
    add: async () => {
      const d = f.ym !== 'all' ? (f.ym === new Date().toISOString().slice(0, 7) ? new Date().toISOString().slice(0, 10) : monthEnd(f.ym)) : undefined;
      if (await editEntry(null, { defaults: { date: d } })) reload();
    },
    edit: async (el) => {
      const e = entries.find((x) => x.id === el.dataset.id);
      if (await editEntry(e)) reload();
    },
    del: async (el) => {
      const e = entries.find((x) => x.id === el.dataset.id);
      if (!(await confirmBox(`刪除傳票 ${e.voucher_no}「${e.description}」？`, { ok: '刪除', danger: true }))) return;
      await store.remove('journal_entries', e.id);
      if (e.source === 'document' && e.source_ref) {
        const doc = await store.get('documents', e.source_ref);
        if (doc) await store.put('documents', { ...doc, entry_id: null, status: 'reviewed' });
      }
      toast('已刪除', 'good');
      reload();
    },
    sync: async () => {
      const r = await syncAll();
      toast(describeSync(r), 'good', 6000);
      reload();
    },
    renumber: async () => {
      if (!(await confirmBox(`依日期順序重新編排 ${f.ym} 的傳票號碼？已列印的傳票號碼會改變。`))) return;
      const changed = renumberMonth(entries.map((e) => ({ ...e })), f.ym);
      await store.put('journal_entries', changed);
      toast('已重新編號', 'good');
      reload();
    },
    lock: async () => {
      if (!(await confirmBox(`將 ${f.ym} 結帳鎖定？鎖定後該月分錄不能新增、修改或刪除，自動分錄也不會再更新。建議先完成「每月結帳檢查」。`, { ok: '鎖定' }))) return;
      await saveSettings({ locked_months: [...new Set([...(settings.locked_months || []), f.ym])] });
      settings.locked_months = [...new Set([...(settings.locked_months || []), f.ym])];
      toast('已鎖定', 'good');
      draw();
    },
    unlock: async () => {
      if (!(await confirmBox(`解除 ${f.ym} 的結帳鎖定？`))) return;
      settings.locked_months = (settings.locked_months || []).filter((m) => m !== f.ym);
      await saveSettings({ locked_months: settings.locked_months });
      draw();
    },
    closing: async () => {
      const year = Number(f.ym.slice(0, 4));
      const ce = closingEntry(entries, accounts, year);
      if (!ce.lines.length) return toast('本年度沒有損益科目餘額', 'info');
      if (!(await confirmBox(`產生 ${year - 1911} 年度結帳分錄（${ce.lines.length} 行），把收入、成本、費用科目結轉至「本期損益」？`))) return;
      const old = entries.find((e) => e.source === 'closing' && e.source_ref === String(year));
      const e = { ...ce, id: old?.id || uid('je_'), voucher_no: old?.voucher_no || nextVoucherNo(entries, ce.date), status: 'posted', created_at: new Date().toISOString() };
      await store.put('journal_entries', e);
      toast('已產生結帳分錄', 'good');
      reload();
    },
    opening: async () => {
      const date = addDays(settings.revenue_start, -1);
      const existing = entries.find((e) => e.source === 'opening');
      const assetsLike = accounts.filter((a) => ['1101', '1102', '1103', '1111', '1112', '1211', '1212', '1213', '1214', '1215', '1216', '1252', '1511', '1521', '1531', '1541', '1811'].includes(a.code));
      const credits = accounts.filter((a) => ['1512', '1522', '1532', '1542', '2111', '2191', '2501'].includes(a.code));
      const val = (code) => {
        const l = existing?.lines.find((x) => x.account === code);
        return l ? l.debit || l.credit : '';
      };
      const r = await modal({
        title: `期初開帳（${date}）`,
        wide: true,
        body: h`<p class="muted">輸入營收起算日（${settings.revenue_start}）前一天的各科目餘額。差額自動列入「3101 資本（業主投資）」。可以之後再修改。</p>
          <div class="grid-2">
            <div><h3 style="font-size:14px;margin:8px 0">資產（借方）</h3>${assetsLike.map((a) => h`<label class="field" style="margin-bottom:6px"><span>${a.code} ${a.name}</span><input type="number" step="1" data-code="${a.code}" data-side="d" value="${val(a.code)}"></label>`)}</div>
            <div><h3 style="font-size:14px;margin:8px 0">累計折舊、負債（貸方）</h3>${credits.map((a) => h`<label class="field" style="margin-bottom:6px"><span>${a.code} ${a.name}</span><input type="number" step="1" data-code="${a.code}" data-side="c" value="${val(a.code)}"></label>`)}
            <p class="muted" style="font-size:12.5px">固定資產的取得成本與累計折舊可參考「固定資產與折舊」頁的期初數字。</p></div>
          </div>`,
        actions: [
          { label: '取消', value: null },
          {
            label: '儲存期初分錄',
            primary: true,
            value: (dlg) => [...dlg.querySelectorAll('input[data-code]')].map((i) => ({ code: i.dataset.code, side: i.dataset.side, v: Number(i.value) || 0 })).filter((x) => x.v),
          },
        ],
      });
      if (!r) return;
      const lines = r.map((x) => (x.side === 'd' ? { account: x.code, debit: x.v, credit: 0, memo: '期初餘額' } : { account: x.code, debit: 0, credit: x.v, memo: '期初餘額' }));
      const dr = lines.reduce((t, l) => t + l.debit, 0);
      const cr = lines.reduce((t, l) => t + l.credit, 0);
      if (dr !== cr) lines.push(dr > cr ? { account: '3101', debit: 0, credit: dr - cr, memo: '期初業主權益' } : { account: '3101', debit: cr - dr, credit: 0, memo: '期初業主權益' });
      if (!lines.length) return;
      const e = { id: existing?.id || uid('je_'), date, description: '期初開帳', source: 'opening', source_ref: 'opening', status: 'posted', voucher_no: existing?.voucher_no || nextVoucherNo(entries, date), lines, created_at: existing?.created_at || new Date().toISOString(), updated_at: new Date().toISOString() };
      await store.put('journal_entries', e);
      toast('期初開帳已儲存', 'good');
      f.ym = date.slice(0, 7);
      reload();
    },
    export: () => {
      const rows = [['日期', '傳票號碼', '傳票種類', '來源', '摘要', '科目代號', '科目名稱', '借方', '貸方', '說明']];
      for (const e of list()) for (const l of e.lines) rows.push([e.date, e.voucher_no, voucherKind(e), SOURCE_LABEL[e.source] || e.source, e.description, l.account, accMap.get(l.account)?.name || '', l.debit || '', l.credit || '', l.memo || '']);
      downloadCSV(`日記簿_${f.ym}.csv`, rows);
    },
  });
  draw();
  return unbind;
}

export { accountSelect };
