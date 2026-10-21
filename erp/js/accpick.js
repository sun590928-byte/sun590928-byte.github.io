// 會計項目下拉的打字篩選（像關鍵字提示）：點開下拉、或在下拉上直接打字，跳出可搜尋的清單。
// 打數字依代號開頭篩選（2 → 2xxx、21 → 21xx、2133），打中文依名稱關鍵字（代墊、銀行）；↑↓ 選、Enter 確定、Esc 取消。
// 底下仍是原本的 <select>（表單讀取、存檔、測試都照舊）：選好後設回 select 並觸發 change。手機、平板照用原生下拉。

import { h } from './ui.js';
import { accountQueryMatch } from './lib/coa.js';

const SEL = 'select[data-acc-pick]';
let cur = null; // 開著的清單：{ sel, box, input, list, foot, opts, shown, hi }
let installed = false;

const touchOnly = () => matchMedia('(hover: none) and (pointer: coarse)').matches;

export function installAccountPicker() {
  if (installed) return;
  installed = true;
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('keydown', onSelectKey, true);
  window.addEventListener('resize', () => close(false));
  document.addEventListener('scroll', (e) => cur && !cur.box.contains(e.target) && close(false), true);
}

function onMouseDown(e) {
  const sel = e.target.closest?.(SEL);
  if (cur && !cur.box.contains(e.target) && sel !== cur.sel) close(false);
  if (!sel || e.button !== 0 || sel.disabled || touchOnly()) return;
  e.preventDefault(); // 不開原生下拉
  if (cur?.sel === sel) close(true);
  else open(sel, '');
}

// 下拉有焦點時直接打字：第一個字就帶進搜尋框
function onSelectKey(e) {
  const sel = e.target;
  if (cur || !(sel instanceof HTMLSelectElement) || !sel.matches(SEL) || sel.disabled || e.ctrlKey || e.metaKey) return;
  const typed = e.key.length === 1 && e.key !== ' ' && !e.altKey;
  if (!typed && !['Enter', ' ', 'F4'].includes(e.key) && !(e.altKey && e.key === 'ArrowDown')) return;
  e.preventDefault();
  open(sel, typed ? e.key : '');
}

function open(sel, q) {
  close(false);
  const opts = [...sel.options].map((o) => ({ v: o.value, text: o.textContent.trim(), group: o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '' }));
  const box = document.createElement('div');
  box.className = 'acc-pop';
  box.innerHTML = String(h`<input type="text" class="acc-q" placeholder="打代號開頭或名稱，例如 21、代墊" autocomplete="off" spellcheck="false" aria-label="篩選會計項目"><ul class="acc-list" role="listbox"></ul><div class="acc-foot"></div>`);
  // 對話框（showModal）在最上層：清單要放在對話框裡才不會被蓋住
  (sel.closest('dialog') || document.body).appendChild(box);
  const input = box.querySelector('.acc-q');
  cur = { sel, box, input, list: box.querySelector('.acc-list'), foot: box.querySelector('.acc-foot'), opts, shown: [], hi: -1 };
  input.value = q;
  input.addEventListener('input', render);
  input.addEventListener('keydown', onInputKey);
  cur.list.addEventListener('mousedown', (e) => e.preventDefault()); // 焦點留在搜尋框
  cur.list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-n]');
    if (li) choose(cur.shown[Number(li.dataset.n)]);
  });
  cur.list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('[data-n]');
    if (li && Number(li.dataset.n) !== cur.hi) hilite(Number(li.dataset.n), false);
  });
  render();
  place();
  input.focus({ preventScroll: true });
}

function render() {
  const { input, list, foot, opts, sel } = cur;
  const q = input.value.trim();
  const shown = opts.filter((o) => (o.v === '' ? !q : !q || accountQueryMatch(q, o.v, `${o.text} ${o.group}`)));
  cur.shown = shown;
  let g = null;
  const rows = [];
  shown.forEach((o, n) => {
    if (o.group !== g && (g = o.group)) rows.push(h`<li class="acc-g" role="presentation">${g}</li>`);
    const code = o.v && o.text.startsWith(o.v + ' ') ? o.v : '';
    rows.push(h`<li class="acc-o${o.v === sel.value ? ' cur' : ''}" role="option" data-n="${n}">${code ? h`<b class="acc-c">${code}</b>${o.text.slice(code.length + 1)}` : o.text}</li>`);
  });
  list.innerHTML = String(rows.length ? h`${rows}` : h`<li class="acc-none">找不到「${q}」：請打代號開頭（例如 21）或名稱裡的字</li>`);
  foot.textContent = q ? `${shown.length} 個符合　↑↓ 選擇　Enter 確定　Esc 取消` : '打數字依代號開頭篩選，打中文依名稱篩選';
  const at = shown.findIndex((o) => o.v === sel.value);
  hilite(q ? (shown.length ? 0 : -1) : Math.max(0, at), true);
}

function hilite(n, scroll) {
  const { list } = cur;
  cur.hi = n;
  list.querySelector('.acc-o.hi')?.classList.remove('hi');
  const li = list.querySelector(`[data-n="${n}"]`);
  if (!li) return;
  li.classList.add('hi');
  if (!scroll) return;
  // 只捲清單本身（scrollIntoView 會連頁面一起捲）；上方留出固定的類別標題
  const top = li.offsetTop - (list.querySelector('.acc-g')?.offsetHeight || 0);
  if (top < list.scrollTop) list.scrollTop = top;
  else if (li.offsetTop + li.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = li.offsetTop + li.offsetHeight - list.clientHeight;
}

function onInputKey(e) {
  if (e.isComposing) return; // 注音、倉頡選字中
  const n = cur.shown.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (n) hilite(Math.min(n - 1, Math.max(0, cur.hi + (e.key === 'ArrowDown' ? 1 : -1))), true);
  } else if (e.key === 'Enter') {
    if (cur.shown[cur.hi]) choose(cur.shown[cur.hi]);
  } else if (e.key === 'Escape') {
    close(true);
  } else if (e.key === 'Tab') {
    // Tab：有打字就選目前反白的那個，焦點照常移到下一格
    if (cur.input.value.trim() && cur.shown[cur.hi]) choose(cur.shown[cur.hi]);
    else close(true);
    return;
  } else return;
  e.preventDefault();
  e.stopPropagation(); // Esc 不要連對話框一起關掉
}

function choose(o) {
  const { sel } = cur;
  close(true);
  if (!o || sel.value === o.v) return;
  sel.value = o.v;
  sel.dispatchEvent(new Event('input', { bubbles: true }));
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

function close(refocus) {
  if (!cur) return;
  const { sel, box } = cur;
  cur = null;
  box.remove();
  if (refocus && sel.isConnected) sel.focus({ preventScroll: true });
}

// 貼在下拉的下方；下方空間不夠就往上開
function place() {
  const { sel, box } = cur;
  const r = sel.getBoundingClientRect();
  const w = Math.min(Math.max(r.width, 320), innerWidth - 16);
  box.style.width = `${w}px`;
  box.style.left = `${Math.min(Math.max(8, r.left), innerWidth - w - 8)}px`;
  const below = innerHeight - r.bottom - 12;
  const above = r.top - 12;
  if (below >= 280 || below >= above) {
    box.style.top = `${r.bottom + 4}px`;
    box.style.maxHeight = `${Math.min(380, below)}px`;
  } else {
    box.style.bottom = `${innerHeight - r.top + 4}px`;
    box.style.maxHeight = `${Math.min(380, above)}px`;
  }
}
