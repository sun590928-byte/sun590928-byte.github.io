// 各頁共用：科目下拉、期間選擇、報表抬頭、分錄編輯器。

import { h, raw, modal, toast, fmt, options } from '../ui.js';
import { store } from '../store.js';
import { getAccounts, getSettings, isLocked } from '../state.js';
import { TYPE_LABELS } from '../lib/coa.js';
import { validateEntry, entryTotals, nextVoucherNo, voucherKind } from '../lib/ledger.js';
import { accountMap } from '../lib/coa.js';
import { uid } from '../lib/text.js';
import { monthEnd, addMonths, eachMonth, today } from '../lib/dates.js';
import { attachmentEditor, linkDocumentsToEntry } from '../attach.js';
import { makeXlsx } from '../lib/xlsxw.js';
import { download } from '../ui.js';

// 匯出 Excel（.xlsx）：sheets 由 lib/reportbook.js 產生
export async function downloadWorkbook(fileName, build) {
  const s = await getSettings();
  const sheets = build({ business: s.business_name });
  download(fileName, makeXlsx(Array.isArray(sheets) ? sheets : [sheets]));
}

export function accountSelect(accounts, selected, attrs = '') {
  const groups = {};
  for (const a of accounts) {
    if (a.active === false && a.code !== selected) continue;
    (groups[a.type] ||= []).push(a);
  }
  return h`<select ${raw(attrs)}><option value="">— 科目 —</option>${Object.entries(groups).map(
    ([t, list]) => h`<optgroup label="${TYPE_LABELS[t] || t}">${list.map((a) => h`<option value="${a.code}" ${a.code === selected ? raw('selected') : ''}>${a.code} ${a.name}</option>`)}</optgroup>`,
  )}</select>`;
}

export const SOURCE_LABEL = { manual: '手動', pos: 'POS 營收', payout: '撥款入帳', depreciation: '折舊', cogs: '存貨成本', document: '憑證', asset: '資產購置', import: '舊帳匯入', opening: '期初開帳', closing: '年底結帳', bank: '存摺補登', vat: '營業稅結轉', vat_pay: '營業稅繳納' };
export const AUTO_SOURCES = new Set(['pos', 'payout', 'depreciation', 'cogs', 'closing', 'vat']);

export function monthsSince(start) {
  return eachMonth(start.slice(0, 7), today().slice(0, 7)).reverse();
}

// 期間：月份或自訂
export function periodFields(p, { allowYear = true } = {}) {
  return h`<label class="field"><span>期間</span><select data-act="period">${options(
    [['month', '單月'], ['ytd', '本年度累計'], ...(allowYear ? [['year', '整年度']] : []), ['custom', '自訂']],
    p.mode,
  )}</select></label>
  ${p.mode === 'custom' ? h`<label class="field"><span>起</span><input type="date" value="${p.from}" data-act="pfrom"></label><label class="field"><span>迄</span><input type="date" value="${p.to}" data-act="pto"></label>` : h`<label class="field"><span>${p.mode === 'year' ? '年度' : '月份'}</span><input type="month" value="${p.ym}" data-act="pym"></label>`}`;
}

export function resolvePeriod(p) {
  if (p.mode === 'custom') return { from: p.from, to: p.to, label: `${p.from} 至 ${p.to}` };
  const y = p.ym.slice(0, 4);
  const roc = Number(y) - 1911;
  if (p.mode === 'year') return { from: `${y}-01-01`, to: `${y}-12-31`, label: `民國 ${roc} 年 1 月 1 日至 12 月 31 日` };
  if (p.mode === 'ytd') return { from: `${y}-01-01`, to: monthEnd(p.ym), label: `民國 ${roc} 年 1 月 1 日至 ${Number(p.ym.slice(5))} 月 ${Number(monthEnd(p.ym).slice(8))} 日` };
  return { from: `${p.ym}-01`, to: monthEnd(p.ym), label: `民國 ${roc} 年 ${Number(p.ym.slice(5))} 月 1 日至 ${Number(monthEnd(p.ym).slice(8))} 日` };
}

export function periodState(params, defaultYm) {
  return { mode: params.pm || 'month', ym: params.ym || defaultYm, from: params.pf || `${defaultYm}-01`, to: params.pt || monthEnd(defaultYm) };
}

export function periodHandlers(p, ctx, redraw) {
  return {
    period: (el) => {
      p.mode = el.value;
      ctx.setParams({ pm: p.mode });
      redraw();
    },
    pym: (el) => {
      if (!el.value) return;
      p.ym = el.value;
      ctx.setParams({ ym: p.ym });
      redraw();
    },
    pfrom: (el) => {
      p.from = el.value;
      ctx.setParams({ pf: p.from });
      redraw();
    },
    pto: (el) => {
      p.to = el.value;
      ctx.setParams({ pt: p.to });
      redraw();
    },
  };
}

export async function reportHead(title, periodLabel) {
  const s = await getSettings();
  return h`<div class="report-head"><div class="co">${s.business_name}</div><div class="rt">${title}</div><div class="rp">${periodLabel}　單位：新台幣元</div></div>`;
}

export function latestMonth(lines, fallback) {
  const d = lines.reduce((m, l) => (l.date > m ? l.date : m), '');
  return (d || fallback || today()).slice(0, 7);
}

/**
 * 分錄編輯器（新增或修改），含附件憑證（拍照、上傳、從憑證匣選擇）。回傳儲存後的分錄或 null。
 * defaults: { date, description, source, source_ref, lines, attachments, docExtra }
 */
export async function editEntry(entry = null, { defaults = {}, title = null } = {}) {
  const accounts = await getAccounts();
  const settings = await getSettings();
  const e = entry ? JSON.parse(JSON.stringify(entry)) : { date: defaults.date || today(), description: defaults.description || '', source: defaults.source || 'manual', source_ref: defaults.source_ref || null, lines: defaults.lines || [{ account: '', debit: '', credit: '', memo: '' }, { account: '', debit: '', credit: '', memo: '' }], attachments: defaults.attachments || [] };
  if (entry && isLocked(settings, entry.date)) {
    toast('這個月份已結帳鎖定，無法修改', 'error');
    return null;
  }
  const readonly = entry && AUTO_SOURCES.has(entry.source);
  const prevAtt = [...(e.attachments || [])];
  const att = { ids: [...prevAtt] };
  const lineRow = (l, i) => h`<tr data-i="${i}">
    <td>${accountSelect(accounts, l.account, `name="acc" ${readonly ? 'disabled' : ''}`)}</td>
    <td><input class="cell num" name="dr" inputmode="decimal" value="${l.debit || ''}" ${readonly ? raw('disabled') : ''}></td>
    <td><input class="cell num" name="cr" inputmode="decimal" value="${l.credit || ''}" ${readonly ? raw('disabled') : ''}></td>
    <td><input class="cell" name="memo" value="${l.memo || ''}" ${readonly ? raw('disabled') : ''}></td>
    <td>${readonly ? '' : h`<button type="button" class="icon-btn" data-del title="刪除此行">✕</button>`}</td>
  </tr>`;
  const body = h`
    ${readonly ? h`<div class="callout" style="margin-bottom:10px"><p>此分錄由系統依「${SOURCE_LABEL[entry.source]}」自動產生，請修改來源資料（例如品項品類、撥款明細）後重新同步。</p></div>` : ''}
    <div class="form-grid" style="margin-bottom:10px">
      <label class="field"><span>日期</span><input type="date" name="date" value="${e.date}" ${readonly ? raw('disabled') : ''}></label>
      <label class="field" style="grid-column:span 2"><span>摘要</span><input type="text" name="desc" value="${e.description || ''}" ${readonly ? raw('disabled') : ''}></label>
    </div>
    <div class="table-wrap"><table class="grid"><thead><tr><th style="width:38%">會計項目</th><th class="num">借方</th><th class="num">貸方</th><th>說明</th><th></th></tr></thead>
    <tbody id="je-lines">${e.lines.map(lineRow)}</tbody>
    <tfoot><tr><td>${readonly ? '' : h`<button type="button" class="btn sm" data-add>＋ 新增一行</button>`}</td><td class="num" id="je-dr"></td><td class="num" id="je-cr"></td><td colspan="2" id="je-bal"></td></tr></tfoot></table></div>
    <div id="je-att" style="margin-top:12px"></div>
    <p class="muted" style="font-size:12.5px;margin-top:8px">傳票號碼儲存時自動編列（民國年月－流水號）；借貸必須平衡才能儲存。附上的發票、收據會自動命名歸檔，也會出現在「憑證歸檔」。</p>`;
  const collect = (dlg) => {
    const rows = [...dlg.querySelectorAll('#je-lines tr')].map((tr) => ({
      account: tr.querySelector('[name=acc]').value,
      debit: Number(String(tr.querySelector('[name=dr]').value).replace(/,/g, '')) || 0,
      credit: Number(String(tr.querySelector('[name=cr]').value).replace(/,/g, '')) || 0,
      memo: tr.querySelector('[name=memo]').value.trim(),
    }));
    return { ...e, date: dlg.querySelector('[name=date]').value, description: dlg.querySelector('[name=desc]').value.trim(), lines: rows.filter((r) => r.account || r.debit || r.credit) };
  };
  const refresh = (dlg) => {
    const t = entryTotals(collect(dlg));
    dlg.querySelector('#je-dr').textContent = fmt(t.debit);
    dlg.querySelector('#je-cr').textContent = fmt(t.credit);
    const diff = Math.round((t.debit - t.credit) * 100) / 100;
    dlg.querySelector('#je-bal').textContent = diff ? `差額 ${fmt(diff)}` : '借貸平衡 ✓';
  };
  const result = await modal({
    title: title || (entry ? `分錄 ${entry.voucher_no || ''}｜${voucherKind(entry)}` : '新增分錄'),
    wide: true,
    body,
    actions: readonly
      ? [
          { label: '關閉', value: null },
          { label: '儲存附件', primary: true, value: () => ({ ...e, attachmentsOnly: true }) },
        ]
      : [
          { label: '取消', value: null },
          {
            label: '儲存',
            primary: true,
            value: (dlg) => {
              const x = collect(dlg);
              const errs = validateEntry(x, accountMap(accounts));
              if (isLocked(settings, x.date)) errs.unshift('該月份已結帳鎖定');
              if (errs.length) {
                toast(errs[0], 'error', 5000);
                return false;
              }
              return x;
            },
          },
        ],
    onMount: (dlg) => {
      attachmentEditor(dlg.querySelector('#je-att'), att, { newDocExtra: () => ({ ...(defaults.docExtra || {}) }), newDocFallback: () => ({ doc_date: dlg.querySelector('[name=date]').value || undefined }) });
      refresh(dlg);
      dlg.addEventListener('input', () => refresh(dlg));
      dlg.addEventListener('change', () => refresh(dlg));
      dlg.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-add]')) {
          const tb = dlg.querySelector('#je-lines');
          tb.insertAdjacentHTML('beforeend', String(lineRow({ account: '', debit: '', credit: '', memo: '' }, tb.children.length)));
        }
        const del = ev.target.closest('[data-del]');
        if (del && dlg.querySelectorAll('#je-lines tr').length > 2) {
          del.closest('tr').remove();
          refresh(dlg);
        }
      });
    },
  });
  if (!result) return null;
  if (result.attachmentsOnly) {
    const saved = { ...entry, attachments: att.ids, updated_at: new Date().toISOString() };
    await store.put('journal_entries', saved);
    await linkDocumentsToEntry(saved, att.ids, prevAtt);
    toast('附件已儲存', 'good');
    return saved;
  }
  const all = await store.all('journal_entries');
  const saved = { ...result, attachments: att.ids, lines: result.lines.map((l) => ({ ...l, debit: Math.round(l.debit * 100) / 100, credit: Math.round(l.credit * 100) / 100 })) };
  if (!saved.id) {
    saved.id = uid('je_');
    saved.status = 'posted';
    saved.created_at = new Date().toISOString();
  }
  if (!saved.voucher_no || saved.voucher_no.slice(0, 5) !== nextVoucherNo([], saved.date).slice(0, 5)) saved.voucher_no = nextVoucherNo(all.filter((x) => x.id !== saved.id), saved.date);
  saved.updated_at = new Date().toISOString();
  await store.put('journal_entries', saved);
  await linkDocumentsToEntry(saved, att.ids, prevAtt);
  toast(`已儲存 ${saved.voucher_no}${att.ids.length ? `（附件 ${att.ids.length} 張）` : ''}`, 'good');
  return saved;
}

// 需要附原始憑證的分錄：手動、資產購置、存摺補登，且借方有費用、成本、存貨或固定資產科目
// （折舊、銀行手續費、利息以存摺為憑，不需另附）
const DOC_TYPES = new Set(['expense', 'cogs', 'nonop_expense']);
const DOC_ASSETS = /^(121[1-6]|1511|1521|1531|1541)$/;
const NO_DOC = new Set(['6124', '6131', '7501']);
export function needsDocument(e, accMap) {
  if (!['manual', 'asset', 'bank'].includes(e.source)) return false;
  return (e.lines || []).some((l) => l.debit > 0 && !NO_DOC.has(l.account) && (DOC_TYPES.has(accMap.get(l.account)?.type) || DOC_ASSETS.test(l.account)));
}

export { addMonths };
