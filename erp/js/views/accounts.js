// 會計項目：咖啡飲品業專用科目表（可新增、修改名稱、停用、匯入整份科目表 CSV）。
// 每次儲存後直接從資料來源重讀確認；資料位置（雲端專案／本機）顯示在頁首，避免改到另一份資料。

import { h, raw, mount, bindActions, dataTable, modal, toast, options, downloadCSV, pickFiles, setBusy } from '../ui.js';
import { store } from '../store.js';
import { getAccounts } from '../state.js';
import { TYPE_LABELS, parseAccountsRows, diffAccounts } from '../lib/coa.js';
import { decodeBytes, parseCSV } from '../lib/csv.js';

const SIDE = { debit: '借', credit: '貸' };
const BEHAVIOR = { '': '—', fixed: '固定', variable: '變動' };

export async function render(root) {
  let accounts = await getAccounts();
  const used = new Set((await store.all('journal_entries')).flatMap((e) => (e.lines || []).map((l) => l.account)));
  const f = { type: '', q: '' };

  function draw() {
    const q = f.q.trim();
    const loc = store.location;
    const rows = accounts.filter((a) => (!f.type || a.type === f.type) && (!q || `${a.code}${a.name}${a.hint || ''}`.includes(q)));
    mount(
      root,
      h`<div class="callout ${loc.kind === 'local' ? 'warn' : ''}" style="margin-bottom:14px"><p>資料位置：<b>${loc.label}</b>${loc.email ? `（${loc.email}）` : ''}。${
        loc.kind === 'local'
          ? h`<br>目前是<b>本機模式</b>：科目只存在這台電腦的這個瀏覽器，其他電腦、手機與 Claude 連接器讀的是雲端，看不到這裡的修改。要共用請到<a href="#/settings">設定與備份</a>啟用雲端。`
          : ''
      }<br>每次儲存後系統會重新讀取確認；匯入整份科目表請用「匯入科目表 CSV」（格式同「匯出 CSV」）。</p></div>
      <div class="toolbar">
        <label class="field"><span>類別</span><select data-act="type">${options([['', '全部'], ...Object.entries(TYPE_LABELS)], f.type)}</select></label>
        <label class="field"><span>搜尋</span><input type="search" value="${f.q}" data-act="q"></label>
        <span class="spacer"></span>
        <button class="btn primary" data-act="add">＋ 新增科目</button>
        <button class="btn" data-act="import">匯入科目表 CSV</button>
        <button class="btn ghost" data-act="export">匯出 CSV</button>
      </div>
      <div class="card"><div id="t"></div></div>`,
    );
    dataTable(root.querySelector('#t'), {
      rows,
      pageSize: 200,
      rowClass: (r) => (r.active === false ? 'muted-row' : ''),
      columns: [
        { key: 'code', label: '代號' },
        { key: 'name', label: '會計項目', fmt: (v, r) => h`<b>${v}</b>${r.contra ? h` <span class="badge">抵銷科目</span>` : ''}${r.active === false ? h` <span class="badge">已停用</span>` : ''}${r.hint ? h`<div class="muted" style="font-size:12px">${r.hint}</div>` : ''}` },
        { key: 'type', label: '類別', fmt: (v, r) => `${TYPE_LABELS[v] || v}${r.grp === 'noncurrent' ? '（非流動）' : r.grp === 'current' ? '（流動）' : ''}` },
        { key: 'side', label: '餘額', fmt: (v) => SIDE[v] || v },
        { key: 'behavior', label: '成本性質', fmt: (v) => BEHAVIOR[v || ''] },
        { key: 'tax_line', label: '營所稅申報欄位' },
        { key: 'code', label: '', nosort: true, fmt: (v, r) => h`<button class="btn sm" data-act="edit" data-code="${v}">修改</button>${used.has(v) ? '' : h` <button class="btn sm ghost" data-act="toggle" data-code="${v}">${r.active === false ? '啟用' : '停用'}</button>`}` },
      ],
    });
  }

  // 寫入後直接從資料來源重讀，逐筆比對名稱、類別、啟用狀態；有不一致就明確告知
  async function saveVerified(rows) {
    await store.put('accounts', rows);
    const back = new Map((await store.fresh('accounts')).map((a) => [a.code, a]));
    const bad = rows.filter((r) => {
      const b = back.get(r.code);
      return !b || b.name !== r.name || b.type !== r.type || (b.active !== false) !== (r.active !== false);
    });
    accounts = await getAccounts();
    if (bad.length) {
      await modal({
        title: '修改沒有存進資料庫',
        body: h`<p>送出了 ${rows.length} 個科目，但重新讀取時有 ${bad.length} 個仍是舊的：${bad.slice(0, 8).map((r) => `${r.code} ${r.name}`).join('、')}${bad.length > 8 ? '…' : ''}。</p>
          <p>資料位置：<b>${store.location.label}</b>。請截圖這個畫面給系統管理者；可先下載加密備份，避免資料遺失。</p>`,
      });
      return false;
    }
    return true;
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
        <label class="field"><span>營所稅申報欄位（費用科目才需要，例如「其他費用」）</span><input type="text" name="tax_line" value="${a.tax_line || ''}"></label>
        <label class="field" style="grid-column:1/-1"><span>說明</span><input type="text" name="hint" value="${a.hint || ''}"></label>
        <label class="check"><input type="checkbox" name="contra" ${a.contra ? raw('checked') : ''}> 抵銷科目（例如累計折舊、銷貨折讓）</label>
      </div>`,
      onMount: (d) => {
        // 新增時依代號帶出類別（1 資產、2 負債…），避免新科目停在預設的「營業費用」
        const code = d.querySelector('[name=code]');
        const type = d.querySelector('[name=type]');
        code?.addEventListener('input', () => {
          const t = { 1: 'asset', 2: 'liability', 3: 'equity', 4: 'revenue', 5: 'cogs', 6: 'expense', 8: 'tax' }[code.value[0]];
          if (isNew && t) type.value = t;
        });
      },
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
            let taxLine = get('tax_line').value.trim();
            if (/^[借貸]$/.test(taxLine)) taxLine = type === 'expense' ? '其他費用' : '';
            return { ...a, code, name: get('name').value.trim(), type, grp: get('grp').value, behavior: get('behavior').value, tax_line: taxLine, hint: get('hint').value.trim(), contra, side: debitType !== contra ? 'debit' : 'credit' };
          },
        },
      ],
    });
    if (!r || !r.name) return;
    if (await saveVerified([r])) toast(`已儲存並確認：${r.code} ${r.name}`, 'good');
    draw();
  }

  async function importCSV() {
    const [file] = await pickFiles({ accept: '.csv,text/csv', multiple: false });
    if (!file) return;
    const { text } = decodeBytes(new Uint8Array(await file.arrayBuffer()));
    const parsed = parseAccountsRows(parseCSV(text), accounts);
    if (parsed.errors.length && !parsed.accounts.length) return modal({ title: '無法匯入', body: h`<ul class="plain-list">${parsed.errors.map((e) => h`<li>${e}</li>`)}</ul>` });
    const diff = diffAccounts(accounts, parsed.accounts, used);
    const oldName = new Map(accounts.map((a) => [a.code, a.name]));
    const swapped = diff.renamed.filter((x) => [...oldName].some(([c, n]) => c !== x.code && n === x.to));
    const keepUsed = diff.missing.filter((m) => m.used);
    const deactivate = diff.missing.filter((m) => !m.used);
    const li = (list, fmt) => (list.length ? h`<ul class="plain-list" style="max-height:180px;overflow:auto">${list.map((x) => h`<li>${fmt(x)}</li>`)}</ul>` : h`<p class="muted">（無）</p>`);
    const ok = await modal({
      title: `匯入科目表：${file.name}`,
      wide: true,
      body: h`<p>共 ${parsed.accounts.length} 個科目，匯入到：<b>${store.location.label}</b>。</p>
        ${parsed.fixes.length ? h`<div class="callout warn" style="margin:8px 0"><p><b>自動修正 ${parsed.fixes.length} 處</b></p>${li(parsed.fixes, (x) => x)}</div>` : ''}
        ${parsed.errors.length ? h`<div class="callout bad" style="margin:8px 0"><p><b>略過 ${parsed.errors.length} 列</b></p>${li(parsed.errors, (x) => x)}</div>` : ''}
        ${swapped.length ? h`<div class="callout bad" style="margin:8px 0"><p><b>名稱對調 ${swapped.length} 個</b>：已入帳的分錄、已填好付款方式的憑證會跟著改名，請確認代號對應正確。</p>${li(swapped, (x) => `${x.code}：${x.from} → ${x.to}${x.used ? '（已有分錄）' : ''}`)}</div>` : ''}
        <h3 style="font-size:14px;margin:10px 0 4px">新增 ${diff.added.length} 個</h3>${li(diff.added, (x) => `${x.code} ${x.name}（${TYPE_LABELS[x.type]}）`)}
        <h3 style="font-size:14px;margin:10px 0 4px">改名 ${diff.renamed.length} 個</h3>${li(diff.renamed, (x) => `${x.code}：${x.from} → ${x.to}${x.used ? '（已有分錄）' : ''}`)}
        <h3 style="font-size:14px;margin:10px 0 4px">其他欄位更新 ${diff.changed.length} 個</h3>${li(diff.changed, (x) => `${x.code} ${x.name}`)}
        <h3 style="font-size:14px;margin:10px 0 4px">科目表裡沒有的科目 ${diff.missing.length} 個</h3>${li(diff.missing, (x) => `${x.code} ${x.name}：${x.used ? '已有分錄，保留' : '將停用（可再啟用）'}`)}`,
      actions: [
        { label: '取消', value: null },
        { label: `確認匯入（${parsed.accounts.length}）`, primary: true, value: true },
      ],
    });
    if (!ok) return;
    const byCode = new Map(accounts.map((a) => [a.code, a]));
    const rows = [...parsed.accounts, ...deactivate.map((m) => ({ ...byCode.get(m.code), active: false }))];
    setBusy(true, '匯入科目表…');
    let good;
    try {
      good = await saveVerified(rows);
    } finally {
      setBusy(false);
    }
    if (good) toast(`已匯入並確認 ${parsed.accounts.length} 個科目${deactivate.length ? `，停用 ${deactivate.length} 個` : ''}${keepUsed.length ? `；${keepUsed.length} 個已有分錄的科目保留` : ''}`, 'good', 8000);
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
    import: () => importCSV(),
    edit: (el) => editor(accounts.find((a) => a.code === el.dataset.code)),
    toggle: async (el) => {
      const a = accounts.find((x) => x.code === el.dataset.code);
      await saveVerified([{ ...a, active: a.active === false }]);
      draw();
    },
    export: () => downloadCSV('會計項目表.csv', [['代號', '名稱', '類別', '餘額方向', '成本性質', '營所稅申報欄位', '說明'], ...accounts.map((a) => [a.code, a.name, TYPE_LABELS[a.type], SIDE[a.side], BEHAVIOR[a.behavior || ''], a.tax_line || '', a.hint || ''])]),
  });
  draw();
  return unbind;
}

