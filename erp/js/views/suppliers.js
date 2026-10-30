// 供應商（Supplier_Profile ＋ Payment_Terms）：基本資料（簡稱、發票抬頭、統編、公司電話、聯絡人業務與手機、備註）
// 與付款條件（付款條件、匯款銀行－分行、銀行代號、戶名、匯款帳號、付款備註）。
// 採購次數、金額、交貨天數、良率由「進貨紀錄」統計；進貨單在進貨紀錄頁登記或從匯入中心匯入。

import { h, mount, bindActions, dataTable, modal, confirmBox, toast, stat, fmt, emptyState, downloadCSV, setBusy } from '../ui.js';
import { store } from '../store.js';
import { supplierStats } from '../lib/inventory.js';
import { supplierLabel, templateCSV } from '../lib/purchases.js';
import { lookupCompanyName, canLookupCompany, isBan } from '../lib/companyname.js';
import { uid } from '../lib/text.js';
import { round2 } from '../lib/money.js';

const fail = (msg) => {
  toast(msg, 'error');
  return false;
};
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const oneDec = (v) => (v === null || v === undefined ? '—' : Number.isInteger(v) ? fmt(v) : v.toFixed(1));
const small = (text) => h`<div class="muted" style="font-size:12px">${text}</div>`;

export const EMPTY_SUPPLIER = { name: '', short_name: '', tax_id: '', phone: '', contact: '', mobile: '', note: '', terms: '', bank_branch: '', bank_code: '', account_name: '', account_number: '', pay_note: '' };

export function bankLine(s) {
  return [s.bank_branch, s.bank_code ? `（${s.bank_code}）` : '', s.account_name, s.account_number].filter(Boolean).join(' ');
}

/**
 * 新增／修改供應商並儲存；取消回傳 null。
 */
export async function editSupplier(sup, { suppliers }) {
  const x = { ...EMPTY_SUPPLIER, ...(sup || {}) };
  const field = (name, label, attrs = '', full = false) => h`<label class="field" ${full ? 'style="grid-column:1/-1"' : ''}><span>${label}</span><input type="text" name="${name}" value="${x[name] || ''}" ${attrs}></label>`;
  const r = await modal({
    title: sup ? `修改供應商：${supplierLabel(x)}` : '新增供應商',
    wide: true,
    body: h`<h3 style="margin:4px 0 8px;font-size:14px">基本資料</h3>
      <div class="form-grid">
        ${field('short_name', '簡稱（畫面上顯示用）', 'placeholder="例如：鮮乳坊"')}
        <label class="field"><span>發票抬頭（登記全名）</span><span class="row" style="gap:6px"><input type="text" name="name" value="${x.name || ''}" placeholder="例如：鮮乳坊股份有限公司" style="flex:1">${canLookupCompany() ? h`<button type="button" class="btn sm" data-regname title="用統編查經濟部商工登記的登記名稱">查全名</button>` : ''}</span></label>
        ${field('tax_id', '統一編號', 'inputmode="numeric" maxlength="8" placeholder="8 碼"')}
        ${field('phone', '公司電話', 'inputmode="tel"')}
        ${field('contact', '聯絡人（業務）')}
        ${field('mobile', '聯絡人手機', 'inputmode="tel"')}
        ${field('note', '備註', 'placeholder="例如：每週二、五配送；最低訂購量 5 kg"', true)}
      </div>
      <h3 style="margin:16px 0 8px;font-size:14px">付款條件</h3>
      <div class="form-grid">
        ${field('terms', '付款條件', 'placeholder="例如：月結 30 天、貨到付款"')}
        ${field('bank_branch', '匯款銀行－分行', 'placeholder="例如：台灣銀行－城中分行"')}
        ${field('bank_code', '銀行代號', 'inputmode="numeric" placeholder="例如：004"')}
        ${field('account_name', '戶名')}
        ${field('account_number', '匯款帳號', 'inputmode="numeric"')}
        ${field('pay_note', '付款備註', 'placeholder="例如：匯款後 LINE 通知業務"', true)}
      </div>`,
    actions: [
      { label: '取消', value: null },
      {
        label: '儲存',
        primary: true,
        value: (dlg) => {
          const g = (n) => dlg.querySelector(`[name=${n}]`).value.trim();
          const out = { ...x, id: x.id || uid('sp_') };
          for (const k of Object.keys(EMPTY_SUPPLIER)) out[k] = g(k);
          if (!out.name && !out.short_name) return fail('請輸入發票抬頭或簡稱');
          if (!out.name) out.name = out.short_name;
          out.tax_id = out.tax_id.normalize('NFKC').replace(/\s/g, '');
          if (out.tax_id && !/^\d{8}$/.test(out.tax_id)) return fail('統一編號應為 8 位數字');
          out.bank_code = out.bank_code.normalize('NFKC').replace(/\D/g, '');
          out.account_number = out.account_number.normalize('NFKC').replace(/[\s-]/g, '');
          const same = (a, b) => a && b && a.trim() === b.trim();
          const clash = suppliers.find((o) => o.id !== out.id && (same(o.name, out.name) || same(o.short_name, out.short_name) || (out.tax_id && o.tax_id === out.tax_id)));
          if (clash) return fail(`已有同名或同統編的供應商「${supplierLabel(clash)}」`);
          return out;
        },
      },
    ],
    onMount: (dlg) => {
      dlg.querySelector('[data-regname]')?.addEventListener('click', async () => {
        const ban = dlg.querySelector('[name=tax_id]').value.trim();
        if (!isBan(ban)) return toast('請先填 8 碼統一編號', 'error');
        setBusy(true, '查商工登記…');
        try {
          const r = await lookupCompanyName(ban, { force: true });
          if (r?.name) {
            dlg.querySelector('[name=name]').value = r.name;
            const an = dlg.querySelector('[name=account_name]');
            if (!an.value.trim()) an.value = r.name;
            toast(`登記名稱：${r.name}${r.status ? `（${r.status}）` : ''}`, 'good', 6000);
          } else toast('商工登記查不到這個統編（分公司請用總公司統編）', 'error', 6000);
        } catch (e) {
          toast(`查詢失敗：${e.message || e}`, 'error', 7000);
        } finally {
          setBusy(false);
        }
      });
    },
  });
  if (!r) return null;
  await store.put('suppliers', r);
  toast(`已儲存「${supplierLabel(r)}」`, 'good');
  return r;
}

export async function render(root, ctx) {
  const colls = ['suppliers', 'inventory_items', 'inventory_moves'];
  let [suppliers, items, moves] = await Promise.all(colls.map((c) => store.all(c)));

  async function reload() {
    [suppliers, items, moves] = await Promise.all(colls.map((c) => store.all(c)));
    draw();
  }

  function draw() {
    const purchases = moves.filter((m) => m.type === 'purchase');
    const supById = new Map(suppliers.map((s) => [s.id, s]));
    const importBtns = h`<a class="btn" href="#/import?target=suppliers">從匯入中心匯入</a><button class="btn ghost" data-act="template">下載匯入範本</button>`;
    if (!suppliers.length) {
      mount(root, h`<div class="card">${emptyState('還沒有供應商', '建立供應商的基本資料與付款條件（匯款銀行、戶名、帳號），登記進貨時就能直接選；也可以用 CSV／Excel 從匯入中心一次匯入整份名單。', h`<div class="row" style="justify-content:center"><button class="btn primary" data-act="addSup">＋ 新供應商</button>${importBtns}</div>`)}</div>`);
      return;
    }
    const noSup = purchases.filter((m) => !supById.has(m.supplier_id)).length;
    const stats = supplierStats(suppliers, items, moves);
    const leads = stats.map((x) => x.avgLead).filter((v) => v !== null);
    const withBank = suppliers.filter((s) => s.account_number).length;
    mount(
      root,
      h`<div class="toolbar">
        <button class="btn primary" data-act="addSup">＋ 新供應商</button>
        ${importBtns}
        <span class="spacer"></span>
        <a class="btn ghost" href="#/purchases">進貨紀錄</a>
      </div>
      <div class="stats">
        ${stat('供應商', fmt(suppliers.length), `${fmt(withBank)} 家已填匯款資料`)}
        ${stat('採購總額', '$' + fmt(round2(purchases.reduce((t, m) => t + (Number(m.amount) || 0), 0))), `${fmt(purchases.length)} 行進貨${noSup ? `・${fmt(noSup)} 行未指定供應商` : ''}`)}
        ${stat('平均交貨天數', oneDec(avg(leads)), leads.length ? `${fmt(leads.length)} 家有訂購日資料` : '進貨時填訂購日即可計算')}
        ${stat('平均良率', oneDec(avg(stats.map((x) => x.avgYield).filter((v) => v !== null))), '進貨時可填 0–100 評分')}
      </div>
      <div class="card">
        <div class="card-head"><h2>供應商名單</h2><span class="card-note">採購次數、交貨天數（訂購日→到貨日）、良率由進貨紀錄統計</span></div>
        <div id="sup-table"></div>
      </div>`,
    );
    dataTable(root.querySelector('#sup-table'), {
      rows: stats.map((x) => ({ ...x.supplier, id: x.supplier.id, label: supplierLabel(x.supplier), count: x.count, total: x.total, avgLead: x.avgLead, avgYield: x.avgYield, last: x.last || '' })),
      exportName: '供應商.csv',
      initialSort: { key: 'total', dir: -1 },
      columns: [
        { key: 'label', label: '供應商', fmt: (v, r) => h`<b style="white-space:nowrap">${v}</b>${r.short_name && r.name && r.name !== r.short_name ? small(r.name) : ''}`, csv: (v, r) => r.name || v },
        { key: 'tax_id', label: '統編' },
        { key: 'phone', label: '公司電話' },
        { key: 'contact', label: '聯絡人（業務）', fmt: (v, r) => h`${v || ''}${r.mobile ? small(r.mobile) : ''}`, csv: (v, r) => [v, r.mobile].filter(Boolean).join(' ') },
        { key: 'terms', label: '付款條件／匯款資料', fmt: (v, r) => h`${v || ''}${bankLine(r) ? small(bankLine(r)) : ''}${r.pay_note ? small(r.pay_note) : ''}`, csv: (v, r) => [v, bankLine(r), r.pay_note].filter(Boolean).join('；') },
        { key: 'count', label: '採購次數', align: 'num', fmt: (v) => fmt(v) },
        { key: 'total', label: '採購總額', align: 'num', fmt: (v) => '$' + fmt(v) },
        { key: 'avgLead', label: '平均交貨天數', align: 'num', fmt: (v) => oneDec(v) },
        { key: 'avgYield', label: '平均良率', align: 'num', fmt: (v) => oneDec(v) },
        { key: 'last', label: '最後採購', fmt: (v) => v || '—' },
        { key: 'note', label: '備註' },
        { key: 'id', label: '', nosort: true, fmt: (v, r) => h`<span style="white-space:nowrap"><button class="btn sm" data-act="editSup" data-id="${v}">修改</button> <a class="btn sm ghost" href="#/purchases?sup=${v}">進貨</a>${r.count ? '' : h` <button class="btn sm danger" data-act="delSup" data-id="${v}">刪除</button>`}</span>`, csv: () => '' },
      ],
    });
  }

  const unbind = bindActions(root, {
    addSup: async () => {
      if (await editSupplier(null, { suppliers })) await reload();
    },
    editSup: async (el) => {
      const sup = suppliers.find((x) => x.id === el.dataset.id);
      if (sup && (await editSupplier(sup, { suppliers }))) await reload();
    },
    delSup: async (el) => {
      const sup = suppliers.find((x) => x.id === el.dataset.id);
      if (!sup) return;
      if (moves.some((m) => m.supplier_id === sup.id)) return toast('這個供應商已有進貨紀錄，無法刪除', 'error');
      if (!(await confirmBox(`刪除供應商「${supplierLabel(sup)}」？`, { ok: '刪除', danger: true }))) return;
      await store.remove('suppliers', sup.id);
      toast('已刪除供應商', 'good');
      await reload();
    },
    template: () => downloadCSV('供應商資料範本.csv', templateCSV('suppliers')),
  });
  draw();
  return unbind;
}
