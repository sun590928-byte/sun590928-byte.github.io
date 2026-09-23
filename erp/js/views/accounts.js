// 會計項目：咖啡飲品業專用科目表（可新增、修改名稱、停用）。

import { h, raw, mount, bindActions, dataTable, modal, toast, options, downloadCSV } from '../ui.js';
import { store } from '../store.js';
import { getAccounts } from '../state.js';
import { TYPE_LABELS } from '../lib/coa.js';

const SIDE = { debit: '借', credit: '貸' };
const BEHAVIOR = { '': '—', fixed: '固定', variable: '變動' };

export async function render(root) {
  let accounts = await getAccounts();
  const used = new Set((await store.all('journal_entries')).flatMap((e) => (e.lines || []).map((l) => l.account)));
  const f = { type: '', q: '' };

  function draw() {
    const q = f.q.trim();
    const rows = accounts.filter((a) => (!f.type || a.type === f.type) && (!q || `${a.code}${a.name}${a.hint || ''}`.includes(q)));
    mount(
      root,
      h`<div class="callout" style="margin-bottom:14px"><p>科目依「商業會計項目表」架構編排，並針對咖啡館增列<b>在途款項（綠界、LINE Pay）、分品類存貨（豆、乳品、包材）、分品類銷貨收入、寄杯預收款</b>等項目；費用科目的「申報欄位」對應營利事業所得稅結算申報書，年度申報可直接彙總。<b>建議版本，請與記帳士確認後使用。</b></p></div>
      <div class="toolbar">
        <label class="field"><span>類別</span><select data-act="type">${options([['', '全部'], ...Object.entries(TYPE_LABELS)], f.type)}</select></label>
        <label class="field"><span>搜尋</span><input type="search" value="${f.q}" data-act="q"></label>
        <span class="spacer"></span>
        <button class="btn primary" data-act="add">＋ 新增科目</button>
        <button class="btn ghost" data-act="export">匯出 CSV</button>
      </div>
      <div class="card"><div id="t"></div></div>`,
    );
    dataTable(root.querySelector('#t'), {
      rows,
      pageSize: 200,
      rowClass: (r) => (r.active === false ? 'muted' : ''),
      columns: [
        { key: 'code', label: '代號' },
        { key: 'name', label: '會計項目', fmt: (v, r) => h`<b>${v}</b>${r.contra ? h` <span class="badge">抵銷科目</span>` : ''}${r.hint ? h`<div class="muted" style="font-size:12px">${r.hint}</div>` : ''}` },
        { key: 'type', label: '類別', fmt: (v, r) => `${TYPE_LABELS[v] || v}${r.grp === 'noncurrent' ? '（非流動）' : r.grp === 'current' ? '（流動）' : ''}` },
        { key: 'side', label: '餘額', fmt: (v) => SIDE[v] || v },
        { key: 'behavior', label: '成本性質', fmt: (v) => BEHAVIOR[v || ''] },
        { key: 'tax_line', label: '營所稅申報欄位' },
        { key: 'code', label: '', nosort: true, fmt: (v, r) => h`<button class="btn sm" data-act="edit" data-code="${v}">修改</button>${used.has(v) ? '' : h` <button class="btn sm ghost" data-act="toggle" data-code="${v}">${r.active === false ? '啟用' : '停用'}</button>`}` },
      ],
    });
  }

  async function editor(a) {
    const isNew = !a;
    a = a || { code: '', name: '', type: 'expense', side: 'debit', grp: '', behavior: '', tax_line: '', hint: '', active: true };
    const r = await modal({
      title: isNew ? '新增會計項目' : `修改 ${a.code} ${a.name}`,
      body: h`<div class="form-grid">
        <label class="field"><span>代號（4 碼）</span><input type="text" name="code" value="${a.code}" ${isNew ? '' : raw('disabled')} pattern="\\d{4}"></label>
        <label class="field"><span>名稱</span><input type="text" name="name" value="${a.name}"></label>
        <label class="field"><span>類別</span><select name="type">${options(Object.entries(TYPE_LABELS), a.type)}</select></label>
        <label class="field"><span>流動性（資產／負債）</span><select name="grp">${options([['', '—'], ['current', '流動'], ['noncurrent', '非流動']], a.grp || '')}</select></label>
        <label class="field"><span>成本性質（營運損益）</span><select name="behavior">${options(Object.entries(BEHAVIOR), a.behavior || '')}</select></label>
        <label class="field"><span>營所稅申報欄位</span><input type="text" name="tax_line" value="${a.tax_line || ''}"></label>
        <label class="field" style="grid-column:1/-1"><span>說明</span><input type="text" name="hint" value="${a.hint || ''}"></label>
        <label class="check"><input type="checkbox" name="contra" ${a.contra ? raw('checked') : ''}> 抵銷科目（例如累計折舊、銷貨折讓）</label>
      </div>`,
      actions: [
        { label: '取消', value: null },
        {
          label: '儲存',
          primary: true,
          value: (d) => {
            const get = (n) => d.querySelector(`[name=${n}]`);
            const code = isNew ? get('code').value.trim() : a.code;
            if (!/^\d{4}$/.test(code)) {
              toast('代號需為 4 位數字', 'error');
              return false;
            }
            if (isNew && accounts.some((x) => x.code === code)) {
              toast('代號已存在', 'error');
              return false;
            }
            const type = get('type').value;
            const contra = get('contra').checked;
            const debitType = ['asset', 'cogs', 'expense', 'nonop_expense', 'tax'].includes(type);
            return { ...a, code, name: get('name').value.trim(), type, grp: get('grp').value, behavior: get('behavior').value, tax_line: get('tax_line').value.trim(), hint: get('hint').value.trim(), contra, side: debitType !== contra ? 'debit' : 'credit' };
          },
        },
      ],
    });
    if (!r || !r.name) return;
    await store.put('accounts', r);
    accounts = await getAccounts();
    toast('已儲存', 'good');
    draw();
  }

  const unbind = bindActions(root, {
    type: (el) => {
      f.type = el.value;
      draw();
    },
    q: (el) => {
      f.q = el.value;
      draw();
    },
    add: () => editor(null),
    edit: (el) => editor(accounts.find((a) => a.code === el.dataset.code)),
    toggle: async (el) => {
      const a = accounts.find((x) => x.code === el.dataset.code);
      await store.put('accounts', { ...a, active: a.active === false });
      accounts = await getAccounts();
      draw();
    },
    export: () => downloadCSV('會計項目表.csv', [['代號', '名稱', '類別', '餘額方向', '成本性質', '營所稅申報欄位', '說明'], ...accounts.map((a) => [a.code, a.name, TYPE_LABELS[a.type], SIDE[a.side], BEHAVIOR[a.behavior || ''], a.tax_line || '', a.hint || ''])]),
  });
  draw();
  return unbind;
}
