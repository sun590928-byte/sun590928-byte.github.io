// 日記簿「修改」憑證入帳的分錄（2026-11-12 老闆需求 二-1）：在同一個視窗直接改課稅別、扣抵代號、拆分明細，
// 按「儲存並同步」→ 更新憑證（仍是已入帳）→ 依入帳規則重新產生分錄（同一張傳票、同一個傳票號）→ 401 進項清單跟著變。
// 以前要：日記簿刪分錄 → 憑證歸檔找卡片 → 改欄位 → 拆分 → 重新入帳（傳票號還會換）。

import { h, raw, modal, toast, fmt, options } from '../ui.js';
import { store } from '../store.js';
import { getAccounts, getSettings, isLocked } from '../state.js';
import { accountMap, ASSET_CATEGORIES } from '../lib/coa.js';
import { validateEntry, nextVoucherNo, voucherKind } from '../lib/ledger.js';
import { TAX_TYPES, DED_CODES } from '../lib/vat.js';
import { applyDocEdit, docEditRows, sameLines, filedPeriodsFor, assetGroups, isBlankRow } from '../lib/docedit.js';
import { attachmentEditor, linkDocumentsToEntry, archivePatch, previewDocument, docLabel } from '../attach.js';
import { syncDepreciation } from '../sync.js';
import { accountSelect, payAccountSelect } from './_shared.js';

// 按「直接改分錄（不改憑證）」：回到原本的分錄編輯器
export const MANUAL = 'manual';

export async function editDocumentEntry(entry, doc) {
  const accounts = await getAccounts();
  const settings = await getSettings();
  const accMap = accountMap(accounts);
  const [filings, assets, einvoices, docs] = await Promise.all([store.all('tax_filings'), store.all('fixed_assets'), store.all('einvoices'), store.all('documents')]);
  // 別張已入帳的憑證、電子發票用掉的發票號碼（改號碼時不能撞號）；連著的電子發票號碼要保留，不然 401 會算兩次
  const linkedInv = doc.einvoice_id ? einvoices.find((i) => i.id === doc.einvoice_id && i.entry_id === entry.id) : null;
  const taken = new Set([
    ...docs.filter((d) => d.id !== doc.id && d.status === 'posted').flatMap((d) => [d.invoice_no, ...(Array.isArray(d.lines) ? d.lines.map((p) => p.invoice_no) : [])]),
    ...einvoices.filter((i) => i.entry_id && !i.voided && i.id !== linkedInv?.id).map((i) => i.invoice_no),
  ].filter(Boolean));
  const opts = { taxId: settings.tax_id, vatMode: settings.vat_mode, payAccount: settings.doc_pay_account || '2134', accounts: new Set(accounts.map((a) => a.code)), takenInvoiceNos: taken, linkedInvoiceNo: linkedInv?.invoice_no || '' };
  const rows0 = docEditRows(doc, opts);
  const first = applyDocEdit(doc, { rows: rows0 }, opts);
  const drift = first.journal && !sameLines(first.journal.lines, entry.lines);
  const myAssets = assets.filter((a) => a.purchase_entry_id === entry.id && (a.doc_ids || []).includes(doc.id));
  const prevAtt = [...(entry.attachments || [])];
  const att = { ids: prevAtt.includes(doc.id) ? [...prevAtt] : [doc.id, ...prevAtt] };
  const others = prevAtt.filter((id) => id !== doc.id).length;
  const ddOpts = (pairs) => pairs.map(([k, v]) => [k, `${k} ${v}`]);
  const DED_SHORT = { 1: '可扣抵', 2: '可扣抵（固定資產）', 3: '不可扣抵', 4: '不可扣抵（固定資產）' }; // 下拉放得下；完整名稱在欄位說明

  const rowHtml = (r = {}) => h`<tr>
    <td><input class="cell" name="inv" value="${r.invoice_no || ''}" placeholder="AB12345678" style="width:112px" autocomplete="off" aria-label="發票號碼"></td>
    <td>${accountSelect(accounts, r.account || '', 'name="acc" aria-label="會計項目" style="width:170px"')}</td>
    <td><input class="cell num" name="amt" inputmode="decimal" value="${r.amount ?? ''}" style="width:92px" autocomplete="off" aria-label="含稅金額"></td>
    <td><input class="cell num" name="tax" inputmode="decimal" value="${r.tax || ''}" style="width:72px" autocomplete="off" aria-label="稅額"></td>
    <td><select name="tt" aria-label="課稅別" style="width:96px">${options(ddOpts(Object.entries(TAX_TYPES)), r.tax_type || '1')}</select></td>
    <td><select name="dc" aria-label="扣抵代號" style="width:150px" title="${Object.entries(DED_CODES).map(([k, v]) => `${k} ${v}`).join('、')}">${options(ddOpts(Object.entries(DED_SHORT)), r.ded_code || '3')}</select></td>
    <td><input class="cell" name="memo" value="${r.memo || ''}" style="width:110px" autocomplete="off" aria-label="說明"></td>
    <td class="de-ok" style="font-size:12.5px;max-width:150px"></td>
    <td><button type="button" class="icon-btn" data-del aria-label="刪除此行">✕</button></td>
  </tr>`;

  const body = h`
    <div class="callout" style="margin-bottom:10px"><p>這張分錄是憑證「<b>${docLabel(doc)}</b>」入帳產生的。<button type="button" class="btn sm ghost" data-de="photo">看照片</button><br>
      直接改下面的<b>課稅別、扣抵代號、拆分明細</b>，按「儲存並同步」後：憑證一起更新、分錄依入帳規則重新產生（傳票號不變），「營業稅 401」的進項清單也會跟著變。</p></div>
    ${drift ? h`<div class="callout warn" style="margin-bottom:10px"><p>這張分錄和憑證算出來的不一樣（可能以前手動改過分錄）。儲存並同步會依憑證重新產生分錄；要保留手動的分錄，請按「直接改分錄（不改憑證）」。</p></div>` : ''}
    ${myAssets.length ? h`<div class="callout warn" style="margin-bottom:10px"><p>這張憑證入帳時建立了固定資產「${myAssets.map((a) => a.name).join('、')}」。改了扣抵或金額，儲存時會照新的未稅金額更新取得成本並重算折舊（已結帳鎖定月份的折舊不會變）。</p></div>` : ''}
    <div id="de-filed"></div>
    <div class="form-grid" style="margin-bottom:10px">
      <label class="field"><span>日期</span><input type="date" name="date" value="${entry.date}"></label>
      <label class="field" style="grid-column:span 2"><span>摘要</span><input type="text" name="desc" value="${entry.description || ''}"></label>
      <label class="field"><span>憑證金額（含稅）</span><input type="text" value="${fmt(Number(doc.amount_total) || 0)}" disabled></label>
      <label class="field" style="grid-column:span 2"><span>付款方式</span>${payAccountSelect(accounts, doc.pay_account || opts.payAccount, 'name="pay"')}</label>
    </div>
    <h3 style="font-size:14px;margin:4px 0">憑證明細（課稅別、扣抵代號、拆分）</h3>
    <p class="muted" style="font-size:12.5px;margin-bottom:6px">一行＝一張發票或一個科目；含稅金額合計要等於憑證金額。要拆成兩張發票或兩個科目就按「＋ 拆成多行」，再把金額分開填。扣抵代號 1、2 可扣抵（稅額記進項稅額 1261），3、4 不可扣抵（稅額併入費用或成本）。</p>
    <div class="table-wrap"><table class="grid"><thead><tr><th>發票號碼</th><th>會計項目</th><th class="num">含稅金額</th><th class="num">稅額</th><th>課稅別</th><th>扣抵代號</th><th>說明</th><th>可否扣抵</th><th></th></tr></thead>
      <tbody id="de-rows">${rows0.map(rowHtml)}</tbody>
      <tfoot><tr><td colspan="2"><button type="button" class="btn sm" data-de="add">＋ 拆成多行</button></td><td class="num" id="de-sum"></td><td colspan="6" id="de-sumnote"></td></tr></tfoot></table></div>
    <div id="de-err" style="margin-top:6px"></div>
    <h3 style="font-size:14px;margin:12px 0 4px">儲存後的分錄</h3>
    <div class="table-wrap"><table class="grid"><thead><tr><th style="width:38%">會計項目</th><th class="num">借方</th><th class="num">貸方</th><th>說明</th></tr></thead><tbody id="de-preview"></tbody></table></div>
    <div id="je-att" style="margin-top:12px"></div>
    ${others ? h`<p class="muted" style="font-size:12.5px;margin-top:6px">另外附的 ${others} 張憑證只當附件，不會被這次修改改到。</p>` : ''}`;

  const collect = (dlg) => ({
    date: dlg.querySelector('[name=date]').value,
    desc: dlg.querySelector('[name=desc]').value.trim(),
    pay: dlg.querySelector('[name=pay]').value,
    rows: [...dlg.querySelectorAll('#de-rows tr')].map((tr) => {
      const v = (n) => tr.querySelector(`[name=${n}]`).value;
      return { invoice_no: v('inv'), account: v('acc'), amount: v('amt'), tax: v('tax'), tax_type: v('tt'), ded_code: v('dc'), memo: v('memo') };
    }),
  });

  // 依目前畫面組出：新憑證、新分錄、會影響的已申報期別
  const build = (dlg) => {
    const x = collect(dlg);
    const r = applyDocEdit(doc, { rows: x.rows, pay_account: x.pay, date: x.date }, opts);
    const after = r.doc || { ...doc, doc_date: x.date || doc.doc_date };
    const filed = filedPeriodsFor([doc, after], filings);
    if (r.errors.length) return { ...r, x, filed };
    // 摘要沒動過（或清空）就用重新產生的（發票號碼改了會跟著變）；動過就保留手打的
    const description = x.desc && x.desc !== (entry.description || '').trim() ? x.desc : r.journal.description;
    const saved = { ...entry, date: x.date, description, lines: r.journal.lines };
    return { ...r, x, filed, saved };
  };

  let filedKey = null;
  const refresh = (dlg) => {
    const b = build(dlg);
    const trs = [...dlg.querySelectorAll('#de-rows tr')];
    const live = trs.filter((tr, i) => !isBlankRow(b.x.rows[i]));
    live.forEach((tr, i) => {
      const c = b.checks?.[i];
      // 代號 3、4 本身就是不可扣抵，不再重複原因
      const why = c && !/^扣抵代號/.test(c.reason) ? c.reason : '';
      tr.querySelector('.de-ok').innerHTML = String(!c ? '' : c.conflict ? h`<span style="color:var(--bad)">✕ 不能扣抵：${c.conflict}</span>` : c.ok ? h`<span style="color:var(--good)">✓ 可扣抵</span>` : h`<span class="muted">不可扣抵${why ? `：${why}` : ''}</span>`);
    });
    for (const tr of trs) if (!live.includes(tr)) tr.querySelector('.de-ok').textContent = '';
    const diff = Math.round(((b.sum || 0) - (b.total || 0)) * 100) / 100;
    dlg.querySelector('#de-sum').textContent = fmt(b.sum || 0);
    dlg.querySelector('#de-sumnote').innerHTML = String(Math.abs(diff) >= 1 ? h`<b style="color:var(--bad)">與憑證金額 ${fmt(b.total)} 差 ${fmt(diff)}</b>` : h`＝ 憑證金額 ${fmt(b.total)} ✓`);
    dlg.querySelector('#de-err').innerHTML = String(b.errors.length ? h`<div class="callout bad"><p>${b.errors.map((e) => h`<span style="display:block">${e}</span>`)}</p></div>` : '');
    dlg.querySelector('#de-preview').innerHTML = String(
      b.saved
        ? h`${b.saved.lines.map((l) => h`<tr><td>${l.credit ? raw('<span class="indent"></span>') : ''}${l.account} ${accMap.get(l.account)?.name || ''}</td><td class="num">${l.debit ? fmt(l.debit) : ''}</td><td class="num">${l.credit ? fmt(l.credit) : ''}</td><td>${l.memo || ''}</td></tr>`)}`
        : h`<tr><td colspan="4" class="muted">明細改好後會顯示</td></tr>`,
    );
    const box = dlg.querySelector('#de-filed');
    const key = b.filed.map((f) => f.id).join(',');
    if (key === filedKey) return; // 期別沒變就不重畫（保留勾選與焦點）
    filedKey = key;
    box.innerHTML = String(
      b.filed.length
        ? h`<div class="callout warn" style="margin-bottom:10px"><p><b>${b.filed.map((f) => f.label).join('、')} 已經申報 401</b>（${b.filed.map((f) => (f.status === 'paid' ? '已繳稅' : '已申報') + (f.filed_on ? ` ${f.filed_on}` : '')).join('、')}）。申報紀錄不會自動改：改了之後帳上和已申報的數字會不一樣，改成可扣抵的稅額會延到下一個還沒申報的期別扣抵；需要時請向國稅局更正申報。</p>
          <label class="check"><input type="checkbox" id="de-filed-ok"> 我知道了，仍要修改</label></div>`
        : '',
    );
  };

  const result = await modal({
    title: `分錄 ${entry.voucher_no || ''}｜${voucherKind(entry)}（憑證）`,
    wide: true,
    body,
    actions: [
      { label: '取消', value: null },
      { label: '直接改分錄（不改憑證）', value: MANUAL },
      {
        label: '儲存並同步',
        primary: true,
        value: (dlg) => {
          const b = build(dlg);
          if (b.errors.length) return toast(b.errors[0], 'error', 6000), false;
          const errs = validateEntry(b.saved, accMap);
          if (isLocked(settings, b.saved.date)) errs.unshift('該月份已結帳鎖定');
          if (errs.length) return toast(errs[0], 'error', 5000), false;
          if (b.filed.length && !dlg.querySelector('#de-filed-ok')?.checked) return toast(`${b.filed.map((f) => f.label).join('、')} 已申報 401：請先勾「我知道了，仍要修改」`, 'error', 6000), false;
          return b;
        },
      },
    ],
    onMount: (dlg) => {
      attachmentEditor(dlg.querySelector('#je-att'), att, { newDocFallback: () => ({ doc_date: dlg.querySelector('[name=date]').value || undefined }) });
      refresh(dlg);
      dlg.addEventListener('input', () => refresh(dlg));
      dlg.addEventListener('change', () => refresh(dlg));
      dlg.addEventListener('click', (ev) => {
        const act = ev.target.closest('[data-de]')?.dataset.de;
        if (act === 'photo') previewDocument(doc);
        if (act === 'add') {
          // 新的一行先帶上一行的課稅別、扣抵代號
          const last = dlg.querySelector('#de-rows tr:last-child');
          dlg.querySelector('#de-rows').insertAdjacentHTML('beforeend', String(rowHtml({ tax_type: last?.querySelector('[name=tt]').value || '1', ded_code: last?.querySelector('[name=dc]').value || '1' })));
          dlg.querySelector('#de-rows tr:last-child [name=inv]').focus();
          refresh(dlg);
        }
        const del = ev.target.closest('#de-rows [data-del]');
        if (del && dlg.querySelectorAll('#de-rows tr').length > 1) {
          del.closest('tr').remove();
          refresh(dlg);
        }
      });
    },
  });
  if (!result || result === MANUAL) return result;

  // ── 存檔：分錄（同 id、同傳票號；換月份才重編）→ 憑證（仍是已入帳、重算歸檔名、留修改紀錄）→ 附件連結 → 電子發票科目 → 固定資產成本
  const now = new Date().toISOString();
  const all = await store.all('journal_entries');
  const saved = { ...result.saved, attachments: att.ids.includes(doc.id) ? att.ids : [doc.id, ...att.ids], updated_at: now };
  if (!saved.voucher_no || saved.voucher_no.slice(0, 5) !== nextVoucherNo([], saved.date).slice(0, 5)) saved.voucher_no = nextVoucherNo(all.filter((x) => x.id !== saved.id), saved.date);
  const changes = result.changes || [];
  const nextDoc = { ...result.doc };
  if (nextDoc.archived_name) {
    const { archived_name, storage_path } = await archivePatch(nextDoc);
    Object.assign(nextDoc, { archived_name, storage_path });
  }
  const log = { at: now, via: '日記簿修改', by: store.location?.email || '', entry_id: saved.id, voucher_no: saved.voucher_no, changes };
  const docSaved = { ...nextDoc, status: 'posted', entry_id: saved.id, updated_at: now, edit_log: [...(doc.edit_log || []), log].slice(-20) };
  await store.put('journal_entries', saved);
  await store.put('documents', docSaved);
  await linkDocumentsToEntry(saved, saved.attachments, prevAtt);
  if (linkedInv && linkedInv.account !== docSaved.account) await store.put('einvoices', { ...linkedInv, account: docSaved.account });
  const assetNote = await updateAssets(myAssets, docSaved);
  toast(`已儲存 ${saved.voucher_no}，憑證與 401 進項已同步${changes.length ? `（${changes.slice(0, 3).join('；')}${changes.length > 3 ? `…等 ${changes.length} 項` : ''}）` : ''}${assetNote}`, 'good', 8000);
  return saved;
}

// 入帳時自動建立的固定資產：依新的未稅金額更新取得成本、可扣抵稅額，再重算折舊
async function updateAssets(myAssets, d) {
  if (!myAssets.length) return '';
  const groups = assetGroups(d);
  const upd = [];
  const lost = [];
  for (const a of myAssets) {
    const g = groups.get(ASSET_CATEGORIES[a.category]?.asset);
    if (!g) {
      lost.push(a.name);
      continue;
    }
    if (g.cost !== a.cost || (g.tax || null) !== (a.tax_amount || null)) upd.push({ ...a, cost: g.cost, tax_amount: g.tax || null, invoice_no: g.invoices.join('+') || a.invoice_no });
  }
  if (upd.length) {
    await store.put('fixed_assets', upd);
    await syncDepreciation();
  }
  return `${upd.length ? `；固定資產「${upd.map((a) => a.name).join('、')}」取得成本已更新為 ${upd.map((a) => fmt(a.cost)).join('、')}` : ''}${lost.length ? `；固定資產「${lost.join('、')}」的科目已不在憑證裡，請到「固定資產與折舊」確認` : ''}`;
}
