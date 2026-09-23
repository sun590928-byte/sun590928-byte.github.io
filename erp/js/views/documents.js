// 憑證歸檔：實體發票／收據照片 → AI 辨識（或從已命名檔名解析）→ 覆核 → 入帳 → 依「民國年/月/日期_廠商_摘要_發票號_金額」歸檔。
// 另含「電子發票」分頁：財政部平台下載的進項發票逐張入帳，並與照片依發票號碼比對，避免重複入帳。

import { h, raw, mount, bindActions, fmt, toast, confirmBox, modal, pickFiles, options, badge, status, setBusy, download, emptyState, stat, dataTable } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getAccounts, isLocked } from '../state.js';
import { parseDocName, archiveName, archiveFolder } from '../lib/docname.js';
import { classifyExpense } from '../lib/classify.js';
import { documentJournal } from '../lib/autojournal.js';
import { nextVoucherNo } from '../lib/ledger.js';
import { uid } from '../lib/text.js';
import { makeZip } from '../lib/zip.js';
import { fnv1a } from '../lib/text.js';
import { accountSelect } from './_shared.js';
import { syncPayouts } from '../sync.js';

const PAY_ACCOUNTS = [
  ['1101', '現金（收銀機）'],
  ['1102', '零用金'],
  ['1103', '銀行存款（轉帳／扣款）'],
  ['2111', '應付帳款（月結）'],
  ['2191', '老闆代墊（業主往來）'],
];
const STATUS = { inbox: ['待覆核', 'medium'], reviewed: ['已覆核', 'accent'], posted: ['已入帳', 'high'], ignored: ['不入帳', 'low'] };
const pending = [];
export function queueFiles(files) {
  pending.push(...files);
}

// 照片縮到長邊 2400px 並轉 JPEG：上傳較快、AI 辨識較省，也順便把 iPhone HEIC 轉成通用格式（瀏覽器支援時）
async function prepareImage(file) {
  const isImg = /^image\//i.test(file.type) || /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name);
  if (!isImg || /gif/i.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    if (scale === 1 && /jpe?g/i.test(file.type) && file.size < 3e6) return file;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.88));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch {
    return file;
  }
}

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  let docs = await store.all('documents');
  let invoices = await store.all('einvoices');
  const f = { tab: ctx.params.tab || 'inbox' };
  const urls = new Map();

  async function thumbUrl(d) {
    if (urls.has(d.id)) return urls.get(d.id);
    let u = '';
    try {
      if (d.storage_path && store.mode === 'cloud') u = await store.backend.fileUrl(d.storage_path);
      else {
        const file = await store.get('files', d.id);
        if (file?.blob) u = URL.createObjectURL(file.blob);
      }
    } catch (e) {
      console.warn(e);
    }
    urls.set(d.id, u);
    return u;
  }

  async function addFiles(files) {
    if (!files.length) return;
    setBusy(true, `加入 ${files.length} 個檔案…`);
    try {
      const rows = [];
      for (const file of files) {
        const parsed = parseDocName(file.name);
        const cls = classifyExpense({ vendor: parsed.vendor, text: parsed.summary });
        const id = uid('doc_');
        const ready = await prepareImage(file);
        const ext = (/\.[a-z0-9]+$/i.exec(ready.name) || [parsed.ext || '.jpg'])[0].toLowerCase();
        const d = {
          id,
          kind: 'receipt',
          status: 'inbox',
          original_name: file.name,
          mime: ready.type || file.type || '',
          doc_date: parsed.date,
          vendor_name: parsed.vendor,
          invoice_no: parsed.invoice_no,
          amount_total: parsed.amount,
          tax_amount: null,
          summary: parsed.summary,
          account: cls.account,
          pay_account: '1101',
          confidence: parsed.date && parsed.amount ? 0.5 : 0.2,
          ai: null,
          created_at: new Date().toISOString(),
        };
        d.file_ext = ext;
        if (store.mode === 'cloud') {
          d.storage_path = await store.backend.upload(`inbox/${id}${ext}`, ready);
        } else {
          await store.put('files', { id, name: file.name, type: ready.type, size: ready.size, blob: ready });
        }
        rows.push(d);
      }
      await store.put('documents', rows);
      docs = await store.all('documents');
      toast(`已加入 ${rows.length} 張憑證${store.mode === 'cloud' ? '，可按「AI 辨識」自動讀取內容' : '（已從檔名帶入日期、廠商、金額）'}`, 'good', 6000);
      f.tab = 'inbox';
    } finally {
      setBusy(false);
    }
    draw();
  }

  function linkByInvoice(d) {
    if (!d.invoice_no) return null;
    return invoices.find((i) => i.invoice_no === d.invoice_no) || null;
  }

  async function aiExtract(list) {
    if (store.mode !== 'cloud') {
      await modal({ title: 'AI 辨識需要雲端', body: h`<p>AI 辨識會把照片交給 Supabase Edge Function（extract-document）呼叫 Claude 讀取發票內容，API 金鑰只存在伺服器端。</p><p>請先到「設定與備份」連線 Supabase，並依 README 部署函式。未連線前可直接手動輸入，或使用已命名檔案自動帶入的欄位。</p>` });
      return;
    }
    let ok = 0;
    for (let i = 0; i < list.length; i++) {
      const d = list[i];
      setBusy(true, `AI 辨識中（${i + 1}/${list.length}）…`);
      try {
        const r = await store.backend.invoke('extract-document', { path: d.storage_path, mime: d.mime, file_name: d.original_name, accounts: accounts.filter((a) => a.active !== false).map((a) => ({ code: a.code, name: a.name, type: a.type })) });
        const upd = {
          ...d,
          kind: r.kind || d.kind,
          doc_date: r.doc_date || d.doc_date,
          vendor_name: r.vendor_name || d.vendor_name,
          vendor_tax_id: r.vendor_tax_id || d.vendor_tax_id || '',
          invoice_no: r.invoice_no || d.invoice_no,
          amount_total: r.amount_total ?? d.amount_total,
          tax_amount: r.tax_amount ?? d.tax_amount,
          summary: r.summary || d.summary,
          items: r.items || [],
          account: r.suggested_account && accounts.some((a) => a.code === r.suggested_account) ? r.suggested_account : d.account,
          confidence: r.confidence ?? 0.7,
          ai: r,
          updated_at: new Date().toISOString(),
        };
        await store.put('documents', upd);
        ok++;
      } catch (e) {
        toast(`「${d.original_name}」辨識失敗：${e.message}`, 'error', 7000);
      }
    }
    setBusy(false);
    docs = await store.all('documents');
    if (ok) toast(`已辨識 ${ok} 張，請逐張覆核後入帳`, 'good');
    draw();
  }

  function readForm(card, d) {
    const g = (n) => card.querySelector(`[name=${n}]`);
    return {
      ...d,
      doc_date: g('doc_date').value || null,
      vendor_name: g('vendor_name').value.trim(),
      vendor_tax_id: g('vendor_tax_id').value.trim(),
      invoice_no: g('invoice_no').value.trim().toUpperCase().replace(/[\s-]/g, '') || null,
      amount_total: g('amount_total').value === '' ? null : Number(g('amount_total').value),
      tax_amount: g('tax_amount').value === '' ? null : Number(g('tax_amount').value),
      summary: g('summary').value.trim(),
      account: g('account').value,
      pay_account: g('pay_account').value,
      deductible: g('deductible').checked,
      updated_at: new Date().toISOString(),
    };
  }

  async function post(d) {
    if (!d.doc_date || !d.amount_total || !d.account) return toast('請填日期、金額與科目', 'error');
    if (isLocked(settings, d.doc_date)) return toast('該月份已結帳鎖定', 'error');
    const inv = linkByInvoice(d);
    if (inv?.entry_id) {
      await store.put('documents', { ...d, status: 'posted', entry_id: inv.entry_id, einvoice_id: inv.id });
      await store.put('einvoices', { ...inv, document_id: d.id });
      toast('此發票已由電子發票入帳，照片已連結，不重複入帳', 'info', 6000);
      return;
    }
    const entries = await store.all('journal_entries');
    const je = documentJournal(d, { deductible: d.deductible !== false && settings.vat_mode === 'general' });
    const e = { ...je, id: uid('je_'), voucher_no: nextVoucherNo(entries, d.doc_date), status: 'posted', attachments: [d.id], created_at: new Date().toISOString() };
    await store.put('journal_entries', e);
    const ext = d.file_ext || (/\.[a-z0-9]+$/i.exec(d.original_name || '') || ['.jpg'])[0].toLowerCase();
    const archived = archiveName(d, ext);
    const folder = archiveFolder(d.doc_date);
    let storage_path = d.storage_path;
    if (store.mode === 'cloud' && d.storage_path) {
      // 雲端物件路徑只用英數（Storage 對中文路徑支援不一），中文歸檔名存於資料庫、下載 ZIP 時套用
      const target = `archive/${d.doc_date.slice(0, 4)}/${d.doc_date.slice(5, 7)}/${d.id}${ext}`;
      try {
        await store.backend.moveFile(d.storage_path, target);
        storage_path = target;
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    await store.put('documents', { ...d, status: 'posted', entry_id: e.id, archived_name: archived, storage_path, einvoice_id: inv?.id || null });
    if (inv) await store.put('einvoices', { ...inv, entry_id: e.id, document_id: d.id, account: d.account });
    toast(`已入帳 ${e.voucher_no}，歸檔名稱：${folder}/${archived}`, 'good', 6000);
  }

  function docCard(d) {
    const [label, tone] = STATUS[d.status] || ['?', ''];
    const inv = linkByInvoice(d);
    const ro = d.status === 'posted';
    const dis = ro ? raw('disabled') : '';
    return h`<div class="doc-card" data-id="${d.id}">
      <div class="doc-thumb" data-act="zoom" data-id="${d.id}"><img alt="${d.original_name}" data-thumb="${d.id}"></div>
      <div class="doc-body">
        <div class="row">${badge(label, tone)}${d.ai ? badge('AI ' + Math.round((d.confidence || 0) * 100) + '%', 'accent') : ''}${inv ? badge('電子發票已存在', inv.entry_id ? 'high' : '') : ''}${d.kind === 'payout_statement' ? badge('撥款明細', 'accent') : ''}</div>
        <div class="fn">${d.archived_name ? `${archiveFolder(d.doc_date)}/${d.archived_name}` : d.original_name}</div>
        <div class="doc-fields">
          <label>日期<input type="date" name="doc_date" value="${d.doc_date || ''}" ${dis}></label>
          <label>金額（含稅）<input type="number" name="amount_total" value="${d.amount_total ?? ''}" ${dis}></label>
          <label>廠商<input type="text" name="vendor_name" value="${d.vendor_name || ''}" ${dis}></label>
          <label>統編<input type="text" name="vendor_tax_id" value="${d.vendor_tax_id || ''}" maxlength="8" ${dis}></label>
          <label>發票號碼<input type="text" name="invoice_no" value="${d.invoice_no || ''}" ${dis}></label>
          <label>稅額（可扣抵）<input type="number" name="tax_amount" value="${d.tax_amount ?? ''}" ${dis}></label>
          <label class="full">摘要（品項）<input type="text" name="summary" value="${d.summary || ''}" ${dis}></label>
          <label class="full">會計項目${accountSelect(accounts.filter((a) => ['asset', 'expense', 'cogs', 'nonop_expense', 'liability'].includes(a.type)), d.account, `name="account" ${ro ? 'disabled' : ''}`)}</label>
          <label class="full">付款方式<select name="pay_account" ${dis}>${options(PAY_ACCOUNTS, d.pay_account || '1101')}</select></label>
          <label class="full check" style="display:flex"><input type="checkbox" name="deductible" ${d.deductible === false ? '' : raw('checked')} ${dis}> 三聯式／載明本店統編（進項稅額可扣抵）</label>
        </div>
        ${d.kind === 'payout_statement' && d.ai?.payouts?.length ? h`<div class="callout"><p>AI 讀到 ${d.ai.payouts.length} 筆撥款：${d.ai.payouts.map((p) => `${p.payout_date} ${fmt(p.net)}`).join('、')}</p><button class="btn sm" data-act="importPayouts" data-id="${d.id}">匯入為撥款紀錄</button></div>` : ''}
        <div class="row">
          ${ro ? h`<a class="btn sm" href="#/journal?ym=${(d.doc_date || '').slice(0, 7)}">查看分錄</a>` : h`<button class="btn sm primary" data-act="post" data-id="${d.id}">入帳並歸檔</button><button class="btn sm" data-act="save" data-id="${d.id}">暫存</button>${store.mode === 'cloud' ? h`<button class="btn sm" data-act="ai" data-id="${d.id}">AI 辨識</button>` : ''}`}
          <span class="spacer"></span>
          ${ro ? '' : h`<button class="btn sm ghost" data-act="ignore" data-id="${d.id}">不入帳</button>`}<button class="btn sm danger" data-act="del" data-id="${d.id}">刪除</button>
        </div>
      </div>
    </div>`;
  }

  function draw() {
    const counts = { inbox: 0, reviewed: 0, posted: 0, ignored: 0 };
    for (const d of docs) counts[d.status] = (counts[d.status] || 0) + 1;
    const list = docs.filter((d) => (f.tab === 'all' ? true : f.tab === 'inbox' ? ['inbox', 'reviewed'].includes(d.status) : d.status === f.tab)).sort((a, b) => ((a.doc_date || '9') < (b.doc_date || '9') ? -1 : 1));
    const invPending = invoices.filter((i) => !i.entry_id && !i.voided).length;
    mount(
      root,
      h`<div class="drop no-print" id="drop" style="margin-bottom:16px">
        <h3>把發票、收據照片拖到這裡</h3>
        <p class="muted">可一次選整個「原始憑證圖檔資料_已命名」資料夾：檔名中的日期、廠商、金額、發票號碼會自動帶入。${store.mode === 'cloud' ? '照片存到 Supabase 私有空間，可用 AI 辨識內容。' : '目前為本機模式，照片存在這台電腦的瀏覽器；連線雲端後可用 AI 辨識。'}</p>
        <div class="row" style="justify-content:center"><button class="btn primary" data-act="pick">選擇照片</button><button class="btn" data-act="pickDir">選擇資料夾</button>${store.mode === 'cloud' && counts.inbox ? h`<button class="btn" data-act="aiAll">AI 辨識全部待覆核（${counts.inbox}）</button>` : ''}</div>
      </div>
      <div class="stats">
        ${stat('待覆核', fmt(counts.inbox + counts.reviewed))}
        ${stat('已入帳', fmt(counts.posted))}
        ${stat('電子發票待入帳', fmt(invPending), `共 ${invoices.length} 張`)}
      </div>
      <div class="card">
        <div class="tabs">${[
          ['inbox', `待處理（${counts.inbox + counts.reviewed}）`],
          ['posted', `已入帳（${counts.posted}）`],
          ['ignored', `不入帳（${counts.ignored}）`],
          ['all', '全部'],
          ['einvoice', `電子發票（${invoices.length}）`],
        ].map(([k, l]) => h`<button class="${f.tab === k ? 'on' : ''}" data-act="tab" data-t="${k}">${l}</button>`)}
        <span class="spacer"></span>${f.tab === 'posted' && counts.posted ? h`<button class="btn sm" data-act="zip">下載已命名歸檔（ZIP）</button>` : ''}</div>
        <div id="body"></div>
      </div>`,
    );
    const body = root.querySelector('#body');
    if (f.tab === 'einvoice') return drawInvoices(body);
    if (!list.length) {
      mount(body, emptyState(f.tab === 'inbox' ? '沒有待處理的憑證' : '沒有資料', '拖入發票或收據照片開始歸檔。電子發票請在「匯入中心」匯入財政部平台下載的檔案。'));
      return;
    }
    mount(body, h`<div class="doc-grid">${list.map(docCard)}</div>`);
    body.querySelectorAll('img[data-thumb]').forEach(async (img) => {
      const d = docs.find((x) => x.id === img.dataset.thumb);
      const u = await thumbUrl(d);
      if (u && !/\.pdf$/i.test(d.original_name || '')) img.src = u;
      else img.replaceWith(Object.assign(document.createElement('span'), { className: 'muted', textContent: /\.pdf$/i.test(d.original_name || '') ? 'PDF' : '無預覽' }));
    });
    const drop = root.querySelector('#drop');
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      addFiles([...e.dataTransfer.files].filter((x) => /image|pdf/.test(x.type) || /\.(jpe?g|png|heic|webp|pdf)$/i.test(x.name)));
    });
  }

  function drawInvoices(body) {
    if (!invoices.length) {
      mount(body, emptyState('尚未匯入電子發票', '到財政部電子發票整合服務平台下載進項發票（或載具發票）明細，拖入「匯入中心」，會自動辨識「M｜D」格式並建議會計項目。', h`<a class="btn primary" href="#/import">前往匯入</a>`));
      return;
    }
    mount(body, h`<div class="row" style="margin-bottom:10px"><span class="muted">同一張發票若也有拍照上傳，會依發票號碼自動連結，只入帳一次。</span><span class="spacer"></span><button class="btn sm primary" data-act="postInvAll">建議科目信心高者全部入帳</button></div><div id="inv"></div>`);
    dataTable(body.querySelector('#inv'), {
      rows: invoices,
      pageSize: 100,
      initialSort: { key: 'date', dir: 1 },
      rowClass: (r) => (r.voided ? 'void' : ''),
      columns: [
        { key: 'date', label: '日期' },
        { key: 'invoice_no', label: '發票號碼', fmt: (v, r) => h`${v}${docs.some((d) => d.invoice_no === v) ? h` ${badge('有照片', 'accent')}` : ''}` },
        { key: 'seller_name', label: '賣方' },
        { key: 'items', label: '品項', fmt: (v) => (v || []).map((i) => i.name).slice(0, 4).join('、') },
        { key: 'total', label: '金額', align: 'num', fmt: (v) => fmt(v) },
        { key: 'tax', label: '可扣抵稅額', align: 'num', fmt: (v) => (v ? fmt(v) : '') },
        { key: 'account', label: '會計項目', nosort: true, fmt: (v, r) => (r.entry_id ? h`${(accounts.find((a) => a.code === (v || r.suggested_account)) || {}).name || ''}` : accountSelect(accounts.filter((a) => ['asset', 'expense', 'cogs'].includes(a.type)), v || r.suggested_account, `data-act="invAcc" data-id="${r.id}"`)) },
        { key: 'confidence', label: '信心', align: 'num', fmt: (v) => (v ? Math.round(v * 100) + '%' : '') },
        { key: 'entry_id', label: '', nosort: true, fmt: (v, r) => (r.voided ? status('na', '作廢') : v ? status('good', '已入帳') : h`<button class="btn sm" data-act="postInv" data-id="${r.id}">入帳</button>`) },
      ],
    });
  }

  async function postInvoice(inv, account) {
    if (inv.entry_id || inv.voided) return false;
    if (isLocked(settings, inv.date)) return false;
    const photo = docs.find((d) => d.invoice_no && d.invoice_no === inv.invoice_no && d.entry_id);
    if (photo) {
      await store.put('einvoices', { ...inv, entry_id: photo.entry_id, document_id: photo.id });
      return true;
    }
    const entries = await store.all('journal_entries');
    const je = documentJournal({ id: inv.id, doc_date: inv.date, vendor_name: inv.seller_name, invoice_no: inv.invoice_no, amount_total: inv.total, tax_amount: inv.tax, summary: (inv.items || []).map((i) => i.name).slice(0, 3).join('、'), account, pay_account: '1101' }, { deductible: inv.deductible && settings.vat_mode === 'general' });
    const e = { ...je, source: 'document', source_ref: inv.id, id: uid('je_'), voucher_no: nextVoucherNo(entries, inv.date), status: 'posted', created_at: new Date().toISOString() };
    await store.put('journal_entries', e);
    await store.put('einvoices', { ...inv, account, entry_id: e.id });
    return true;
  }

  const unbind = bindActions(root, {
    tab: (el) => {
      f.tab = el.dataset.t;
      ctx.setParams({ tab: f.tab });
      draw();
    },
    pick: async () => addFiles(await pickFiles({ accept: 'image/*,.pdf,.heic' })),
    pickDir: async () => addFiles((await pickFiles({ directory: true })).filter((x) => /\.(jpe?g|png|heic|webp|pdf)$/i.test(x.name))),
    aiAll: () => aiExtract(docs.filter((d) => d.status === 'inbox' && d.storage_path)),
    ai: (el) => aiExtract(docs.filter((d) => d.id === el.dataset.id)),
    save: async (el) => {
      const card = el.closest('.doc-card');
      const d = readForm(card, docs.find((x) => x.id === el.dataset.id));
      await store.put('documents', { ...d, status: 'reviewed' });
      docs = await store.all('documents');
      toast('已暫存', 'good');
    },
    post: async (el) => {
      const card = el.closest('.doc-card');
      const d = readForm(card, docs.find((x) => x.id === el.dataset.id));
      await post(d);
      [docs, invoices] = await Promise.all([store.all('documents'), store.all('einvoices')]);
      draw();
    },
    ignore: async (el) => {
      const d = docs.find((x) => x.id === el.dataset.id);
      await store.put('documents', { ...d, status: 'ignored' });
      docs = await store.all('documents');
      draw();
    },
    del: async (el) => {
      const d = docs.find((x) => x.id === el.dataset.id);
      if (!(await confirmBox(`刪除「${d.original_name}」？${d.entry_id ? '對應分錄不會自動刪除，請到日記簿處理。' : ''}`, { danger: true, ok: '刪除' }))) return;
      await store.remove('documents', d.id);
      if (store.mode !== 'cloud') await store.remove('files', d.id);
      docs = await store.all('documents');
      draw();
    },
    zoom: async (el) => {
      const d = docs.find((x) => x.id === el.dataset.id);
      const u = await thumbUrl(d);
      if (u) window.open(u, '_blank', 'noopener');
    },
    importPayouts: async (el) => {
      const d = docs.find((x) => x.id === el.dataset.id);
      const rows = (d.ai?.payouts || []).filter((p) => p.payout_date && (p.net || p.gross)).map((p) => {
        const fee = Math.abs(Number(p.fee) || 0);
        const net = Number(p.net) || Number(p.gross) - fee;
        const gross = Number(p.gross) || net + fee;
        const provider = p.provider || 'linepay';
        return { id: 'po_' + fnv1a([provider, p.payout_date, p.ref || '', gross, net, fee].join('|')), provider, payout_date: p.payout_date, gross, fee, net, period_from: p.period_from || null, period_to: p.period_to || null, ref: p.ref || '', note: 'AI 辨識自 ' + d.original_name, document_id: d.id };
      });
      if (!rows.length) return;
      await store.put('payouts', rows);
      await syncPayouts();
      await store.put('documents', { ...d, status: 'posted' });
      docs = await store.all('documents');
      toast(`已匯入 ${rows.length} 筆撥款並產生入帳分錄`, 'good');
      draw();
    },
    invAcc: async (el) => {
      const inv = invoices.find((x) => x.id === el.dataset.id);
      await store.put('einvoices', { ...inv, account: el.value });
      invoices = await store.all('einvoices');
    },
    postInv: async (el) => {
      const inv = invoices.find((x) => x.id === el.dataset.id);
      if (await postInvoice(inv, inv.account || inv.suggested_account)) toast('已入帳', 'good');
      else toast('無法入帳（已入帳、作廢或月份已鎖定）', 'error');
      invoices = await store.all('einvoices');
      draw();
    },
    postInvAll: async () => {
      const list = invoices.filter((i) => !i.entry_id && !i.voided && (i.account || (i.confidence || 0) >= 0.6));
      if (!list.length) return toast('沒有可自動入帳的發票（信心 60% 以上或已手動指定科目）', 'info');
      if (!(await confirmBox(`將 ${list.length} 張電子發票入帳？`))) return;
      let n = 0;
      for (const inv of list) if (await postInvoice(inv, inv.account || inv.suggested_account)) n++;
      invoices = await store.all('einvoices');
      toast(`已入帳 ${n} 張`, 'good');
      draw();
    },
    zip: async () => {
      const posted = docs.filter((d) => d.status === 'posted' && d.archived_name);
      setBusy(true, '打包中…');
      try {
        const files = [];
        for (const d of posted) {
          let data = null;
          if (store.mode === 'cloud' && d.storage_path) {
            const u = await store.backend.fileUrl(d.storage_path);
            data = new Uint8Array(await (await fetch(u)).arrayBuffer());
          } else {
            const file = await store.get('files', d.id);
            if (file?.blob) data = new Uint8Array(await file.blob.arrayBuffer());
          }
          if (data) files.push({ name: `${archiveFolder(d.doc_date)}/${d.archived_name}`, data });
        }
        download(`午月憑證歸檔_${new Date().toISOString().slice(0, 10)}.zip`, makeZip(files));
      } finally {
        setBusy(false);
      }
    },
  });
  draw();
  if (pending.length) addFiles(pending.splice(0));
  return () => {
    unbind();
    for (const u of urls.values()) if (u.startsWith('blob:')) URL.revokeObjectURL(u);
  };
}
