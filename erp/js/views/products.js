// 品項整併：找出 POS 與進銷存系統迭代後「名稱不同、其實同一商品」的品項，勾選確認後合併。

import { h, raw, mount, bindActions, dataTable, toast, modal, options, fmt, stat, badge, downloadCSV, emptyState, confirmBox } from '../ui.js';
import { store } from '../store.js';
import { today } from '../lib/dates.js';
import { getProductIndex, mergeProducts, unmapAlias, getSettings } from '../state.js';
import { analyzeDuplicates, pairKey, aliasKey } from '../lib/dedupe.js';
import { CATEGORIES, guessCategory } from '../lib/pos.js';
import { syncSales } from '../sync.js';

const CONF = { high: ['高度疑似', 'high'], medium: ['中度疑似', 'medium'], low: ['低度疑似', 'low'] };

let syncTimer = null;
function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncSales().catch((e) => console.error(e)), 800);
}

export async function render(root, ctx) {
  const state = {
    tab: ctx.params.tab || 'dup',
    threshold: Number(ctx.params.th) || 0.7,
    q: '',
    checks: new Map(), // `${clusterId}|${key}` → 使用者手動勾選狀態
    names: {}, // 群組自訂標準名稱
    cats: {},
    selected: new Set(), // 全部品名頁勾選
  };
  let lines = await store.all('sales_lines');
  const settings = await getSettings();
  let analysis = null;
  let idx = null;

  async function analyze() {
    idx = await getProductIndex();
    const notSame = new Set((await store.all('product_not_same')).map((r) => r.id));
    analysis = analyzeDuplicates(lines, { aliases: idx.aliasToProductId, notSame, threshold: state.threshold });
  }

  function productOfKey(key) {
    const pid = idx.aliasToProductId.get(key);
    return pid ? idx.byId.get(pid) : null;
  }

  function filteredClusters(type) {
    const q = state.q.trim().toLowerCase();
    return analysis.clusters.filter((c) => c.type === type && (!q || c.members.some((m) => m.spellings.some((s) => s.toLowerCase().includes(q)))));
  }

  function draw() {
    if (!lines.length) {
      mount(root, h`<div class="card">${emptyState('還沒有銷售資料', '先到「匯入中心」匯入 POS 銷售明細 CSV，系統會自動比對疑似同一商品的不同名稱。', h`<a class="btn primary" href="#/import">前往匯入</a>`)}</div>`);
      return;
    }
    const dups = filteredClusters('duplicate');
    const vars = filteredClusters('variant');
    const mapped = analysis.names.filter((n) => idx.aliasToProductId.has(n.key)).length;
    const byConf = (c) => dups.filter((x) => x.confidence === c).length;
    mount(
      root,
      h`<div class="stats">
        ${stat('品名數（去除空白／全半形差異）', fmt(analysis.names.length), analysis.autoMerged.length ? `其中 ${analysis.autoMerged.length} 個僅格式不同，已自動視為同名` : '')}
        ${stat('疑似同品項群組', fmt(dups.length), `高 ${byConf('high')}・中 ${byConf('medium')}・低 ${byConf('low')}`)}
        ${stat('冰熱／容量變體群組', fmt(vars.length), '核心名稱相同')}
        ${stat('已整併的品名', `${fmt(mapped)} / ${fmt(analysis.names.length)}`, `標準品項 ${fmt(idx.products.length)} 個`)}
      </div>
      <div class="card">
        <div class="toolbar">
          <label class="field"><span>比對門檻（越低列出越多）</span><input type="range" min="0.55" max="0.95" step="0.05" value="${state.threshold}" data-act="th" data-on="change"><span class="muted">${Math.round(state.threshold * 100)}%</span></label>
          <label class="field"><span>搜尋品名</span><input type="search" value="${state.q}" data-act="q" data-on="input" placeholder="例如：拿鐵"></label>
          <span class="spacer"></span>
          <button class="btn" data-act="exportPairs">匯出疑似清單</button>
          <button class="btn" data-act="exportMap">匯出品項對照表</button>
        </div>
        <div class="tabs" role="tablist">
          ${[
            ['dup', `疑似同品項（${dups.length}）`],
            ['var', `冰熱／容量變體（${vars.length}）`],
            ['all', `全部品名（${analysis.names.length}）`],
            ['master', `標準品項（${idx.products.length}）`],
          ].map(([k, l]) => h`<button role="tab" aria-selected="${state.tab === k}" class="${state.tab === k ? 'on' : ''}" data-act="tab" data-tab="${k}">${l}</button>`)}
        </div>
        <div id="tab-body"></div>
      </div>`,
    );
    const body = root.querySelector('#tab-body');
    if (state.tab === 'dup') drawClusters(body, dups, '沒有找到疑似重複的品名。可以把門檻調低再看看。');
    else if (state.tab === 'var') drawClusters(body, vars, '沒有冰熱／容量變體。', true);
    else if (state.tab === 'all') drawAll(body);
    else drawMaster(body);
  }

  function drawClusters(body, clusters, emptyText, isVariant = false) {
    if (!clusters.length) {
      mount(body, h`<p class="muted" style="padding:16px 4px">${emptyText}</p>`);
      return;
    }
    const intro = isVariant
      ? h`<div class="callout" style="margin-bottom:12px"><p>這些品名只差在冰／熱、大小杯或甜冰度。若想在報表中視為同一商品（例如「冰美式」「熱美式」都算「美式」），就合併；若售價、配方不同想分開分析，按「不是同一品項」。</p></div>`
      : h`<div class="callout" style="margin-bottom:12px"><p>系統依<b>名稱相似度</b>、<b>售價</b>、<b>販售期間是否前後接續（改名）</b>與<b>品類</b>判斷。確認後按「合併選取」，之後所有報表都以標準名稱統計；判斷錯誤就按「不是同一品項」，下次不再提示。</p></div>`;
    mount(body, h`${intro}${clusters.map((c) => clusterCard(c))}`);
  }

  // 預設勾選：與群組內其他品名的最高相似分數 ≥ 85% 者；分數較低者（例如只是包含同一個字）預設不勾，避免一鍵誤併
  function bestScore(c, key) {
    return c.pairs.filter((p) => p.a === key || p.b === key).reduce((m, p) => Math.max(m, p.score), 0);
  }
  function isChecked(c, key) {
    const k = `${c.id}|${key}`;
    return state.checks.has(k) ? state.checks.get(k) : bestScore(c, key) >= 0.85;
  }

  function clusterCard(c) {
    const [confLabel, confTone] = CONF[c.confidence];
    const name = state.names[c.id] ?? (c.existingProduct ? idx.byId.get(c.existingProduct)?.name : c.suggestedName);
    const cat = state.cats[c.id] ?? (c.existingProduct ? idx.byId.get(c.existingProduct)?.category : c.suggestedCat);
    const reasons = [...new Set(c.pairs.flatMap((p) => p.reasons))].slice(0, 6);
    return h`<div class="cluster">
      <div class="cluster-head">
        ${badge(`${confLabel} ${Math.round(c.score * 100)}%`, confTone)}
        <h3>${c.members.map((m) => m.name).join('　／　')}</h3>
      </div>
      <div class="members">${c.members.map((m) => {
        const key = `${c.id}|${m.key}`;
        const p = productOfKey(m.key);
        const low = bestScore(c, m.key) < 0.85;
        return h`<label class="member">
          <input type="checkbox" data-act="toggle" data-k="${key}" ${isChecked(c, m.key) ? raw('checked') : ''}>
          <span><span class="nm">${m.name}</span>${low ? h` <span class="badge low">相似度較低，請確認</span>` : ''}${m.spellings.length > 1 ? h` <span class="muted">（另寫作 ${m.spellings.filter((s) => s !== m.name).join('、')}）</span>` : ''}${p ? h` ${badge('已歸入「' + p.name + '」', 'accent')}` : ''}</span>
          <span class="meta">${m.first.slice(5)}～${m.last.slice(5)}</span>
          <span class="meta">${fmt(m.qty)} 份</span>
          <span class="meta">均價 ${m.avgPrice ? '$' + fmt(Math.round(m.avgPrice)) : '—'}</span>
          <span class="meta">${m.rawCat || CATEGORIES[m.guessCat]}</span>
        </label>`;
      })}</div>
      <div class="reasons">${reasons.map((r) => h`<span>${r}</span>`)}</div>
      <div class="merge-bar">
        <input type="text" value="${name}" data-act="name" data-on="input" data-id="${c.id}" aria-label="標準名稱">
        <select data-act="cat" data-id="${c.id}" aria-label="品類">${options(Object.entries(CATEGORIES), cat)}</select>
        <button class="btn primary sm" data-act="merge" data-id="${c.id}">合併選取</button>
        <button class="btn sm" data-act="notSame" data-id="${c.id}">不是同一品項</button>
      </div>
    </div>`;
  }

  function drawAll(body) {
    const q = state.q.trim().toLowerCase();
    const rows = analysis.names
      .filter((n) => !q || n.spellings.some((s) => s.toLowerCase().includes(q)))
      .map((n) => {
        const p = productOfKey(n.key);
        return { ...n, product: p?.name || '', category: p?.category || n.guessCat };
      });
    mount(
      body,
      h`<div class="row" style="margin-bottom:10px">
        <span class="muted">勾選多個品名後可手動合併</span><span class="spacer"></span>
        <span class="muted">已選 ${state.selected.size} 個</span>
        <button class="btn primary sm" data-act="mergeSelected" ${state.selected.size >= 1 ? '' : raw('disabled')}>合併／設定品項</button>
        <button class="btn sm" data-act="clearSel" ${state.selected.size ? '' : raw('disabled')}>清除勾選</button>
      </div><div id="all-table"></div>`,
    );
    dataTable(body.querySelector('#all-table'), {
      rows,
      pageSize: 200,
      exportName: '全部品名.csv',
      columns: [
        { key: 'key', label: '', nosort: true, fmt: (v) => h`<input type="checkbox" data-act="sel" data-k="${v}" ${state.selected.has(v) ? raw('checked') : ''} aria-label="選取">`, csv: () => '' },
        { key: 'name', label: 'POS 品名', fmt: (v, r) => h`${v}${r.spellings.length > 1 ? h`<div class="muted" style="font-size:12px">${r.spellings.filter((s) => s !== v).join('、')}</div>` : ''}` },
        { key: 'product', label: '標準品項', fmt: (v) => v || h`<span class="muted">未整併</span>` },
        { key: 'category', label: '品類', fmt: (v) => CATEGORIES[v] || v },
        { key: 'first', label: '首次販售' },
        { key: 'last', label: '最後販售' },
        { key: 'qty', label: '數量', align: 'num', fmt: (v) => fmt(v) },
        { key: 'avgPrice', label: '均價', align: 'num', fmt: (v) => (v ? fmt(Math.round(v)) : '—') },
        { key: 'amount', label: '金額', align: 'num', fmt: (v) => fmt(v) },
        { key: 'voidQty', label: '作廢數', align: 'num', fmt: (v) => (v ? fmt(v) : '') },
      ],
      initialSort: { key: 'amount', dir: -1 },
    });
  }

  function drawMaster(body) {
    const aliases = new Map();
    for (const [k, pid] of idx.aliasToProductId) {
      if (!aliases.has(pid)) aliases.set(pid, []);
      aliases.get(pid).push(k);
    }
    const nameByKey = new Map(analysis.names.map((n) => [n.key, n]));
    const rows = idx.products.map((p) => {
      const keys = aliases.get(p.id) || [];
      const ns = keys.map((k) => nameByKey.get(k)).filter(Boolean);
      return { ...p, aliases: keys, aliasNames: ns.map((n) => n.name), qty: ns.reduce((t, n) => t + n.qty, 0), amount: ns.reduce((t, n) => t + n.amount, 0) };
    });
    mount(body, h`<div id="master-table"></div>`);
    dataTable(body.querySelector('#master-table'), {
      rows,
      empty: '尚未建立標準品項。在「疑似同品項」合併，或在「全部品名」勾選後設定。',
      exportName: '標準品項.csv',
      columns: [
        { key: 'name', label: '標準品項', fmt: (v, r) => h`<b>${v}</b> <button class="btn sm ghost" data-act="rename" data-id="${r.id}">改名</button>` },
        { key: 'category', label: '品類', fmt: (v, r) => h`<select data-act="setCat" data-id="${r.id}">${options(Object.entries(CATEGORIES), v)}</select>`, csv: (v) => CATEGORIES[v] || v },
        { key: 'aliasNames', label: 'POS 上的名稱', fmt: (v, r) => h`${r.aliases.map((k, i) => h`<span class="badge" style="margin:2px">${v[i] || k} <button class="icon-btn" style="font-size:12px;padding:0 2px" data-act="unmap" data-k="${k}" title="移出">✕</button></span>`)}`, csv: (v) => v.join('、') },
        { key: 'qty', label: '累計數量', align: 'num', fmt: (v) => fmt(v) },
        { key: 'amount', label: '累計金額', align: 'num', fmt: (v) => fmt(v) },
      ],
      initialSort: { key: 'amount', dir: -1 },
    });
  }

  async function doMerge(keys, name, category, excludedKeys = []) {
    const rawNames = keys.flatMap((k) => analysis.names.find((n) => n.key === k)?.spellings || []);
    const existingIds = [...new Set(keys.map((k) => idx.aliasToProductId.get(k)).filter(Boolean))];
    await mergeProducts(rawNames, { name, category, productId: existingIds[0] });
    // 使用者取消勾選的品名：記為「不是同一品項」
    if (excludedKeys.length) {
      const now = new Date().toISOString();
      await store.put('product_not_same', excludedKeys.flatMap((x) => keys.map((k) => ({ id: pairKey(x, k), a: x, b: k, updated_at: now }))));
    }
    scheduleSync();
  }

  const unbind = bindActions(root, {
    tab: (el) => {
      state.tab = el.dataset.tab;
      ctx.setParams({ tab: state.tab });
      draw();
    },
    th: async (el) => {
      state.threshold = Number(el.value);
      ctx.setParams({ th: state.threshold });
      await analyze();
      draw();
    },
    q: (el) => {
      state.q = el.value;
      const pos = el.selectionStart;
      draw();
      const box = root.querySelector('[data-act="q"]');
      box.focus();
      box.setSelectionRange(pos, pos);
    },
    toggle: (el) => {
      state.checks.set(el.dataset.k, el.checked);
    },
    name: (el) => {
      state.names[el.dataset.id] = el.value;
    },
    cat: (el) => {
      state.cats[el.dataset.id] = el.value;
    },
    merge: async (el) => {
      const c = analysis.clusters.find((x) => x.id === el.dataset.id);
      const keys = c.keys.filter((k) => isChecked(c, k));
      const excluded = c.keys.filter((k) => !isChecked(c, k));
      if (keys.length < 1) return toast('請至少勾選一個品名', 'error');
      if (keys.length === 1 && !c.existingProduct && !(await confirmBox(`只勾選了 1 個品名，要把它單獨設為標準品項，並把其他品名標記為「不是同一品項」嗎？`))) return;
      const name = (state.names[c.id] ?? root.querySelector(`[data-act="name"][data-id="${c.id}"]`).value).trim();
      if (!name) return toast('請輸入標準名稱', 'error');
      const cat = state.cats[c.id] ?? root.querySelector(`[data-act="cat"][data-id="${c.id}"]`).value;
      await doMerge(keys, name, cat, excluded);
      toast(`已合併為「${name}」`, 'good');
      await analyze();
      draw();
    },
    notSame: async (el) => {
      const c = analysis.clusters.find((x) => x.id === el.dataset.id);
      const now = new Date().toISOString();
      const rows = [];
      for (let i = 0; i < c.keys.length; i++) for (let j = i + 1; j < c.keys.length; j++) rows.push({ id: pairKey(c.keys[i], c.keys[j]), a: c.keys[i], b: c.keys[j], updated_at: now });
      await store.put('product_not_same', rows);
      toast('已標記為不同品項', 'good');
      await analyze();
      draw();
    },
    sel: (el) => {
      if (el.checked) state.selected.add(el.dataset.k);
      else state.selected.delete(el.dataset.k);
      const bar = root.querySelector('[data-act="mergeSelected"]');
      if (bar) bar.disabled = state.selected.size < 1;
      const count = bar?.previousElementSibling;
      if (count) count.textContent = `已選 ${state.selected.size} 個`;
    },
    clearSel: () => {
      state.selected.clear();
      draw();
    },
    mergeSelected: async () => {
      const keys = [...state.selected];
      const ns = keys.map((k) => analysis.names.find((n) => n.key === k)).filter(Boolean);
      const newest = [...ns].sort((a, b) => (a.last < b.last ? 1 : -1))[0];
      const existing = keys.map((k) => productOfKey(k)).find(Boolean);
      const r = await modal({
        title: `設定 ${ns.length} 個品名的標準品項`,
        body: h`<p class="muted">${ns.map((n) => n.name).join('、')}</p>
          <div class="form-grid">
            <label class="field"><span>標準名稱</span><input type="text" name="nm" value="${existing?.name || newest.name}"></label>
            <label class="field"><span>品類</span><select name="cat">${options(Object.entries(CATEGORIES), existing?.category || newest.guessCat)}</select></label>
          </div>`,
        actions: [
          { label: '取消', value: null },
          { label: '確定', primary: true, value: (dlg) => ({ name: dlg.querySelector('[name=nm]').value.trim(), cat: dlg.querySelector('[name=cat]').value }) },
        ],
      });
      if (!r || !r.name) return;
      await doMerge(keys, r.name, r.cat);
      state.selected.clear();
      toast(`已設定為「${r.name}」`, 'good');
      await analyze();
      draw();
    },
    setCat: async (el) => {
      const p = idx.byId.get(el.dataset.id);
      await store.put('products', { ...p, category: el.value, updated_at: new Date().toISOString() });
      scheduleSync();
      await analyze();
      toast('品類已更新，營收分錄將自動重算', 'good');
    },
    rename: async (el) => {
      const p = idx.byId.get(el.dataset.id);
      const r = await modal({ title: '標準品項改名', body: h`<label class="field"><span>名稱</span><input type="text" name="nm" value="${p.name}"></label>`, actions: [{ label: '取消', value: null }, { label: '儲存', primary: true, value: (d) => d.querySelector('[name=nm]').value.trim() }] });
      if (!r) return;
      await store.put('products', { ...p, name: r, updated_at: new Date().toISOString() });
      await analyze();
      draw();
    },
    unmap: async (el) => {
      const n = analysis.names.find((x) => x.key === el.dataset.k);
      if (!(await confirmBox(`把「${n?.name || el.dataset.k}」移出這個標準品項？`))) return;
      for (const s of n?.spellings || [el.dataset.k]) await unmapAlias(s);
      scheduleSync();
      await analyze();
      draw();
    },
    exportPairs: () => {
      const byKey = new Map(analysis.names.map((n) => [n.key, n]));
      const rows = [['群組', '信心', '分數', '類型', '品名 A', 'A 期間', 'A 均價', '品名 B', 'B 期間', 'B 均價', '判斷理由']];
      analysis.clusters.forEach((c, i) => {
        for (const p of c.pairs) {
          const a = byKey.get(p.a);
          const b = byKey.get(p.b);
          rows.push([i + 1, CONF[c.confidence][0], Math.round(p.score * 100), p.type === 'variant' ? '變體' : '疑似重複', a.name, `${a.first}~${a.last}`, a.avgPrice ? Math.round(a.avgPrice) : '', b.name, `${b.first}~${b.last}`, b.avgPrice ? Math.round(b.avgPrice) : '', p.reasons.join('；')]);
        }
      });
      downloadCSV(`疑似同品項清單_${today()}.csv`, rows);
    },
    exportMap: () => {
      const rows = [['POS 品名', '標準品項', '品類', '首次販售', '最後販售', '數量', '金額']];
      for (const n of analysis.names) {
        const p = productOfKey(n.key);
        for (const s of n.spellings) rows.push([s, p?.name || '', CATEGORIES[p?.category || n.guessCat], n.first, n.last, n.qty, n.amount]);
      }
      downloadCSV(`品項對照表_${today()}.csv`, rows);
    },
  });

  await analyze();
  draw();
  if (settings && lines.length && !lines.some((l) => l.date >= settings.revenue_start)) toast(`匯入的銷售資料都在營收起算日 ${settings.revenue_start} 之前`, 'info');
  return unbind;
}

export { aliasKey, guessCategory };
