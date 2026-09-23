// 主程式：路由、選單、登入與初始化。各頁面以動態 import 延遲載入。

import { store, cloudConfig } from './store.js';
import { h, mount, toast, $, bindActions } from './ui.js';
import { ensureAccounts, getSettings } from './state.js';

export const ROUTES = [
  { group: '總覽', path: 'dashboard', title: '營運儀表板', load: () => import('./views/dashboard.js') },
  { group: '資料匯入', path: 'import', title: '匯入中心', load: () => import('./views/import.js') },
  { group: '資料匯入', path: 'products', title: '品項整併', load: () => import('./views/products.js') },
  { group: '資料匯入', path: 'documents', title: '憑證歸檔（AI）', load: () => import('./views/documents.js') },
  { group: '營運分析', path: 'sales', title: '銷售明細與作廢', load: () => import('./views/sales.js') },
  { group: '營運分析', path: 'payments', title: '金流對帳', load: () => import('./views/payments.js') },
  { group: '營運分析', path: 'inventory', title: '原物料進銷存', load: () => import('./views/inventory.js') },
  { group: '營運分析', path: 'suppliers', title: '採購與供應商', load: () => import('./views/suppliers.js') },
  { group: '營運分析', path: 'customers', title: '會員消費輪廓', load: () => import('./views/customers.js') },
  { group: '營運分析', path: 'campaigns', title: '行銷活動成效', load: () => import('./views/campaigns.js') },
  { group: '營運分析', path: 'pnl', title: '營運損益', load: () => import('./views/pnl.js') },
  { group: '會計帳務', path: 'accounts', title: '會計項目', load: () => import('./views/accounts.js') },
  { group: '會計帳務', path: 'journal', title: '日記簿', load: () => import('./views/journal.js') },
  { group: '會計帳務', path: 'ledger', title: '分類帳', load: () => import('./views/ledger.js') },
  { group: '會計帳務', path: 'trial', title: '試算表', load: () => import('./views/trial.js') },
  { group: '會計帳務', path: 'balance', title: '資產負債表', load: () => import('./views/balance.js') },
  { group: '會計帳務', path: 'income', title: '綜合損益表', load: () => import('./views/income.js') },
  { group: '會計帳務', path: 'vouchers', title: '傳票列印', load: () => import('./views/vouchers.js') },
  { group: '會計帳務', path: 'assets', title: '固定資產與折舊', load: () => import('./views/assets.js') },
  { group: '會計帳務', path: 'cost', title: '存貨與成本', load: () => import('./views/cost.js') },
  { group: '會計帳務', path: 'bank', title: '銀行存摺對帳', load: () => import('./views/bank.js') },
  { group: '會計帳務', path: 'closing', title: '每月結帳檢查', load: () => import('./views/closing.js') },
  { group: '會計帳務', path: 'tax', title: '申報行事曆', load: () => import('./views/tax.js') },
  { group: '系統', path: 'settings', title: '設定與備份', load: () => import('./views/settings.js') },
];

let current = null;
let unbind = null;

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs] = raw.split('?');
  return { path: path || 'dashboard', params: Object.fromEntries(new URLSearchParams(qs || '')) };
}

export function go(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  const target = `#/${path}${qs ? '?' + qs : ''}`;
  if (location.hash === target) render();
  else location.hash = target;
}

// 更新網址參數但不重新渲染（保留篩選狀態）
export function setParams(params) {
  const { path, params: cur } = parseHash();
  const merged = { ...cur, ...params };
  const qs = new URLSearchParams(Object.entries(merged).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString();
  history.replaceState(null, '', `#/${path}${qs ? '?' + qs : ''}`);
}

function renderNav(active) {
  const groups = [];
  for (const r of ROUTES) {
    let g = groups.find((x) => x.name === r.group);
    if (!g) groups.push((g = { name: r.group, items: [] }));
    g.items.push(r);
  }
  mount(
    $('#nav-links'),
    groups.map(
      (g) => h`<div class="nav-group"><div class="nav-group-title">${g.name}</div>${g.items.map(
        (r) => h`<a href="#/${r.path}" class="${r.path === active ? 'active' : ''}" ${r.path === active ? h`aria-current="page"` : ''}><span class="dot"></span>${r.title}</a>`,
      )}</div>`,
    ),
  );
  const cfg = cloudConfig();
  mount(
    $('#mode-pill'),
    store.mode === 'cloud'
      ? h`資料位置：<b>雲端（Supabase）</b><br>${store.backend.session?.user?.email || ''}`
      : h`資料位置：<b>本機瀏覽器</b><br>${cfg?.url ? '雲端已設定、未啟用' : '尚未連線雲端'}`,
  );
}

async function render() {
  const { path, params } = parseHash();
  const route = ROUTES.find((r) => r.path === path) || ROUTES[0];
  renderNav(route.path);
  closeNav();
  $('#page-title').textContent = route.title;
  $('#crumb').textContent = route.group;
  document.title = `${route.title}｜午月營運帳務`;
  const view = $('#view');
  const actions = $('#topbar-actions');
  actions.replaceChildren();
  if (unbind) unbind();
  unbind = null;
  if (store.needsLogin()) {
    renderLogin(view);
    return;
  }
  const token = {};
  current = token;
  view.innerHTML = '<div class="muted" style="padding:20px">載入中…</div>';
  try {
    const mod = await route.load();
    if (current !== token) return;
    view.replaceChildren();
    const ctx = { params, actions, go, setParams, rerender: render };
    const cleanup = await mod.render(view, ctx);
    if (current !== token) return;
    unbind = typeof cleanup === 'function' ? cleanup : null;
    view.focus({ preventScroll: true });
  } catch (e) {
    console.error(e);
    mount(view, h`<div class="callout bad"><p><b>頁面載入失敗：</b>${e.message || e}</p></div>`);
  }
}

function renderLogin(view) {
  mount(
    view,
    h`<div class="login card">
      <div class="card-head"><h2>登入雲端資料庫</h2></div>
      <p class="muted">此裝置已設定使用 Supabase 雲端資料庫，請以管理者建立的帳號登入。</p>
      <form id="login-form" class="stack">
        <label class="field"><span>Email</span><input type="email" name="email" required autocomplete="email"></label>
        <label class="field"><span>密碼（留白則寄送登入連結到信箱）</span><input type="password" name="password" autocomplete="current-password"></label>
        <div class="row"><button class="btn primary" type="submit">登入</button><span class="spacer"></span><button class="btn ghost sm" type="button" data-act="local">改用本機資料</button></div>
      </form>
    </div>`,
  );
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const r = await store.backend.signIn(String(fd.get('email')).trim(), String(fd.get('password') || ''));
      if (!r.session) toast('已寄出登入連結，請到信箱點擊連結完成登入', 'good', 8000);
      else {
        store.reload();
        render();
      }
    } catch (err) {
      toast('登入失敗：' + err.message, 'error');
    }
  });
  unbind = bindActions(view, {
    local: () => {
      const cfg = cloudConfig();
      localStorage.setItem('wuyue-erp:cloud', JSON.stringify({ ...cfg, enabled: false }));
      location.reload();
    },
  });
}

function closeNav() {
  $('#nav').classList.remove('open');
  $('#nav-scrim').classList.remove('open');
}

async function boot() {
  $('#menu-btn').addEventListener('click', () => {
    $('#nav').classList.add('open');
    $('#nav-scrim').classList.add('open');
  });
  $('#nav-scrim').addEventListener('click', closeNav);
  $('#theme-toggle').addEventListener('click', () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    try {
      localStorage.setItem('wuyue-erp:theme', root.dataset.theme);
    } catch {}
  });
  try {
    await store.init();
  } catch (e) {
    toast('雲端連線失敗，暫時改用本機資料：' + e.message, 'error', 8000);
  }
  if (!store.needsLogin()) {
    await ensureAccounts();
    await getSettings();
  }
  window.addEventListener('hashchange', render);
  render();
}

boot();
