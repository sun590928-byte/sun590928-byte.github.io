// SVG 圖表：直條（單系列／堆疊）、水平長條、熱度圖、折線。
// 規格：細長條（≤24px、4px 圓角資料端）、2px 表面間隙、髮絲格線、滑過顯示提示；≥2 系列必附圖例。

import { fmt } from './lib/money.js';

const NS = 'http://www.w3.org/2000/svg';

function niceStep(max, ticks = 4) {
  if (max <= 0) return 1;
  const raw = max / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(a >= 1e5 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return fmt(n);
}

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

// 上端 4px 圓角、底端方角的長條路徑
function barPath(x, y, w, hgt, r = 4) {
  if (hgt <= 0) return '';
  const rr = Math.min(r, w / 2, hgt);
  return `M${x},${y + hgt}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + hgt}Z`;
}

let tipEl = null;
function tip() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'chart-tip';
    tipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

// rows: [{ label, value, color? }]
function showTip(evt, title, rows) {
  const t = tip();
  t.replaceChildren();
  const hd = document.createElement('div');
  hd.className = 'chart-tip-title';
  hd.textContent = title;
  t.appendChild(hd);
  for (const r of rows) {
    const line = document.createElement('div');
    line.className = 'chart-tip-row';
    if (r.color) {
      const k = document.createElement('span');
      k.className = 'chart-tip-key';
      k.style.background = r.color;
      line.appendChild(k);
    }
    const v = document.createElement('strong');
    v.textContent = r.value;
    const l = document.createElement('span');
    l.textContent = r.label;
    line.append(v, l);
    t.appendChild(line);
  }
  t.classList.add('on');
  const rect = evt.target.getBoundingClientRect ? evt.target.getBoundingClientRect() : { left: evt.clientX, top: evt.clientY, width: 0 };
  const x = (evt.clientX ?? rect.left + rect.width / 2) + 14;
  const y = (evt.clientY ?? rect.top) - 10;
  const w = t.offsetWidth;
  t.style.left = Math.min(x, window.innerWidth - w - 12) + 'px';
  t.style.top = Math.max(8, y - t.offsetHeight) + 'px';
}
function hideTip() {
  tipEl?.classList.remove('on');
}

function legend(container, series) {
  if (series.length < 2) return;
  const lg = document.createElement('div');
  lg.className = 'chart-legend';
  for (const s of series) {
    const item = document.createElement('span');
    const sw = document.createElement('i');
    sw.style.background = s.color;
    item.append(sw, document.createTextNode(s.label));
    lg.appendChild(item);
  }
  container.appendChild(lg);
}

// 容器寬度改變（視窗縮放、側欄收合、首次排版）時重繪
function responsive(container, draw) {
  container._ro?.disconnect();
  let lastW = container.clientWidth;
  let t = null;
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth;
    if (!w || Math.abs(w - lastW) < 16) return;
    lastW = w;
    clearTimeout(t);
    t = setTimeout(draw, 80);
  });
  ro.observe(container);
  container._ro = ro;
}

/**
 * 直條圖（單系列或堆疊）
 * @param opts.data [{ key, label, values: { seriesKey: number } }]
 * @param opts.series [{ key, label, color }]
 */
export function columnChart(container, opts) {
  responsive(container, () => drawColumns(container, opts));
  drawColumns(container, opts);
}

function drawColumns(container, { data, series, height = 220, format = (v) => '$' + fmt(v), labelEvery = null, highlightKey = null, ariaLabel = '' }) {
  container.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'chart';
  container.appendChild(wrap);
  legend(wrap, series);
  const width = Math.max(320, container.clientWidth || 640);
  const pad = { l: 48, r: 8, t: 12, b: 26 };
  const totals = data.map((d) => series.reduce((t, s) => t + Math.max(0, d.values[s.key] || 0), 0));
  const max = Math.max(1, ...totals);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': ariaLabel || '直條圖' });
  wrap.appendChild(svg);
  const ih = height - pad.t - pad.b;
  const iw = width - pad.l - pad.r;
  const y = (v) => pad.t + ih - (v / top) * ih;
  for (let v = 0; v <= top + 1e-9; v += step) {
    el('line', { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), class: v === 0 ? 'axis' : 'grid' }, svg);
    const t = el('text', { x: pad.l - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg);
    t.textContent = compact(v);
  }
  const band = iw / Math.max(1, data.length);
  const bw = Math.max(2, Math.min(24, band - 2));
  const every = labelEvery || Math.max(1, Math.ceil(data.length / Math.floor(iw / 44)));
  data.forEach((d, i) => {
    const cx = pad.l + band * i + band / 2;
    let acc = 0;
    const g = el('g', { class: 'bar-g' + (highlightKey && d.key === highlightKey ? ' hl' : ''), tabindex: '0' }, svg);
    series.forEach((s, si) => {
      const v = Math.max(0, d.values[s.key] || 0);
      if (!v) return;
      const y0 = y(acc);
      const y1 = y(acc + v);
      const isTop = series.slice(si + 1).every((s2) => !(d.values[s2.key] > 0));
      const hgt = Math.max(0, y0 - y1 - (acc > 0 ? 2 : 0)); // 2px 表面間隙
      const p = isTop ? barPath(cx - bw / 2, y1, bw, hgt) : `M${cx - bw / 2},${y1}h${bw}v${hgt}h${-bw}Z`;
      if (p) el('path', { d: p, fill: s.color, class: 'bar' }, g);
      acc += v;
    });
    const hit = el('rect', { x: pad.l + band * i, y: pad.t, width: band, height: ih, fill: 'transparent' }, g);
    const rows = series.filter((s) => d.values[s.key]).map((s) => ({ label: s.label, value: format(d.values[s.key]), color: series.length > 1 ? s.color : null }));
    if (series.length > 1) rows.push({ label: '合計', value: format(totals[i]) });
    const onTip = (e) => showTip(e, d.label, rows);
    hit.addEventListener('pointermove', onTip);
    hit.addEventListener('pointerleave', hideTip);
    g.addEventListener('focus', (e) => showTip({ target: g, clientX: g.getBoundingClientRect().left + 10, clientY: g.getBoundingClientRect().top + 20 }, d.label, rows));
    g.addEventListener('blur', hideTip);
    if (i % every === 0) {
      const t = el('text', { x: cx, y: height - 8, class: 'tick', 'text-anchor': 'middle' }, svg);
      t.textContent = d.short || d.label;
    }
  });
  // 標示最高點
  const maxI = totals.indexOf(max);
  if (maxI >= 0 && data.length > 1) {
    const cx = pad.l + band * maxI + band / 2;
    const t = el('text', { x: Math.min(width - 30, Math.max(pad.l + 20, cx)), y: y(max) - 5, class: 'val', 'text-anchor': 'middle' }, svg);
    t.textContent = compact(max);
  }
}

// 水平長條清單（HTML），值標在長條末端
export function barList(container, items, { format = (v) => fmt(v), color = 'var(--series-1)', max = null } = {}) {
  const m = max || Math.max(1, ...items.map((i) => i.value));
  container.replaceChildren();
  const list = document.createElement('div');
  list.className = 'barlist';
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'barlist-row';
    const lab = document.createElement('div');
    lab.className = 'barlist-label';
    lab.textContent = it.label;
    if (it.sub) {
      const s = document.createElement('span');
      s.className = 'muted';
      s.textContent = ' ' + it.sub;
      lab.appendChild(s);
    }
    const track = document.createElement('div');
    track.className = 'barlist-track';
    const bar = document.createElement('div');
    bar.className = 'barlist-bar';
    bar.style.width = Math.max(0.5, (it.value / m) * 100) + '%';
    bar.style.background = it.color || color;
    const val = document.createElement('span');
    val.className = 'barlist-val';
    val.textContent = format(it.value);
    track.append(bar, val);
    row.append(lab, track);
    list.appendChild(row);
  }
  container.appendChild(list);
}

// 熱度圖（單一色相，淺→深）
export function heatmap(container, { rows, cols, values, format = (v) => '$' + fmt(v), title = (r, c) => `${r} ${c}` }) {
  container.replaceChildren();
  const max = Math.max(1, ...values.flat());
  const grid = document.createElement('div');
  grid.className = 'heat';
  grid.style.gridTemplateColumns = `2.2em repeat(${cols.length}, minmax(0, 1fr))`;
  grid.appendChild(document.createElement('span'));
  for (const c of cols) {
    const hd = document.createElement('span');
    hd.className = 'heat-col';
    hd.textContent = c;
    grid.appendChild(hd);
  }
  rows.forEach((r, ri) => {
    const rl = document.createElement('span');
    rl.className = 'heat-row';
    rl.textContent = r;
    grid.appendChild(rl);
    cols.forEach((c, ci) => {
      const v = values[ri][ci] || 0;
      const cell = document.createElement('span');
      cell.className = 'heat-cell';
      cell.tabIndex = 0;
      cell.style.setProperty('--a', v ? (0.12 + 0.88 * (v / max)).toFixed(3) : 0);
      const rowsTip = [{ label: '營收', value: format(v) }];
      cell.addEventListener('pointermove', (e) => showTip(e, title(r, c), rowsTip));
      cell.addEventListener('pointerleave', hideTip);
      cell.addEventListener('focus', () => {
        const b = cell.getBoundingClientRect();
        showTip({ target: cell, clientX: b.right, clientY: b.top }, title(r, c), rowsTip);
      });
      cell.addEventListener('blur', hideTip);
      grid.appendChild(cell);
    });
  });
  container.appendChild(grid);
  const scale = document.createElement('div');
  scale.className = 'heat-scale';
  scale.innerHTML = '<span>少</span><i></i><span>多</span>';
  container.appendChild(scale);
}

// 折線（單系列，十字線提示）
export function lineChart(container, opts) {
  responsive(container, () => drawLine(container, opts));
  drawLine(container, opts);
}

function drawLine(container, { points, height = 180, format = (v) => '$' + fmt(v), color = 'var(--series-1)', ariaLabel = '' }) {
  container.replaceChildren();
  if (!points.length) return;
  const width = Math.max(300, container.clientWidth || 560);
  const pad = { l: 48, r: 16, t: 14, b: 24 };
  const vals = points.map((p) => p.value);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || Math.abs(hi) || 1;
  const min = Math.max(0, lo - span * 0.2);
  const max = hi + span * 0.2;
  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', height, role: 'img', 'aria-label': ariaLabel || '折線圖' });
  container.appendChild(svg);
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const x = (i) => pad.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v) => pad.t + ih - ((v - min) / (max - min)) * ih;
  const step = niceStep(max - min, 3);
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) {
    el('line', { x1: pad.l, x2: width - pad.r, y1: y(v), y2: y(v), class: 'grid' }, svg);
    const t = el('text', { x: pad.l - 6, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, svg);
    t.textContent = compact(v);
  }
  el('path', { d: points.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.value)}`).join(''), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
  const last = points.length - 1;
  el('circle', { cx: x(last), cy: y(points[last].value), r: 4, fill: color, class: 'dot' }, svg);
  const lt = el('text', { x: Math.min(width - 4, x(last)), y: y(points[last].value) - 9, class: 'val', 'text-anchor': 'end' }, svg);
  lt.textContent = format(points[last].value);
  [0, last].forEach((i) => {
    const t = el('text', { x: x(i), y: height - 6, class: 'tick', 'text-anchor': i ? 'end' : 'start' }, svg);
    t.textContent = points[i].label;
  });
  const cross = el('line', { y1: pad.t, y2: pad.t + ih, class: 'cross' }, svg);
  const hit = el('rect', { x: pad.l, y: pad.t, width: iw, height: ih, fill: 'transparent' }, svg);
  hit.addEventListener('pointermove', (e) => {
    const b = svg.getBoundingClientRect();
    const px = ((e.clientX - b.left) / b.width) * width;
    const i = Math.max(0, Math.min(last, Math.round(((px - pad.l) / iw) * last)));
    cross.setAttribute('x1', x(i));
    cross.setAttribute('x2', x(i));
    cross.classList.add('on');
    showTip(e, points[i].label, [{ label: points[i].sub || '', value: format(points[i].value) }]);
  });
  hit.addEventListener('pointerleave', () => {
    cross.classList.remove('on');
    hideTip();
  });
}

export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];
