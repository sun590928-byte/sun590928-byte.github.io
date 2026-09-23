// 固定資產與折舊明細表：平均法、殘值預設「成本 ÷（耐用年數＋1）」，每月自動提列折舊分錄。
// 新增資產時可上傳購置發票（拍照或檔案），並手動建立購置分錄（系統預填，可修改）。

import { h, mount, bindActions, dataTable, fmt, stat, modal, toast, options, confirmBox, emptyState, status } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getAccounts, isLocked } from '../state.js';
import { accountBalance } from '../lib/ledger.js';
import { monthEnd } from '../lib/dates.js';
import { ASSET_CATEGORIES } from '../lib/coa.js';
import { assetSummary, schedule, normalizeAsset, defaultResidual } from '../lib/assets.js';
import { addMonths, today } from '../lib/dates.js';
import { round2 } from '../lib/money.js';
import { uid } from '../lib/text.js';
import { syncDepreciation } from '../sync.js';
import { reportHead, editEntry, downloadWorkbook } from './_shared.js';
import { assetsSheet } from '../lib/reportbook.js';
import { attachmentEditor, previewDocument } from '../attach.js';
import { FIXED_ASSET_ACCOUNTS } from '../lib/vat.js';

const PAY_ACCOUNTS = [
  ['1103', '1103 銀行存款（轉帳／刷卡扣款）'],
  ['1101', '1101 庫存現金'],
  ['2111', '2111 應付帳款（分期或月結）'],
  ['2191', '2191 業主往來（老闆代墊）'],
  ['2501', '2501 長期借款'],
];

export async function render(root, ctx) {
  const settings = await getSettings();
  let assets = await store.all('fixed_assets');
  const accounts = await getAccounts();
  let entries = await store.all('journal_entries');
  let docs = await store.all('documents');
  const f = { ym: ctx.params.ym || today().slice(0, 7), detail: ctx.params.detail || '' };
  const isOpening = (a) => a.acquired_on && a.acquired_on < settings.revenue_start;
  const entryOf = (a) => (a.purchase_entry_id ? entries.find((e) => e.id === a.purchase_entry_id) : null);

  async function draw() {
    const sum = assetSummary(assets, f.ym);
    const openingYm = addMonths(settings.revenue_start.slice(0, 7), -1);
    const opening = assetSummary(assets, openingYm);
    const head = await reportHead('固定資產及折舊明細表', `截至 ${Number(f.ym.slice(0, 4)) - 1911} 年 ${Number(f.ym.slice(5))} 月`);
    const tot = (k) => sum.reduce((t, a) => t + (a[k] || 0), 0);
    // 財產目錄 vs 帳上科目餘額：新增資產不會自動做購置分錄，差異代表尚未入帳（或重複入帳）
    const asOf = monthEnd(f.ym);
    const recon = Object.entries(ASSET_CATEGORIES).map(([k, c]) => {
      const list = sum.filter((a) => a.category === k && a.acquired_on <= asOf && (!a.disposed_on || a.disposed_on > asOf));
      const regCost = list.reduce((t, a) => t + a.cost, 0);
      const regAccum = list.reduce((t, a) => t + a.accum, 0);
      const glCost = accountBalance(entries, accounts, c.asset, { to: asOf });
      const glAccum = accountBalance(entries, accounts, c.accum, { to: asOf });
      return { k, label: c.label.replace(/（.*）/, ''), asset: c.asset, regCost, glCost, regAccum, glAccum, ok: Math.abs(regCost - glCost) < 1 && Math.abs(regAccum - glAccum) < 1 };
    }).filter((r) => r.regCost || r.glCost || r.regAccum || r.glAccum);
    mount(
      root,
      h`<div class="toolbar no-print">
        <label class="field"><span>截至月份</span><input type="month" value="${f.ym}" data-act="ym"></label>
        <span class="spacer"></span>
        <button class="btn primary" data-act="add">＋ 新增資產</button>
        <button class="btn" data-act="print">列印</button>
        <button class="btn" data-act="xlsx">匯出 Excel</button>
      </div>
      <div class="callout no-print" style="margin-bottom:14px"><p>折舊採<b>平均法</b>，殘值預設為「成本 ÷（耐用年數＋1）」，取得當月即開始提列。耐用年數請依財政部《固定資產耐用年數表》；耐用年限不及 2 年，或單價未達新台幣 8 萬元的器具，一般可直接列為費用（「雜項購置」），有疑問可洽國稅局免付費電話 0800-000-321。新增資產時請<b>附上購置發票</b>，再按「建立購置分錄」；資產變動後會自動更新 ${settings.revenue_start.slice(0, 7)} 起的每月折舊分錄。</p></div>
      <div class="stats">
        ${stat('資產成本合計', '$' + fmt(tot('cost')), `${assets.length} 項`)}
        ${stat('累計折舊', '$' + fmt(tot('accum')), `截至 ${f.ym}`)}
        ${stat('帳面價值', '$' + fmt(tot('book')))}
        ${stat('每月折舊', '$' + fmt(sum.filter((a) => a.remaining > 0).reduce((t, a) => t + a.monthly, 0)), `本年度已提 ${fmt(tot('thisYear'))}`)}
      </div>
      ${recon.length ? h`<div class="card no-print" style="margin-bottom:16px"><div class="card-head"><h2>財產目錄與帳上餘額核對</h2><span class="card-note">截至 ${asOf}</span></div>
        <div class="table-wrap"><table class="grid"><thead><tr><th>類別</th><th class="num">目錄成本</th><th class="num">帳上成本</th><th class="num">目錄累計折舊</th><th class="num">帳上累計折舊</th><th>狀態</th></tr></thead><tbody>
        ${recon.map((r) => h`<tr><td>${r.asset} ${r.label}</td><td class="num">${fmt(r.regCost)}</td><td class="num">${fmt(r.glCost)}</td><td class="num">${fmt(r.regAccum)}</td><td class="num">${fmt(r.glAccum)}</td><td>${r.ok ? status('good', '一致') : status('warn', '不一致')}</td></tr>`)}
        </tbody></table></div>
        ${recon.some((r) => !r.ok) ? h`<p class="muted" style="font-size:12.5px;margin-top:8px">新增資產只會自動提列折舊，購置分錄請在清單按「建立購置分錄」（系統預填、可修改）；營收起算日（${settings.revenue_start}）前購置者，取得成本與累計折舊請列入「日記簿 → 期初開帳」。</p>` : ''}
      </div>` : ''}
      <div class="card">${head}<div id="t"></div>
        ${opening.some((a) => a.accum) ? h`<p class="muted" style="font-size:12.5px;margin-top:10px">營收起算日前（${openingYm}）的累計折舊合計 ${fmt(opening.reduce((t, a) => t + a.accum, 0))} 元，請在「日記簿 → 期初開帳」輸入對應的累計折舊科目。</p>` : ''}
      </div>
      <div id="detail"></div>`,
    );
    if (!assets.length) {
      mount(root.querySelector('#t'), emptyState('尚未登錄固定資產', '把咖啡機、磨豆機、製冰機、裝潢工程等登錄進來，系統會每月自動提列折舊。也可以在匯入中心匯入「固定資產清單」。'));
    } else
      dataTable(root.querySelector('#t'), {
        rows: sum,
        exportName: `固定資產折舊明細_${f.ym}.csv`,
        columns: [
          { key: 'name', label: '資產名稱', fmt: (v, r) => h`<b>${v}</b>${r.note ? h`<div class="muted" style="font-size:12px">${r.note}</div>` : ''}` },
          { key: 'category', label: '類別', fmt: (v) => ASSET_CATEGORIES[v]?.label.replace(/（.*）/, '') || v },
          { key: 'acquired_on', label: '取得日期' },
          { key: 'cost', label: '取得成本', align: 'num', fmt: (v) => fmt(v) },
          { key: 'life_years', label: '年限', align: 'num' },
          { key: 'residual', label: '殘值', align: 'num', fmt: (v) => fmt(v) },
          { key: 'monthly', label: '月折舊', align: 'num', fmt: (v) => fmt(v) },
          { key: 'thisYear', label: '本年折舊', align: 'num', fmt: (v) => fmt(v) },
          { key: 'accum', label: '累計折舊', align: 'num', fmt: (v) => fmt(v) },
          { key: 'book', label: '帳面價值', align: 'num', fmt: (v) => fmt(v) },
          { key: 'endMonth', label: '提列至' },
          {
            key: 'doc_ids',
            label: '購置憑證',
            sort: (r) => (r.doc_ids || []).length,
            csv: (v) => (v || []).length,
            fmt: (v, r) => ((v || []).length ? h`<button class="btn sm ghost" data-act="viewDoc" data-id="${r.id}">📎 ${(v || []).length} 張</button>` : isOpening(r) ? h`<span class="muted">期初</span>` : status('warn', '缺發票')),
          },
          {
            key: 'purchase_entry_id',
            label: '購置分錄',
            sort: (r) => (entryOf(r) ? 1 : 0),
            csv: (v, r) => entryOf(r)?.voucher_no || (isOpening(r) ? '期初開帳' : ''),
            fmt: (v, r) => {
              const e = entryOf(r);
              if (e) return h`<a href="#/journal?ym=${e.date.slice(0, 7)}&q=${encodeURIComponent(e.voucher_no)}">${e.voucher_no}</a>`;
              if (isOpening(r)) return h`<span class="muted" title="營收起算日前購置，請列入期初開帳">期初開帳</span>`;
              return h`<button class="btn sm primary" data-act="purchase" data-id="${r.id}">建立購置分錄</button>`;
            },
          },
          { key: 'id', label: '', nosort: true, csv: () => '', fmt: (v) => h`<button class="btn sm" data-act="detail" data-id="${v}">明細</button> <button class="btn sm" data-act="edit" data-id="${v}">修改</button> <button class="btn sm danger" data-act="del" data-id="${v}">刪除</button>` },
        ],
      });
    if (f.detail) {
      const a = assets.find((x) => x.id === f.detail);
      if (a) {
        const sch = schedule(a);
        mount(root.querySelector('#detail'), h`<div class="card"><div class="card-head"><h2>${a.name}｜逐月折舊表</h2><span class="card-note">成本 ${fmt(normalizeAsset(a).cost)}，殘值 ${fmt(normalizeAsset(a).residual)}，${normalizeAsset(a).life_years} 年</span></div><div id="sch"></div></div>`);
        dataTable(root.querySelector('#sch'), { rows: sch, pageSize: 60, exportName: `${a.name}_折舊表.csv`, columns: [{ key: 'month', label: '月份' }, { key: 'amount', label: '折舊', align: 'num', fmt: (v) => fmt(v) }, { key: 'accum', label: '累計折舊', align: 'num', fmt: (v) => fmt(v) }, { key: 'book', label: '帳面價值', align: 'num', fmt: (v) => fmt(v) }] });
      }
    }
  }

  async function editor(a) {
    const isNew = !a;
    a = a || { name: '', category: 'machine', acquired_on: today(), cost: '', life_years: '', residual: '', disposed_on: '', supplier: '', invoice_no: '', tax_amount: '', pay_account: settings.bank_gl || '1103', doc_ids: [], note: '' };
    const att = { ids: [...(a.doc_ids || [])] };
    const r = await modal({
      title: isNew ? '新增固定資產' : `修改 ${a.name}`,
      wide: true,
      body: h`<div class="form-grid">
        <label class="field"><span>名稱</span><input type="text" name="name" value="${a.name}"></label>
        <label class="field"><span>類別</span><select name="category">${options(Object.entries(ASSET_CATEGORIES).map(([k, v]) => [k, `${v.label}（建議 ${v.life} 年）`]), a.category)}</select></label>
        <label class="field"><span>取得日期</span><input type="date" name="acquired_on" value="${a.acquired_on}"></label>
        <label class="field"><span>取得成本（未稅）</span><input type="number" name="cost" value="${a.cost}"></label>
        <label class="field"><span>進項稅額（發票上的營業稅）</span><input type="number" name="tax_amount" value="${a.tax_amount ?? ''}"></label>
        <label class="field"><span>發票號碼</span><input type="text" name="invoice_no" value="${a.invoice_no || ''}" maxlength="12"></label>
        <label class="field"><span>廠商</span><input type="text" name="supplier" value="${a.supplier || ''}"></label>
        <label class="field"><span>付款方式</span><select name="pay_account">${options(PAY_ACCOUNTS, a.pay_account || settings.bank_gl || '1103')}</select></label>
        <label class="field"><span>耐用年數（空白＝類別建議值）</span><input type="number" name="life_years" value="${a.life_years ?? ''}"></label>
        <label class="field"><span>殘值（空白＝成本÷(年數+1)）</span><input type="number" name="residual" value="${a.residual ?? ''}"></label>
        <label class="field"><span>處分日期（報廢／出售）</span><input type="date" name="disposed_on" value="${a.disposed_on || ''}"></label>
        <label class="field"><span>備註</span><input type="text" name="note" value="${a.note || ''}"></label>
      </div>
      <div id="fa-att" style="margin-top:12px"></div>
      <p class="muted" style="font-size:12.5px;margin-top:8px">購置發票可以拍照、上傳檔案，或從憑證匣選擇（也可選已入帳的資產發票）。儲存後可按「建立購置分錄」，系統預填「借 資產科目、進項稅額／貸 付款方式」，確認後再存。</p>`,
      onMount: (dlg) => {
        const touched = new Set();
        dlg.addEventListener('input', (ev) => ev.target.name && touched.add(ev.target.name));
        return attachmentEditor(dlg.querySelector('#fa-att'), att, {
          newDocExtra: () => ({ status: 'reviewed', account: ASSET_CATEGORIES[dlg.querySelector('[name=category]').value]?.asset }),
          newDocFallback: () => ({ doc_date: touched.has('acquired_on') ? dlg.querySelector('[name=acquired_on]').value : undefined, vendor_name: dlg.querySelector('[name=supplier]').value.trim() || undefined }),
          include: (d) => FIXED_ASSET_ACCOUNTS.has(d.account) && !d.asset_id,
          onChange: (ids, all) => {
            // 從發票帶入空白欄位
            const d = all.find((x) => x.id === ids[ids.length - 1]);
            if (!d) return;
            // 使用者沒改過的欄位才帶入（新增時的預設日期會被發票日期取代）
            const set = (n, v) => {
              const el = dlg.querySelector(`[name=${n}]`);
              if (el && (!el.value || (isNew && !touched.has(n))) && v !== null && v !== undefined && v !== '') el.value = v;
            };
            set('invoice_no', d.invoice_no);
            set('supplier', d.vendor_name);
            set('acquired_on', d.doc_date);
            if (d.amount_total) {
              const tax = d.tax_amount ?? (d.invoice_no ? Math.round(d.amount_total - d.amount_total / 1.05) : 0);
              set('tax_amount', tax || '');
              set('cost', round2(d.amount_total - (tax || 0)));
            }
          },
        });
      },
      actions: [
        { label: '取消', value: null },
        {
          label: '儲存',
          primary: true,
          value: (d) => {
            const g = (n) => d.querySelector(`[name=${n}]`).value.trim();
            if (!g('name') || !g('acquired_on') || !(Number(g('cost')) > 0)) {
              toast('請填名稱、取得日期與成本', 'error');
              return false;
            }
            return {
              ...a,
              id: a.id || uid('fa_'),
              name: g('name'),
              category: g('category'),
              acquired_on: g('acquired_on'),
              cost: Number(g('cost')),
              tax_amount: g('tax_amount') === '' ? null : Number(g('tax_amount')),
              invoice_no: g('invoice_no').toUpperCase().replace(/[\s-]/g, ''),
              pay_account: g('pay_account'),
              life_years: g('life_years') ? Number(g('life_years')) : null,
              residual: g('residual') === '' ? null : Number(g('residual')),
              disposed_on: g('disposed_on') || null,
              supplier: g('supplier'),
              note: g('note'),
            };
          },
        },
      ],
    });
    if (!r) return;
    r.doc_ids = att.ids;
    docs = await store.all('documents');
    // 附上的發票若已在「憑證歸檔」入帳，直接視為購置分錄，避免重複入帳
    const posted = docs.find((d) => att.ids.includes(d.id) && d.entry_id);
    if (!r.purchase_entry_id && posted) r.purchase_entry_id = posted.entry_id;
    await store.put('fixed_assets', r);
    const linkDocs = docs.filter((d) => att.ids.includes(d.id) && d.asset_id !== r.id).map((d) => ({ ...d, asset_id: r.id }));
    const unlinkDocs = docs.filter((d) => d.asset_id === r.id && !att.ids.includes(d.id)).map((d) => ({ ...d, asset_id: null }));
    if (linkDocs.length || unlinkDocs.length) await store.put('documents', [...linkDocs, ...unlinkDocs]);
    assets = await store.all('fixed_assets');
    await syncDepreciation();
    entries = await store.all('journal_entries');
    toast(`已儲存，預設殘值 ${fmt(defaultResidual(r.cost, normalizeAsset(r).life_years))}，折舊分錄已更新`, 'good');
    await draw();
    if (!r.purchase_entry_id && !isOpening(r) && (await confirmBox(`要現在建立「${r.name}」的購置分錄嗎？系統會預填金額與科目，確認後再儲存。`, { ok: '建立購置分錄' }))) await purchase(r);
  }

  // 附在資產上的發票：補上發票號、金額、稅額、科目（營業稅工作表的進項清單以憑證為準）
  async function syncAssetDocs(a, assetAccount, tax) {
    docs = await store.all('documents');
    const mine = docs.filter((d) => (a.doc_ids || []).includes(d.id));
    const invoiceDoc = mine.find((d) => d.invoice_no && d.invoice_no === a.invoice_no) || (mine.length === 1 ? mine[0] : null);
    const upd = mine.map((d) => {
      const x = { ...d, asset_id: a.id };
      if (d === invoiceDoc) {
        Object.assign(x, {
          doc_date: d.doc_date || a.acquired_on,
          vendor_name: d.vendor_name || a.supplier,
          invoice_no: a.invoice_no || d.invoice_no,
          amount_total: round2(Number(a.cost) + (Number(a.tax_amount) || 0)),
          tax_amount: Number(a.tax_amount) || null,
          account: assetAccount,
          deductible: tax > 0 ? true : d.deductible,
          summary: d.summary || a.name,
        });
      }
      return x;
    });
    if (upd.length) await store.put('documents', upd);
    docs = await store.all('documents');
  }

  // 購置分錄：借 資產科目（未稅成本）、進項稅額；貸 付款方式
  async function purchase(a) {
    a = assets.find((x) => x.id === a.id) || a;
    if (isLocked(settings, a.acquired_on)) return toast(`${a.acquired_on.slice(0, 7)} 已結帳鎖定，請先解除鎖定`, 'error');
    const cat = ASSET_CATEGORIES[a.category] || ASSET_CATEGORIES.machine;
    const tax = settings.vat_mode === 'general' ? Number(a.tax_amount) || 0 : 0;
    const cost = settings.vat_mode === 'general' ? Number(a.cost) : Number(a.cost) + (Number(a.tax_amount) || 0);
    const lines = [{ account: cat.asset, debit: cost, credit: 0, memo: a.name }];
    if (tax) lines.push({ account: '1261', debit: tax, credit: 0, memo: '進項稅額（固定資產）' });
    lines.push({ account: a.pay_account || settings.bank_gl || '1103', debit: 0, credit: round2(cost + tax), memo: a.supplier || '' });
    const saved = await editEntry(null, {
      title: `建立購置分錄：${a.name}`,
      defaults: { date: a.acquired_on, description: ['購置', a.name, a.supplier, a.invoice_no].filter(Boolean).join('｜'), source: 'asset', source_ref: a.id, lines, attachments: a.doc_ids || [], docExtra: { asset_id: a.id, account: cat.asset } },
    });
    if (!saved) return;
    const upd = { ...a, purchase_entry_id: saved.id, doc_ids: saved.attachments || a.doc_ids || [] };
    await store.put('fixed_assets', upd);
    await syncAssetDocs(upd, cat.asset, tax);
    assets = await store.all('fixed_assets');
    entries = await store.all('journal_entries');
    if (!upd.doc_ids.length) toast('購置分錄已建立，但還沒有附上發票，請記得補上', 'info', 6000);
    draw();
  }

  const unbind = bindActions(root, {
    ym: (el) => {
      if (!el.value) return;
      f.ym = el.value;
      ctx.setParams({ ym: f.ym });
      draw();
    },
    add: () => editor(null),
    edit: (el) => editor(assets.find((a) => a.id === el.dataset.id)),
    purchase: (el) => purchase(assets.find((a) => a.id === el.dataset.id)),
    viewDoc: async (el) => {
      const a = assets.find((x) => x.id === el.dataset.id);
      docs = await store.all('documents');
      const list = (a.doc_ids || []).map((id) => docs.find((d) => d.id === id)).filter(Boolean);
      if (list.length) await previewDocument(list[0]);
      if (list.length > 1) toast(`共 ${list.length} 張，其餘請在「修改」中檢視`, 'info');
    },
    detail: (el) => {
      f.detail = el.dataset.id;
      ctx.setParams({ detail: f.detail });
      draw();
    },
    del: async (el) => {
      const a = assets.find((x) => x.id === el.dataset.id);
      if (!(await confirmBox(`刪除「${a.name}」？相關折舊分錄會重新計算（已鎖定月份不變）。${entryOf(a) ? `購置分錄 ${entryOf(a).voucher_no} 不會自動刪除，請到日記簿處理。` : ''}`, { danger: true, ok: '刪除' }))) return;
      await store.remove('fixed_assets', a.id);
      assets = await store.all('fixed_assets');
      await syncDepreciation();
      entries = await store.all('journal_entries');
      draw();
    },
    print: () => window.print(),
    xlsx: () => downloadWorkbook(`固定資產折舊明細_${f.ym}.xlsx`, (meta) => assetsSheet(assets, f.ym, { ...meta, period: `截至民國 ${Number(f.ym.slice(0, 4)) - 1911} 年 ${Number(f.ym.slice(5))} 月` })),
  });
  await draw();
  return unbind;
}
