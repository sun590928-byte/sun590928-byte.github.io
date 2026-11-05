// 濾掛與禮盒企劃：單包成本與月試算、禮盒組合、試製到開賣的進度表、批次與效期（留樣檢查）、開賣後的 POS 銷量對照。
// 企劃存在 settings 的 dripbag_plan；店家的豆價、售價、包材成本不寫在程式裡，從「匯入企劃檔」或畫面上填。

import { h, raw, mount, bindActions, modal, confirmBox, toast, stat, status, badge, options, fmt, pct, emptyState, pickFiles, download } from '../ui.js';
import { store } from '../store.js';
import { getSettings, revenueLines } from '../state.js';
import { averageCosts } from '../lib/inventory.js';
import { PLAN_ID, COST_FIELDS, MONTH_FIELDS, OWNERS, BLOCKERS, CHECK_DAYS, skuMargin, monthPlan, giftCost, batchStatus, sampleChecks, canExtend, nextBatchCode, posDrip, salesVerdict, buildSchedule, scheduleStatus, normalizePlan, checkPlanFile, mergeImport, exportPlan, beanKgFrom } from '../lib/dripbag.js';
import { today, weekdayIndex, WEEKDAYS, addDays, daysBetween, eachDay } from '../lib/dates.js';
import { uid } from '../lib/text.js';

const TABS = [
  ['cost', '單包與月試算'],
  ['gift', '禮盒組合'],
  ['plan', '試製到開賣'],
  ['batch', '批次與效期'],
  ['sales', '銷售對照'],
];
const PURPOSE = { sale: '販售', trial: '試製（不賣）', gift: '禮盒預留' };
const VERDICT = { pass: ['good', '達標'], adjust: ['warn', '要調整（陳列、話術、品項）'], stop: ['bad', '不擴大，只留主力單包'], collecting: ['info', '資料收集中'], pending: ['na', '還沒開賣'] };

const cash = (v) => (v === null || v === undefined ? '—' : (v < 0 ? '−$' : '$') + fmt(Math.round(Math.abs(v))));
const cash1 = (v) => (v === null || v === undefined ? '—' : (v < 0 ? '−' : '') + Math.abs(v).toFixed(1));
const num = (v) => (v === null || v === undefined || String(v).trim() === '' ? null : Number(v));
const md = (ymd) => (ymd ? `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}（${WEEKDAYS[weekdayIndex(ymd)]}）` : '—');
const fail = (msg) => {
  toast(msg, 'error');
  return false;
};
const safeName = (s) => s.replace(/[\\/:*?"<>|]/g, '-');

export async function render(root, ctx) {
  const settings = await getSettings();
  const vatRate = settings.vat_mode === 'general' ? 0.05 : 0;
  const day = today();
  const f = { tab: TABS.some(([k]) => k === ctx.params.tab) ? ctx.params.tab : 'cost' };

  let rec = (await store.all('settings')).find((r) => r.id === PLAN_ID);
  let plan = normalizePlan(rec?.value);
  let stamp = rec?.value?.updated_at || null; // 讀進來時的版本，存檔前比對，避免兩台裝置互相蓋掉
  let saving = false;

  // 熟豆成本：連到原物料就用進貨紀錄的未稅平均進價
  const [items, moves] = await Promise.all([store.all('inventory_items'), store.all('inventory_moves')]);
  const avg = averageCosts(items, moves, { asOf: day, vatRate });
  const itemById = new Map(items.map((it) => [it.id, it]));
  const linkedKg = (s) => (s.item_id ? beanKgFrom(itemById.get(s.item_id), avg.get(s.item_id)?.avg) : null);
  const beanKgOf = (s) => linkedKg(s) ?? s.bean_kg;
  const skuName = (id) => plan.skus.find((s) => s.id === id)?.name || '（已刪除的品項）';

  async function save(msg, before = null) {
    if (saving) return false;
    saving = true;
    root.setAttribute('aria-busy', 'true');
    try {
      const latest = (await store.all('settings')).find((r) => r.id === PLAN_ID);
      const latestStamp = latest?.value?.updated_at || null;
      if (latestStamp && latestStamp !== stamp) {
        rec = latest;
        plan = normalizePlan(latest.value);
        stamp = latestStamp;
        toast('別的裝置剛改過這份企劃，已載入最新的內容，請再做一次剛才的修改。', 'error', 7000);
        return false;
      }
      const nextStamp = new Date().toISOString();
      await store.put('settings', { id: PLAN_ID, value: { ...plan, updated_at: nextStamp } });
      stamp = nextStamp;
      rec = { id: PLAN_ID, value: plan };
      if (msg) toast(msg, 'good');
      return true;
    } catch (e) {
      console.error(e);
      if (before) plan = before;
      toast(`沒有存到：${e.message || e}。請再試一次；一直失敗就先按「完整備份」。`, 'error', 8000);
      return false;
    } finally {
      saving = false;
      root.removeAttribute('aria-busy');
    }
  }

  // 改資料一律走這裡：先記下改之前的樣子，存檔失敗就退回
  const setAndSave = async (fn, msg) => {
    const before = structuredClone(plan);
    fn();
    await save(msg, before);
    draw();
  };

  function draw() {
    mount(
      root,
      h`<div class="toolbar">
        <div class="field" style="flex:1;min-width:220px"><span>企劃</span><b style="font-size:16px">${plan.name}</b></div>
        <button class="btn" data-act="importPlan">匯入企劃檔</button>
        <button class="btn" data-act="exportPlan" title="不含批次紀錄與備註，可以分享">匯出企劃</button>
        <button class="btn" data-act="exportFull" title="含批次與留樣紀錄，自己備份用">完整備份</button>
      </div>
      ${!rec ? h`<div class="callout" style="margin-bottom:16px"><p><b>第一次使用：</b>畫面上是示範數字，不是你的店。按「匯入企劃檔」帶入整理好的品項、價格、禮盒和進度表，或直接在各分頁填。企劃只存在你的資料裡（本機或雲端），不會放在程式碼中。</p></div>` : ''}
      <div class="tabs" role="tablist" aria-label="濾掛與禮盒企劃">${TABS.map(([k, l]) => h`<button role="tab" id="db-tab-${k}" aria-controls="db-body" aria-selected="${f.tab === k ? 'true' : 'false'}" tabindex="${f.tab === k ? '0' : '-1'}" class="${f.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`)}</div>
      <div id="db-body" role="tabpanel" aria-labelledby="db-tab-${f.tab}"></div>`,
    );
    const body = root.querySelector('#db-body');
    if (f.tab === 'gift') drawGift(body);
    else if (f.tab === 'plan') drawPlan(body);
    else if (f.tab === 'batch') drawBatch(body);
    else if (f.tab === 'sales') drawSales(body).catch((e) => mount(body, h`<div class="callout bad"><p><b>銷售對照載入失敗：</b>${e.message || e}</p></div>`));
    else drawCost(body);
  }

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
    root.querySelector(`#db-tab-${f.tab}`)?.focus();
  };
  root.addEventListener('keydown', onTabKey);

  // ─────────── 單包與月試算

  const numField = (group, fd, value) =>
    h`<label class="field"><span>${fd.label}（${fd.unit}）</span><input type="number" min="0" max="${fd.max}" step="any" inputmode="decimal" data-act="param" data-group="${group}" data-k="${fd.key}" value="${value}"></label>`;

  function drawCost(body) {
    const rows = plan.skus.map((s) => ({ s, r: skuMargin(s, plan.costs, { vatRate, beanKg: beanKgOf(s) }), linked: linkedKg(s) }));
    const mp = monthPlan(plan.skus, plan.costs, plan.month, { vatRate, beanKgOf });
    const noBean = rows.filter((x) => x.r.cost === null).map((x) => x.s.name);
    mount(
      body,
      h`<div class="card">
        <div class="card-head"><h2>品項與單包毛利</h2><span class="spacer" style="flex:1"></span><button class="btn primary" data-act="addSku">＋ 新增品項</button></div>
        ${
          rows.length
            ? h`<div class="table-wrap"><table class="grid">
              <thead><tr><th scope="col">品項</th><th scope="col" class="num">售價（含稅）</th><th scope="col" class="num">熟豆／kg（未稅）</th><th scope="col" class="num">豆子</th><th scope="col" class="num">包材</th><th scope="col" class="num">人工</th><th scope="col" class="num">損耗</th><th scope="col" class="num">手續費</th><th scope="col" class="num">單包成本</th><th scope="col" class="num">毛利率（未稅）</th><th scope="col" class="num">銷售佔比</th><th scope="col"></th></tr></thead>
              <tbody>${rows.map(({ s, r, linked }) => {
                const c = r.cost;
                return h`<tr class="${s.active === false ? 'muted' : ''}">
                  <th scope="row" style="text-align:left">${s.name}${s.active === false ? h` ${badge('停售', 'low')}` : ''}${s.weekly_limit ? h`<div class="muted" style="font-size:12px">限量每週 ${fmt(s.weekly_limit)} 包</div>` : ''}</th>
                  <td class="num">${cash(s.price)}</td>
                  <td class="num">${linked !== null ? h`${cash(linked)}<div class="muted" style="font-size:11.5px">進貨平均</div>` : s.bean_kg !== null ? h`${cash(s.bean_kg)}<div class="muted" style="font-size:11.5px">${s.item_id ? '連了原物料但還沒有進貨價，先用手填' : '手填'}</div>` : status('warn', s.item_id ? '原物料還沒有進貨價' : '沒填')}</td>
                  <td class="num">${c ? cash1(c.bean) : '—'}</td><td class="num">${c ? cash1(c.pack) : '—'}</td><td class="num">${c ? cash1(c.labor) : '—'}</td><td class="num">${c ? cash1(c.loss) : '—'}</td><td class="num">${c ? cash1(c.fee) : '—'}</td>
                  <td class="num"><b>${c ? cash1(c.total) : '—'}</b></td>
                  <td class="num">${r.rate === null ? '—' : h`<b class="${r.rate >= 0.5 ? 'bp-pos' : r.rate < 0.3 ? 'bp-neg' : ''}">${pct(r.rate, 0)}</b><div class="muted" style="font-size:11.5px">每包 ${cash1(r.margin)}</div>`}</td>
                  <td class="num">${s.active === false ? '—' : `${fmt(s.mix)}%`}</td>
                  <td style="white-space:nowrap"><button class="btn sm" data-act="editSku" data-id="${s.id}">修改</button></td>
                </tr>`;
              })}</tbody></table></div>
              ${noBean.length ? h`<div class="callout warn" style="margin-top:10px"><p>${noBean.join('、')} 還沒有熟豆成本，不算毛利。豆子成本不要從售價倒推：連到「原物料」用進貨平均價，或手填烘豆商報價（未稅）。</p></div>` : ''}`
            : emptyState('還沒有品項', '新增要賣的濾掛：名稱、含稅售價、熟豆每公斤成本（或連到原物料用進貨平均價）、預估銷售佔比。也可以按上方「匯入企劃檔」一次帶入。', h`<button class="btn primary" data-act="addSku">＋ 新增品項</button>`)
        }
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>每包共用的成本</h2><span class="card-note">改了就存</span></div>
          <div class="form-grid">${COST_FIELDS.map((fd) => numField('costs', fd, plan.costs[fd.key]))}</div>
          <p class="muted" style="font-size:12.5px;margin:10px 0 0">單包成本＝（豆子＋包材＋人工）÷（1 − 損耗）＋ 含稅售價 × 手續費。售價先除以 ${1 + vatRate} 扣營業稅再算毛利率。</p>
        </div>
        <div class="card">
          <div class="card-head"><h2>一個月大概多少</h2><span class="card-note">試算，不是預測</span></div>
          <div class="form-grid">${MONTH_FIELDS.map((fd) => numField('month', fd, plan.month[fd.key]))}</div>
          <div class="stats" style="margin-top:12px">
            ${stat('一個月', `${fmt(Math.round(mp.packs))} 包`, `平均每包 ${cash(mp.avgPrice)}`)}
            ${stat('營收（含稅）', cash(mp.revenue), '')}
            ${stat('毛利（未稅）', cash(mp.profit), `已扣 5 入袋 ${cash(mp.bags)}`, mp.profit >= 0 ? 'good' : 'bad')}
            ${stat('回本', mp.breakeven === null ? '—' : `${fmt(mp.breakeven)} 包`, `第一次購買 ${cash(plan.month.first_order)}`)}
          </div>
          ${mp.missing.length ? h`<p class="muted" style="font-size:12.5px">${mp.missing.join('、')} 沒有成本，毛利沒算進去。</p>` : ''}
          <p class="muted" style="font-size:12.5px;margin:8px 0 0">週末天數＝營業天數 × 2/7；銷售佔比照上表。沒有算廣告、寄送和滯銷報廢。</p>
        </div>
      </div>`,
    );
  }

  async function editSku(s) {
    const x = s || { id: '', name: '', price: null, bean_kg: null, mix: 0, item_id: '', weekly_limit: null, note: '', active: true };
    const beans = [...items].filter((it) => beanKgFrom(it, 1) !== null).sort((a, b) => (a.name < b.name ? -1 : 1));
    const r = await modal({
      title: s ? `修改品項：${x.name}` : '新增品項',
      wide: true,
      body: h`<div class="form-grid">
        <label class="field" style="grid-column:1/-1"><span>名稱</span><input type="text" name="name" value="${x.name}"></label>
        <label class="field"><span>售價（含稅）</span><input type="number" name="price" min="0" step="1" value="${x.price ?? ''}"></label>
        <label class="field"><span>熟豆每公斤（未稅，手填）</span><input type="number" name="bean_kg" min="0" step="any" value="${x.bean_kg ?? ''}"></label>
        <label class="field" style="grid-column:1/-1"><span>連到原物料（單位是 g 或 kg 的才能選；有進貨就用平均進價）</span><select name="item_id">${options([['', '不連結，用手填'], ...beans.map((it) => [it.id, `${it.name}（${it.unit}）`])], x.item_id)}</select></label>
        <label class="field"><span>預估銷售佔比（%）</span><input type="number" name="mix" min="0" step="any" value="${x.mix ?? 0}"></label>
        <label class="field"><span>限量（每週幾包，不限留空）</span><input type="number" name="weekly_limit" min="0" step="1" value="${x.weekly_limit ?? ''}"></label>
        <label class="field" style="grid-column:1/-1"><span>備註（豆名、產區、比例證明放哪）</span><input type="text" name="note" value="${x.note}"></label>
        <label class="row" style="grid-column:1/-1"><input type="checkbox" name="active" ${x.active !== false ? raw('checked') : ''}> 上架中</label>
      </div>`,
      actions: [
        ...(s ? [{ label: '刪除', danger: true, value: 'delete' }] : []),
        { label: '取消', value: null },
        {
          label: '儲存',
          primary: true,
          value: (dlg) => {
            const g = (k) => dlg.querySelector(`[name=${k}]`);
            const v = { ...x, name: g('name').value.trim(), price: num(g('price').value), bean_kg: num(g('bean_kg').value), item_id: g('item_id').value, mix: num(g('mix').value) ?? 0, weekly_limit: num(g('weekly_limit').value), note: g('note').value.trim(), active: g('active').checked };
            if (!v.name) return fail('請輸入名稱');
            if (!(v.price > 0)) return fail('請輸入售價');
            for (const [k, l] of [['bean_kg', '熟豆成本'], ['mix', '銷售佔比'], ['weekly_limit', '限量']]) if (v[k] !== null && !(v[k] >= 0)) return fail(`${l}需為 0 以上`);
            return { ...v, id: v.id || uid('s_') };
          },
        },
      ],
    });
    if (!r) return;
    if (r === 'delete') {
      const used = plan.gifts.filter((g) => g.items.some((it) => it.sku_id === s.id)).map((g) => g.name);
      if (!(await confirmBox(`刪除「${s.name}」？${used.length ? `禮盒「${used.join('、')}」有放這款，成本會缺。` : ''}`, { ok: '刪除', danger: true }))) return;
      return setAndSave(() => (plan.skus = plan.skus.filter((y) => y.id !== s.id)), '已刪除品項');
    }
    await setAndSave(() => (plan.skus = s ? plan.skus.map((y) => (y.id === r.id ? r : y)) : [...plan.skus, r]), `已儲存「${r.name}」`);
  }

  // ─────────── 禮盒

  function drawGift(body) {
    mount(
      body,
      h`<div class="toolbar"><span class="spacer" style="flex:1"></span><button class="btn primary" data-act="addGift">＋ 新增禮盒</button></div>
      ${
        plan.gifts.length
          ? h`<div class="db-gifts">${plan.gifts.map((g) => {
              const c = giftCost(g, plan.skus, plan.costs, { vatRate, beanKgOf });
              return h`<div class="card">
                <div class="card-head"><h2>${g.name}</h2><span class="spacer" style="flex:1"></span><b style="font-size:18px">${cash(g.price)}</b></div>
                <ul class="plain-list" style="margin:0 0 8px">
                  ${g.items.filter((it) => it.qty > 0).map((it) => h`<li>${skuName(it.sku_id)} × ${fmt(it.qty)}</li>`)}
                  ${g.extras.map((x) => h`<li class="muted">${x.name}（${cash(x.cost)}）</li>`)}
                </ul>
                <div class="bp-kv">
                  ${[
                    ['濾掛 ' + fmt(c.packs) + ' 包', cash1(c.contents)],
                    ['其他物品', cash1(c.extras)],
                    [`組裝人工（${fmt(g.minutes)} 分鐘）`, cash1(c.labor)],
                    ['刷卡手續費', cash1(c.fee)],
                    ['成本合計', cash1(c.total)],
                    ['未稅售價', cash1(c.net)],
                  ].map(([a, b]) => h`<div><span>${a}</span><span>${b}</span></div>`)}
                </div>
                <div class="stats" style="margin-top:10px">${stat('直接貢獻', cash(c.profit), c.rate === null ? '' : `貢獻率 ${pct(c.rate, 0)}`, c.rate !== null && c.rate >= 0.4 ? 'good' : 'warn')}</div>
                ${c.missing.length ? h`<p class="muted" style="font-size:12.5px">${c.missing.join('、')} 沒有成本，沒算進去。</p>` : ''}
                ${g.note ? h`<p style="font-size:13px;margin:6px 0 0">${g.note}</p>` : ''}
                <p style="margin:10px 0 0"><button class="btn sm" data-act="editGift" data-id="${g.id}">修改</button></p>
              </div>`;
            })}</div>
            <p class="muted" style="font-size:12.5px">直接貢獻＝未稅售價 − 濾掛（不含手續費的單包成本）− 其他物品 − 組裝人工 − 刷卡手續費；沒算廣告和寄送。同一個禮盒同一款只放同一批，吊牌的有效日期用這幾批裡最早的（「批次與效期」可以查）。</p>`
          : h`<div class="card">${emptyState('還沒有禮盒', '新增禮盒：售價、放哪幾款各幾包、其他物品（束口袋、卡片、杯子）的成本、組裝要幾分鐘。', h`<button class="btn primary" data-act="addGift">＋ 新增禮盒</button>`)}</div>`
      }`,
    );
  }

  async function editGift(g) {
    const x = g || { id: '', name: '', price: null, minutes: 5, items: [], extras: [], note: '' };
    const qtyOf = (id) => x.items.find((it) => it.sku_id === id)?.qty ?? '';
    const r = await modal({
      title: g ? `修改禮盒：${x.name}` : '新增禮盒',
      wide: true,
      body: h`<div class="form-grid">
        <label class="field" style="grid-column:1/-1"><span>名稱</span><input type="text" name="name" value="${x.name}"></label>
        <label class="field"><span>售價（含稅）</span><input type="number" name="price" min="0" step="1" value="${x.price ?? ''}"></label>
        <label class="field"><span>組裝（分鐘／份）</span><input type="number" name="minutes" min="0" step="any" value="${x.minutes ?? 0}"></label>
        <fieldset style="grid-column:1/-1;border:0;padding:0;margin:0"><legend class="muted" style="font-size:13px;margin-bottom:6px">放幾包</legend>
          <div class="form-grid">${plan.skus.map((s) => h`<label class="field"><span>${s.name}</span><input type="number" min="0" step="1" data-sku="${s.id}" value="${qtyOf(s.id)}"></label>`)}</div>
          ${plan.skus.length ? '' : h`<p class="muted">先到「單包與月試算」新增品項。</p>`}
        </fieldset>
        <label class="field" style="grid-column:1/-1"><span>其他物品，一行一個：「名稱 成本」（例如：束口袋 30）</span><textarea name="extras" rows="5">${x.extras.map((e) => `${e.name} ${e.cost}`).join('\n')}</textarea></label>
        <label class="field" style="grid-column:1/-1"><span>備註（加購、取貨方式）</span><input type="text" name="note" value="${x.note}"></label>
      </div>`,
      actions: [
        ...(g ? [{ label: '刪除', danger: true, value: 'delete' }] : []),
        { label: '取消', value: null },
        {
          label: '儲存',
          primary: true,
          value: (dlg) => {
            const gv = (k) => dlg.querySelector(`[name=${k}]`).value.trim();
            const extras = [];
            for (const line of gv('extras').split('\n').map((l) => l.trim()).filter(Boolean)) {
              const m = line.match(/^(.*?)[\s　]+(\d+(?:\.\d+)?)$/);
              if (!m || !m[1].trim()) return fail(`「${line}」看不懂，要寫成「名稱 成本」`);
              extras.push({ name: m[1].trim(), cost: Number(m[2]) });
            }
            const its = [...dlg.querySelectorAll('[data-sku]')].map((el) => ({ sku_id: el.dataset.sku, qty: num(el.value) ?? 0 }));
            if (its.some((it) => !(it.qty >= 0))) return fail('包數需為 0 以上');
            const v = { ...x, name: gv('name'), price: num(gv('price')), minutes: num(gv('minutes')) ?? 0, items: its.filter((it) => it.qty > 0), extras, note: gv('note') };
            if (!v.name) return fail('請輸入名稱');
            if (!(v.price > 0)) return fail('請輸入售價');
            if (!(v.minutes >= 0)) return fail('組裝分鐘需為 0 以上');
            return { ...v, id: v.id || uid('g_') };
          },
        },
      ],
    });
    if (!r) return;
    if (r === 'delete' && !(await confirmBox(`刪除「${g.name}」？`, { ok: '刪除', danger: true }))) return;
    await setAndSave(() => {
      if (r === 'delete') plan.gifts = plan.gifts.filter((y) => y.id !== g.id);
      else plan.gifts = g ? plan.gifts.map((y) => (y.id === r.id ? r : y)) : [...plan.gifts, r];
    }, r === 'delete' ? '已刪除禮盒' : `已儲存「${r.name}」`);
  }

  // ─────────── 試製到開賣

  function drawPlan(body) {
    const st = scheduleStatus(plan.schedule, day);
    const left = plan.launch_date ? daysBetween(day, plan.launch_date) : null;
    const dates = [...new Set(plan.schedule.map((t) => t.date))].sort();
    mount(
      body,
      h`<div class="toolbar">
        <label class="field"><span>試製日</span><input type="date" data-act="trialDate" value="${plan.trial_date}"></label>
        <label class="field"><span>開賣日</span><input type="date" data-act="launchDate" value="${plan.launch_date}"></label>
        <button class="btn" data-act="rebuild">${plan.schedule.length ? '依範本重排' : '依範本產生進度表'}</button>
        <span class="spacer" style="flex:1"></span>
        <button class="btn primary" data-act="addTask">＋ 新增事項</button>
      </div>
      ${
        plan.schedule.length
          ? h`<div class="stats">
            ${stat('完成', `${st.done}／${st.total}`, pct(st.ratio, 0), st.ratio === 1 ? 'good' : '')}
            ${stat('逾期', fmt(st.overdue.length), st.overdue.length ? st.overdue.map((t) => t.title.slice(0, 14)).slice(0, 2).join('、') : '沒有', st.overdue.length ? 'bad' : 'good')}
            ${stat('下一件', st.next ? md(st.next.date) : '—', st.next ? `${st.next.owner}：${st.next.title.slice(0, 24)}` : '全部完成')}
            ${stat('距離開賣', left === null ? '—' : left > 0 ? `${left} 天` : left === 0 ? '今天' : '已開賣', plan.launch_date ? md(plan.launch_date) : '還沒設開賣日')}
          </div>
          <div class="bp-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${st.total}" aria-valuenow="${st.done}"><i style="width:${(st.ratio * 100).toFixed(1)}%"></i></div>
          <div class="card">${dates.map(
            (dt) => h`<div class="bp-day ${dt === plan.launch_date ? 'launch' : ''}">
              <div class="bp-day-head"><b>${md(dt)}</b>${dt === day ? badge('今天', 'accent') : ''}${dt === plan.trial_date ? badge('試製', 'medium') : ''}${dt === plan.launch_date ? badge('開賣', 'high') : ''}</div>
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
          : h`<div class="card">${emptyState('還沒有進度表', '選試製日與開賣日，按「依範本產生進度表」：業者登錄與保險、包材、研磨刻度、封口測試、試製批與留樣、三個關卡、開賣、第 14／30 天留樣檢查，每一件都有負責人與完成標準。', '')}</div>`
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
        <label class="field"><span>負責</span><select name="owner">${options([...new Set([...OWNERS, x.owner].filter(Boolean))].map((o) => [o, o]), x.owner)}</select></label>
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
      else plan.schedule = (t ? plan.schedule.map((x2) => (x2.id === r.id ? r : x2)) : [...plan.schedule, r]).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    }, r === 'delete' ? '已刪除事項' : '已儲存進度表');
  }

  // ─────────── 批次與效期

  function drawBatch(body) {
    const ext = canExtend(plan);
    const checks = sampleChecks(plan.batches, day);
    const due = checks.filter((c) => !c.rec && c.due <= addDays(day, 3));
    const list = [...plan.batches].reverse();
    const tone = { expired: 'bad', soon: 'warn', ok: 'good', na: 'na' };
    const label = (st) => (st.kind === 'expired' ? `已過期 ${-st.left} 天` : st.kind === 'soon' ? (st.left === 0 ? '今天到期' : `${st.left} 天內到期`) : st.kind === 'ok' ? `還有 ${st.left} 天` : '—');
    mount(
      body,
      h`<div class="grid-2">
        <div class="card">
          <div class="card-head"><h2>有效日期</h2></div>
          <p style="margin:0 0 8px">新批次預設 <b>製造日＋${fmt(plan.shelf.days)} 天</b>。已經建好的批次照建立時的天數，不會跟著改。</p>
          <div class="form-grid">
            <label class="field"><span>目前天數</span><input type="number" min="1" step="1" data-act="shelf" data-k="days" value="${plan.shelf.days}"></label>
            <label class="field"><span>延長後天數</span><input type="number" min="1" step="1" data-act="shelf" data-k="extended_days" value="${plan.shelf.extended_days}"></label>
          </div>
          <label class="row" style="margin-top:8px"><input type="checkbox" data-act="specOk" ${plan.shelf.spec_ok ? raw('checked') : ''}> 外袋阻隔（阻氧、阻濕）規格書已拿到</label>
          <div style="margin-top:10px">${ext.ok ? h`${status('good', '留樣第 30 天合格、規格書到手，可以延長')} <button class="btn sm" data-act="extend" ${plan.shelf.days >= plan.shelf.extended_days ? raw('disabled') : ''}>改成 ${fmt(plan.shelf.extended_days)} 天</button>` : status('warn', `還不能延長：${!ext.passed ? '還沒有留樣第 30 天合格的批次' : ''}${!ext.passed && !ext.spec ? '、' : ''}${!ext.spec ? '外袋規格書還沒到' : ''}`)}</div>
        </div>
        <div class="card">
          <div class="card-head"><h2>留樣檢查</h2><span class="card-note">第 ${CHECK_DAYS.join('／')} 天：重量、結塊、外袋、風味</span></div>
          ${
            checks.length
              ? h`<div class="db-checks">${checks.map(
                  (c) => h`<div class="db-check ${c.overdue ? 'late' : ''}">
                    <span><b>${c.code}</b> 第 ${c.day} 天 · ${md(c.due)}</span>
                    <span>${c.rec ? status(c.rec.result === 'pass' ? 'good' : c.rec.result === 'fail' ? 'bad' : 'na', c.rec.result === 'pass' ? '合格' : c.rec.result === 'fail' ? '不合格' : '已記') : c.overdue ? status('bad', '逾期沒記') : due.includes(c) ? status('warn', '快到了') : status('na', '還沒到')}
                    <button class="btn sm ghost" data-act="check" data-id="${c.batch_id}" data-day="${c.day}">${c.rec ? '修改' : '記錄'}</button></span>
                  </div>`,
                )}</div>`
              : h`<p class="muted">建批次時填「留樣幾包」，這裡就會列出要檢查的日子。</p>`
          }
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>批次</h2><span class="spacer" style="flex:1"></span><button class="btn primary" data-act="addBatch">＋ 新增批次</button></div>
        ${
          list.length
            ? h`<div class="table-wrap"><table class="grid">
              <thead><tr><th scope="col">批號</th><th scope="col">品項</th><th scope="col">用途</th><th scope="col">製造日</th><th scope="col" class="num">包數</th><th scope="col">有效日期</th><th scope="col">狀態</th><th scope="col">封口抽驗</th><th scope="col"></th></tr></thead>
              <tbody>${list.map((b) => {
                const st = batchStatus(b, day, { soonDays: plan.rules.soon_days });
                return h`<tr>
                  <th scope="row" style="text-align:left">${b.code}</th>
                  <td>${skuName(b.sku_id)}</td>
                  <td>${PURPOSE[b.purpose]}</td>
                  <td>${md(b.date)}</td>
                  <td class="num">${fmt(b.packs)}${b.retained ? h`<div class="muted" style="font-size:11.5px">留樣 ${fmt(b.retained)}</div>` : ''}</td>
                  <td>${md(st.expiry)}<div class="muted" style="font-size:11.5px">＋${fmt(b.shelf_days)} 天</div></td>
                  <td>${b.purpose === 'trial' ? status('na', `不販售 · ${label(st)}`) : status(tone[st.kind], label(st))}</td>
                  <td>${b.qc === 'pass' ? status('good', '合格') : b.qc === 'fail' ? status('bad', '不合格') : status('na', '沒記')}</td>
                  <td style="white-space:nowrap"><button class="btn sm" data-act="editBatch" data-id="${b.id}">修改</button></td>
                </tr>`;
              })}</tbody></table></div>`
            : emptyState('還沒有批次', '每包一批就記一筆：製造日、品項、包數、研磨刻度、封口時間、留樣幾包、封口抽驗結果。有效日期自動算；過期與快到期會標出來。', h`<button class="btn primary" data-act="addBatch">＋ 新增批次</button>`)
        }
        <p class="muted" style="font-size:12.5px;margin:8px 0 0">封口抽驗不合格的批次不要上架。禮盒預留的批次和架上販售的分開放，不算進 POS 剩餘數量。</p>
      </div>`,
    );
  }

  async function editBatch(b) {
    const date0 = b?.date || day;
    const x = b || { id: '', code: nextBatchCode(plan.batches, date0), date: date0, sku_id: plan.skus[0]?.id || '', packs: null, purpose: 'sale', shelf_days: plan.shelf.days, retained: 0, grind: '', seal: '', qc: '', checks: [], note: '' };
    if (!plan.skus.length) return toast('先到「單包與月試算」新增品項', 'error');
    const r = await modal({
      title: b ? `修改批次 ${x.code}` : '新增批次',
      wide: true,
      body: h`<div class="form-grid">
        <label class="field"><span>批號</span><input type="text" name="code" value="${x.code}"></label>
        <label class="field"><span>製造日</span><input type="date" name="date" value="${x.date}"></label>
        <label class="field"><span>品項</span><select name="sku_id">${options(plan.skus.map((s) => [s.id, s.name]), x.sku_id)}</select></label>
        <label class="field"><span>用途</span><select name="purpose">${options(Object.entries(PURPOSE), x.purpose)}</select></label>
        <label class="field"><span>包數</span><input type="number" name="packs" min="1" step="1" value="${x.packs ?? ''}"></label>
        <label class="field"><span>留樣（包）</span><input type="number" name="retained" min="0" step="1" value="${x.retained ?? 0}"></label>
        <label class="field"><span>有效天數（製造日＋）</span><input type="number" name="shelf_days" min="1" step="1" value="${x.shelf_days ?? plan.shelf.days}"></label>
        <label class="field"><span>封口抽驗</span><select name="qc">${options([['', '還沒驗'], ['pass', '合格'], ['fail', '不合格']], x.qc)}</select></label>
        <label class="field"><span>研磨刻度</span><input type="text" name="grind" value="${x.grind}"></label>
        <label class="field"><span>封口時間／溫度</span><input type="text" name="seal" value="${x.seal}"></label>
        <label class="field" style="grid-column:1/-1"><span>備註（烘焙日、環境濕度、試喝意見）</span><input type="text" name="note" value="${x.note}"></label>
      </div>`,
      actions: [
        ...(b ? [{ label: '刪除', danger: true, value: 'delete' }] : []),
        { label: '取消', value: null },
        {
          label: '儲存',
          primary: true,
          value: (dlg) => {
            const g = (k) => dlg.querySelector(`[name=${k}]`).value.trim();
            const v = { ...x, code: g('code'), date: g('date'), sku_id: g('sku_id'), purpose: g('purpose'), packs: num(g('packs')), retained: num(g('retained')) ?? 0, shelf_days: num(g('shelf_days')), qc: g('qc'), grind: g('grind'), seal: g('seal'), note: g('note') };
            if (!/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return fail('請選製造日');
            if (!(v.packs > 0)) return fail('請輸入包數');
            if (!(v.shelf_days > 0)) return fail('請輸入有效天數');
            if (!(v.retained >= 0) || v.retained > v.packs) return fail('留樣需在 0 到包數之間');
            if (!v.code) v.code = nextBatchCode(plan.batches, v.date);
            if (plan.batches.some((y) => y.code === v.code && y.id !== x.id)) return fail(`批號「${v.code}」已經有了`);
            return { ...v, id: v.id || uid('b_') };
          },
        },
      ],
    });
    if (!r) return;
    if (r === 'delete' && !(await confirmBox(`刪除批次「${b.code}」？留樣紀錄也會一起刪掉。`, { ok: '刪除', danger: true }))) return;
    await setAndSave(() => {
      if (r === 'delete') plan.batches = plan.batches.filter((y) => y.id !== b.id);
      else plan.batches = (b ? plan.batches.map((y) => (y.id === r.id ? r : y)) : [...plan.batches, r]).sort((a, c) => (a.date < c.date ? -1 : a.date > c.date ? 1 : 0));
    }, r === 'delete' ? '已刪除批次' : `已儲存批次 ${r.code}`);
  }

  async function editCheck(batchId, d) {
    const b = plan.batches.find((y) => y.id === batchId);
    if (!b) return;
    const c = b.checks.find((y) => y.day === d) || { day: d, date: day, result: '', note: '' };
    const r = await modal({
      title: `留樣 ${b.code} 第 ${d} 天`,
      body: h`<div class="form-grid">
        <label class="field"><span>檢查日</span><input type="date" name="date" value="${c.date || day}"></label>
        <label class="field"><span>結果（重量、結塊、外袋、風味都要看）</span><select name="result">${options([['', '還沒判斷'], ['pass', '四項都合格'], ['fail', '有一項不合格']], c.result)}</select></label>
        <label class="field" style="grid-column:1/-1"><span>紀錄（重量幾克、杯測描述）</span><input type="text" name="note" value="${c.note}"></label>
      </div>`,
      actions: [
        { label: '取消', value: null },
        { label: '儲存', primary: true, value: (dlg) => ({ day: d, date: dlg.querySelector('[name=date]').value, result: dlg.querySelector('[name=result]').value, note: dlg.querySelector('[name=note]').value.trim() }) },
      ],
    });
    if (!r) return;
    await setAndSave(() => (plan.batches = plan.batches.map((y) => (y.id === b.id ? { ...y, checks: [...y.checks.filter((z) => z.day !== d), r].sort((p, q) => p.day - q.day) } : y))), '已記下留樣檢查');
  }

  // ─────────── 銷售對照

  async function drawSales(body) {
    const from = plan.launch_date;
    const to = day;
    const lines = from && from <= day ? await revenueLines({ from, to }) : [];
    const days = posDrip(lines, { from, to, keywords: plan.keywords });
    const v = salesVerdict(days, { launch: from, today: day, rules: plan.rules });
    const by = new Map(days.map((d) => [d.date, d]));
    const shown = from && from <= day ? eachDay(from, day).reverse() : [];
    const total = days.reduce((a, d) => a + d.packs, 0);
    const orders = days.reduce((a, d) => a + d.orders, 0);
    const dripOrders = days.reduce((a, d) => a + d.dripOrders, 0);
    const [tone, label] = VERDICT[v.verdict];
    const R = plan.rules;
    mount(
      body,
      h`<div class="toolbar">
        <label class="field" style="min-width:220px"><span>POS 品名或品類關鍵字（逗號分開）</span><input type="text" data-act="keywords" value="${plan.keywords}"></label>
        <label class="field"><span>目標（包／天）</span><input type="number" min="0" step="any" data-act="rule" data-k="target_per_day" value="${R.target_per_day}"></label>
        <label class="field"><span>停止線（包／天）</span><input type="number" min="0" step="any" data-act="rule" data-k="stop_per_day" value="${R.stop_per_day}"></label>
        <label class="field"><span>看幾天再判斷</span><input type="number" min="1" step="1" data-act="rule" data-k="review_days" value="${R.review_days}"></label>
      </div>
      <div class="stats">
        ${stat('判斷', status(tone, label), v.verdict === 'collecting' ? `開賣第 ${v.elapsed} 天，滿 ${R.review_days} 天才下結論` : from ? `開賣日 ${md(from)}` : '到「試製到開賣」設開賣日')}
        ${stat('平均每天', v.avg === null ? '—' : `${v.avg.toFixed(1)} 包`, `目標 ${fmt(R.target_per_day)}、停止線 ${fmt(R.stop_per_day)}`, v.avg === null ? '' : v.avg >= R.target_per_day ? 'good' : v.avg < R.stop_per_day ? 'bad' : 'warn')}
        ${stat('開賣以來', `${fmt(total)} 包`, cash(days.reduce((a, d) => a + d.revenue, 0)))}
        ${stat('附購率', orders ? pct(dripOrders / orders, 1) : '—', '有買濾掛的單 ÷ 全部單')}
      </div>
      <div class="card">
        ${
          shown.length
            ? h`<div class="table-wrap"><table class="grid"><thead><tr><th scope="col">日期</th><th scope="col" class="num">包數</th><th scope="col" class="num">營收（含稅）</th><th scope="col" class="num">附購率</th></tr></thead>
              <tbody>${shown.map((dt) => {
                const d = by.get(dt);
                return h`<tr><th scope="row" style="text-align:left">${md(dt)}</th><td class="num">${d ? fmt(d.packs) : h`<span class="muted">沒有 POS 資料</span>`}</td><td class="num">${d ? cash(d.revenue) : '—'}</td><td class="num">${d && d.orders ? pct(d.attach, 1) : '—'}</td></tr>`;
              })}</tbody></table></div>`
            : emptyState(from ? '還沒開賣' : '還沒設開賣日', '開賣後到「資料匯入」匯入 POS 銷售明細，這裡會照關鍵字算每天賣幾包、附購率。5 入在 POS 打 5 個單包，照數量算。', '')
        }
        <p class="muted" style="font-size:12.5px;margin:8px 0 0">沒有 POS 資料的日子也算進天數（平均會被拉低），請記得每天匯入。作廢、招待、測試和售價 0 的不算。</p>
      </div>`,
    );
  }

  const unbind = bindActions(root, {
    tab: (el) => {
      f.tab = el.dataset.tab;
      ctx.setParams({ tab: f.tab });
      draw();
    },
    param: (el) => {
      const v = num(el.value);
      const g = el.dataset.group;
      const fd = (g === 'costs' ? COST_FIELDS : MONTH_FIELDS).find((x) => x.key === el.dataset.k);
      if (v === null || !(v >= 0) || !fd || v > fd.max) {
        el.value = plan[g][el.dataset.k];
        return toast(`需為 0 到 ${fmt(fd?.max ?? 0)} 之間的數字`, 'error');
      }
      return setAndSave(() => (plan[g] = { ...plan[g], [el.dataset.k]: v }), '');
    },
    addSku: () => editSku(null),
    editSku: (el) => editSku(plan.skus.find((s) => s.id === el.dataset.id)),
    addGift: () => editGift(null),
    editGift: (el) => editGift(plan.gifts.find((g) => g.id === el.dataset.id)),
    trialDate: (el) => setAndSave(() => (plan.trial_date = el.value), '已儲存試製日'),
    launchDate: (el) => setAndSave(() => (plan.launch_date = el.value), '已儲存開賣日'),
    rebuild: async () => {
      if (!plan.trial_date || !plan.launch_date) return toast('先選試製日和開賣日', 'error');
      if (plan.launch_date < plan.trial_date) return toast('開賣日不能早於試製日', 'error');
      if (plan.schedule.length && !(await confirmBox('依範本重排會換掉現在的進度表（包含已勾完成的），確定？', { ok: '重排', danger: true }))) return;
      await setAndSave(() => (plan.schedule = buildSchedule(plan.trial_date, plan.launch_date)), '已產生進度表');
    },
    addTask: () => editTask(null),
    editTask: (el) => editTask(plan.schedule.find((t) => t.id === el.dataset.id)),
    toggleTask: (el) => setAndSave(() => (plan.schedule = plan.schedule.map((t) => (t.id === el.dataset.id ? { ...t, done: el.checked } : t))), el.checked ? '完成一件' : ''),
    shelf: (el) => {
      const v = num(el.value);
      if (!(v >= 1)) return toast('天數需為 1 以上', 'error');
      return setAndSave(() => (plan.shelf = { ...plan.shelf, [el.dataset.k]: Math.round(v) }), '已儲存效期設定');
    },
    specOk: (el) => setAndSave(() => (plan.shelf = { ...plan.shelf, spec_ok: el.checked }), ''),
    extend: async () => {
      if (!canExtend(plan).ok) return toast('留樣第 30 天合格、規格書到手才能延長', 'error');
      if (!(await confirmBox(`之後新建的批次改成製造日＋${plan.shelf.extended_days} 天？已經建好的批次不會改。記得同時更新標籤和有效日期訂定紀錄。`, { ok: '延長' }))) return;
      await setAndSave(() => (plan.shelf = { ...plan.shelf, days: plan.shelf.extended_days }), '已延長有效天數');
    },
    addBatch: () => editBatch(null),
    editBatch: (el) => editBatch(plan.batches.find((b) => b.id === el.dataset.id)),
    check: (el) => editCheck(el.dataset.id, Number(el.dataset.day)),
    keywords: (el) => setAndSave(() => (plan.keywords = el.value.trim()), ''),
    rule: (el) => {
      const v = num(el.value);
      if (v === null || !(v >= 0) || (el.dataset.k === 'review_days' && !(v >= 1))) {
        el.value = plan.rules[el.dataset.k];
        return toast('數字不對', 'error');
      }
      return setAndSave(() => (plan.rules = { ...plan.rules, [el.dataset.k]: el.dataset.k === 'review_days' ? Math.round(v) : v }), '');
    },
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
      if (!next.skus.length && !next.schedule.length) return toast('企劃檔裡沒有品項也沒有進度表', 'error');
      const fileBatches = next.batches.length;
      const r = await modal({
        title: `匯入「${next.name}」`,
        body: h`<p>會換掉品項（${next.skus.length} 款）、禮盒（${next.gifts.length} 個）、進度表（${next.schedule.length} 件）、成本參數與效期設定。</p>
          <p>批次與留樣紀錄是現場記的，<b>預設不會被刪</b>${plan.batches.length ? `：現有 ${plan.batches.length} 批保留，檔案裡同一批號的不會蓋過去` : ''}${fileBatches ? `；檔案裡有 ${fileBatches} 批，只補沒有的批號` : ''}。</p>
          ${chk.warnings.length ? h`<div class="callout warn" style="margin:8px 0"><p><b>會略過：</b></p><ul class="plain-list">${chk.warnings.map((w) => h`<li>${w}</li>`)}</ul></div>` : ''}
          ${plan.batches.length ? h`<label class="row" style="margin-top:8px"><input type="checkbox" name="replaceBatches"> 連批次紀錄一起換成檔案裡的（現有 ${plan.batches.length} 批會被刪掉）</label>` : ''}`,
        actions: [
          { label: '取消', value: null },
          { label: '匯入', primary: true, value: (dlg) => ({ replaceBatches: !!dlg.querySelector('[name=replaceBatches]')?.checked }) },
        ],
      });
      if (!r) return;
      if (r.replaceBatches && !(await confirmBox(`真的要刪掉現有 ${plan.batches.length} 批的紀錄？`, { ok: '刪掉並匯入', danger: true }))) return;
      await setAndSave(() => (plan = mergeImport(plan, next, r)), `已匯入「${next.name}」：${next.skus.length} 款、${next.gifts.length} 個禮盒、${next.schedule.length} 件事`);
    },
  });

  draw();
  return () => {
    unbind();
    root.removeEventListener('keydown', onTabKey);
  };
}
