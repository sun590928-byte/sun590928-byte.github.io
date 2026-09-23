// 會員消費輪廓（Customer_Profiles）：會員等級、累積消費、客製化偏好、最後到店 → 分群、12 個月 LTV 與自動化行銷名單。

import { h, mount, bindActions, dataTable, modal, toast, stat, badge, options, fmt, pct, emptyState } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getProductIndex, revenueLines } from '../state.js';
import { buildProfiles, marketingTriggers, memberKey, maskMember, tierOf, DEFAULT_TIERS } from '../lib/customers.js';
import { barList } from '../charts.js';
import { today } from '../lib/dates.js';
import { round2 } from '../lib/money.js';

// 分群：[徽章色調, 判斷規則]（規則同 lib/customers.js segmentOf）
const SEGMENTS = {
  忠實常客: ['high', '14 天內到店，且近 90 天到店 6 天以上'],
  穩定回訪: ['accent', '30 天內到店，且近 90 天到店 3 天以上'],
  新客: ['accent', '30 天內首次消費、到店 2 天以內'],
  一般: ['', '其他有消費的會員'],
  沉睡中: ['medium', '31–60 天沒有到店'],
  流失風險: ['medium', '超過 60 天沒有到店'],
  尚未消費: ['low', '在會員名單中，但營收期間沒有消費'],
};

const fail = (msg) => {
  toast(msg, 'error');
  return false;
};
const pad2 = (n) => String(n).padStart(2, '0');
const topText = (list) => list.map(([n, q]) => `${n}×${fmt(q)}`).join('、');
const prefText = (p) => [...new Set([...p.prefs, ...String(p.prefNote || '').split(/[、,，;；\s]+/)].map((x) => x.trim()).filter(Boolean))].join('、');

// 生日統一為 MM-DD 或 YYYY-MM-DD（壽星名單依月份比對，需補零）；空白回傳 ''，看不懂回傳 null
function normBirthday(s) {
  const t = String(s || '').normalize('NFKC').trim();
  if (!t) return '';
  let p = t.match(/\d+/g) || [];
  if (p.length === 1 && p[0].length === 8) p = [p[0].slice(0, 4), p[0].slice(4, 6), p[0].slice(6)];
  else if (p.length === 1 && p[0].length === 4) p = [p[0].slice(0, 2), p[0].slice(2)];
  const [y, m, d] = p.length === 3 ? p.map(Number) : p.length === 2 ? [0, ...p.map(Number)] : [];
  if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  if (!y) return `${pad2(m)}-${pad2(d)}`;
  const yy = y < 1000 ? y + 1911 : y; // 民國年
  return yy >= 1900 && yy <= 2100 ? `${yy}-${pad2(m)}-${pad2(d)}` : null;
}

export async function render(root, ctx) {
  const settings = await getSettings();
  const idx = await getProductIndex();
  const lines = await revenueLines();
  let customers = await store.all('customers');
  const tiers = settings.tiers?.length ? settings.tiers : DEFAULT_TIERS;
  const asOf = lines.reduce((m, l) => (l.date > m ? l.date : m), '') || today();
  const f = { seg: ctx.params.seg || '', q: '', full: false };
  const show = (key) => (f.full ? key : maskMember(key));

  // 全店與會員營收（不含作廢）
  const live = lines.filter((l) => !l.void_reason);
  const totalRevenue = round2(live.reduce((t, l) => t + l.revenue, 0));
  const memberRevenue = round2(live.filter((l) => memberKey(l.member)).reduce((t, l) => t + l.revenue, 0));
  const allOrders = new Set(live.map((l) => l.order_no || `${l.date} ${l.time}`)).size;
  const hasMember = lines.some((l) => memberKey(l.member));

  let profiles = [];
  let master = new Map();
  const build = () => {
    profiles = buildProfiles(lines, customers, { asOf, tiers, productNameOf: (l) => idx.of(l).name });
    master = new Map(customers.map((c) => [memberKey(c.member_no), c]));
  };

  // 欄位定義（輪廓表與行銷名單共用）
  const col = {
    key: { key: 'key', label: '會員', fmt: (v) => show(v) },
    name: { key: 'name', label: '姓名' },
    tier: { key: 'tier', label: '等級' },
    last: { key: 'last', label: '最後到店', fmt: (v) => v || '—' },
    recency: { key: 'recency', label: '距今天數', align: 'num', fmt: (v) => (v === null ? '—' : fmt(v)) },
    visits: { key: 'visits', label: '消費次數', align: 'num', fmt: (v) => fmt(v) },
    spend: { key: 'spend', label: '累積消費', align: 'num', fmt: (v) => '$' + fmt(v) },
    avgTicket: { key: 'avgTicket', label: '客單價', align: 'num', fmt: (v) => (v ? '$' + fmt(Math.round(v)) : '—') },
    top: { key: 'topItems', label: '常點品項', nosort: true, fmt: (v) => topText(v) },
    prefs: { key: 'prefs', label: '偏好', nosort: true, fmt: (v, r) => prefText(r) },
  };

  function draw() {
    const dataNote = !lines.length
      ? h`<div class="callout warn" style="margin-bottom:16px"><p>尚未匯入營收起算日（${settings.revenue_start}）之後的銷售明細。匯入 POS 銷售明細後，就能看到每位會員的消費輪廓。</p></div>`
      : hasMember
        ? ''
        : h`<div class="callout warn" style="margin-bottom:16px"><p><b>銷售明細裡沒有會員資料。</b>請在 POS 匯出銷售報表時加入「會員」或「手機」欄位，匯入時對應到「會員」欄，系統才能把每筆消費歸到會員身上，算出累積消費、最後到店與偏好。</p></div>`;
    if (!profiles.length) {
      mount(root, h`${dataNote}<div class="card">${emptyState('還沒有會員資料', '銷售明細有會員（手機／會員編號）欄位時，系統會自動彙整每位會員的累積消費、到店頻率與偏好；也可以手動新增會員，或到匯入中心匯入會員名單。', h`<div class="row" style="justify-content:center"><button class="btn primary" data-act="add">＋ 新增會員</button><a class="btn" href="#/import">前往匯入中心</a></div>`)}</div>`);
      return;
    }
    const active = profiles.filter((p) => p.visits > 0);
    const orders = active.reduce((t, p) => t + p.orders, 0);
    const spend = active.reduce((t, p) => t + p.spend, 0);
    const seen30 = active.filter((p) => p.recency !== null && p.recency < 30);
    const seg = {};
    for (const p of profiles) {
      const s = (seg[p.segment] ||= { n: 0, spend: 0 });
      s.n++;
      s.spend += p.spend;
    }
    const tierN = new Map();
    for (const p of profiles) tierN.set(p.tier, (tierN.get(p.tier) || 0) + 1);
    const rank = (name) => (tiers.findIndex((t) => t.name === name) + 1 || 99);
    const q = f.q.trim().toLowerCase();
    const rows = profiles.filter((p) => (!f.seg || p.segment === f.seg) && (!q || `${p.key} ${p.name} ${prefText(p)}`.toLowerCase().includes(q)));
    const trig = marketingTriggers(profiles, { asOf });
    const lists = [
      { key: 'winBack', title: '喚回名單', note: '到店 3 天以上、31–90 天沒來的常客', sort: { key: 'spend', dir: -1 }, cols: [col.key, col.name, col.tier, col.last, col.recency, col.visits, col.spend, col.top] },
      {
        key: 'nearTier',
        title: '即將升級',
        note: '差額 ≤ 兩倍客單價（至少 $300），且 60 天內有到店',
        sort: { key: 'gap', dir: 1 },
        cols: [col.key, col.name, col.tier, { key: 'next', label: '下一級', sort: (r) => r.nextTier?.name, fmt: (v, r) => r.nextTier?.name || '' }, { key: 'gap', label: '差額', align: 'num', sort: (r) => r.nextTier?.gap, fmt: (v, r) => '$' + fmt(r.nextTier?.gap) }, col.avgTicket, col.last],
      },
      { key: 'birthday', title: `當月壽星（${Number(asOf.slice(5, 7))} 月）`, note: '會員資料有填生日者', sort: { key: 'birthday', dir: 1 }, cols: [col.key, col.name, { key: 'birthday', label: '生日', sort: (r) => String(r.birthday).replace(/\D/g, '').slice(-4) }, col.tier, col.last, col.prefs] },
      { key: 'newcomers', title: '新客關懷', note: '30 天內首次消費、到店 2 天以內', sort: { key: 'first', dir: -1 }, cols: [col.key, col.name, { key: 'first', label: '首次到店' }, col.visits, col.spend, col.top] },
    ];

    mount(
      root,
      h`${dataNote}
      <div class="stats">
        ${stat('會員數', fmt(profiles.length), `有消費 ${fmt(active.length)}・會員名單 ${fmt(customers.length)}`)}
        ${stat('會員營收占比', pct(totalRevenue ? memberRevenue / totalRevenue : null), `$${fmt(memberRevenue)}／全店 $${fmt(totalRevenue)}`)}
        ${stat('平均客單價（會員）', orders ? '$' + fmt(Math.round(spend / orders)) : '—', allOrders ? `全店平均 $${fmt(Math.round(totalRevenue / allOrders))}` : '')}
        ${stat('近 30 天回訪會員', fmt(seen30.filter((p) => p.visits >= 2).length), `近 30 天到店 ${fmt(seen30.length)} 位・資料至 ${asOf}`)}
      </div>
      <div class="grid-2">
        <div class="card" style="margin:0"><div class="card-head"><h2>會員分群</h2><span class="card-note">依最後到店與近 90 天到店天數</span></div><div id="c-seg"></div>
          <p class="muted" style="font-size:12.5px;margin:10px 0 0">${Object.entries(SEGMENTS).map(([k, v]) => `${k}：${v[1]}`).join('；')}</p></div>
        <div class="card" style="margin:0"><div class="card-head"><h2>會員等級</h2><span class="card-note">依累積消費自動分級（門檻在 <a href="#/settings">設定</a>），或手動指定</span></div><div id="c-tier"></div></div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h2>會員輪廓</h2><span class="card-note">預估 12 個月 LTV＝客單價 × 每月到店次數 × 12</span><span class="spacer"></span>
          <button class="btn sm ghost" data-act="full">${f.full ? '隱藏完整號碼' : '顯示完整號碼'}</button>
          <button class="btn sm" data-act="add">＋ 新增會員</button></div>
        <div class="toolbar">
          <label class="field"><span>分群</span><select data-act="seg">${options([['', '全部'], ...Object.keys(SEGMENTS).map((k) => [k, `${k}（${seg[k]?.n || 0}）`])], f.seg)}</select></label>
          <label class="field"><span>搜尋（號碼、姓名、偏好）</span><input type="search" value="${f.q}" data-act="q"></label>
        </div>
        <div id="c-table"></div>
      </div>
      <div class="card-head" style="margin:24px 0 10px"><h2>行銷觸發名單</h2><span class="card-note">依資料最後一天 ${asOf} 計算；匯出 CSV 的號碼遮罩跟隨目前的顯示設定</span></div>
      <div class="grid-2">${lists.map((t) => h`<div class="card" style="margin:0"><div class="card-head"><h3>${t.title}（${fmt(trig[t.key].length)}）</h3><span class="card-note">${t.note}</span></div><div id="t-${t.key}"></div></div>`)}</div>`,
    );

    barList(root.querySelector('#c-seg'), Object.keys(SEGMENTS).map((k) => ({ label: k, value: seg[k]?.n || 0, sub: seg[k]?.spend ? `$${fmt(round2(seg[k].spend))}` : '' })), { format: (v) => `${fmt(v)} 位` });
    barList(root.querySelector('#c-tier'), [...tierN.entries()].sort((a, b) => rank(a[0]) - rank(b[0])).map(([label, value]) => ({ label, value })), { format: (v) => `${fmt(v)} 位`, color: 'var(--series-2)' });
    dataTable(root.querySelector('#c-table'), {
      rows,
      exportName: `會員輪廓_${asOf}.csv`,
      initialSort: { key: 'spend', dir: -1 },
      empty: '沒有符合條件的會員',
      columns: [
        col.key,
        col.name,
        { key: 'tier', label: '等級', fmt: (v, r) => h`${badge(v, 'accent')}${master.get(r.key)?.tier ? h` <span class="muted" style="font-size:12px">指定</span>` : ''}`, csv: (v) => v },
        { key: 'gap', label: '距下一級', align: 'num', sort: (r) => r.nextTier?.gap ?? null, fmt: (v, r) => (r.nextTier ? `${r.nextTier.name} 差 $${fmt(r.nextTier.gap)}` : r.visits ? '已是最高級' : '—') },
        col.spend,
        col.visits,
        col.avgTicket,
        col.last,
        col.recency,
        { key: 'prefs', label: '偏好', nosort: true, fmt: (v, r) => h`${v.map((w) => h`<span class="badge" style="margin:1px 2px 1px 0">${w}</span>`)}${r.prefNote ? h`<div style="font-size:12.5px">${r.prefNote}</div>` : ''}`, csv: (v, r) => prefText(r) },
        col.top,
        { key: 'ltv12', label: '預估 12 個月 LTV', align: 'num', fmt: (v) => (v ? '$' + fmt(Math.round(v)) : '—') },
        { key: 'segment', label: '分群', fmt: (v) => badge(v, SEGMENTS[v]?.[0] || ''), csv: (v) => v },
        { key: 'act', label: '', nosort: true, fmt: (v, r) => h`<button class="btn sm" data-act="edit" data-key="${r.key}">編輯</button>`, csv: () => '' },
      ],
    });
    for (const t of lists) dataTable(root.querySelector(`#t-${t.key}`), { rows: trig[t.key], columns: t.cols, pageSize: 10, initialSort: t.sort, exportName: `${t.title}_${asOf}.csv`, empty: '目前沒有名單' });
  }

  async function editCustomer(key) {
    const isNew = !key;
    const p = key ? profiles.find((x) => x.key === key) : null;
    const c = (key && master.get(key)) || { member_no: key || '', name: p?.name || '', tier: '', birthday: '', preferences: '', note: '' };
    const tierOpts = [['', `自動（依累積消費${p ? '：' + tierOf(p.spend, tiers).tier : ''}）`], ...tiers.map((t) => [t.name, `${t.name}（累積 $${fmt(t.min)} 起）`])];
    if (c.tier && !tiers.some((t) => t.name === c.tier)) tierOpts.push([c.tier, c.tier]);
    const r = await modal({
      title: isNew ? '新增會員' : `會員資料：${show(key)}`,
      body: h`<div class="form-grid">
          ${isNew ? h`<label class="field"><span>會員編號／手機</span><input type="text" name="member_no" inputmode="tel" placeholder="例如：0912345678"></label>` : h`<div class="field"><span>會員編號／手機</span><b>${show(key)}</b></div>`}
          <label class="field"><span>姓名／稱呼</span><input type="text" name="name" value="${c.name || ''}"></label>
          <label class="field"><span>會員等級</span><select name="tier">${options(tierOpts, c.tier || '')}</select></label>
          <label class="field"><span>生日</span><input type="text" name="birthday" value="${c.birthday || ''}" placeholder="MM-DD 或 YYYY-MM-DD"></label>
          <label class="field" style="grid-column:1/-1"><span>客製化偏好</span><input type="text" name="preferences" value="${c.preferences || ''}" placeholder="例如：燕麥奶、淺焙、少冰"></label>
          <label class="field" style="grid-column:1/-1"><span>備註</span><input type="text" name="note" value="${c.note || ''}"></label>
        </div>
        ${p?.prefs.length ? h`<p class="muted" style="font-size:12.5px;margin:10px 0 0">從 POS 選項／備註偵測到的偏好：${p.prefs.join('、')}</p>` : ''}`,
      actions: [
        { label: '取消', value: null },
        {
          label: '儲存',
          primary: true,
          value: (dlg) => {
            const g = (n) => dlg.querySelector(`[name=${n}]`)?.value.trim() ?? '';
            const memberNo = isNew ? g('member_no') : c.member_no || key;
            const k = memberKey(memberNo);
            if (!k) return fail('請輸入會員編號或手機號碼');
            if (isNew && master.has(k)) return fail('這位會員已經在名單中');
            const birthday = normBirthday(g('birthday'));
            if (birthday === null) return fail('生日格式看不懂，請輸入 MM-DD 或 YYYY-MM-DD');
            const joined = c.id ? {} : { joined_on: p?.first || today() }; // 新建主檔：以首次消費日（或今天）為加入日
            return { ...c, ...joined, id: c.id || 'c_' + k, member_no: memberNo, name: g('name'), tier: g('tier'), birthday, preferences: g('preferences'), note: g('note') };
          },
        },
      ],
    });
    if (!r) return;
    await store.put('customers', r);
    customers = await store.all('customers');
    build();
    toast('已儲存會員資料', 'good');
    draw();
  }

  const unbind = bindActions(root, {
    seg: (el) => {
      f.seg = el.value;
      ctx.setParams({ seg: el.value });
      draw();
    },
    q: (el) => {
      f.q = el.value;
      draw();
    },
    full: () => {
      f.full = !f.full;
      draw();
    },
    add: () => editCustomer(null),
    edit: (el) => editCustomer(el.dataset.key),
  });
  build();
  draw();
  return unbind;
}
