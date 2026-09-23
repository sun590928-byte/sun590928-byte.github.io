// 行銷活動成效（Campaign_ROI）：寄杯優惠、時段限定折扣等活動的符合訂單、帶動營收、兌換率、單一獲客成本與 ROI，避免折扣侵蝕獲利。

import { h, mount, bindActions, dataTable, modal, confirmBox, toast, stat, status, badge, options, fmt, pct, emptyState } from '../ui.js';
import { store } from '../store.js';
import { getSettings, revenueLines } from '../state.js';
import { CAMPAIGN_TYPES, campaignStats, firstVisits } from '../lib/customers.js';
import { uid } from '../lib/text.js';
import { today } from '../lib/dates.js';
import { round2 } from '../lib/money.js';

const fail = (msg) => {
  toast(msg, 'error');
  return false;
};
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v));
const cash = (v) => '$' + fmt(round2(v || 0));
const sub = (text) => h`<div class="muted" style="font-size:12px">${text}</div>`;

// 活動狀態：[徽章色調, 文字]
function phase(c, day) {
  if (c.start_date && day < c.start_date) return ['', '未開始'];
  if (c.end_date && day > c.end_date) return ['low', '已結束'];
  return ['accent', '進行中'];
}

export async function render(root) {
  const settings = await getSettings();
  const lines = await revenueLines();
  const fv = firstVisits(lines);
  const gm = Number(settings.gross_margin_est) || 0.7;
  let campaigns = await store.all('campaigns');
  const statsOf = (c) => campaignStats(c, lines, { firstVisit: fv, grossMargin: gm });

  function draw() {
    const notes = h`<div class="callout" style="margin-bottom:16px">
        <p><b>ROI ＝（帶動營收 × 估計毛利率 − 總成本）÷ 總成本。</b>估計毛利率目前設為 ${pct(gm, 0)}（在 <a href="#/settings">設定</a> 調整）。總成本＝折扣成本（符合訂單上的折扣）＋行銷費用；帶動營收＝含活動關鍵字的整張訂單營收；單一獲客成本（CAC）＝總成本 ÷ 新客數，新客指在活動期間首次消費、且當天訂單符合活動的會員。ROI 小於 0 代表折扣與費用已經吃掉活動帶來的毛利。</p>
        <p>寄杯售出時收到的錢是<b>預收款</b>（2151 預收款項－寄杯），不是營收：請在 <a href="#/products">品項整併</a> 把寄杯商品的品類設為「寄杯／儲值（預收）」，顧客兌換時以「寄杯／儲值扣抵」付款，系統才會沖轉預收款並認列收入。寄杯活動的「帶動營收」包含寄杯售出金額（現金流入），分析時請留意。</p>
      </div>
      ${!lines.length ? h`<div class="callout warn" style="margin-bottom:16px"><p>尚未匯入營收起算日（${settings.revenue_start}）之後的銷售明細，活動成效暫時都是 0。</p></div>` : !fv.size ? h`<div class="callout warn" style="margin-bottom:16px"><p>銷售明細沒有會員欄位，無法辨識新客，新客數與單一獲客成本不會計算。POS 匯出時請加入「會員／手機」欄位。</p></div>` : ''}`;
    if (!campaigns.length) {
      mount(root, h`${notes}<div class="card">${emptyState('還沒有行銷活動', '建立活動並設定期間與比對關鍵字（例如「寄杯」「第二杯半價」），系統會從 POS 銷售明細找出符合的訂單，計算帶動營收、兌換率、獲客成本與 ROI。', h`<button class="btn primary" data-act="add">＋ 新增活動</button>`)}</div>`);
      return;
    }
    const now = today();
    const rows = campaigns.map((c) => ({ ...c, ...statsOf(c), marketing: Number(c.marketing_cost) || 0, auto: num(c.redeemed_qty) === null, phase: phase(c, now) }));
    const total = (k) => rows.reduce((t, r) => t + (Number(r[k]) || 0), 0);
    const [tRev, tCost, tNew] = [total('revenue'), total('cost'), total('newCustomers')];
    const roi = tCost ? (tRev * gm - tCost) / tCost : null;
    mount(
      root,
      h`<div class="toolbar"><span class="spacer"></span><button class="btn primary" data-act="add">＋ 新增活動</button></div>
      ${notes}
      <div class="stats">
        ${stat('活動數', fmt(rows.length), `進行中 ${fmt(rows.filter((r) => r.phase[1] === '進行中').length)}`)}
        ${stat('帶動營收合計', cash(tRev), '活動期間重疊時可能重複計算')}
        ${stat('總成本合計', cash(tCost), `折扣 ${cash(total('discount'))}＋行銷費用 ${cash(total('marketing'))}`)}
        ${stat('整體 ROI', roi === null ? '—' : pct(roi), `新客 ${fmt(tNew)} 位${tNew ? `・平均獲客成本 $${fmt(Math.round(tCost / tNew))}` : ''}`, roi === null ? '' : roi >= 0 ? 'good' : 'bad')}
      </div>
      <div class="card"><div class="card-head"><h2>活動成效</h2><span class="card-note">兌換數標示「自動計算」者依銷售明細推算</span></div><div id="cp-table"></div></div>`,
    );
    dataTable(root.querySelector('#cp-table'), {
      rows,
      exportName: `行銷活動成效_${now}.csv`,
      initialSort: { key: 'start_date', dir: -1 },
      columns: [
        { key: 'name', label: '活動', fmt: (v, r) => h`<b>${v}</b>${r.keywords ? sub(`關鍵字：${r.keywords}`) : ''}${r.note ? sub(r.note) : ''}`, csv: (v) => v },
        { key: 'type', label: '類型', fmt: (v) => CAMPAIGN_TYPES[v] || v || '' },
        { key: 'start_date', label: '期間', fmt: (v, r) => h`<span style="white-space:nowrap">${v || '—'} ～ ${r.end_date || '持續中'}</span><div>${badge(r.phase[1], r.phase[0])}</div>`, csv: (v, r) => `${v || ''}～${r.end_date || ''}` },
        { key: 'orders', label: '符合訂單數', align: 'num', fmt: (v) => fmt(v) },
        { key: 'revenue', label: '帶動營收', align: 'num', fmt: cash },
        { key: 'discount', label: '折扣成本', align: 'num', fmt: cash },
        { key: 'marketing', label: '行銷費用', align: 'num', fmt: cash },
        { key: 'cost', label: '總成本', align: 'num', fmt: cash },
        { key: 'issued', label: '發放', align: 'num', fmt: (v) => (v ? fmt(v) : '—') },
        { key: 'redeemed', label: '兌換', align: 'num', fmt: (v, r) => h`${fmt(v)}${r.auto ? sub('自動計算') : ''}`, csv: (v) => v },
        { key: 'redemptionRate', label: '兌換率', align: 'num', fmt: (v) => pct(v) },
        { key: 'newCustomers', label: '新客數', align: 'num', fmt: (v) => fmt(v) },
        { key: 'cac', label: '單一獲客成本', align: 'num', fmt: (v) => (v === null ? '—' : '$' + fmt(Math.round(v))) },
        { key: 'roi', label: 'ROI', align: 'num', fmt: (v) => (v === null ? status('na', '無成本') : status(v >= 0 ? 'good' : 'bad', pct(v))), csv: (v) => (v === null ? '' : pct(v)) },
        { key: 'id', label: '', nosort: true, fmt: (v) => h`<span style="white-space:nowrap"><button class="btn sm" data-act="edit" data-id="${v}">修改</button> <button class="btn sm danger" data-act="del" data-id="${v}">刪除</button></span>`, csv: () => '' },
      ],
    });
  }

  async function editCampaign(c) {
    const x = c || { name: '', type: 'discount', start_date: today(), end_date: '', keywords: '', issued_qty: null, redeemed_qty: null, marketing_cost: null, note: '' };
    const read = (dlg) => {
      const g = (n) => dlg.querySelector(`[name=${n}]`).value.trim();
      return { ...x, name: g('name'), type: g('type'), start_date: g('start_date'), end_date: g('end_date') || null, keywords: g('keywords'), issued_qty: num(g('issued_qty')), redeemed_qty: num(g('redeemed_qty')), marketing_cost: num(g('marketing_cost')), note: g('note') };
    };
    let timer = null;
    const preview = (dlg) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const d = read(dlg);
        const s = statsOf(d);
        dlg.querySelector('[data-preview]').textContent = !lines.length
          ? '尚未匯入銷售明細，無法試算。'
          : `試算：符合 ${fmt(s.orders)} 張訂單、帶動營收 ${cash(s.revenue)}、折扣 ${cash(s.discount)}、兌換 ${fmt(s.redeemed)}${s.roi === null ? '' : `、ROI ${pct(s.roi)}`}${d.keywords ? '' : '（尚未設定關鍵字，無法比對訂單）'}`;
      }, 200);
    };
    const r = await modal({
      title: c ? `修改活動：${x.name}` : '新增行銷活動',
      wide: true,
      body: h`<div class="form-grid">
          <label class="field" style="grid-column:1/-1"><span>活動名稱</span><input type="text" name="name" value="${x.name || ''}" placeholder="例如：秋季寄杯買 10 送 2"></label>
          <label class="field"><span>類型</span><select name="type">${options(Object.entries(CAMPAIGN_TYPES), x.type)}</select></label>
          <label class="field"><span>開始日</span><input type="date" name="start_date" value="${x.start_date || ''}"></label>
          <label class="field"><span>結束日（留白＝持續中）</span><input type="date" name="end_date" value="${x.end_date || ''}"></label>
          <label class="field" style="grid-column:1/-1"><span>比對關鍵字（以逗號分隔）</span><input type="text" name="keywords" value="${x.keywords || ''}" placeholder="例如：寄杯, 第二杯半價, 早鳥"></label>
          <label class="field"><span>發放數量</span><input type="number" name="issued_qty" min="0" step="1" value="${x.issued_qty ?? ''}"></label>
          <label class="field"><span>兌換數量（留白＝自動計算）</span><input type="number" name="redeemed_qty" min="0" step="1" value="${x.redeemed_qty ?? ''}"></label>
          <label class="field"><span>行銷費用（廣告、印刷、贈品）</span><input type="number" name="marketing_cost" min="0" step="any" value="${x.marketing_cost ?? ''}"></label>
          <label class="field" style="grid-column:1/-1"><span>備註</span><input type="text" name="note" value="${x.note || ''}"></label>
        </div>
        <p class="muted" style="font-size:12.5px;margin:10px 0 0">關鍵字會比對 POS 銷售明細的品名、規格／選項、備註、付款方式與通路文字（不分全半形、大小寫）；一張訂單只要有任一品項含關鍵字，整張訂單都算「符合訂單」。兌換數留白時自動計算：寄杯類型為期間內以「寄杯／儲值扣抵」付款的杯數，其他類型為含關鍵字品項的份數。發放數量是送出的券、卡或寄杯杯數，用來計算兌換率。</p>
        <p data-preview style="margin:8px 0 0;font-weight:600"></p>`,
      actions: [
        { label: '取消', value: null },
        {
          label: '儲存',
          primary: true,
          value: (dlg) => {
            const d = read(dlg);
            if (!d.name) return fail('請輸入活動名稱');
            if (!d.start_date) return fail('請選擇開始日');
            if (d.end_date && d.end_date < d.start_date) return fail('結束日不可早於開始日');
            for (const k of ['issued_qty', 'redeemed_qty', 'marketing_cost']) if (d[k] !== null && !(d[k] >= 0)) return fail('數量與費用需為 0 以上的數字');
            return { ...d, id: d.id || uid('cp_') };
          },
        },
      ],
      onMount: (dlg) => {
        dlg.addEventListener('input', () => preview(dlg));
        dlg.addEventListener('change', () => preview(dlg));
        preview(dlg);
      },
    });
    clearTimeout(timer);
    if (!r) return;
    await store.put('campaigns', r);
    campaigns = await store.all('campaigns');
    toast(`已儲存「${r.name}」`, 'good');
    draw();
  }

  const unbind = bindActions(root, {
    add: () => editCampaign(null),
    edit: (el) => {
      const c = campaigns.find((x) => x.id === el.dataset.id);
      if (c) return editCampaign(c);
    },
    del: async (el) => {
      const c = campaigns.find((x) => x.id === el.dataset.id);
      if (!c || !(await confirmBox(`刪除活動「${c.name}」？`, { ok: '刪除', danger: true }))) return;
      await store.remove('campaigns', c.id);
      campaigns = await store.all('campaigns');
      toast('已刪除活動', 'good');
      draw();
    },
  });
  draw();
  return unbind;
}
