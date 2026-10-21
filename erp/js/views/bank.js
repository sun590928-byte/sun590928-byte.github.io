// 銀行存摺對帳：匯入存摺明細（網銀檔或存摺照片）、自動勾稽帳上「銀行存款」分錄、補登未入帳項目，產生銀行存款餘額調節表。
// 存摺照片在這台電腦辨識（不用外部 AI）：每列用「上一列結存 ± 金額 ＝ 結存」核對，列出所有讀到的列讓使用者勾選、修正後才匯入。

import { h, raw, mount, bindActions, dataTable, fmt, stat, status, toast, modal, options, emptyState, pickFiles, setBusy } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getAccounts, isLocked } from '../state.js';
import { bookLines, autoMatch, reconciliation } from '../lib/bank.js';
import { parsePassbookText, verifyChain, toBankLine, alreadyImported, suggestBankAccount, bankHistory } from '../lib/passbook.js';
import { readPassbook, releaseOcr } from '../vision.js';
import { nextVoucherNo } from '../lib/ledger.js';
import { monthEnd, today } from '../lib/dates.js';
import { uid } from '../lib/text.js';
import { accountSelect, latestMonth, reportHead } from './_shared.js';

// 其他頁面（例如憑證歸檔選資料夾時的「存摺明細」）送過來的存摺照片
const queued = [];
export function queuePassbookPhotos(files) {
  queued.push(...files);
}

const STATUS_CHIP = {
  ok: ['good', '對得上'],
  corrected: ['good', '結存推算'],
  inferred: ['warn', '金額推算'],
  check: ['bad', '需確認'],
  duplicate: ['na', '重複'],
  imported: ['na', '已匯入'],
  manual: ['info', '手動新增'],
};
const near = (a, b) => Math.abs(a - b) < 0.5;
const num = (v) => {
  const n = Number(String(v ?? '').replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

// 檔名上的期間：「20260907-20260911-淡信存摺明細.jpg」
function rangeOf(name) {
  const d = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  const m = /(20\d{6})\D+(20\d{6})/.exec(name) || /(20\d{6})/.exec(name);
  if (!m) return { year: Number(today().slice(0, 4)), from: null, to: null };
  return { year: Number(m[1].slice(0, 4)), from: d(m[1]), to: m[2] ? d(m[2]) : null };
}

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  let [bankLines, entries] = await Promise.all([store.all('bank_lines'), store.all('journal_entries')]);
  const acctIds = () => [...new Set(bankLines.map((b) => b.bank_account_id || 'main'))];
  const f = { acct: ctx.params.acct || acctIds()[0] || 'main', asOf: ctx.params.asof || monthEnd(latestMonth(bankLines, settings.revenue_start)), gl: ctx.params.gl || settings.bank_gl || '1103' };

  async function reload() {
    [bankLines, entries] = await Promise.all([store.all('bank_lines'), store.all('journal_entries')]);
  }

  async function draw() {
    const lines = bankLines.filter((b) => (b.bank_account_id || 'main') === f.acct).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.balance ?? 0) - (b.balance ?? 0)));
    if (!lines.length) {
      mount(
        root,
        h`<div class="card">${emptyState(
          '尚未匯入存摺明細',
          '兩種方式：拍存摺內頁的照片，在這台電腦辨識（會用結存逐列核對，讓你勾選要匯入的列）；或從網路銀行下載交易明細（CSV／XLSX），到「匯入中心」選「銀行存摺明細」。匯入後自動與帳上的銀行存款分錄勾稽。',
          h`<div class="row" style="justify-content:center"><button class="btn primary" data-act="photos">匯入存摺照片</button><a class="btn" href="#/import">匯入網銀明細檔</a></div>`,
        )}</div>`,
      );
      return;
    }
    const books = bookLines(entries, f.gl);
    const matches = autoMatch(lines, books);
    const rec = reconciliation({ bankLines: lines, books, matches, asOf: f.asOf });
    const bookByKey = new Map(books.map((b) => [b.key, b]));
    const head = await reportHead('銀行存款餘額調節表', `截至 ${f.asOf}｜帳戶 ${f.acct}｜會計項目 ${f.gl}`);
    const pendingAuto = lines.filter((b) => !b.match_key && matches.has(b.id)).length;
    const unbooked = lines.filter((b) => !matches.has(b.id) && !isLocked(settings, b.date)).length;
    const sum = (arr, k) => arr.reduce((t, x) => t + x[k], 0);
    mount(
      root,
      h`<div class="toolbar no-print">
        <label class="field"><span>存摺帳戶</span><select data-act="acct">${options(acctIds().map((a) => [a, a]), f.acct)}</select></label>
        <label class="field"><span>對應會計項目</span>${accountSelect(accounts, f.gl, 'data-act="gl"')}</label>
        <label class="field"><span>對帳截止日</span><input type="date" value="${f.asOf}" data-act="asof"></label>
        <span class="spacer"></span>
        <button class="btn" data-act="photos" title="在這台電腦辨識存摺內頁照片，逐列核對結存後勾選匯入">匯入存摺照片</button>
        ${pendingAuto ? h`<button class="btn primary" data-act="confirmAll">確認 ${pendingAuto} 筆自動勾稽</button>` : ''}
        ${unbooked ? h`<button class="btn" data-act="bookMany" title="存摺上有、帳上沒有的項目，一次補登分錄（依摘要建議會計項目）">批次補登（${unbooked}）</button>` : ''}
        <button class="btn" data-act="print">列印調節表</button>
      </div>
      <div class="stats">
        ${stat('存摺餘額', '$' + fmt(rec.bankBalance), `截至 ${f.asOf}`)}
        ${stat('帳面餘額', '$' + fmt(rec.bookBalance), `${f.gl} 銀行存款`)}
        ${stat('已勾稽', fmt(rec.matchedCount), `存摺 ${lines.filter((b) => b.date <= f.asOf).length} 筆`)}
        ${stat('調節後差異', fmt(rec.diff), Math.abs(rec.diff) < 0.5 ? '已平衡' : '需查明', Math.abs(rec.diff) < 0.5 ? 'good' : 'bad')}
      </div>
      <div class="card report" style="max-width:none">${head}
        <div class="grid-2">
          <table class="fin">
            <tr class="h"><td>存摺餘額</td><td class="amt">${fmt(rec.bankBalance)}</td></tr>
            <tr class="i"><td>加：在途存款（帳上已記、銀行未入）${rec.depositsInTransit.length} 筆</td><td class="amt">${fmt(sum(rec.depositsInTransit, 'debit'))}</td></tr>
            <tr class="i"><td>減：未兌現支出（帳上已記、銀行未扣）${rec.outstanding.length} 筆</td><td class="amt">(${fmt(sum(rec.outstanding, 'credit'))})</td></tr>
            <tr class="gt"><td>調整後存摺餘額</td><td class="amt">${fmt(rec.adjBank)}</td></tr>
          </table>
          <table class="fin">
            <tr class="h"><td>帳面餘額</td><td class="amt">${fmt(rec.bookBalance)}</td></tr>
            <tr class="i"><td>加：銀行已入、帳上未記 ${rec.bankOnlyIn.length} 筆</td><td class="amt">${fmt(sum(rec.bankOnlyIn, 'deposit'))}</td></tr>
            <tr class="i"><td>減：銀行已扣、帳上未記 ${rec.bankOnlyOut.length} 筆</td><td class="amt">(${fmt(sum(rec.bankOnlyOut, 'withdrawal'))})</td></tr>
            <tr class="gt"><td>調整後帳面餘額</td><td class="amt">${fmt(rec.adjBook)}</td></tr>
          </table>
        </div>
        <p style="margin-top:10px">${Math.abs(rec.diff) < 0.5 ? status('good', '調整後餘額一致') : status('bad', `差異 ${fmt(rec.diff)}：請檢查帳上金額是否誤植，或存摺期初餘額是否正確`)}</p>
      </div>
      <div class="card no-print"><div class="card-head"><h2>存摺明細</h2><span class="card-note">未勾稽的項目可「補登分錄」（例如利息、轉帳手續費、自動扣繳水電、漏記的存入）；一次很多筆用上方「批次補登」</span></div><div id="bl"></div></div>
      ${rec.depositsInTransit.length || rec.outstanding.length ? h`<div class="card no-print"><div class="card-head"><h2>帳上有、存摺沒有</h2></div><div id="bo"></div></div>` : ''}`,
    );
    dataTable(root.querySelector('#bl'), {
      rows: lines,
      pageSize: 100,
      initialSort: { key: 'date', dir: 1 },
      columns: [
        { key: 'date', label: '日期' },
        { key: 'description', label: '摘要', fmt: (v, r) => [v, r.note && !String(v).includes(r.note) ? r.note : '', r.counterparty].filter(Boolean).join('｜') },
        { key: 'withdrawal', label: '支出', align: 'num', fmt: (v) => (v ? fmt(v) : '') },
        { key: 'deposit', label: '存入', align: 'num', fmt: (v) => (v ? fmt(v) : '') },
        { key: 'balance', label: '餘額', align: 'num', fmt: (v) => (v === null || v === undefined ? '' : fmt(v)) },
        {
          key: 'id',
          label: '勾稽',
          nosort: true,
          fmt: (v, r) => {
            const k = matches.get(v);
            if (k) {
              const b = bookByKey.get(k);
              return h`${status(r.match_key ? 'good' : 'warn', `${b?.voucher_no || ''} ${r.match_key ? '' : '（自動）'}`)} <button class="btn sm ghost" data-act="unmatch" data-id="${v}">取消</button>`;
            }
            return h`<button class="btn sm" data-act="book" data-id="${v}" ${isLocked(settings, r.date) ? raw('disabled') : ''}>補登分錄</button> <button class="btn sm ghost" data-act="pick" data-id="${v}">手動對應</button>`;
          },
        },
      ],
    });
    const bo = root.querySelector('#bo');
    if (bo)
      dataTable(bo, {
        rows: [...rec.depositsInTransit, ...rec.outstanding],
        columns: [
          { key: 'date', label: '日期' },
          { key: 'voucher_no', label: '傳票' },
          { key: 'memo', label: '摘要' },
          { key: 'debit', label: '借（存入）', align: 'num', fmt: (v) => (v ? fmt(v) : '') },
          { key: 'credit', label: '貸（支出）', align: 'num', fmt: (v) => (v ? fmt(v) : '') },
        ],
      });
    root._ctx = { lines, books, matches };
  }

  // ── 存摺照片：辨識 → 帳鏈核對 → 列出全部讀到的列 → 勾選、修正 → 匯入
  async function importPhotos(files) {
    files = files.filter((x) => /^image\//i.test(x.type) || /\.(jpe?g|png|webp)$/i.test(x.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
    if (!files.length) return toast('請選存摺內頁的照片（JPG、PNG）', 'info');
    const pages = [];
    const failed = [];
    try {
      for (const [i, file] of files.entries()) {
        const range = rangeOf(file.name);
        setBusy(true, `辨識存摺照片 ${i + 1}/${files.length}…（每張約 5 秒，在這台電腦辨識）`);
        try {
          const r = await readPassbook(file, { score: (t) => parsePassbookText(t, range).rows.length });
          const page = parsePassbookText(r.text, range);
          if (!page.rows.length) failed.push(`${file.name}：沒有讀到存摺明細列（照片請拍正、對焦清楚、整頁入鏡）`);
          pages.push({ ...page, file });
        } catch (e) {
          failed.push(`${file.name}：${e.message || e}`);
        }
      }
    } finally {
      setBusy(false);
      releaseOcr();
    }
    const usable = pages.filter((p) => p.rows.length);
    if (!usable.length) {
      await modal({ title: '存摺照片沒有讀到內容', body: h`<ul class="plain-list">${failed.map((x) => h`<li>${x}</li>`)}</ul>` });
      return;
    }
    const rows = verifyChain(usable.map(({ opening, rows }) => ({ opening, rows })));
    const sameAcct = bankLines.filter((b) => (b.bank_account_id || 'main') === f.acct);
    for (const r of rows) if (r.status !== 'duplicate' && r.date && alreadyImported(r, sameAcct)) r.imported = true;
    const picked = await reviewRows(rows, usable, failed);
    if (!picked) return;
    const batchId = uid('b_bank_');
    const all = picked.rows.map((r) => toBankLine(r, { bankAccountId: picked.acct, batchId }));
    const existing = bankLines.filter((b) => (b.bank_account_id || 'main') === picked.acct);
    const add = all.filter((b) => !alreadyImported(b, existing));
    if (add.length) {
      await store.put('bank_lines', add);
      const dates = add.map((b) => b.date).sort();
      await store.put('import_batches', { id: batchId, target: 'bank', file_name: usable.map((p) => p.file.name).join('、'), encoding: 'photo', row_count: rows.length, added: add.length, skipped: all.length - add.length, date_from: dates[0], date_to: dates[dates.length - 1], imported_at: new Date().toISOString() });
    }
    await reload();
    f.acct = picked.acct;
    ctx.setParams({ acct: f.acct });
    if (add.length) f.asOf = monthEnd(add.map((b) => b.date).sort().pop().slice(0, 7));
    await draw();
    toast(`已匯入 ${add.length} 列存摺明細${all.length - add.length ? `（${all.length - add.length} 列先前已匯入，略過）` : ''}；沒對到帳上分錄的可按「批次補登」`, 'good', 8000);
  }

  // 列出所有讀到的列：可勾選、修改；改完即時用結存重新核對
  function reviewRows(rows, pages, failed) {
    const urls = pages.map((p) => URL.createObjectURL(p.file));
    const defaultOn = (r) => !r.imported && r.status !== 'duplicate' && r.status !== 'check';
    const chip = (r) => {
      const [tone, label] = STATUS_CHIP[r.imported ? 'imported' : r.status] || STATUS_CHIP.check;
      return status(tone, label);
    };
    const rowHtml = (r, k) => h`<tr data-k="${k}" data-page="${r.page}" class="${r.status === 'duplicate' || r.imported ? 'void' : ''}">
      <td><input type="checkbox" name="on" ${defaultOn(r) ? raw('checked') : ''} aria-label="匯入這一列"></td>
      <td class="pb-chip">${chip(r)}</td>
      <td><input type="date" name="d" value="${r.date || ''}" class="cell"></td>
      <td><input type="text" name="s" value="${r.summary || ''}" class="cell" style="width:150px"></td>
      <td><input name="w" inputmode="decimal" class="cell num" value="${r.withdrawal || ''}" style="width:96px"></td>
      <td><input name="dep" inputmode="decimal" class="cell num" value="${r.deposit || ''}" style="width:96px"></td>
      <td><input name="b" inputmode="decimal" class="cell num" value="${r.balance ?? ''}" style="width:110px"></td>
      <td class="muted pb-note" style="font-size:12px;max-width:260px">${r.note || ''}</td>
    </tr>`;
    const counts = {};
    for (const r of rows) {
      const k = r.imported ? 'imported' : r.status;
      counts[k] = (counts[k] || 0) + 1;
    }
    const groups = pages.map((p, pi) => ({ p, pi, rows: rows.map((r, k) => [r, k]).filter(([r]) => r.page === pi) }));
    let nextK = rows.length;
    const body = h`<div class="callout" style="margin-bottom:10px"><p>照片 ${pages.length} 張、讀到 ${rows.length} 列：${['ok', 'corrected', 'inferred', 'check', 'duplicate', 'imported'].filter((k) => counts[k]).map((k) => `${STATUS_CHIP[k][1]} ${counts[k]}`).join('、')}。
        每列都用「上一列結存 ± 金額 ＝ 結存」核對；<b>需確認</b>的請點照片對照、修正數字（改完會即時重新核對），沒讀到的列可「＋ 新增一列」。只會匯入打勾的列，已匯入過的會自動略過。</p></div>
      ${failed.length ? h`<div class="callout warn" style="margin-bottom:10px"><p>${failed.join('；')}</p></div>` : ''}
      <div class="row" style="margin-bottom:8px;gap:8px;flex-wrap:wrap">
        <label class="field" style="flex-direction:row;align-items:center;gap:6px"><span>存摺帳戶代號</span><input type="text" id="pb-acct" value="${f.acct}" style="width:110px"></label>
        <span class="spacer"></span>
        <button type="button" class="btn sm" data-sel="ok">只選對得上的</button>
        <button type="button" class="btn sm" data-sel="new">全選未匯入</button>
        <button type="button" class="btn sm" data-sel="none">全不選</button>
      </div>
      <div class="table-wrap" style="max-height:60vh"><table class="grid"><thead><tr><th></th><th>核對</th><th>日期</th><th>摘要</th><th class="num">支出</th><th class="num">存入</th><th class="num">結存</th><th>說明</th></tr></thead>
      <tbody id="pb-rows">${groups.map((g) => h`<tr class="pb-head"><td colspan="8"><b>照片 ${g.pi + 1}</b>　${g.p.file.name}　<a href="${urls[g.pi]}" target="_blank" rel="noopener">開啟照片對照</a>　<button type="button" class="btn sm ghost" data-addrow="${g.pi}">＋ 新增一列</button></td></tr>${g.rows.map(([r, k]) => rowHtml(r, k))}`)}</tbody></table></div>
      <p class="muted" id="pb-sum" style="margin-top:8px"></p>`;
    const collect = (dlg) =>
      [...dlg.querySelectorAll('#pb-rows tr[data-k]')].map((tr) => {
        const v = (n) => tr.querySelector(`[name=${n}]`).value.trim();
        const k = Number(tr.dataset.k);
        return { tr, k, on: tr.querySelector('[name=on]').checked, page: Number(tr.dataset.page), date: v('d'), summary: v('s'), withdrawal: num(v('w')), deposit: num(v('dep')), balance: v('b') === '' ? null : num(v('b')), orig: rows[k] };
      });
    // 依畫面上的數字重新核對結存（略過標重複、已匯入的列）
    const recheck = (dlg) => {
      let prev = null;
      let n = 0;
      let bad = 0;
      for (const x of collect(dlg)) {
        const o = x.orig;
        if (o && (o.status === 'duplicate' || o.imported)) continue;
        const cell = x.tr.querySelector('.pb-chip');
        if (prev !== null && x.balance !== null && (x.withdrawal || x.deposit)) {
          const ok = near(prev - x.withdrawal + x.deposit, x.balance);
          const edited = !!x.tr.dataset.edited;
          // 沒改過的「推算」列保留原標示，讓人知道要對照照片；改過且對得上的標「已修正」
          if (ok && !edited && o && STATUS_CHIP[o.status] && o.status !== 'check') cell.innerHTML = String(status(...STATUS_CHIP[o.status]));
          else cell.innerHTML = String(ok ? status('good', edited ? '對得上（已修正）' : '對得上') : status('bad', `差 ${fmt(Math.round((x.balance - (prev - x.withdrawal + x.deposit)) * 100) / 100)}`));
          if (!ok) bad++;
        }
        if (x.balance !== null) prev = x.balance;
        if (x.on) n++;
      }
      dlg.querySelector('#pb-sum').textContent = `已勾選 ${n} 列${bad ? `；還有 ${bad} 列結存對不上（可能是讀錯的數字或漏讀的列）` : '；勾選的列結存都對得上'}`;
      return { n, bad };
    };
    return modal({
      title: '存摺照片辨識結果：勾選要匯入的列',
      wide: true,
      body,
      onMount: (dlg) => {
        dlg.querySelector('.modal-inner').style.maxWidth = '1180px';
        recheck(dlg);
        dlg.addEventListener('input', (ev) => {
          ev.target.closest?.('tr[data-k]')?.setAttribute('data-edited', '1');
          recheck(dlg);
        });
        dlg.addEventListener('change', () => recheck(dlg));
        dlg.addEventListener('click', (ev) => {
          const sel = ev.target.closest('[data-sel]');
          if (sel) {
            for (const x of collect(dlg)) {
              const o = x.orig;
              const fresh = !o || (!o.imported && o.status !== 'duplicate');
              x.tr.querySelector('[name=on]').checked = sel.dataset.sel === 'none' ? false : sel.dataset.sel === 'new' ? fresh : fresh && !!o && ['ok', 'corrected'].includes(o.status);
            }
            recheck(dlg);
          }
          const add = ev.target.closest('[data-addrow]');
          if (add) {
            const pi = Number(add.dataset.addrow);
            const last = [...dlg.querySelectorAll(`#pb-rows tr[data-page="${pi}"]`)].pop() || add.closest('tr');
            const r = { page: pi, status: 'manual', date: last?.querySelector?.('[name=d]')?.value || '', summary: '', withdrawal: 0, deposit: 0, balance: null, note: '手動補上照片上沒讀到的列' };
            rows.push(r);
            last.insertAdjacentHTML('afterend', String(rowHtml(r, nextK++)));
            recheck(dlg);
          }
        });
      },
      actions: [
        { label: '取消', value: null },
        {
          label: '匯入勾選的列',
          primary: true,
          value: (dlg) => {
            const list = collect(dlg).filter((x) => x.on);
            if (!list.length) return toast('沒有勾選任何一列', 'error'), false;
            const bad = list.find((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x.date) || (!x.withdrawal && !x.deposit) || (x.withdrawal && x.deposit));
            if (bad) return toast(`第 ${list.indexOf(bad) + 1} 個勾選的列：日期要填，支出或存入要擇一填金額`, 'error', 6000), false;
            const acct = dlg.querySelector('#pb-acct').value.trim() || 'main';
            return { acct, rows: list.map(({ date, summary, withdrawal, deposit, balance, orig }) => ({ date, summary, withdrawal, deposit, balance, memo: orig?.memo || '' })) };
          },
        },
      ],
    }).finally(() => urls.forEach((u) => URL.revokeObjectURL(u)));
  }

  // ── 補登分錄：一筆或一次多筆（依摘要與以前的補登建議會計項目）
  async function createBankEntries(list) {
    let all = await store.all('journal_entries');
    const made = [];
    for (const { b, acc, desc } of list) {
      const isDep = b.deposit > 0;
      const amount = b.deposit || b.withdrawal;
      const e = {
        id: uid('je_'),
        date: b.date,
        description: desc || b.description || '存摺補登',
        source: 'bank',
        source_ref: b.id,
        status: 'posted',
        voucher_no: nextVoucherNo(all, b.date),
        lines: isDep ? [{ account: f.gl, debit: amount, credit: 0, memo: '' }, { account: acc, debit: 0, credit: amount, memo: b.note || '' }] : [{ account: acc, debit: amount, credit: 0, memo: b.note || '' }, { account: f.gl, debit: 0, credit: amount, memo: '' }],
        created_at: new Date().toISOString(),
      };
      all = [...all, e];
      made.push({ e, b: { ...b, match_key: `${e.id}#${isDep ? 0 : 1}` } });
    }
    if (!made.length) return [];
    await store.put('journal_entries', made.map((x) => x.e));
    await store.put('bank_lines', made.map((x) => x.b));
    await reload();
    return made.map((x) => x.e);
  }

  async function bookMany() {
    const { lines, matches } = root._ctx;
    const todo = lines.filter((b) => !matches.has(b.id) && !isLocked(settings, b.date));
    if (!todo.length) return toast('沒有需要補登的項目', 'info');
    const hist = bankHistory(entries, f.gl);
    const sugg = todo.map((b) => suggestBankAccount(b, hist));
    const r = await modal({
      title: `批次補登：存摺上有、帳上沒有的 ${todo.length} 筆`,
      wide: true,
      body: h`<p class="muted" style="margin-bottom:8px">每筆會建立一張分錄（${f.gl} 銀行存款 對 你選的會計項目）並勾稽。會計項目依摘要與你以前的補登建議，請逐筆確認；不確定的取消勾選，之後再處理。</p>
        <div class="table-wrap" style="max-height:60vh"><table class="grid"><thead><tr><th></th><th>日期</th><th>摘要</th><th class="num">支出</th><th class="num">存入</th><th>會計項目</th><th>建議依據</th></tr></thead><tbody>
        ${todo.map((b, i) => h`<tr data-i="${i}"><td><input type="checkbox" name="on" ${/暫收|暫付/.test(sugg[i].why) ? '' : raw('checked')}></td><td>${b.date}</td><td>${[b.description, b.note && !String(b.description).includes(b.note) ? b.note : ''].filter(Boolean).join('｜')}</td><td class="num">${b.withdrawal ? fmt(b.withdrawal) : ''}</td><td class="num">${b.deposit ? fmt(b.deposit) : ''}</td><td>${accountSelect(accounts, sugg[i].account, 'name="acc"')}</td><td class="muted" style="font-size:12px">${sugg[i].why}</td></tr>`)}
        </tbody></table></div>`,
      actions: [
        { label: '取消', value: null },
        {
          label: '建立勾選的分錄',
          primary: true,
          value: (dlg) => {
            const list = [...dlg.querySelectorAll('tbody tr[data-i]')].filter((tr) => tr.querySelector('[name=on]').checked).map((tr) => ({ b: todo[Number(tr.dataset.i)], acc: tr.querySelector('[name=acc]').value }));
            if (!list.length) return toast('沒有勾選任何一筆', 'error'), false;
            if (list.some((x) => !x.acc)) return toast('勾選的每一筆都要選會計項目', 'error'), false;
            return list;
          },
        },
      ],
    });
    if (!r) return;
    const made = await createBankEntries(r);
    toast(`已建立 ${made.length} 張補登分錄並勾稽`, 'good', 6000);
    draw();
  }

  const unbind = bindActions(root, {
    acct: (el) => {
      f.acct = el.value;
      ctx.setParams({ acct: f.acct });
      draw();
    },
    gl: (el) => {
      f.gl = el.value;
      ctx.setParams({ gl: f.gl });
      draw();
    },
    asof: (el) => {
      f.asOf = el.value;
      ctx.setParams({ asof: f.asOf });
      draw();
    },
    print: () => window.print(),
    photos: async () => importPhotos(await pickFiles({ accept: 'image/*', multiple: true })),
    bookMany: () => bookMany(),
    confirmAll: async () => {
      const { lines, matches } = root._ctx;
      const upd = lines.filter((b) => !b.match_key && matches.has(b.id)).map((b) => ({ ...b, match_key: matches.get(b.id) }));
      await store.put('bank_lines', upd);
      await reload();
      toast(`已確認 ${upd.length} 筆`, 'good');
      draw();
    },
    unmatch: async (el) => {
      const b = bankLines.find((x) => x.id === el.dataset.id);
      await store.put('bank_lines', { ...b, match_key: null, match_rejected: root._ctx.matches.get(b.id) || null });
      await reload();
      draw();
    },
    pick: async (el) => {
      const b = bankLines.find((x) => x.id === el.dataset.id);
      const { books, matches } = root._ctx;
      const used = new Set(matches.values());
      const cands = books.filter((k) => !used.has(k.key) && (b.deposit ? k.debit : k.credit) > 0).sort((x, y) => Math.abs((b.deposit || b.withdrawal) - (x.debit || x.credit)) - Math.abs((b.deposit || b.withdrawal) - (y.debit || y.credit))).slice(0, 40);
      const r = await modal({
        title: `手動對應：${b.date} ${b.description} ${fmt(b.deposit || b.withdrawal)}`,
        body: cands.length ? h`<select name="k" size="10" style="width:100%">${cands.map((k) => h`<option value="${k.key}">${k.date}｜${k.voucher_no}｜${k.memo}｜${fmt(k.debit || k.credit)}</option>`)}</select>` : h`<p class="muted">帳上沒有可對應的分錄，請改用「補登分錄」。</p>`,
        actions: [{ label: '取消', value: null }, ...(cands.length ? [{ label: '對應', primary: true, value: (d) => d.querySelector('[name=k]').value || false }] : [])],
      });
      if (!r) return;
      await store.put('bank_lines', { ...b, match_key: r });
      await reload();
      draw();
    },
    book: async (el) => {
      const b = bankLines.find((x) => x.id === el.dataset.id);
      const isDep = b.deposit > 0;
      const amount = b.deposit || b.withdrawal;
      const guess = suggestBankAccount(b, bankHistory(entries, f.gl));
      const r = await modal({
        title: `補登分錄：${b.date} ${isDep ? '存入' : '支出'} ${fmt(amount)}`,
        body: h`<p class="muted">${b.description} ${b.note && !String(b.description).includes(b.note) ? b.note : ''}</p>
          <div class="form-grid"><label class="field"><span>${isDep ? '貸方（收入來源）' : '借方（支出用途）'}</span>${accountSelect(accounts, guess.account, 'name="acc"')}</label>
          <label class="field"><span>摘要</span><input type="text" name="desc" value="${b.description || '存摺補登'}"></label></div>
          <p class="muted" style="font-size:12.5px;margin-top:6px">建議：${guess.why}</p>`,
        actions: [{ label: '取消', value: null }, { label: '建立分錄並勾稽', primary: true, value: (d) => ({ acc: d.querySelector('[name=acc]').value, desc: d.querySelector('[name=desc]').value.trim() }) }],
      });
      if (!r || !r.acc) return;
      const [e] = await createBankEntries([{ b, acc: r.acc, desc: r.desc }]);
      toast(`已建立 ${e.voucher_no}`, 'good');
      draw();
    },
  });
  await draw();
  if (queued.length) importPhotos(queued.splice(0));
  return unbind;
}
