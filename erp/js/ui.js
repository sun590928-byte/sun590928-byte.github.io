// 介面工具：安全的 HTML 樣板（自動跳脫）、表格、對話框、通知、下載與檔案選取。

import { fmt, fmtMoney, pct } from './lib/money.js';
import { toCSV } from './lib/csv.js';

class Raw {
  constructor(s) {
    this.s = s;
  }
  toString() {
    return this.s;
  }
}

export const raw = (s) => new Raw(String(s));

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toHtml(v) {
  if (v === null || v === undefined || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(toHtml).join('');
  return esc(String(v));
}

// h`<p>${userText}</p>`：插值自動跳脫；巢狀 h`` 與 raw() 不再跳脫
export function h(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += toHtml(vals[i]);
  });
  return new Raw(out);
}

export { fmt, fmtMoney, pct };

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function mount(el, content) {
  el.innerHTML = toHtml(content);
  return el;
}

// 事件委派：data-act="name" → handlers.name(el, event)
export function bindActions(root, handlers) {
  const run = (ev, type) => {
    const el = ev.target.closest('[data-act]');
    if (!el || !root.contains(el)) return;
    const name = el.dataset.act;
    const evType = el.dataset.on || (el.matches('input,select,textarea') ? 'change' : 'click');
    if (evType !== type) return;
    const fn = handlers[name];
    if (!fn) return;
    if (type === 'click' && el.tagName === 'A') ev.preventDefault();
    Promise.resolve(fn(el, ev)).catch((e) => {
      console.error(e);
      toast(e.message || String(e), 'error');
    });
  };
  const c = (e) => run(e, 'click');
  const ch = (e) => run(e, 'change');
  const inp = (e) => run(e, 'input');
  root.addEventListener('click', c);
  root.addEventListener('change', ch);
  root.addEventListener('input', inp);
  return () => {
    root.removeEventListener('click', c);
    root.removeEventListener('change', ch);
    root.removeEventListener('input', inp);
  };
}

// ─────────── 通知

export function toast(msg, type = 'info', ms = 3800) {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'polite');
    document.body.appendChild(box);
  }
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.classList.add('out'), ms);
  setTimeout(() => t.remove(), ms + 400);
}

// ─────────── 對話框

export function modal({ title, body, actions = [{ label: '關閉', value: null }], wide = false, onMount } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'modal' + (wide ? ' wide' : '');
    dlg.innerHTML = String(h`<form method="dialog" class="modal-inner">
      <header class="modal-head"><h2>${title}</h2><button type="button" class="icon-btn" data-close aria-label="關閉">✕</button></header>
      <div class="modal-body">${body}</div>
      <footer class="modal-foot">${actions.map((a, i) => h`<button type="button" class="btn ${a.primary ? 'primary' : ''} ${a.danger ? 'danger' : ''}" data-i="${i}">${a.label}</button>`)}</footer>
    </form>`);
    document.body.appendChild(dlg);
    const done = (v) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (b) {
        const a = actions[Number(b.dataset.i)];
        const v = typeof a.value === 'function' ? a.value(dlg) : a.value;
        if (v === false) return; // 驗證失敗，保持開啟
        done(v);
      } else if (e.target.closest('[data-close]') || e.target === dlg) done(null);
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      done(null);
    });
    dlg.showModal();
    onMount?.(dlg);
  });
}

export async function confirmBox(message, { ok = '確定', danger = false } = {}) {
  const r = await modal({ title: '請確認', body: h`<p>${message}</p>`, actions: [{ label: '取消', value: false }, { label: ok, value: true, primary: !danger, danger }] });
  return !!r;
}

// ─────────── 檔案

export function pickFiles({ accept = '', multiple = true, directory = false } = {}) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.multiple = multiple;
    if (directory) inp.webkitdirectory = true;
    inp.onchange = () => resolve([...inp.files]);
    inp.click();
  });
}

export function download(name, content, mime = 'text/plain;charset=utf-8') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

export function downloadCSV(name, rows) {
  download(name, toCSV(rows), 'text/csv;charset=utf-8');
}

// ─────────── 表格（排序、分頁、匯出）

/**
 * columns: [{ key, label, align:'num'|'left', fmt:(v,row)=>string|Raw, sort:(row)=>value, width }]
 */
export function dataTable(el, { columns, rows, pageSize = 100, empty = '沒有資料', exportName = null, rowClass = null, footer = null, initialSort = null }) {
  const state = { sortKey: initialSort?.key ?? null, dir: initialSort?.dir ?? 1, page: 0 };
  const render = () => {
    let list = rows;
    if (state.sortKey !== null) {
      const col = columns.find((c) => c.key === state.sortKey);
      const get = col.sort || ((r) => r[col.key]);
      list = [...rows].sort((a, b) => {
        const x = get(a);
        const y = get(b);
        if (x === y) return 0;
        if (x === null || x === undefined || x === '') return 1;
        if (y === null || y === undefined || y === '') return -1;
        return (x < y ? -1 : 1) * state.dir;
      });
    }
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    state.page = Math.min(state.page, pages - 1);
    const slice = list.slice(state.page * pageSize, (state.page + 1) * pageSize);
    el.innerHTML = String(h`<div class="table-wrap"><table class="grid">
      <thead><tr>${columns.map(
        (c) => h`<th class="${c.align === 'num' ? 'num' : ''}" style="${c.width ? `width:${c.width}` : ''}" ${c.nosort ? '' : raw(`data-sort="${esc(c.key)}" tabindex="0" aria-sort="${state.sortKey === c.key ? (state.dir > 0 ? 'ascending' : 'descending') : 'none'}"`)}>${c.label}${state.sortKey === c.key ? (state.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`,
      )}</tr></thead>
      <tbody>${
        slice.length
          ? slice.map((r) => h`<tr class="${rowClass ? rowClass(r) : ''}">${columns.map((c) => h`<td class="${c.align === 'num' ? 'num' : ''} ${c.cls || ''}">${c.fmt ? c.fmt(r[c.key], r) : r[c.key] ?? ''}</td>`)}</tr>`)
          : h`<tr><td colspan="${columns.length}" class="empty">${empty}</td></tr>`
      }</tbody>
      ${footer ? h`<tfoot>${footer}</tfoot>` : ''}
    </table></div>
    <div class="table-bar">
      <span class="muted">共 ${fmt(list.length)} 筆${pages > 1 ? `，第 ${state.page + 1}／${pages} 頁` : ''}</span>
      <span class="spacer"></span>
      ${pages > 1 ? h`<button class="btn sm" data-pg="-1" ${state.page === 0 ? raw('disabled') : ''}>上一頁</button><button class="btn sm" data-pg="1" ${state.page >= pages - 1 ? raw('disabled') : ''}>下一頁</button>` : ''}
      ${exportName ? h`<button class="btn sm ghost" data-export>匯出 CSV</button>` : ''}
    </div>`);
    el.querySelectorAll('[data-sort]').forEach((th) => {
      const go = () => {
        const k = th.dataset.sort;
        if (state.sortKey === k) state.dir = -state.dir;
        else {
          state.sortKey = k;
          state.dir = columns.find((c) => c.key === k)?.align === 'num' ? -1 : 1;
        }
        render();
      };
      th.addEventListener('click', go);
      th.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go()));
    });
    el.querySelectorAll('[data-pg]').forEach((b) =>
      b.addEventListener('click', () => {
        state.page += Number(b.dataset.pg);
        render();
      }),
    );
    el.querySelector('[data-export]')?.addEventListener('click', () => {
      const plain = (v) => (v instanceof Raw ? v.s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'") : v);
      downloadCSV(exportName, [columns.map((c) => c.label), ...list.map((r) => columns.map((c) => (c.csv ? c.csv(r[c.key], r) : plain(c.fmt ? c.fmt(r[c.key], r) : r[c.key]) ?? '')))]);
    });
  };
  render();
  return { update(newRows) { rows = newRows; render(); } };
}

// ─────────── 小元件

export function stat(label, value, sub = '', tone = '') {
  return h`<div class="stat ${tone}"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${sub ? h`<div class="stat-sub">${sub}</div>` : ''}</div>`;
}

export function badge(text, tone = '') {
  return h`<span class="badge ${tone}">${text}</span>`;
}

// 狀態：圖示 + 文字，不只靠顏色
export function status(kind, text) {
  const icon = { good: '✓', warn: '!', bad: '✕', na: '–', info: 'i' }[kind] || '•';
  return h`<span class="status status-${kind}"><span class="status-ic" aria-hidden="true">${icon}</span>${text}</span>`;
}

export function money(n, { zero = '—' } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (Math.abs(n) < 0.005) return zero;
  return fmt(n);
}

export function monthOptions(months, selected) {
  return months.map((m) => h`<option value="${m}" ${m === selected ? raw('selected') : ''}>${Number(m.slice(0, 4)) - 1911} 年 ${Number(m.slice(5))} 月</option>`);
}

export function options(pairs, selected) {
  return pairs.map(([v, label]) => h`<option value="${v}" ${String(v) === String(selected) ? raw('selected') : ''}>${label}</option>`);
}

export function emptyState(title, text, actionHtml = '') {
  return h`<div class="empty-state"><div class="empty-mark" aria-hidden="true"></div><h3>${title}</h3><p>${text}</p>${actionHtml}</div>`;
}

export function readFileAsArrayBuffer(file) {
  return file.arrayBuffer();
}

export function setBusy(on, text = '處理中…') {
  let el = $('#busy');
  if (!el) {
    el = document.createElement('div');
    el.id = 'busy';
    el.innerHTML = '<div class="busy-card"><div class="spinner" aria-hidden="true"></div><span></span></div>';
    document.body.appendChild(el);
  }
  el.querySelector('span').textContent = text;
  el.classList.toggle('on', on);
}
