// 附件（原始憑證）：拍照或選檔上傳發票、收據，連結到分錄或固定資產；預覽、選取、入帳歸檔共用。
// 所有上傳的檔案都成為「憑證歸檔」裡的一筆紀錄，讓每一張發票、收據在系統裡都查得到。

import { h, raw, modal, toast, pickFiles, fmt, setBusy } from './ui.js';
import { store } from './store.js';
import { parseDocName, archiveName, archiveFolder } from './lib/docname.js';
import { classifyExpense } from './lib/classify.js';
import { uid } from './lib/text.js';

export const FILE_ACCEPT = 'image/*,.pdf,.heic,.heif';

// 照片縮到長邊 2400px 並轉 JPEG：上傳較快、AI 辨識較省，也順便把 iPhone HEIC 轉成通用格式（瀏覽器支援時）
export async function prepareImage(file) {
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

export const isDocFile = (f) => /image|pdf/.test(f.type) || /\.(jpe?g|png|heic|heif|webp|pdf)$/i.test(f.name);

// 拍照（手機開相機）或選檔
export function pickDocFiles({ camera = false, multiple = true } = {}) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = camera ? 'image/*' : FILE_ACCEPT;
    inp.multiple = multiple && !camera;
    if (camera) inp.setAttribute('capture', 'environment');
    inp.onchange = () => resolve([...inp.files].filter(isDocFile));
    inp.click();
  });
}

/**
 * 上傳檔案並建立憑證紀錄（檔名中的日期、廠商、金額、發票號會自動帶入）。
 * @param extra    覆寫欄位，例如 { status: 'reviewed', asset_id }
 * @param fallback 檔名沒有時才使用的欄位，例如 { doc_date, vendor_name }
 * @returns 新建立的憑證
 */
export async function createDocuments(files, extra = {}, fallback = {}) {
  const rows = [];
  if (!files.length) return rows;
  setBusy(true, `上傳 ${files.length} 個檔案…`);
  try {
    for (const file of files) {
      const parsed = parseDocName(file.name);
      const cls = classifyExpense({ vendor: parsed.vendor, text: parsed.summary });
      const id = uid('doc_');
      const ready = await prepareImage(file);
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
      for (const [k, v] of Object.entries(fallback)) if ((d[k] === null || d[k] === undefined || d[k] === '') && v !== undefined && v !== '') d[k] = v;
      for (const [k, v] of Object.entries(extra)) if (v !== undefined) d[k] = v;
      Object.assign(d, await store.saveFile(id, ready));
      rows.push(d);
    }
    await store.put('documents', rows);
  } finally {
    setBusy(false);
  }
  return rows;
}

// 入帳後歸檔：產生「YYYYMMDD_廠商_摘要_發票號_金額元」名稱；雲端檔案搬到 archive/年/月/
export async function archivePatch(d) {
  const ext = d.file_ext || (/\.[a-z0-9]+$/i.exec(d.original_name || '') || ['.jpg'])[0].toLowerCase();
  const archived_name = archiveName(d, ext);
  let storage_path = d.storage_path || null;
  if (store.mode === 'cloud' && d.storage_path && d.doc_date) {
    const target = `archive/${d.doc_date.slice(0, 4)}/${d.doc_date.slice(5, 7)}/${d.id}${ext}`;
    if (target !== d.storage_path) {
      try {
        await store.backend.moveFile(d.storage_path, target);
        storage_path = target;
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  }
  return { archived_name, storage_path, folder: archiveFolder(d.doc_date) };
}

/**
 * 更新憑證與分錄的連結：新加入者標記「已入帳」並歸檔；移除者解除連結。
 */
export async function linkDocumentsToEntry(entry, docIds, prevIds = []) {
  const docs = await store.all('documents');
  const byId = new Map(docs.map((d) => [d.id, d]));
  const updates = [];
  const elsewhere = [];
  for (const id of docIds) {
    const d = byId.get(id);
    if (!d || d.entry_id === entry.id) continue;
    if (d.entry_id) {
      elsewhere.push(d); // 已由其他分錄入帳：保留原連結，避免同一張發票入帳兩次
      continue;
    }
    const patch = d.status === 'posted' && d.archived_name ? {} : await archivePatch({ ...d, doc_date: d.doc_date || entry.date });
    delete patch.folder;
    updates.push({ ...d, ...patch, doc_date: d.doc_date || entry.date, status: 'posted', entry_id: entry.id, updated_at: new Date().toISOString() });
  }
  for (const id of prevIds) {
    if (docIds.includes(id)) continue;
    const d = byId.get(id);
    if (d && d.entry_id === entry.id) updates.push({ ...d, entry_id: null, status: 'reviewed', updated_at: new Date().toISOString() });
  }
  if (updates.length) await store.put('documents', updates);
  if (elsewhere.length) toast(`${elsewhere.map(docLabel).join('、')} 已由其他分錄入帳，請確認沒有重複入帳`, 'info', 7000);
}

// ─────────── 預覽

export async function previewDocument(d) {
  let url = '';
  try {
    url = await store.fileUrl(d);
  } catch (e) {
    return toast('無法開啟檔案：' + e.message, 'error');
  }
  if (!url) return toast('找不到檔案（可能在另一台裝置上傳，且尚未上傳到雲端）', 'error', 6000);
  const pdf = /pdf/.test(d.mime || '') || /\.pdf$/i.test(d.original_name || '');
  const title = d.archived_name ? `${archiveFolder(d.doc_date)}/${d.archived_name}` : d.original_name || '憑證';
  await modal({
    title,
    wide: true,
    body: pdf ? h`<iframe class="doc-preview pdf" src="${url}" title="${title}"></iframe>` : h`<img class="doc-preview" src="${url}" alt="${title}">`,
    actions: [
      { label: '另開視窗', value: () => (window.open(url, '_blank', 'noopener'), false) },
      { label: '關閉', primary: true, value: null },
    ],
  });
  if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ─────────── 附件欄位（分錄、固定資產共用）

export function docLabel(d) {
  if (!d) return '（已刪除的憑證）';
  const parts = [d.doc_date, d.vendor_name, d.invoice_no, d.amount_total ? `${fmt(d.amount_total)} 元` : ''].filter(Boolean);
  return parts.length ? parts.join('・') : d.original_name || d.id;
}

// 選取尚未連結的憑證（include 可額外納入其他憑證，例如已入帳的資產發票）
export async function pickExistingDocuments({ exclude = [], title = '從憑證匣選擇', include = () => false } = {}) {
  const docs = (await store.all('documents'))
    .filter((d) => !exclude.includes(d.id) && d.kind !== 'payout_statement' && d.status !== 'ignored' && (!d.entry_id || include(d)))
    .sort((a, b) => ((a.doc_date || a.created_at || '') < (b.doc_date || b.created_at || '') ? 1 : -1));
  if (!docs.length) {
    toast('憑證匣裡沒有尚未入帳的憑證，請直接上傳', 'info');
    return [];
  }
  const r = await modal({
    title,
    wide: true,
    body: h`<p class="muted" style="margin-bottom:8px">列出尚未入帳的發票與收據（${docs.length} 張）。</p>
      <div class="pick-list">${docs.map((d) => h`<label class="check pick-row"><input type="checkbox" value="${d.id}"><span>${docLabel(d)}<span class="muted">　${d.original_name || ''}${d.entry_id ? '（已入帳）' : ''}</span></span></label>`)}</div>`,
    actions: [
      { label: '取消', value: null },
      { label: '加入', primary: true, value: (dlg) => [...dlg.querySelectorAll('input:checked')].map((i) => i.value) },
    ],
  });
  return r || [];
}

/**
 * 在容器中顯示附件清單與「拍照／上傳／從憑證匣選擇」按鈕。
 * @param box   容器元素
 * @param state { ids: string[] } 會被直接修改
 * @param opts  { readonly, newDocExtra: () => ({...}) 覆寫欄位, newDocFallback: () => ({...}) 檔名沒有時的預設, onChange, include }
 */
export function attachmentEditor(box, state, { readonly = false, newDocExtra = () => ({}), newDocFallback = () => ({}), onChange, include } = {}) {
  let docs = [];
  const draw = async () => {
    docs = await store.all('documents');
    const byId = new Map(docs.map((d) => [d.id, d]));
    box.innerHTML = String(h`<div class="attach">
      <div class="attach-head"><b>附件憑證（${state.ids.length}）</b>${state.ids.length ? '' : h`<span class="muted">　還沒有附上發票或收據</span>`}</div>
      <div class="attach-list">${state.ids.map((id) => h`<span class="attach-chip"><button type="button" class="linkish" data-att="view" data-id="${id}">📎 ${docLabel(byId.get(id))}</button>${readonly ? '' : h`<button type="button" class="icon-btn" data-att="del" data-id="${id}" aria-label="移除附件">✕</button>`}</span>`)}</div>
      ${readonly ? '' : h`<div class="row attach-btns"><button type="button" class="btn sm" data-att="camera">拍照</button><button type="button" class="btn sm" data-att="upload">上傳檔案</button><button type="button" class="btn sm ghost" data-att="pick">從憑證匣選擇</button></div>`}
    </div>`);
  };
  box.addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-att]');
    if (!b) return;
    ev.preventDefault();
    const act = b.dataset.att;
    try {
      if (act === 'view') return previewDocument(docs.find((d) => d.id === b.dataset.id) || { id: b.dataset.id });
      if (act === 'del') state.ids = state.ids.filter((x) => x !== b.dataset.id);
      if (act === 'camera' || act === 'upload') {
        const files = await pickDocFiles({ camera: act === 'camera' });
        const created = await createDocuments(files, { status: 'reviewed', ...newDocExtra() }, newDocFallback());
        state.ids = [...state.ids, ...created.map((d) => d.id)];
        if (created.length) toast(`已上傳 ${created.length} 個檔案，也會出現在「憑證歸檔」`, 'good');
      }
      if (act === 'pick') state.ids = [...new Set([...state.ids, ...(await pickExistingDocuments({ exclude: state.ids, include }))])];
      await draw();
      onChange?.(state.ids, docs);
    } catch (e) {
      toast(e.message || String(e), 'error');
    }
  });
  return draw();
}
