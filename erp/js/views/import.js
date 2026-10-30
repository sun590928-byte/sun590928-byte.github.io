// 匯入中心：拖入 CSV／XLSX → 自動判斷種類與欄位 → 預覽 → 匯入（重複列自動略過）。

import { h, raw, mount, bindActions, dataTable, toast, pickFiles, confirmBox, options, fmt, setBusy, badge, downloadCSV } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getAccounts } from '../state.js';
import { decodeBytes, parseCSV } from '../lib/csv.js';
import { readXlsx } from '../lib/xlsx.js';
import { TARGETS, detectHeaderRow, autoMap, headerSignature, guessTarget, extract } from '../lib/importer.js';
import { normalizeSales } from '../lib/pos.js';
import { normalizeEcpayTx, normalizePayouts, guessProvider } from '../lib/payments.js';
import { normalizeBank } from '../lib/bank.js';
import { buildJournalEntries } from '../lib/journalimport.js';
import { isMofFormat, parseMofInvoices, normalizeInvoiceRows } from '../lib/einvoice.js';
import { parseDate } from '../lib/dates.js';
import { parseAmount, round2 } from '../lib/money.js';
import { nextVoucherNo } from '../lib/ledger.js';
import { sha256Hex, uid, compactKey } from '../lib/text.js';
import { INVENTORY_CATEGORIES } from '../lib/inventory.js';
import { normalizePurchaseRows, normalizeSupplierRows, templateCSV, supplierLabel, VAT_RATE } from '../lib/purchases.js';
import { ASSET_CATEGORIES } from '../lib/coa.js';
import { PROVIDERS } from '../lib/autojournal.js';
import { syncAll, describeSync } from '../sync.js';

const TARGET_STORE = { sales: 'sales_lines', ecpay_tx: 'payment_tx', payouts: 'payouts', bank: 'bank_lines', journal: 'journal_entries', suppliers: 'suppliers', purchases: 'inventory_moves', assets: 'fixed_assets', customers: 'customers', einvoice: 'einvoices' };
// 供應商、進貨紀錄頁的「從匯入中心匯入」會帶 ?target=，這裡先固定資料類型並提供範本
const TEMPLATE_NAME = { suppliers: '供應商資料範本.csv', purchases: '進貨紀錄範本.csv' };
const IMAGE = /\.(jpe?g|png|heic|heif|webp|gif|pdf)$/i;

export async function render(root, ctx) {
  let queue = [];
  let cur = null; // 目前處理中的檔案
  let prepared = null;
  const forced = TARGETS[ctx.params.target] ? ctx.params.target : null;

  const settings = await getSettings();
  const vatRate = settings.vat_mode === 'general' ? VAT_RATE : 0;

  async function loadFile(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const hash = await sha256Hex(buf);
    const f = { file, name: file.name, hash, sheets: null, sheetIdx: 0, rows: [], encoding: '', mof: null };
    if (/\.xlsx$/i.test(file.name)) {
      f.sheets = await readXlsx(buf);
      f.sheetIdx = Math.max(0, f.sheets.findIndex((s) => !s.hidden && s.rows.length > 1));
      f.rows = f.sheets[f.sheetIdx]?.rows || [];
      f.encoding = 'xlsx';
    } else if (/\.xls$/i.test(file.name)) {
      throw new Error(`「${file.name}」是舊版 .xls，請在 Excel 另存為 .xlsx 或 .csv 後再匯入`);
    } else {
      const { text, encoding } = decodeBytes(buf);
      f.encoding = encoding;
      if (isMofFormat(text)) {
        f.mof = text;
        f.target = 'einvoice';
        return f;
      }
      f.rows = parseCSV(text);
    }
    f.target = forced || guessTarget(f.rows, file.name);
    await applyProfileOrAuto(f);
    return f;
  }

  async function applyProfileOrAuto(f) {
    const { index } = detectHeaderRow(f.rows, f.target);
    f.headerIndex = index;
    const headers = f.rows[index] || [];
    const sig = headerSignature(headers);
    const profiles = await store.all('import_profiles');
    const prof = profiles.find((p) => p.signature === sig && p.target === f.target);
    if (prof) {
      f.mapping = { ...prof.mapping };
      f.profileUsed = true;
    } else {
      f.mapping = autoMap(headers, f.target);
      f.profileUsed = false;
    }
    f.provider = guessProvider(f.name) || (f.target === 'payouts' ? 'ecpay' : null);
    f.bankAccountId = 'main';
    f.accountOverrides = {};
  }

  async function prepare(f) {
    const t = f.target;
    if (t === 'einvoice' && f.mof) {
      const rows = parseMofInvoices(f.mof, { businessTaxId: settings.tax_id });
      return withDupes(t, rows, [], rows.map((r) => r.date));
    }
    const err = TARGETS[t].validate?.(f.mapping);
    if (err) return { error: err };
    const raw = extract(f.rows, f.headerIndex, f.mapping);
    const batchId = 'b_' + f.hash.slice(0, 12);
    if (t === 'sales') {
      const { lines, skipped } = normalizeSales(raw, { rules: settings.void_rules, batchId, cutoffHour: Number(settings.cutoff_hour) || 0 });
      return withDupes(t, lines, skipped, lines.map((l) => l.date));
    }
    if (t === 'ecpay_tx') {
      const { rows, skipped } = normalizeEcpayTx(raw, { batchId });
      return withDupes(t, rows, skipped, rows.map((r) => r.date));
    }
    if (t === 'payouts') {
      const { rows, skipped } = normalizePayouts(raw, { batchId, provider: f.provider || 'ecpay' });
      return withDupes(t, rows, skipped, rows.map((r) => r.payout_date));
    }
    if (t === 'bank') {
      const { rows, skipped } = normalizeBank(raw, { batchId, bankAccountId: f.bankAccountId });
      return withDupes(t, rows, skipped, rows.map((r) => r.date));
    }
    if (t === 'journal') {
      const accounts = await getAccounts();
      const { entries, unresolved, errors } = buildJournalEntries(raw, accounts, { overrides: f.accountOverrides, sourceTag: 'import' });
      const existing = new Set((await store.all('journal_entries')).filter((e) => e.source === 'import').map((e) => e.source_ref));
      const tagged = entries.map((e) => ({ ...e, source_ref: `${f.hash.slice(0, 8)}:${e.source_ref}` }));
      const fresh = tagged.filter((e) => !existing.has(e.source_ref));
      return { rows: fresh, all: tagged, dup: tagged.length - fresh.length, skipped: errors.map((m) => ({ row: '', reason: m })), unresolved, accounts, dates: tagged.map((e) => e.date) };
    }
    if (t === 'purchases') return preparePurchases(raw, f);
    if (t === 'suppliers') return prepareSuppliers(raw, f);
    if (t === 'assets') {
      const rows = raw
        .map((r) => ({ id: 'fa_' + compactKey(r.name + (r.acquired_on || '')).slice(0, 24), name: r.name, category: guessAssetCategory(r.category, r.name), acquired_on: parseDate(r.acquired_on), cost: parseAmount(r.cost), life_years: parseAmount(r.life_years) || null, residual: parseAmount(r.residual), note: r.note || '' }))
        .filter((r) => r.name && r.acquired_on && r.cost);
      return withDupes(t, rows, [], rows.map((r) => r.acquired_on));
    }
    if (t === 'customers') {
      const rows = raw.filter((r) => r.member_no).map((r) => ({ id: 'c_' + compactKey(r.member_no), member_no: r.member_no, name: r.name || '', tier: r.tier || '', birthday: r.birthday || '', preferences: r.preferences || '', joined_on: parseDate(r.joined_on), note: r.note || '' }));
      return withDupes(t, rows, [], []);
    }
    if (t === 'einvoice') {
      const rows = normalizeInvoiceRows(raw, { businessTaxId: settings.tax_id });
      return withDupes(t, rows, [], rows.map((r) => r.date));
    }
    return { error: '不支援的類型' };
  }

  async function withDupes(t, rows, skipped, dates) {
    const coll = TARGET_STORE[t];
    const existing = new Set((await store.all(coll)).map((r) => r.id));
    const fresh = rows.filter((r) => !existing.has(r.id));
    return { rows: fresh, all: rows, dup: rows.length - fresh.length, skipped, dates: dates.filter(Boolean) };
  }

  async function preparePurchases(raw, f) {
    const [items, suppliers] = await Promise.all([store.all('inventory_items'), store.all('suppliers')]);
    const batchId = 'b_' + f.hash.slice(0, 12);
    const r = normalizePurchaseRows(raw, { items, suppliers, sourceFile: f.name, batchId, vatRate });
    const res = await withDupes('purchases', r.rows, r.skipped, r.rows.map((x) => x.date));
    const fresh = new Set(res.rows.map((x) => x.item_id));
    res.newItems = r.newItems.filter((it) => fresh.has(it.id));
    res.updatedItems = r.updatedItems.filter((it) => fresh.has(it.id));
    const usedSup = new Set(res.rows.map((x) => x.supplier_id));
    res.newSups = r.newSups.filter((x) => usedSup.has(x.id));
    res.docs = r.docs;
    const itemBy = new Map([...items, ...r.newItems].map((i) => [i.id, i]));
    const supBy = new Map([...suppliers, ...r.newSups].map((x) => [x.id, x]));
    const newItem = new Set(r.newItems.map((i) => i.id));
    const newSup = new Set(r.newSups.map((x) => x.id));
    res.preview = r.rows.map((m) => {
      const it = itemBy.get(m.item_id);
      return { ...m, itemName: it?.name || '', itemNew: newItem.has(m.item_id), category: it?.category || '', autoCat: !!it?.auto_category, supplierName: supplierLabel(supBy.get(m.supplier_id)), supNew: newSup.has(m.supplier_id) };
    });
    return res;
  }

  async function prepareSuppliers(raw, f) {
    const suppliers = await store.all('suppliers');
    const batchId = 'b_' + f.hash.slice(0, 12);
    const r = normalizeSupplierRows(raw, { suppliers, batchId, sourceFile: f.name });
    return { rows: r.rows, all: r.preview, preview: r.preview, dup: r.unchanged, skipped: r.skipped, dates: [], added: r.preview.filter((x) => x._state === 'new').length, updated: r.preview.filter((x) => x._state === 'update').length };
  }

  async function commit() {
    const f = cur;
    const p = prepared;
    if (!p || p.error) return;
    const t = f.target;
    if (t === 'journal' && p.unresolved.some(([label]) => !f.accountOverrides[label])) {
      toast('還有會計科目未對應，請先在下方選擇', 'error');
      return;
    }
    setBusy(true, '匯入中…');
    try {
      const batchId = 'b_' + f.hash.slice(0, 12);
      let rows = p.rows;
      if (t === 'journal') {
        const all = [...(await store.all('journal_entries'))];
        rows = rows.map((e) => {
          const x = { ...e, id: uid('je_'), status: 'posted', created_at: new Date().toISOString() };
          x.voucher_no = nextVoucherNo(all, x.date);
          all.push(x);
          return x;
        });
      }
      if (t === 'purchases') {
        if (p.newItems.length) await store.put('inventory_items', p.newItems);
        if (p.updatedItems?.length) await store.put('inventory_items', p.updatedItems);
        if (p.newSups.length) await store.put('suppliers', p.newSups);
      }
      await store.put(TARGET_STORE[t], rows);
      const dates = p.dates.sort();
      await store.put('import_batches', {
        id: batchId + '_' + t,
        batch_key: batchId,
        target: t,
        file_name: f.name,
        file_hash: f.hash,
        encoding: f.encoding,
        row_count: p.all.length,
        added: rows.length,
        skipped: p.dup + p.skipped.length,
        date_from: dates[0] || null,
        date_to: dates[dates.length - 1] || null,
        mapping: f.mapping || null,
        imported_at: new Date().toISOString(),
      });
      if (!f.mof) {
        const headers = f.rows[f.headerIndex] || [];
        await store.put('import_profiles', { id: 'pf_' + t + '_' + headerSignature(headers), target: t, signature: headerSignature(headers), header_index: f.headerIndex, mapping: f.mapping, headers, name: f.name, updated_at: new Date().toISOString() });
      }
      let msg = t === 'suppliers' ? `已新增 ${fmt(p.added)} 家、更新 ${fmt(p.updated)} 家供應商${p.dup ? `，${fmt(p.dup)} 家資料相同未變動` : ''}` : `已匯入 ${fmt(rows.length)} 筆${p.dup ? `，略過重複 ${fmt(p.dup)} 筆` : ''}`;
      if (t === 'purchases') msg += `；進貨單 ${fmt(new Set(rows.map((r) => r.purchase_id)).size)} 張${p.newItems.length ? `、自動建檔原物料 ${fmt(p.newItems.length)} 項` : ''}${p.newSups.length ? `、新供應商 ${fmt(p.newSups.length)} 家` : ''}，已載入原物料進銷存`;
      if (['sales', 'payouts', 'assets'].includes(t)) {
        const r = await syncAll();
        msg += '。' + describeSync(r);
      }
      toast(msg, 'good', 6000);
      next();
    } finally {
      setBusy(false);
    }
  }

  function next() {
    cur = null;
    prepared = null;
    if (queue.length) startFile(queue.shift());
    else draw();
  }

  async function startFile(file) {
    try {
      setBusy(true, `讀取「${file.name}」…`);
      cur = await loadFile(file);
      prepared = await prepare(cur);
    } catch (e) {
      toast(e.message, 'error', 7000);
      cur = null;
      prepared = null;
      if (queue.length) return startFile(queue.shift());
    } finally {
      setBusy(false);
    }
    draw();
  }

  async function handleFiles(files) {
    const images = files.filter((f) => IMAGE.test(f.name));
    const data = files.filter((f) => !IMAGE.test(f.name));
    if (images.length) {
      const docs = await import('./documents.js');
      docs.queueFiles(images);
      if (!data.length) return ctx.go('documents');
      toast(`${images.length} 張憑證影像已排入「憑證歸檔」，資料檔處理完後可前往查看`, 'info', 6000);
    }
    queue.push(...data);
    if (!cur && queue.length) startFile(queue.shift());
  }

  async function draw() {
    const batches = (await store.all('import_batches')).sort((a, b) => (a.imported_at < b.imported_at ? 1 : -1));
    mount(
      root,
      h`<div class="stack">
        ${cur ? mappingPanel() : dropZone()}
        <div class="card">
          <div class="card-head"><h2>匯入紀錄</h2><span class="card-note">刪除批次會一併移除該次匯入的資料</span></div>
          <div id="batches"></div>
        </div>
      </div>`,
    );
    const LABEL = Object.fromEntries(Object.entries(TARGETS).map(([k, v]) => [k, v.label]));
    dataTable(root.querySelector('#batches'), {
      rows: batches,
      empty: '尚未匯入任何檔案',
      columns: [
        { key: 'imported_at', label: '匯入時間', fmt: (v) => (v ? v.slice(0, 16).replace('T', ' ') : '') },
        { key: 'target', label: '類型', fmt: (v) => LABEL[v] || v },
        { key: 'file_name', label: '檔案' },
        { key: 'date_from', label: '資料期間', fmt: (v, r) => (v ? `${v} ～ ${r.date_to}` : '—') },
        { key: 'added', label: '新增', align: 'num', fmt: (v) => fmt(v) },
        { key: 'skipped', label: '略過', align: 'num', fmt: (v) => fmt(v) },
        { key: 'id', label: '', nosort: true, fmt: (v) => h`<button class="btn sm danger" data-act="delBatch" data-id="${v}">刪除批次</button>` },
      ],
    });
    if (cur) renderPreview();
    else wireDrop();
  }

  function dropZone() {
    const back = { suppliers: ['suppliers', '供應商'], purchases: ['purchases', '進貨紀錄'] }[forced];
    return h`${
      forced
        ? h`<div class="callout" style="margin-bottom:12px"><p><b>匯入「${TARGETS[forced].label}」</b>：${TARGETS[forced].hint}。欄位順序不限，表頭文字相近即可自動對應。${TEMPLATE_NAME[forced] ? h` <button class="btn sm" data-act="template" data-target="${forced}">下載範本 CSV</button>` : ''}${back ? h` <a class="btn sm ghost" href="#/${back[0]}">回${back[1]}</a>` : ''}</p></div>`
        : ''
    }<div class="drop" id="drop">
      <h3>把檔案拖到這裡</h3>
      <p class="muted">支援 POS 銷售明細、綠界刷卡明細／撥款明細、銀行存摺、電子發票、舊帳 XLSX、供應商資料、進貨／採購紀錄；照片與 PDF 會轉到「憑證歸檔」。<br>檔案只在這台電腦的瀏覽器裡解析${store.mode === 'cloud' ? '，匯入後存到你的 Supabase 雲端資料庫' : '，不會上傳到任何伺服器'}。</p>
      <div class="row" style="justify-content:center"><button class="btn primary" data-act="pick">選擇檔案</button><button class="btn" data-act="pickDir">選擇整個資料夾</button></div>
      <p class="muted" style="margin-top:12px;font-size:13px">營收自 <b>${settings.revenue_start}</b> 起計算；「老闆測試／老闆招待／報廢」金額一律作廢（可在設定頁調整）。</p>
    </div>`;
  }

  function mappingPanel() {
    const f = cur;
    const t = TARGETS[f.target];
    const headers = f.rows[f.headerIndex] || [];
    const colOpts = [['', '（不使用）'], ...headers.map((hd, i) => [String(i), `${colName(i)}｜${hd || '(空白)'}`])];
    return h`<div class="card">
      <div class="card-head">
        <h2>${f.name}</h2>
        ${badge(f.encoding === 'big5' ? 'Big5 編碼' : f.encoding === 'xlsx' ? 'Excel' : 'UTF-8')}
        ${f.profileUsed ? badge('已套用上次的欄位對應', 'accent') : ''}
        <span class="spacer"></span>
        ${queue.length ? h`<span class="muted">後面還有 ${queue.length} 個檔案</span>` : ''}
      </div>
      <div class="toolbar">
        <label class="field"><span>資料類型</span><select data-act="target">${options(Object.entries(TARGETS).map(([k, v]) => [k, v.label]), f.target)}</select></label>
        ${f.sheets ? h`<label class="field"><span>工作表</span><select data-act="sheet">${options(f.sheets.map((s, i) => [i, s.name + (s.hidden ? '（隱藏）' : '')]), f.sheetIdx)}</select></label>` : ''}
        ${!f.mof ? h`<label class="field"><span>表頭在第幾列</span><input type="number" min="1" max="${f.rows.length}" value="${f.headerIndex + 1}" data-act="headerRow" style="width:90px"></label>` : ''}
        ${f.target === 'payouts' ? h`<label class="field"><span>金流</span><select data-act="provider">${options(Object.entries(PROVIDERS), f.provider)}</select></label>` : ''}
        ${f.target === 'bank' ? h`<label class="field"><span>銀行帳戶代號</span><input type="text" value="${f.bankAccountId}" data-act="bankAcc" style="width:120px"></label>` : ''}
      </div>
      <p class="muted" style="font-size:13px">${t.hint}</p>
      ${
        f.mof
          ? h`<div class="callout"><p>偵測到財政部電子發票平台格式（M｜D 分隔），已自動讀取發票表頭與品項明細。</p></div>`
          : h`<details open><summary><b>欄位對應</b>（系統已自動判斷，可調整）</summary>
          <div class="map-grid" style="margin-top:10px">${t.fields.map(
            (fd) => h`<label class="${fd.required ? 'req' : ''}"><b>${fd.label}</b><select data-act="map" data-field="${fd.key}">${options(colOpts, f.mapping[fd.key] ?? '')}</select></label>`,
          )}</div></details>`
      }
      <div id="prep" style="margin-top:14px"></div>
      <div class="row" style="margin-top:14px">
        <button class="btn primary" data-act="commit" ${prepared && !prepared.error && prepared.rows.length ? '' : raw('disabled')}>匯入 ${prepared && !prepared.error ? fmt(prepared.rows.length) : 0} 筆</button>
        <button class="btn" data-act="skip">略過此檔</button>
      </div>
    </div>`;
  }

  function renderPreview() {
    const el = root.querySelector('#prep');
    if (!el) return;
    const p = prepared;
    if (!p) return;
    if (p.error) {
      mount(el, h`<div class="callout warn"><p>${p.error}</p></div>`);
      return;
    }
    const dates = [...p.dates].sort();
    const parts = [h`<div class="row" style="gap:18px;margin-bottom:10px">
      <span>可匯入 <b>${fmt(p.rows.length)}</b> 筆</span>
      ${p.dup ? h`<span class="muted">已存在（略過）${fmt(p.dup)} 筆</span>` : ''}
      ${p.skipped.length ? h`<span class="muted">無法辨識 ${fmt(p.skipped.length)} 列</span>` : ''}
      ${dates.length ? h`<span class="muted">期間 ${dates[0]} ～ ${dates[dates.length - 1]}</span>` : ''}
    </div>`];
    if (cur.target === 'sales') {
      const voids = p.all.filter((l) => l.void_reason);
      const before = p.all.filter((l) => l.date < settings.revenue_start).length;
      parts.push(h`<div class="callout" style="margin-bottom:10px"><p>作廢（金額計 0）：老闆測試 ${voids.filter((l) => l.void_reason === 'boss_test').length} 筆、老闆招待 ${voids.filter((l) => l.void_reason === 'boss_treat').length} 筆、報廢 ${voids.filter((l) => l.void_reason === 'scrap').length} 筆、POS 作廢 ${voids.filter((l) => l.void_reason === 'pos_void').length} 筆。${before ? ` ${settings.revenue_start} 以前的 ${fmt(before)} 筆會保留供品項比對，但不計入營收。` : ''}</p></div>`);
    }
    if (cur.target === 'purchases') {
      const docs = p.docs || [];
      parts.push(h`<div class="callout" style="margin-bottom:10px"><p>合成 <b>${fmt(docs.length)}</b> 張進貨單（同發票號碼的多行為一張）。匯入後每行進貨自動載入「原物料進銷存」：${p.newItems.length ? h`沒見過的品名會自動建檔 <b>${fmt(p.newItems.length)}</b> 項（${p.newItems.slice(0, 8).map((i) => `${i.name}→${INVENTORY_CATEGORIES[i.category]?.label || i.category}`).join('、')}${p.newItems.length > 8 ? '…' : ''}），分類依品名自動判斷，之後可在「進貨紀錄 → 原物料主檔」修改並設定安全庫存、進貨包裝折合量；` : '品名都已建檔；'}${p.newSups.length ? h`新供應商 <b>${p.newSups.map((x) => x.name).join('、')}</b> 會一併建立（可到「供應商」補統編與匯款資料）。` : ''}</p></div>`);
    }
    if (cur.target === 'suppliers') {
      parts.push(h`<div class="callout" style="margin-bottom:10px"><p>新增 <b>${fmt(p.added)}</b> 家、更新既有資料 <b>${fmt(p.updated)}</b> 家${p.dup ? `、${fmt(p.dup)} 家資料相同不變動` : ''}。以統一編號或發票抬頭／簡稱比對既有供應商；匯入檔裡空白的欄位不會蓋掉原本的資料。</p></div>`);
    }
    if (cur.target === 'journal' && p.unresolved.length) {
      const accOpts = [['', '— 選擇科目 —'], ...p.accounts.map((a) => [a.code, `${a.code} ${a.name}`])];
      parts.push(h`<div class="callout warn" style="margin-bottom:10px"><p><b>以下科目在系統中找不到，請指定對應的會計項目：</b></p>
        <div class="map-grid">${p.unresolved.map(([label, n]) => h`<label><b>${label || '(空白)'}</b><span class="muted">${n} 行</span><select data-acc-pick data-act="accMap" data-label="${label}">${options(accOpts, cur.accountOverrides[label] || '')}</select></label>`)}</div></div>`);
    }
    if (p.skipped.length) parts.push(h`<details style="margin-bottom:10px"><summary class="muted">查看無法辨識的列</summary><ul>${p.skipped.slice(0, 50).map((s) => h`<li>${s.row ? `第 ${s.row} 列：` : ''}${s.reason}</li>`)}</ul></details>`);
    parts.push(h`<div id="preview-table" class="preview"></div>`);
    mount(el, h`${parts}`);
    const cols = previewColumns(cur.target);
    dataTable(el.querySelector('#preview-table'), { rows: (p.preview || p.all).slice(0, 200), columns: cols, pageSize: 50, rowClass: (r) => (r.void_reason ? 'void' : '') });
  }

  function wireDrop() {
    const drop = root.querySelector('#drop');
    if (!drop) return;
    drop.addEventListener('dragover', (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      handleFiles([...e.dataTransfer.files]);
    });
  }

  async function refreshPrep() {
    prepared = await prepare(cur);
    draw();
  }

  const unbind = bindActions(root, {
    pick: async () => handleFiles(await pickFiles({ accept: '.csv,.txt,.xlsx,.xls,image/*,.pdf' })),
    template: (el) => downloadCSV(TEMPLATE_NAME[el.dataset.target] || '範本.csv', templateCSV(el.dataset.target)),
    pickDir: async () => handleFiles(await pickFiles({ directory: true })),
    skip: () => next(),
    commit: () => commit(),
    target: async (el) => {
      cur.target = el.value;
      if (cur.mof && el.value !== 'einvoice') cur.mof = null;
      await applyProfileOrAuto(cur);
      refreshPrep();
    },
    sheet: async (el) => {
      cur.sheetIdx = Number(el.value);
      cur.rows = cur.sheets[cur.sheetIdx].rows;
      cur.target = guessTarget(cur.rows, cur.name + ' ' + cur.sheets[cur.sheetIdx].name);
      await applyProfileOrAuto(cur);
      refreshPrep();
    },
    headerRow: (el) => {
      cur.headerIndex = Math.max(0, Number(el.value) - 1);
      cur.mapping = autoMap(cur.rows[cur.headerIndex] || [], cur.target);
      refreshPrep();
    },
    map: (el) => {
      if (el.value === '') delete cur.mapping[el.dataset.field];
      else cur.mapping[el.dataset.field] = Number(el.value);
      cur.profileUsed = false;
      refreshPrep();
    },
    provider: (el) => {
      cur.provider = el.value;
      refreshPrep();
    },
    bankAcc: (el) => {
      cur.bankAccountId = el.value.trim() || 'main';
      refreshPrep();
    },
    accMap: (el) => {
      cur.accountOverrides[el.dataset.label] = el.value;
      refreshPrep();
    },
    delBatch: async (el) => {
      const b = (await store.all('import_batches')).find((x) => x.id === el.dataset.id);
      if (!b) return;
      if (!(await confirmBox(`刪除「${b.file_name}」這次匯入的 ${fmt(b.added)} 筆資料？`, { ok: '刪除', danger: true }))) return;
      const coll = TARGET_STORE[b.target];
      const batchKey = b.batch_key || b.id.slice(0, 14);
      const rows = await store.all(coll);
      let ids;
      if (b.target === 'journal') ids = rows.filter((r) => r.source === 'import' && String(r.source_ref).startsWith(b.file_hash.slice(0, 8) + ':')).map((r) => r.id);
      else ids = rows.filter((r) => r.batch_id === batchKey).map((r) => r.id);
      await store.remove(coll, ids);
      await store.remove('import_batches', b.id);
      if (['sales', 'payouts'].includes(b.target)) await syncAll();
      toast(`已刪除 ${fmt(ids.length)} 筆`, 'good');
      draw();
    },
  });

  // 由其他頁帶入的檔案
  if (pendingForImport.length) {
    const files = pendingForImport.splice(0);
    handleFiles(files);
  } else draw();
  return unbind;
}

export const pendingForImport = [];

function colName(i) {
  let s = '';
  i += 1;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

function guessAssetCategory(cat, name) {
  const s = `${cat || ''} ${name || ''}`;
  if (/裝潢|工程|改良|木作|水電/.test(s)) return 'leasehold';
  if (/電腦|pos|收銀|平板|印表機|筆電/i.test(s)) return 'it';
  if (/冰箱|冷藏|製冰|烤箱|淨水|冷凍|展示櫃/.test(s)) return 'equipment';
  if (Object.keys(ASSET_CATEGORIES).includes(cat)) return cat;
  return 'machine';
}

function previewColumns(t) {
  const m = (v) => (v === null || v === undefined ? '' : fmt(v));
  switch (t) {
    case 'sales':
      return [
        { key: 'date', label: '日期' },
        { key: 'time', label: '時間' },
        { key: 'order_no', label: '單號' },
        { key: 'item_raw', label: '品項' },
        { key: 'option_raw', label: '選項' },
        { key: 'qty', label: '數量', align: 'num' },
        { key: 'amount', label: '金額', align: 'num', fmt: m },
        { key: 'payment_raw', label: '付款' },
        { key: 'void_reason', label: '作廢', fmt: (v, r) => (v ? h`<span class="badge medium">${r.void_keyword}</span>` : '') },
      ];
    case 'ecpay_tx':
      return [
        { key: 'date', label: '日期' },
        { key: 'time', label: '時間' },
        { key: 'order_no', label: '訂單編號' },
        { key: 'amount', label: '金額', align: 'num', fmt: m },
        { key: 'fee', label: '手續費', align: 'num', fmt: m },
        { key: 'status', label: '狀態' },
        { key: 'payout_date', label: '撥款日' },
      ];
    case 'payouts':
      return [
        { key: 'payout_date', label: '撥款日' },
        { key: 'provider', label: '金流', fmt: (v) => PROVIDERS[v] || v },
        { key: 'gross', label: '交易總額', align: 'num', fmt: m },
        { key: 'fee', label: '手續費', align: 'num', fmt: m },
        { key: 'net', label: '撥款金額', align: 'num', fmt: m },
        { key: 'ref', label: '編號' },
      ];
    case 'bank':
      return [
        { key: 'date', label: '日期' },
        { key: 'description', label: '摘要' },
        { key: 'withdrawal', label: '支出', align: 'num', fmt: m },
        { key: 'deposit', label: '存入', align: 'num', fmt: m },
        { key: 'balance', label: '餘額', align: 'num', fmt: m },
        { key: 'note', label: '備註' },
      ];
    case 'journal':
      return [
        { key: 'date', label: '日期' },
        { key: 'original_voucher', label: '原傳票號' },
        { key: 'description', label: '摘要' },
        { key: 'lines', label: '分錄', fmt: (v) => h`${v.map((l) => h`<div>${l.debit ? '借' : '貸'} ${l.account || '？'} ${fmt(l.debit || l.credit)}</div>`)}` },
      ];
    case 'purchases':
      return [
        { key: 'invoice_date', label: '發票日期' },
        { key: 'invoice_no', label: '發票號碼' },
        { key: 'supplierName', label: '供應商', fmt: (v, r) => h`${v || '—'}${r.supNew ? h` ${badge('新', 'accent')}` : ''}` },
        { key: 'itemName', label: '品名', fmt: (v, r) => h`${v}${r.itemNew ? h` ${badge('新建檔', 'accent')}` : ''}` },
        { key: 'unit', label: '單位' },
        { key: 'pack_qty', label: '數量', align: 'num', fmt: m },
        { key: 'unit_price', label: '單價（含稅）', align: 'num', fmt: m },
        { key: 'amount', label: '含稅金額', align: 'num', fmt: m },
        { key: 'category', label: '分類', fmt: (v, r) => h`${INVENTORY_CATEGORIES[v]?.label || v || ''}${r.autoCat ? h` ${badge('待確認', 'medium')}` : ''}` },
      ];
    case 'suppliers':
      return [
        { key: 'short_name', label: '簡稱' },
        { key: 'name', label: '發票抬頭' },
        { key: 'tax_id', label: '統編' },
        { key: 'phone', label: '公司電話' },
        { key: 'contact', label: '聯絡人', fmt: (v, r) => [v, r.mobile].filter(Boolean).join(' ') },
        { key: 'terms', label: '付款條件' },
        { key: 'bank_branch', label: '匯款銀行', fmt: (v, r) => [v, r.bank_code ? `(${r.bank_code})` : '', r.account_number].filter(Boolean).join(' ') },
        { key: '_state', label: '', fmt: (v) => (v === 'new' ? badge('新增', 'accent') : v === 'update' ? badge('更新', 'medium') : badge('不變')) },
      ];
    case 'assets':
      return [
        { key: 'name', label: '名稱' },
        { key: 'category', label: '類別', fmt: (v) => ASSET_CATEGORIES[v]?.label || v },
        { key: 'acquired_on', label: '取得日' },
        { key: 'cost', label: '成本', align: 'num', fmt: m },
        { key: 'life_years', label: '年限', align: 'num' },
      ];
    case 'customers':
      return [
        { key: 'member_no', label: '會員' },
        { key: 'name', label: '姓名' },
        { key: 'tier', label: '等級' },
        { key: 'preferences', label: '偏好' },
      ];
    case 'einvoice':
      return [
        { key: 'date', label: '日期' },
        { key: 'invoice_no', label: '發票號碼' },
        { key: 'seller_name', label: '賣方' },
        { key: 'total', label: '金額', align: 'num', fmt: m },
        { key: 'items', label: '品項', fmt: (v) => (v || []).map((i) => i.name).join('、') },
        { key: 'suggested_account', label: '建議科目' },
      ];
    default:
      return [];
  }
}
