// 固定資產與折舊明細表：平均法、殘值預設「成本 ÷（耐用年數＋1）」，每月自動提列折舊分錄。

import { h, mount, bindActions, dataTable, fmt, stat, modal, toast, options, confirmBox, emptyState, status } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getAccounts } from '../state.js';
import { accountBalance } from '../lib/ledger.js';
import { monthEnd } from '../lib/dates.js';
import { ASSET_CATEGORIES } from '../lib/coa.js';
import { assetSummary, schedule, normalizeAsset, defaultResidual } from '../lib/assets.js';
import { addMonths, today } from '../lib/dates.js';
import { uid } from '../lib/text.js';
import { syncDepreciation } from '../sync.js';
import { reportHead } from './_shared.js';

export async function render(root, ctx) {
  const settings = await getSettings();
  let assets = await store.all('fixed_assets');
  const accounts = await getAccounts();
  let entries = await store.all('journal_entries');
  const f = { ym: ctx.params.ym || today().slice(0, 7), detail: ctx.params.detail || '' };

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
      </div>
      <div class="callout no-print" style="margin-bottom:14px"><p>折舊採<b>平均法</b>，殘值預設為「成本 ÷（耐用年數＋1）」，取得當月即開始提列。耐用年數請依財政部《固定資產耐用年數表》；單價未達新台幣 8 萬元或耐用年限不及 2 年的器具，一般可直接列為費用（「雜項購置」），<b>實際認定請與記帳士確認</b>。資產變動後會自動更新 ${settings.revenue_start.slice(0, 7)} 起的每月折舊分錄。</p></div>
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
        ${recon.some((r) => !r.ok) ? h`<p class="muted" style="font-size:12.5px;margin-top:8px">新增資產只會自動提列折舊，<b>不會</b>自動做購置分錄。請在「憑證歸檔」或「日記簿」以資產科目（例如 1511 生財器具）登錄購置；營收起算日前購置者，取得成本與累計折舊請列入「期初開帳」。</p>` : ''}
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
    a = a || { name: '', category: 'machine', acquired_on: today(), cost: '', life_years: '', residual: '', disposed_on: '', supplier: '', note: '' };
    const r = await modal({
      title: isNew ? '新增固定資產' : `修改 ${a.name}`,
      body: h`<div class="form-grid">
        <label class="field"><span>名稱</span><input type="text" name="name" value="${a.name}"></label>
        <label class="field"><span>類別</span><select name="category">${options(Object.entries(ASSET_CATEGORIES).map(([k, v]) => [k, `${v.label}（建議 ${v.life} 年）`]), a.category)}</select></label>
        <label class="field"><span>取得日期</span><input type="date" name="acquired_on" value="${a.acquired_on}"></label>
        <label class="field"><span>取得成本（未稅）</span><input type="number" name="cost" value="${a.cost}"></label>
        <label class="field"><span>耐用年數（空白＝類別建議值）</span><input type="number" name="life_years" value="${a.life_years ?? ''}"></label>
        <label class="field"><span>殘值（空白＝成本÷(年數+1)）</span><input type="number" name="residual" value="${a.residual ?? ''}"></label>
        <label class="field"><span>處分日期（報廢／出售）</span><input type="date" name="disposed_on" value="${a.disposed_on || ''}"></label>
        <label class="field"><span>廠商</span><input type="text" name="supplier" value="${a.supplier || ''}"></label>
        <label class="field" style="grid-column:1/-1"><span>備註</span><input type="text" name="note" value="${a.note || ''}"></label>
      </div>`,
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
            return { ...a, id: a.id || uid('fa_'), name: g('name'), category: g('category'), acquired_on: g('acquired_on'), cost: Number(g('cost')), life_years: g('life_years') ? Number(g('life_years')) : null, residual: g('residual') === '' ? null : Number(g('residual')), disposed_on: g('disposed_on') || null, supplier: g('supplier'), note: g('note') };
          },
        },
      ],
    });
    if (!r) return;
    await store.put('fixed_assets', r);
    assets = await store.all('fixed_assets');
    await syncDepreciation();
    entries = await store.all('journal_entries');
    toast(`已儲存，預設殘值 ${fmt(defaultResidual(r.cost, normalizeAsset(r).life_years))}，折舊分錄已更新`, 'good');
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
    detail: (el) => {
      f.detail = el.dataset.id;
      ctx.setParams({ detail: f.detail });
      draw();
    },
    del: async (el) => {
      const a = assets.find((x) => x.id === el.dataset.id);
      if (!(await confirmBox(`刪除「${a.name}」？相關折舊分錄會重新計算（已鎖定月份不變）。`, { danger: true, ok: '刪除' }))) return;
      await store.remove('fixed_assets', a.id);
      assets = await store.all('fixed_assets');
      await syncDepreciation();
    entries = await store.all('journal_entries');
      draw();
    },
    print: () => window.print(),
  });
  await draw();
  return unbind;
}
