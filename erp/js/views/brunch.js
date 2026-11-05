// 早午餐企劃：新時段加賣的試算器（拉桿、情境、損益平衡線）、菜單與成本（可接配方）、推出進度表、測試期每日紀錄與判斷。
// 企劃存在 settings 的 brunch_plan；店家的價格、成本不寫在程式裡，從「匯入企劃檔」或畫面上填。

import { h, raw, esc, mount, bindActions, modal, confirmBox, toast, stat, status, badge, options, fmt, pct, emptyState, pickFiles, download } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getProductIndex, revenueLines } from '../state.js';
import { averageCosts, productCosts } from '../lib/inventory.js';
import { PLAN_ID, SIM_FIELDS, SCENARIOS, BLOCKERS, OWNERS, simulate, profitCurve, dailyFixedOf, menuSummary, dishCost, swapMarginOf, testVerdict, dayResult, entryProblem, posWindow, buildSchedule, scheduleStatus, normalizePlan, checkPlanFile, mergeImport, exportPlan, isWeekend } from '../lib/brunch.js';
import { today, weekdayIndex, WEEKDAYS, addDays, daysBetween, eachDay } from '../lib/dates.js';
import { uid } from '../lib/text.js';

const TABS = [
  ['sim', '試算器'],
  ['menu', '菜單與成本'],
  ['plan', '推出進度'],
  ['test', '測試紀錄'],
];
const VERDICT = { pass: ['good', '過關'], adjust: ['warn', '換品項或加強宣傳'], fix: ['warn', '要先調整'], stop: ['bad', '停'], collecting: ['info', '資料收集中'], pending: ['na', '還不能判斷'] };
const WEATHER = ['', '晴', '多雲', '陰', '雨', '冷', '熱', '颱風'];

const cash = (v) => (v === null || v === undefined ? '—' : (v < 0 ? '−$' : '$') + fmt(Math.round(Math.abs(v))));
const signed = (v) => (v === null || v === undefined ? '—' : (v >= 0 ? '+' : '−') + '$' + fmt(Math.round(Math.abs(v))));
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v));
const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}（${WEEKDAYS[weekdayIndex(ymd)]}）`;
const fail = (msg) => {
  toast(msg, 'error');
  return false;
};
const same = (a, b) => SIM_FIELDS.every((f) => Number(a[f.key]) === Number(b[f.key]));
const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, '-');

export async function render(root, ctx) {
  const settings = await getSettings();
  const vatRate = settings.vat_mode === 'general' ? 0.05 : 0;
  const day = today();
  const f = { tab: TABS.some(([k]) => k === ctx.params.tab) ? ctx.params.tab : 'sim' };

  let rec = (await store.all('settings')).find((r) => r.id === PLAN_ID);
  let plan = normalizePlan(rec?.value);
  let stamp = rec?.value?.updated_at || null; // 讀進來時的版本，存檔前比對，避免兩台裝置互相蓋掉
  let sim = { ...plan.params };
  let simKey = 'mine';
  let saving = false;

  // 圖表照容器實際寬度畫；第一次量不到寬度（還沒排版）或寬度改變時重畫，字才不會被縮小。
  // 觀察器集中管理：畫新的之前先拆掉已經不在畫面上的，離開頁面時全部拆掉
  const observers = new Set();
  const dropObservers = (all = false) => {
    for (const o of observers)
      if (all || !o.el.isConnected) {
        o.ro.disconnect();
        observers.delete(o);
      }
  };
  function fitWidth(el, redraw) {
    dropObservers();
    let w = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const nw = el.clientWidth;
      if (nw && Math.abs(nw - w) >= 16) {
        w = nw;
        redraw();
      }
    });
    ro.observe(el);
    observers.add({ el, ro });
  }

  // 配方成本：品項主檔 × 配方 × 原物料平均進價（未稅）
  const [idx, items, moves, recipes] = await Promise.all([getProductIndex(), store.all('inventory_items'), store.all('inventory_moves'), store.all('recipes')]);
  const avg = averageCosts(items, moves, { asOf: day, vatRate });
  const pCost = productCosts(idx.products, recipes, (id) => avg.get(id)?.avg || 0);
  const recipeCostOf = (pid) => pCost.get(pid);
  const productName = new Map(idx.products.map((p) => [p.id, p.name]));

  // 存檔：失敗會提示、不會留下空白頁；別台裝置剛改過（雲端模式）就不覆蓋，重新載入後請再做一次
  async function save(msg, before = null) {
    if (saving) return false;
    saving = true;
    root.setAttribute('aria-busy', 'true');
    try {
      // 不經快取，直接從資料來源重讀：雲端模式下別台裝置改過才看得到
      const latest = (await store.fresh('settings')).find((r) => r.id === PLAN_ID);
      const latestStamp = latest?.value?.updated_at || null;
      if (latestStamp && latestStamp !== stamp) {
        rec = latest;
        plan = normalizePlan(latest.value);
        stamp = latestStamp;
        sim = { ...plan.params };
        toast('別的裝置剛改過這份企劃，已載入最新的內容，請再做一次剛才的修改。', 'error', 7000);
        return false;
      }
      const nextStamp = new Date().toISOString();
      await store.put('settings', { id: PLAN_ID, value: { ...plan, updated_at: nextStamp } });
      // 寫完再讀一次：兩台裝置幾乎同時存檔時，後寫的會蓋掉先寫的；先寫的這台要知道自己的修改沒留下來
      const after = (await store.fresh('settings')).find((r) => r.id === PLAN_ID);
      if (after?.value?.updated_at && after.value.updated_at !== nextStamp) {
        rec = after;
        plan = normalizePlan(after.value);
        stamp = after.value.updated_at;
        sim = { ...plan.params };
        toast('別的裝置同時存了這份企劃，你剛才的修改沒有留下來；已載入最新的內容，請再做一次。', 'error', 8000);
        return false;
      }
      stamp = nextStamp;
      rec = { id: PLAN_ID, value: plan };
      if (msg) toast(msg, 'good');
      return true;
    } catch (e) {
      console.error(e);
      if (before) plan = before; // 沒存到就退回改之前，畫面不會顯示假的結果
      toast(`沒有存到：${e.message || e}。請再試一次；一直失敗就先按「完整備份」。`, 'error', 8000);
      return false;
    } finally {
      saving = false;
      root.removeAttribute('aria-busy');
    }
  }

  const summary = () => menuSummary(plan.menu, { vatRate, feePct: plan.params.fee, recipeCostOf });

  // ─────────── 共用外框

  function draw() {
    dropObservers(true);
    mount(
      root,
      h`<div class="toolbar">
        <div class="field" style="flex:1;min-width:220px"><span>企劃</span><b style="font-size:16px">${plan.name}</b></div>
        <button class="btn" data-act="importPlan">匯入企劃檔</button>
        <button class="btn" data-act="exportPlan" title="不含每日紀錄與備註，可以分享">匯出企劃</button>
        <button class="btn" data-act="exportFull" title="含每日紀錄，自己備份用">完整備份</button>
      </div>
      ${!rec ? h`<div class="callout" style="margin-bottom:16px"><p><b>第一次使用：</b>畫面上是示範數字，不是你的店。按「匯入企劃檔」帶入整理好的企劃（菜單、價格、進度表），或直接在各分頁填，填了就會存。企劃只存在你的資料裡（本機或雲端），不會放在程式碼中。</p></div>` : ''}
      <div class="tabs" role="tablist" aria-label="早午餐企劃">${TABS.map(([k, l]) => h`<button role="tab" id="bp-tab-${k}" aria-controls="bp-body" aria-selected="${f.tab === k ? 'true' : 'false'}" tabindex="${f.tab === k ? '0' : '-1'}" class="${f.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`)}</div>
      <div id="bp-body" role="tabpanel" aria-labelledby="bp-tab-${f.tab}"></div>`,
    );
    const body = root.querySelector('#bp-body');
    if (f.tab === 'menu') drawMenu(body);
    else if (f.tab === 'plan') drawPlan(body);
    else if (f.tab === 'test') drawTest(body).catch((e) => mount(body, h`<div class="callout bad"><p><b>測試紀錄載入失敗：</b>${e.message || e}</p><p><button class="btn" data-act="tab" data-tab="test">重新載入</button></p></div>`));
    else drawSim(body);
  }

  // 分頁可用方向鍵切換（跟瀏覽器的分頁元件一樣）
  const onTabKey = (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const keys = TABS.map(([k]) => k);
    const i = keys.indexOf(tab.dataset.tab);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? keys.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + keys.length) % keys.length;
    f.tab = keys[next];
    ctx.setParams({ tab: f.tab });
    draw();
    root.querySelector(`#bp-tab-${f.tab}`)?.focus();
  };
  root.addEventListener('keydown', onTabKey);
  // ─────────── 試算器

  function drawSim(body) {
    const ms = summary();
    mount(
      body,
      h`<div class="toolbar bp-scen" role="group" aria-label="情境">
        <button class="btn sm ${simKey === 'mine' ? 'primary' : ''}" data-act="scenario" data-k="mine">我的設定</button>
        ${SCENARIOS.map((s) => h`<button class="btn sm ${simKey === s.key ? 'primary' : ''}" data-act="scenario" data-k="${s.key}">${s.label}</button>`)}
        <span class="spacer" style="flex:1"></span>
        ${ms.avgRate !== null ? h`<button class="btn sm" data-act="useMenuCost" title="用「菜單與成本」算出來的平均成本率">套用菜單成本率 ${pct(ms.avgRate, 0)}</button>` : ''}
        <button class="btn sm primary" data-act="saveSim" ${same(sim, plan.params) ? raw('disabled') : ''}>存成我的設定</button>
      </div>
      <div class="grid-2 bp-sim">
        <div class="card">
          <div class="card-head"><h2>參數</h2><span class="card-note">拉動就會重算</span></div>
          <div class="bp-sliders">${SIM_FIELDS.map(
            (fd) => h`<label class="bp-slider">
              <span class="bp-sl-head"><span>${fd.label}</span><b data-val="${fd.key}"></b></span>
              <input type="range" min="${fd.min}" max="${fd.max}" step="${fd.step}" value="${sim[fd.key]}" data-act="slide" data-on="input" data-k="${fd.key}" aria-label="${fd.label}">
              <span class="bp-hint">${fd.hint}</span>
            </label>`,
          )}</div>
        </div>
        <div class="card" id="bp-result"></div>
      </div>`,
    );
    paintSim(body);
  }

  function paintSim(body) {
    for (const fd of SIM_FIELDS) {
      const el = body.querySelector(`[data-val="${fd.key}"]`);
      if (el) el.textContent = `${fd.key === 'hours' ? Number(sim[fd.key]).toFixed(2) : fmt(sim[fd.key])} ${fd.unit}`;
    }
    const s = simulate(sim, { vatRate });
    const parts = [
      ['營業稅', s.tax, 'var(--mute)'],
      ['食材', s.food, 'var(--series-1)'],
      ['人力', s.labor, 'var(--series-2)'],
      ['手續費、報廢、耗材、水電', s.fee + s.wasteUtil + Math.max(0, s.lostMargin), 'var(--warn)'],
      ['多賺', Math.max(0, s.profit), 'var(--good)'],
    ];
    const total = parts.reduce((t, p) => t + p[1], 0) || 1;
    const below = s.breakEven !== null && s.params.people < s.breakEven;
    const out = body.querySelector('#bp-result');
    mount(
      out,
      h`<div class="card-head"><h2>結果</h2><span class="card-note">${s.params.days} 天／月</span></div>
      <div class="stats" style="margin-bottom:12px">
        ${stat('每天多賺', signed(s.profit), `營收 ${cash(s.revenue)}（含稅）`, s.profit >= 0 ? 'good' : 'bad')}
        ${stat('每月多賺', signed(s.month), `${s.params.days} 天`, s.month >= 0 ? 'good' : 'bad')}
        ${stat('打平線', s.breakEven === null ? '—' : `${fmt(s.breakEven)} 人／天`, below ? '目前設定低於打平線' : `每位客人約 ${cash(s.perGuest)} 毛利`, below ? 'bad' : 'good')}
      </div>
      <div class="bp-flow" role="img" aria-label="營收去向：${parts.map(([l, v]) => `${l} ${cash(v)}`).join('、')}">${parts.map(([l, v, c]) => (v > 0 ? h`<i style="width:${((v / total) * 100).toFixed(2)}%;background:${c}" title="${l} ${cash(v)}"></i>` : ''))}</div>
      <div class="chart-legend" style="margin-top:6px">${parts.map(([l, v, c]) => h`<span><i style="background:${c}"></i>${l} ${cash(v)}</span>`)}</div>
      <div class="bp-kv">
        ${[
          ['多出來的營收（含稅）', cash(s.revenue)],
          ['扣營業稅後', cash(s.net)],
          ['食材', cash(-s.food)],
          ['人力', cash(-s.labor)],
          ['金流手續費', cash(-s.fee)],
          ['報廢', cash(-s.waste)],
          ['耗材', cash(-s.supplies)],
          ['水電', cash(-s.util)],
          ...(s.params.lost ? [['縮短營業少掉的毛利', cash(-s.lostMargin)]] : []),
        ].map(([a, b]) => h`<div><span>${a}</span><span>${b}</span></div>`)}
      </div>
      <h3 style="font-size:14px;margin:16px 0 4px">客人數 vs 每天多賺</h3>
      <div id="bp-curve" class="chart"></div>
      <p class="muted" style="font-size:12.5px;margin:6px 0 0">營收先除以 ${1 + vatRate} 扣營業稅；食材成本率是「成本 ÷ 含稅售價」。只算因為這個時段才多來的客人；原本就會來、只是改點的，只有毛利差算數（在「測試紀錄」分開記）。</p>`,
    );
    const curveEl = out.querySelector('#bp-curve');
    const pts = profitCurve(sim, { vatRate });
    curve(curveEl, pts, s);
    fitWidth(curveEl, () => curve(curveEl, pts, s));
    const btn = root.querySelector('[data-act="saveSim"]');
    if (btn) btn.disabled = same(sim, plan.params);
  }

  // 損益平衡圖：橫軸客人數、縱軸每天多賺，標 0 線、打平線與目前設定
  function curve(el, pts, s) {
    el.replaceChildren();
    const width = Math.max(300, el.clientWidth || 520);
    const height = 190;
    const pad = { l: 52, r: 14, t: 14, b: 26 };
    const xs = pts.map((p) => p.people);
    const ys = pts.map((p) => p.profit);
    const lo = Math.min(0, ...ys);
    const hi = Math.max(0, ...ys);
    const span = hi - lo || 1;
    const x = (v) => pad.l + ((v - xs[0]) / (xs[xs.length - 1] - xs[0] || 1)) * (width - pad.l - pad.r);
    const y = (v) => pad.t + (1 - (v - lo) / span) * (height - pad.t - pad.b);
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.people).toFixed(1)},${y(p.profit).toFixed(1)}`).join('');
    const be = s.breakEven;
    const svg = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="損益平衡圖">
      <line class="axis" x1="${pad.l}" x2="${width - pad.r}" y1="${y(0)}" y2="${y(0)}"/>
      <text class="tick" x="${pad.l - 6}" y="${y(0) + 4}" text-anchor="end">0</text>
      <text class="tick" x="${pad.l - 6}" y="${y(hi) + 4}" text-anchor="end">${hi > 0 && y(0) - y(hi) > 14 ? '+' + fmt(Math.round(hi)) : ''}</text>
      <text class="tick" x="${pad.l - 6}" y="${y(lo) + 4}" text-anchor="end">${lo < 0 && y(lo) - y(0) > 14 ? '−' + fmt(Math.round(-lo)) : ''}</text>
      ${be !== null && be <= xs[xs.length - 1] ? `<line x1="${x(be)}" x2="${x(be)}" y1="${pad.t}" y2="${height - pad.b}" stroke="var(--warn)" stroke-dasharray="4 4"/><text class="val" x="${x(be) + 4}" y="${pad.t + 10}">打平 ${be} 人</text>` : ''}
      <path d="${path}" fill="none" stroke="var(--series-1)" stroke-width="2" stroke-linejoin="round"/>
      <circle class="dot" cx="${x(s.params.people)}" cy="${y(s.profit)}" r="5" fill="${s.profit >= 0 ? 'var(--good)' : 'var(--bad)'}"/>
      <text class="tick" x="${pad.l}" y="${height - 6}">0 人</text>
      <text class="tick" x="${width - pad.r}" y="${height - 6}" text-anchor="end">${xs[xs.length - 1]} 人</text>
    </svg>`;
    el.innerHTML = svg;
  }

  // ─────────── 菜單與成本

  function drawMenu(body) {
    const ms = summary();
    const tone = (r) => (r === null ? 'na' : r <= 0.35 ? 'good' : r <= 0.38 ? 'warn' : 'bad');
    mount(
      body,
      h`<div class="toolbar"><span class="spacer" style="flex:1"></span><button class="btn primary" data-act="addDish">＋ 新增品項</button></div>
      <div class="stats">
        ${stat('品項', `${fmt(ms.count)} 道`, ms.missingCost ? `${ms.missingCost} 道還沒有成本` : '都有成本')}
        ${stat('平均售價', ms.avgPrice ? cash(ms.avgPrice) : '—', '含稅')}
        ${stat('平均成本率', ms.avgRate === null ? '—' : pct(ms.avgRate), '目標 35% 以內', ms.avgRate === null ? '' : ms.avgRate <= 0.35 ? 'good' : 'bad')}
        ${stat('每份毛利', ms.margin === null ? '—' : cash(ms.margin), '扣營業稅、食材、金流')}
      </div>
      <div class="callout" style="margin-bottom:16px"><p><b>成本怎麼來：</b>品項連到 ERP 的品項主檔、而且在 <a href="#/inventory?tab=bom">原物料進銷存 → 配方</a> 設好配方，就用「配方 × 原物料平均進價（未稅）」自動算；沒有配方的用手填成本。成本率 ＝ 成本 ÷ 含稅售價。</p></div>
      <div class="card">${
        plan.menu.length
          ? h`<div class="table-wrap"><table class="grid"><thead><tr><th scope="col">品項</th><th scope="col" class="num">售價</th><th scope="col" class="num">成本</th><th scope="col" class="num">成本率</th><th scope="col" class="num">每份毛利</th><th scope="col">過敏原</th><th scope="col"></th></tr></thead><tbody>${plan.menu.map((d) => {
              const c = dishCost(d, recipeCostOf);
              const margin = c.cost !== null && c.price > 0 ? c.price / (1 + vatRate) - c.cost - (c.price * plan.params.fee) / 100 : null;
              return h`<tr class="${d.active === false ? 'muted-row' : ''}">
                <td><b>${d.name}</b> ${badge(`第 ${d.phase || 1} 階段`, 'low')}${d.active === false ? badge('停賣', 'low') : ''}${d.method ? h`<div class="muted" style="font-size:12px">${d.method}</div>` : ''}${d.product_id ? h`<div class="muted" style="font-size:12px">連結：${productName.get(d.product_id) || '（品項已刪除）'}</div>` : ''}</td>
                <td class="num">${c.price ? cash(c.price) : '—'}</td>
                <td class="num">${c.cost === null ? '—' : cash(c.cost)}<div class="muted" style="font-size:12px">${c.source === 'recipe' ? '配方' : c.source === 'manual' ? '手填' : '未填'}</div></td>
                <td class="num">${c.rate === null ? '—' : status(tone(c.rate), pct(c.rate))}</td>
                <td class="num">${margin === null ? '—' : cash(margin)}</td>
                <td>${d.allergens || '—'}</td>
                <td style="white-space:nowrap"><button class="btn sm" data-act="editDish" data-id="${d.id}">修改</button> <button class="btn sm danger" data-act="delDish" data-id="${d.id}">刪除</button></td>
              </tr>`;
            })}</tbody></table></div>`
          : emptyState('還沒有品項', '新增要試賣的餐點：名稱、售價、成本（或連到品項主檔用配方算）、過敏原。也可以按上方「匯入企劃檔」一次帶入。', h`<button class="btn primary" data-act="addDish">＋ 新增品項</button>`)
      }</div>
      <div class="card"><div class="card-head"><h2>換點對照</h2><span class="card-note">原本會點這個、改點早午餐的客人，多賺的是兩邊毛利的差</span></div>
        <div class="form-grid">
          <label class="field"><span>被換掉的品項</span><input type="text" data-act="swapRef" data-k="name" value="${plan.swap_ref.name}" placeholder="例如：甜點平均"></label>
          <label class="field"><span>售價（含稅）</span><input type="number" min="0" step="1" data-act="swapRef" data-k="price" value="${plan.swap_ref.price ?? ''}"></label>
          <label class="field"><span>成本</span><input type="number" min="0" step="any" data-act="swapRef" data-k="cost" value="${plan.swap_ref.cost ?? ''}"></label>
          <div class="field"><span>每份毛利</span><b style="font-size:18px">${(() => {
            const m = swapMarginOf(plan.swap_ref, { vatRate, feePct: plan.params.fee });
            return m === null ? '—（沒填就用差價估）' : cash(m);
          })()}</b></div>
        </div>
      </div>`,
    );
  }

  async function editDish(d) {
    const x = d || { id: '', name: '', price: null, cost: null, product_id: '', allergens: '', method: '', phase: 1, active: true };
    const prods = [...idx.products].sort((a, b) => (a.name < b.name ? -1 : 1));
    const r = await modal({
      title: d ? `修改品項：${x.name}` : '新增品項',
      wide: true,
      body: h`<div class="form-grid">
        <label class="field" style="grid-column:1/-1"><span>名稱</span><input type="text" name="name" value="${x.name}"></label>
        <label class="field"><span>售價（含稅）</span><input type="number" name="price" min="0" step="1" value="${x.price ?? ''}"></label>
        <label class="field"><span>手填成本（沒有配方時用）</span><input type="number" name="cost" min="0" step="any" value="${x.cost ?? ''}"></label>
        <label class="field"><span>連到品項主檔（用配方算成本）</span><select name="product_id">${options([['', '不連結'], ...prods.map((p) => [p.id, p.name + (pCost.has(p.id) ? '（有配方）' : '')])], x.product_id)}</select></label>
        <label class="field"><span>階段</span><select name="phase">${options([[1, '第 1 階段'], [2, '第 2 階段']], x.phase || 1)}</select></label>
        <label class="field" style="grid-column:1/-1"><span>過敏原</span><input type="text" name="allergens" value="${x.allergens}" placeholder="例如：蛋、奶、小麥"></label>
        <label class="field" style="grid-column:1/-1"><span>做法（一句話）</span><input type="text" name="method" value="${x.method}"></label>
        <label class="row" style="grid-column:1/-1"><input type="checkbox" name="active" ${x.active !== false ? raw('checked') : ''}> 供應中</label>
      </div>`,
      actions: [
        { label: '取消', value: null },
        {
          label: '儲存',
          primary: true,
          value: (dlg) => {
            const g = (k) => dlg.querySelector(`[name=${k}]`);
            const v = { ...x, name: g('name').value.trim(), price: num(g('price').value), cost: num(g('cost').value), product_id: g('product_id').value, phase: Number(g('phase').value) || 1, allergens: g('allergens').value.trim(), method: g('method').value.trim(), active: g('active').checked };
            if (!v.name) return fail('請輸入名稱');
            if (!(v.price > 0)) return fail('請輸入售價');
            if (v.cost !== null && !(v.cost >= 0)) return fail('成本需為 0 以上');
            return { ...v, id: v.id || uid('d_') };
          },
        },
      ],
    });
    if (!r) return;
    await setAndSave(() => (plan.menu = d ? plan.menu.map((m) => (m.id === r.id ? r : m)) : [...plan.menu, r]), `已儲存「${r.name}」`);
  }

  // ─────────── 推出進度

  function drawPlan(body) {
    const st = scheduleStatus(plan.schedule, day);
    const left = plan.launch_date ? daysBetween(day, plan.launch_date) : null;
    const dates = [...new Set(plan.schedule.map((t) => t.date))].sort();
    mount(
      body,
      h`<div class="toolbar">
        <label class="field"><span>開始日</span><input type="date" data-act="startDate" value="${plan.start_date}"></label>
        <label class="field"><span>推出日</span><input type="date" data-act="launchDate" value="${plan.launch_date}"></label>
        <button class="btn" data-act="rebuild">${plan.schedule.length ? '依範本重排' : '依範本產生進度表'}</button>
        <span class="spacer" style="flex:1"></span>
        <button class="btn primary" data-act="addTask">＋ 新增事項</button>
      </div>
      ${
        plan.schedule.length
          ? h`<div class="stats">
            ${stat('完成', `${st.done}／${st.total}`, pct(st.ratio, 0), st.ratio === 1 ? 'good' : '')}
            ${stat('逾期', fmt(st.overdue.length), st.overdue.length ? st.overdue.map((t) => t.title).slice(0, 2).join('、') : '沒有', st.overdue.length ? 'bad' : 'good')}
            ${stat('下一件', st.next ? md(st.next.date) : '—', st.next ? `${st.next.owner}：${st.next.title}` : '全部完成')}
            ${stat('距離推出', left === null ? '—' : left > 0 ? `${left} 天` : left === 0 ? '今天' : '已推出', plan.launch_date ? md(plan.launch_date) : '還沒設推出日')}
          </div>
          <div class="bp-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${st.total}" aria-valuenow="${st.done}"><i style="width:${(st.ratio * 100).toFixed(1)}%"></i></div>
          <div class="card">${dates.map(
            (dt) => h`<div class="bp-day ${dt === day ? 'today' : ''} ${dt === plan.launch_date ? 'launch' : ''}">
              <div class="bp-day-head"><b>${md(dt)}</b>${dt === day ? badge('今天', 'accent') : ''}${dt === plan.launch_date ? badge('推出日', 'high') : ''}</div>
              ${plan.schedule
                .filter((t) => t.date === dt)
                .map(
                  (t) => h`<div class="bp-task ${t.done ? 'done' : ''} ${!t.done && t.date < day ? 'late' : ''}">
                    <input type="checkbox" data-act="toggleTask" data-id="${t.id}" ${t.done ? raw('checked') : ''} aria-label="完成：${t.title}">
                    <div class="bp-task-main"><div>${badge(t.owner || '—', 'low')} ${t.title}</div>${t.done_when ? h`<div class="muted" style="font-size:12.5px">完成標準：${t.done_when}</div>` : ''}${t.note ? h`<div style="font-size:12.5px">備註：${t.note}</div>` : ''}</div>
                    <span style="white-space:nowrap"><button class="btn sm ghost" data-act="editTask" data-id="${t.id}">修改</button></span>
                  </div>`,
                )}
            </div>`,
          )}</div>`
          : h`<div class="card">${emptyState('還沒有進度表', '選開始日與推出日，按「依範本產生進度表」：試做、定價、成本、食品安全、POS 品項、菜單卡、員工訓練、推出首日，每一件都有負責人與完成標準。', '')}</div>`
      }
      <div class="card"><div class="card-head"><h2>卡關怎麼辦</h2></div><table class="grid"><tbody>${BLOCKERS.map((b) => h`<tr><td style="width:38%"><b>${b.when}</b></td><td>${b.then}</td></tr>`)}</tbody></table></div>`,
    );
  }

  async function editTask(t) {
    const x = t || { id: '', date: day, owner: OWNERS[0], title: '', done_when: '', done: false, note: '' };
    const r = await modal({
      title: t ? '修改事項' : '新增事項',
      wide: true,
      body: h`<div class="form-grid">
        <label class="field"><span>日期</span><input type="date" name="date" value="${x.date}"></label>
        <label class="field"><span>負責</span><select name="owner">${options(OWNERS.map((o) => [o, o]), x.owner)}</select></label>
        <label class="field" style="grid-column:1/-1"><span>事項</span><input type="text" name="title" value="${x.title}"></label>
        <label class="field" style="grid-column:1/-1"><span>完成標準</span><input type="text" name="done_when" value="${x.done_when}"></label>
        <label class="field" style="grid-column:1/-1"><span>備註</span><input type="text" name="note" value="${x.note}"></label>
      </div>`,
      actions: [
        ...(t ? [{ label: '刪除', danger: true, value: 'delete' }] : []),
        { label: '取消', value: null },
        {
          label: '儲存',
          primary: true,
          value: (dlg) => {
            const g = (k) => dlg.querySelector(`[name=${k}]`).value.trim();
            const v = { ...x, date: g('date'), owner: g('owner'), title: g('title'), done_when: g('done_when'), note: g('note') };
            if (!v.title) return fail('請輸入事項');
            if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return fail('請選日期');
            return { ...v, id: v.id || uid('t_') };
          },
        },
      ],
    });
    if (!r) return;
    if (r === 'delete' && !(await confirmBox(`刪除「${t.title}」？`, { ok: '刪除', danger: true }))) return;
    await setAndSave(() => {
      if (r === 'delete') plan.schedule = plan.schedule.filter((x2) => x2.id !== t.id);
      else plan.schedule = t ? plan.schedule.map((x2) => (x2.id === r.id ? r : x2)) : [...plan.schedule, r];
    }, r === 'delete' ? '已刪除事項' : '已儲存進度表');
  }

  // ─────────── 測試紀錄

  // 主指標要用的數字：餐點毛利與成本（有 POS 就照實際銷售組合加權）、新客整張單（試算器的每位客人毛利，估算）、被換掉的品項、每天固定增量成本
  function testContext(mix) {
    const ms = menuSummary(plan.menu, { vatRate, feePct: plan.params.fee, recipeCostOf, mix });
    const s = simulate(plan.params, { vatRate });
    return {
      dishMargin: ms.margin ?? s.perGuest,
      dishCost: ms.avgCost ?? 0,
      guestMargin: s.perGuest,
      swapMargin: swapMarginOf(plan.swap_ref, { vatRate, feePct: plan.params.fee }),
      dailyFixed: dailyFixedOf(plan.params, { vatRate }),
      costRate: ms.avgRate ?? plan.params.cost / 100,
      feePct: plan.params.fee,
      wage: plan.params.wage,
      vatRate,
      fromMenu: ms.margin !== null,
      weighted: ms.weighted,
      missingCost: ms.missingCost,
      soldUncosted: ms.soldUncosted,
    };
  }

  async function drawTest(body) {
    const from = plan.test.from || plan.launch_date || '';
    const to = plan.test.to || (from ? addDays(from, 27) : '');
    const lines = from ? await revenueLines({ from, to }) : [];
    const pos = posWindow(lines, { from, to, start: plan.window.start, end: plan.window.end, keywords: plan.test.keywords, dishes: plan.menu.map((d) => d.name) });
    const tctx = testContext(pos.mix.size ? pos.mix : null);
    const v = testVerdict(plan.log, tctx, plan.rules, { from, to, today: day, safetyOk: plan.safety_ok });
    const posBy = new Map(pos.map((p) => [p.date, p]));
    const logBy = new Map(plan.log.map((e) => [e.date, e]));
    const shownDates = from && from <= day ? eachDay(from, to < day ? to : day) : plan.log.map((e) => e.date);
    const [tone, label] = VERDICT[v.verdict];
    const R = plan.rules;
    const swapNote = tctx.swapMargin === null ? '「菜單與成本」還沒設被換掉的品項，換點先用差價估' : `早午餐毛利減掉被換掉的品項（每份 ${cash(tctx.swapMargin)}）`;
    const warns = [
      tctx.missingCost ? `${tctx.missingCost} 道菜還沒有成本，沒算進每份毛利（到「菜單與成本」補）。` : '',
      tctx.soldUncosted.length ? `POS 有賣出但沒有成本的：${tctx.soldUncosted.join('、')}。` : '',
      !plan.safety_ok ? '食品業者登錄、產品責任險還沒勾「已確認」，不會判過關。' : '',
    ].filter(Boolean);
    const cell = (label2, content, cls = '') => h`<td class="${cls}" data-label="${label2}">${content}</td>`;
    mount(
      body,
      h`<div class="toolbar">
        <label class="field"><span>測試開始</span><input type="date" data-act="testFrom" value="${plan.test.from || from}"></label>
        <label class="field"><span>測試結束</span><input type="date" data-act="testTo" value="${plan.test.to || to}"></label>
        <label class="field"><span>試賣時段</span><span class="row"><input type="time" data-act="winStart" value="${plan.window.start}" style="width:140px" aria-label="試賣開始"> – <input type="time" data-act="winEnd" value="${plan.window.end}" style="width:140px" aria-label="試賣結束"></span></label>
        <label class="field" style="min-width:200px"><span>POS 品類關鍵字（品名會自動比對）</span><input type="text" data-act="keywords" value="${plan.test.keywords}"></label>
        <label class="row bp-safety"><input type="checkbox" data-act="safety" ${plan.safety_ok ? raw('checked') : ''}> 食品業者登錄、產品責任險已確認</label>
        <span class="spacer" style="flex:1"></span>
        <button class="btn primary" data-act="addLog" data-date="${day}">＋ 記今天</button>
      </div>
      <div class="stats">
        ${stat('判斷', h`${status(tone, label)}`, `${v.count} 天紀錄（週末 ${v.weekendCount} 天）${v.missing.length ? `，缺 ${v.missing.length} 天` : ''}`, v.missing.length ? 'bad' : '')}
        ${stat('平均每天多賺', signed(v.avgProfit), `週末 ${signed(v.weekendProfit)}／平日 ${signed(v.weekdayProfit)}；門檻 ${cash(R.min_profit)}`, v.avgProfit === null ? '' : v.avgProfit >= R.min_profit ? 'good' : 'bad')}
        ${stat('週末平均份數', v.weekendPortions === null ? '—' : `${fmt(v.weekendPortions)} 份`, `平日 ${v.weekdayPortions === null ? '—' : fmt(v.weekdayPortions) + ' 份'}`)}
        ${stat('報廢率', v.count ? pct(v.wasteRate, 0) : '—', `上限 ${pct(R.waste_rate, 0)}`, v.count && v.wasteRate > R.waste_rate ? 'bad' : '')}
        ${stat('出餐太慢', `${fmt(v.slowDays)} 天`, `超過 ${R.max_serve_min} 分鐘；最多 ${pct(R.max_slow_share, 0)} 的天數`, v.slowDays && v.count && v.slowDays / v.count > R.max_slow_share ? 'bad' : '')}
        ${stat('提早開的訊號', `${fmt(v.doorGroups)} 組`, `開門前在等的組數；問卷想來 ${fmt(v.surveyYes)} 人`)}
      </div>
      <div class="callout ${v.verdict === 'pass' ? 'good' : v.verdict === 'stop' ? 'bad' : ['adjust', 'fix'].includes(v.verdict) || v.missing.length ? 'warn' : ''}" style="margin-bottom:16px">
        <p><b>${v.reason}</b></p>
        ${warns.length ? h`<ul class="plain-list" style="margin:6px 0 8px">${warns.map((w) => h`<li>${w}</li>`)}</ul>` : ''}
        <details class="bp-how"><summary>每天多賺怎麼算、什麼時候判斷</summary>
          <p>新客（因為早午餐才來的人）算整張單的毛利，每位 ${cash(tctx.guestMargin)}，是用試算器的客單估的；原本的客人多加點，算那份餐的毛利（每份 ${cash(tctx.dishMargin)}${tctx.weighted ? '，照 POS 實際賣的組合加權' : tctx.fromMenu ? '，菜單平均' : '，菜單還沒有成本，暫用每位客人毛利'}）；換點算${swapNote}；再扣當天的報廢、多排的人力，以及每天都有的耗材、水電${plan.params.lost ? '、縮短營業少掉的毛利' : ''}（每天 ${cash(tctx.dailyFixed)}）。</p>
          <p>測試期結束、每天都有紀錄（沒賣記 0，公休勾公休）、週末至少 ${R.min_weekend_days} 天、食品安全已確認，才會下結論。平均每天多賺至少 ${cash(R.min_profit)}、報廢率不超過 ${pct(R.waste_rate, 0)}、出餐超過 ${R.max_serve_min} 分鐘的天數不超過 ${pct(R.max_slow_share, 0)}，才算過關；沒賺到門檻時看週末平均份數：不到 ${R.stop_portions} 份停、${R.stop_portions}–${R.adjust_portions} 份換品項或加強宣傳、超過 ${R.adjust_portions} 份調價、降成本或減人力。</p>
        </details>
      </div>
      <div class="card"><div class="card-head"><h2>每天多賺</h2><span class="card-note">綠色多賺、紅色虧</span></div><div id="bp-bars" class="chart"></div></div>
      <div class="card"><div class="card-head"><h2>每日紀錄</h2><span class="card-note">POS 欄位來自匯入的銷售明細（${plan.window.start}–${plan.window.end}）；手記份數和 POS 差 2 份以上會標出來</span></div>
      ${
        shownDates.length
          ? h`<div class="table-wrap bp-log-wrap"><table class="grid bp-log"><thead><tr><th scope="col">日期</th><th scope="col" class="num">POS 時段營收</th><th scope="col" class="num">POS 份數</th><th scope="col" class="num">手記份數</th><th scope="col" class="num">新客／加點／換點</th><th scope="col" class="num">報廢</th><th scope="col" class="num">多排人力</th><th scope="col" class="num">最慢出餐</th><th scope="col">天氣、活動</th><th scope="col" class="num">當天多賺</th><th scope="col"><span class="sr-only">動作</span></th></tr></thead><tbody>${shownDates
              .slice()
              .reverse()
              .map((d) => {
                const e = logBy.get(d);
                const p = posBy.get(d);
                const r = e && !e.closed ? dayResult(e, tctx) : null;
                const miss = !e && d < day;
                const problem = e ? entryProblem(e) : '';
                const gap = r && p && Math.abs((e.portions || 0) - p.brunchQty) >= 2;
                return h`<tr class="${miss || problem ? 'bp-miss' : ''}">
                  <th scope="row" class="bp-date">${md(d)}${isWeekend(d) ? badge('週末', 'accent') : ''}</th>
                  ${cell('POS 時段營收', p ? cash(p.windowRevenue) : '—', 'num')}
                  ${cell('POS 份數', p ? (gap ? status('warn', `${fmt(p.brunchQty)}（差 ${fmt(Math.abs((e.portions || 0) - p.brunchQty))}）`) : fmt(p.brunchQty)) : '—', 'num')}
                  ${cell('手記份數', e?.closed ? badge('公休', 'low') : problem ? status('warn', `不完整：${problem}`) : e ? fmt(e.portions || 0) : miss ? status('warn', '缺紀錄') : '—', 'num')}
                  ${cell('新客／加點／換點', r ? `${fmt(e.new_count || 0)}／${fmt(e.addon_count || 0)}／${fmt(e.swap_count || 0)}` : '—', 'num')}
                  ${cell('報廢', r ? cash(e.waste || 0) : '—', 'num')}
                  ${cell('多排人力', r ? `${fmt(e.extra_hours || 0)} 小時` : '—', 'num')}
                  ${cell('最慢出餐', r && e.slowest_min ? (e.slowest_min > R.max_serve_min ? status('bad', `${e.slowest_min} 分`) : `${e.slowest_min} 分`) : '—', 'num')}
                  ${cell('天氣、活動', e ? [e.weather, e.event, e.posted ? '有發文' : ''].filter(Boolean).join('、') || '—' : '—')}
                  ${cell('當天多賺', r ? h`<b class="${r.profit >= 0 ? 'bp-pos' : 'bp-neg'}">${signed(r.profit)}</b>` : '—', 'num')}
                  <td class="bp-act"><button class="btn sm" data-act="addLog" data-date="${d}" aria-label="${e ? '修改' : '記錄'} ${md(d)}">${e ? '修改' : '記錄'}</button></td>
                </tr>`;
              })}</tbody></table></div>`
          : emptyState('還沒有紀錄', '推出後每天收班花 1 分鐘：份數、新客／加點／換點、報廢、最慢出餐、天氣；沒賣也要記 0。測試期間有匯入 POS 銷售明細的話，時段營收會自動帶出來。', h`<button class="btn primary" data-act="addLog" data-date="${day}">＋ 記今天</button>`)
      }</div>`,
    );
    const barsEl = body.querySelector('#bp-bars');
    const barPts = v.days.filter((d) => !d.closed).map((d) => ({ label: md(d.date), value: d.profit }));
    bars(barsEl, barPts);
    if (barsEl) fitWidth(barsEl, () => bars(barsEl, barPts));
  }
  // 正負直條（多賺／虧）
  function bars(el, pts) {
    if (!el) return;
    if (!pts.length) {
      el.innerHTML = '<p class="muted" style="margin:0">有紀錄之後才會畫。</p>';
      return;
    }
    const width = Math.max(300, el.clientWidth || 600);
    const height = 170;
    const pad = { l: 52, r: 8, t: 12, b: 24 };
    const lo = Math.min(0, ...pts.map((p) => p.value));
    const hi = Math.max(0, ...pts.map((p) => p.value));
    const span = hi - lo || 1;
    const y = (v) => pad.t + (1 - (v - lo) / span) * (height - pad.t - pad.b);
    const band = (width - pad.l - pad.r) / pts.length;
    const bw = Math.max(3, Math.min(24, band - 3));
    const every = Math.max(1, Math.ceil(pts.length / Math.floor((width - pad.l) / 56)));
    const summaryText = pts.map((p) => `${p.label} ${p.value >= 0 ? "多賺" : "虧"} ${fmt(Math.round(Math.abs(p.value)))} 元`).join("、");
    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="每天多賺：${esc(summaryText)}">
      <line class="axis" x1="${pad.l}" x2="${width - pad.r}" y1="${y(0)}" y2="${y(0)}"/>
      <text class="tick" x="${pad.l - 6}" y="${y(0) + 4}" text-anchor="end">0</text>
      ${hi > 0 && y(0) - y(hi) > 14 ? `<text class="tick" x="${pad.l - 6}" y="${y(hi) + 4}" text-anchor="end">+${fmt(Math.round(hi))}</text>` : ''}
      ${lo < 0 && y(lo) - y(0) > 14 ? `<text class="tick" x="${pad.l - 6}" y="${y(lo) + 4}" text-anchor="end">−${fmt(Math.round(-lo))}</text>` : ''}
      ${pts
        .map((p, i) => {
          const cx = pad.l + band * i + band / 2;
          const top = Math.min(y(p.value), y(0));
          const hgt = Math.max(1, Math.abs(y(p.value) - y(0)));
          const lbl = i % every === 0 ? `<text class="tick" x="${cx}" y="${height - 7}" text-anchor="middle">${p.label.replace(/（.）/, '')}</text>` : '';
          return `<rect x="${cx - bw / 2}" y="${top}" width="${bw}" height="${hgt}" rx="3" fill="${p.value >= 0 ? 'var(--good)' : 'var(--bad)'}"><title>${p.label} ${p.value >= 0 ? '+' : '−'}$${fmt(Math.round(Math.abs(p.value)))}</title></rect>${lbl}`;
        })
        .join('')}
    </svg>`;
  }

  async function editLog(date) {
    const e = plan.log.find((x) => x.date === date) || { date, portions: null, new_count: null, addon_count: null, swap_count: null, swap_diff: null, waste: null, extra_hours: null, slowest_min: null, weather: '', event: '', posted: false, door_groups: null, survey_yes: null, note: '' };
    const field = (name, label, attrs = '') => h`<label class="field"><span>${label}</span><input type="number" name="${name}" min="0" step="any" value="${e[name] ?? ''}" ${raw(attrs)}></label>`;
    const r = await modal({
      title: `每日紀錄：${md(date)}`,
      wide: true,
      body: h`<div class="form-grid">
        <label class="row" style="grid-column:1/-1"><input type="checkbox" name="closed" ${e.closed ? raw('checked') : ''}> 這天公休（不算進平均）</label>
        ${field('portions', '早午餐份數（沒賣記 0）')}
        ${field('new_count', '新客：因為早午餐才來的人')}
        ${field('addon_count', '原本的客人多加點（份）')}
        ${field('swap_count', '原本的客人換點（份）')}
        ${field('swap_diff', '換點差價合計（沒設被換掉的品項時才用）')}
        ${field('waste', '報廢金額（成本）')}
        ${field('extra_hours', '多排的人力（小時）')}
        ${field('slowest_min', '最慢一份出餐（分鐘）')}
        <label class="field"><span>天氣</span><select name="weather">${options(WEATHER.map((w) => [w, w || '—']), e.weather)}</select></label>
        <label class="field"><span>附近活動</span><input type="text" name="event" value="${e.event || ''}"></label>
        ${field('door_groups', '開門前在等的組數')}
        ${field('survey_yes', '問卷「提早開會來」人數')}
        <label class="row"><input type="checkbox" name="posted" ${e.posted ? raw('checked') : ''}> 當天有發文</label>
        <label class="field" style="grid-column:1/-1"><span>備註</span><input type="text" name="note" value="${e.note || ''}"></label>
      </div>
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">新客算「人」，一位新客點 1 份餐＋飲料就記 1。換點：原本會點甜點、改點早午餐的；在「菜單與成本」設好被換掉的品項，就照毛利相減算，差價可以不填。份數不填會自動加總。</p>`,
      actions: [
        ...(plan.log.some((x) => x.date === date) ? [{ label: '刪除這天', danger: true, value: 'delete' }] : []),
        { label: '取消', value: null },
        {
          label: '儲存',
          primary: true,
          value: (dlg) => {
            const g = (k) => dlg.querySelector(`[name=${k}]`);
            const out = { date };
            for (const k of ['portions', 'new_count', 'addon_count', 'swap_count', 'swap_diff', 'waste', 'extra_hours', 'slowest_min', 'door_groups', 'survey_yes']) {
              const val = num(g(k).value);
              if (val !== null && !(val >= 0)) return fail('數字需為 0 以上');
              out[k] = val;
            }
            out.closed = g('closed').checked;
            const split = (out.new_count || 0) + (out.addon_count || 0) + (out.swap_count || 0);
            if (!out.closed) {
              if (out.portions === null) out.portions = split;
              if (out.portions !== split) return fail(`新客＋加點＋換點（${split}）要等於份數（${out.portions}）；一位新客點 1 份就記 1`);
              if (out.portions > 0 && out.slowest_min === null) return fail('有賣出就要填最慢一份的出餐分鐘');
            }
            out.weather = g('weather').value;
            out.event = g('event').value.trim();
            out.posted = g('posted').checked;
            out.note = g('note').value.trim();
            return out;
          },
        },
      ],
    });
    if (!r) return;
    await setAndSave(() => (plan.log = r === 'delete' ? plan.log.filter((x) => x.date !== date) : [...plan.log.filter((x) => x.date !== date), r].sort((a, b) => (a.date < b.date ? -1 : 1))), r === 'delete' ? '已刪除這天的紀錄' : '已儲存每日紀錄');
  }

  // ─────────── 事件

  // 改資料一律走這裡：先記下改之前的樣子，存檔失敗就退回
  const setAndSave = async (fn, msg) => {
    const before = structuredClone(plan);
    fn();
    await save(msg, before);
    draw();
  };

  const unbind = bindActions(root, {
    tab: (el) => {
      f.tab = el.dataset.tab;
      ctx.setParams({ tab: f.tab });
      draw();
    },
    scenario: (el) => {
      simKey = el.dataset.k;
      sim = { ...(simKey === 'mine' ? plan.params : SCENARIOS.find((s) => s.key === simKey).params) };
      draw();
    },
    slide: (el) => {
      sim[el.dataset.k] = Number(el.value);
      paintSim(root);
    },
    useMenuCost: () => {
      const ms = summary();
      if (ms.avgRate === null) return;
      sim.cost = Math.round(ms.avgRate * 100);
      draw();
    },
    saveSim: async () => {
      simKey = 'mine';
      await setAndSave(() => (plan.params = { ...sim }), '已存成我的設定');
    },
    addDish: () => editDish(null),
    editDish: (el) => editDish(plan.menu.find((d) => d.id === el.dataset.id)),
    delDish: async (el) => {
      const d = plan.menu.find((x) => x.id === el.dataset.id);
      if (!d || !(await confirmBox(`刪除「${d.name}」？`, { ok: '刪除', danger: true }))) return;
      await setAndSave(() => (plan.menu = plan.menu.filter((x) => x.id !== d.id)), '已刪除品項');
    },
    startDate: (el) => setAndSave(() => (plan.start_date = el.value), '已儲存開始日'),
    launchDate: (el) => setAndSave(() => (plan.launch_date = el.value), '已儲存推出日'),
    rebuild: async () => {
      if (!plan.start_date || !plan.launch_date) return toast('先選開始日和推出日', 'error');
      if (plan.launch_date < plan.start_date) return toast('推出日不能早於開始日', 'error');
      if (plan.schedule.length && !(await confirmBox('依範本重排會換掉現在的進度表（包含已勾完成的），確定？', { ok: '重排', danger: true }))) return;
      await setAndSave(() => (plan.schedule = buildSchedule(plan.start_date, plan.launch_date)), '已產生進度表');
    },
    addTask: () => editTask(null),
    editTask: (el) => editTask(plan.schedule.find((t) => t.id === el.dataset.id)),
    toggleTask: (el) => setAndSave(() => (plan.schedule = plan.schedule.map((t) => (t.id === el.dataset.id ? { ...t, done: el.checked } : t))), el.checked ? '完成一件' : ''),
    testFrom: (el) => setAndSave(() => (plan.test = { ...plan.test, from: el.value }), ''),
    testTo: (el) => setAndSave(() => (plan.test = { ...plan.test, to: el.value }), ''),
    winStart: (el) => setAndSave(() => (plan.window = { ...plan.window, start: el.value }), ''),
    winEnd: (el) => setAndSave(() => (plan.window = { ...plan.window, end: el.value }), ''),
    keywords: (el) => setAndSave(() => (plan.test = { ...plan.test, keywords: el.value.trim() }), ''),
    addLog: (el) => editLog(el.dataset.date),
    swapRef: (el) => {
      const k = el.dataset.k;
      const v = k === 'name' ? el.value.trim() : num(el.value);
      if (k !== 'name' && v !== null && !(v >= 0)) return toast('需為 0 以上的數字', 'error');
      return setAndSave(() => (plan.swap_ref = { ...plan.swap_ref, [k]: v }), '已儲存換點對照');
    },
    safety: (el) => setAndSave(() => (plan.safety_ok = el.checked), el.checked ? '已記下：食品安全已確認' : ''),
    exportPlan: () => download(`${safeName(plan.name)}_企劃_${day}.json`, JSON.stringify(exportPlan(plan), null, 2), 'application/json'),
    exportFull: () => download(`${safeName(plan.name)}_完整備份_${day}.json`, JSON.stringify(exportPlan(plan, { full: true }), null, 2), 'application/json'),
    importPlan: async () => {
      const [file] = await pickFiles({ accept: '.json,application/json', multiple: false });
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) return toast('檔案太大，不像企劃檔（上限 2 MB）', 'error');
      let data;
      try {
        data = JSON.parse(await file.text());
      } catch {
        return toast('這不是企劃檔（JSON 讀不出來）', 'error');
      }
      const chk = checkPlanFile(data);
      if (chk.errors.length) return toast(chk.errors.join('；'), 'error', 7000);
      const next = normalizePlan(data);
      if (!next.menu.length && !next.schedule.length) return toast('企劃檔裡沒有菜單也沒有進度表', 'error');
      const fileLog = next.log.length;
      const r = await modal({
        title: `匯入「${next.name}」`,
        body: h`<p>會換掉菜單（${next.menu.length} 道）、進度表（${next.schedule.length} 件）、試算參數與測試設定。</p>
          <p>每日紀錄是現場記的，<b>預設不會被刪</b>${plan.log.length ? `：現有 ${plan.log.length} 天保留，檔案裡同一天的紀錄不會蓋過去` : ''}${fileLog ? `；檔案裡有 ${fileLog} 天紀錄，只補沒有的日子` : ''}。</p>
          ${chk.warnings.length ? h`<div class="callout warn" style="margin:8px 0"><p><b>會略過：</b></p><ul class="plain-list">${chk.warnings.map((w) => h`<li>${w}</li>`)}</ul></div>` : ''}
          ${plan.log.length ? h`<label class="row" style="margin-top:8px"><input type="checkbox" name="replaceLog"> 連每日紀錄一起換成檔案裡的（現有 ${plan.log.length} 天會被刪掉）</label>` : ''}`,
        actions: [
          { label: '取消', value: null },
          { label: '匯入', primary: true, value: (dlg) => ({ replaceLog: !!dlg.querySelector('[name=replaceLog]')?.checked }) },
        ],
      });
      if (!r) return;
      if (r.replaceLog && !(await confirmBox(`真的要刪掉現有 ${plan.log.length} 天的每日紀錄？`, { ok: '刪掉並匯入', danger: true }))) return;
      simKey = 'mine';
      await setAndSave(() => {
        plan = mergeImport(plan, next, r);
        sim = { ...plan.params };
      }, `已匯入「${next.name}」：${next.menu.length} 道菜、${next.schedule.length} 件事`);
    },
  });

  draw();
  return () => {
    unbind();
    dropObservers(true);
    root.removeEventListener('keydown', onTabKey);
  };
}
