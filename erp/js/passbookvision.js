// 存摺照片的表格辨識（瀏覽器內）：找表格線 → 攤平 → 切列 → 整列文字辨識，再依「字的種類與順序」分欄：
// 第一個數字串是日期、接著摘要、支出與存入看金額印在備註的前面或後面、最後一個金額是結存、結存右邊的中文是備註。
// 印字常相對於格線左右偏移、甚至溢到隔壁欄，所以格線只當參考，不硬切。
// 日期、摘要、金額各自再用限定字集辨識一次（更準）。每一列另外切一張縮圖，讓使用者逐列對照。
// 找不到表格線（別家銀行、照片糊掉）時回傳 ok:false，由呼叫端改用整頁辨識。

import { colorMasks, detectTable, homography, warp, layoutTable, COLUMN_KEYS } from './lib/passbookgeo.js';
import { ocrWorker } from './vision.js';

const WORK = 2000; // 找表格線用的縮圖長邊
const MAX_OUT = 2600; // 攤平後表格的最長邊
const DIGITS = '0123456789';
const MONEY = '0123456789,.*';
// 摘要欄只會出現這些字（交易別＋原交易日期）
const SUMMARY = '網銀電匯現金轉帳利息手續費提款存款代收轉入轉出CD0123456789';

function canvasOf(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// 照片畫到畫布：長邊縮到 maxSide，可轉 0/90/270
function draw(bmp, { maxSide, deg = 0 }) {
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s);
  const h = Math.round(bmp.height * s);
  const rot = deg % 180 !== 0;
  const c = canvasOf(rot ? h : w, rot ? w : h);
  const g = c.getContext('2d', { willReadFrequently: true });
  g.translate(c.width / 2, c.height / 2);
  g.rotate((deg * Math.PI) / 180);
  g.drawImage(bmp, -w / 2, -h / 2, w, h);
  return { canvas: c, scale: s, img: g.getImageData(0, 0, c.width, c.height) };
}

const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

/**
 * 找表格並攤平。
 * @returns { ok, why, deg, table:{width,height,data}, canvas }
 */
export async function rectifyPassbook(bmp, { onStep } = {}) {
  let found = null;
  for (const deg of [0, 90, 270]) {
    onStep?.(deg ? `轉 ${deg}° 找表格線` : '找表格線');
    const small = draw(bmp, { maxSide: WORK, deg });
    const det = detectTable(small.img);
    if (det.ok) {
      found = { deg, det, scale: small.scale };
      break;
    }
    if (!found) found = { deg, det, scale: small.scale, failed: true };
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!found || found.failed) return { ok: false, why: found?.det?.why || '找不到表格線', deg: 0 };
  const { deg, det, scale } = found;
  onStep?.('攤平表格');
  // 四個角換算回原圖（已轉正）的座標
  const full = draw(bmp, { maxSide: Infinity, deg });
  const corners = det.corners.map((p) => ({ x: p.x / scale, y: p.y / scale }));
  const [tl, tr, br, bl] = corners;
  // 第一階段的框已經含左右框線（粗略對齊）；再多留一點邊，上下各 2%
  const span = (dist(tl, tr) + dist(bl, br)) / 2;
  const tall = (dist(tl, bl) + dist(tr, br)) / 2;
  const k = Math.min(1, MAX_OUT / Math.max(span * 1.08, tall * 1.04));
  const mx = Math.round(span * 0.04 * k);
  const my = Math.round(tall * 0.02 * k);
  const outW = Math.round(span * k) + mx * 2;
  const outH = Math.round(tall * k) + my * 2;
  // 輸出矩形 → 原圖的投影轉換（直接求反向，攤平時逐像素反查）
  const Hinv = homography(
    [
      { x: mx, y: my },
      { x: outW - 1 - mx, y: my },
      { x: outW - 1 - mx, y: outH - 1 - my },
      { x: mx, y: outH - 1 - my },
    ],
    corners,
  );
  const table = warp(full.img, Hinv, outW, outH);
  const canvas = canvasOf(outW, outH);
  canvas.getContext('2d').putImageData(new ImageData(table.data, outW, outH), 0, 0);
  return { ok: true, deg, table, canvas, corners, vlines: det.vlines.length, hlines: det.hlines.length, aligned: det.aligned, matched: det.matched };
}

// 墨水遮罩 → 黑白畫布（OCR 用）
function binaryCanvas(ink, W, H) {
  const c = canvasOf(W, H);
  const g = c.getContext('2d');
  const img = g.createImageData(W, H);
  const d = img.data;
  for (let p = 0, o = 0; p < ink.length; p++, o += 4) {
    const v = ink[p] ? 0 : 255;
    d[o] = d[o + 1] = d[o + 2] = v;
    d[o + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
}

// 一段裡的墨水範圍 {x0,x1,count}；rightmost=true 只取最右邊那一團（中間空超過 gap 就斷開）
function inkExtent(ink, W, x0, y0, x1, y1, { rightmost = false, gap = 26, shear = 0, xRef = 0 } = {}) {
  x0 = Math.max(0, Math.round(x0));
  x1 = Math.min(W - 1, Math.round(x1));
  const H = ink.length / W;
  const cols = new Uint16Array(Math.max(0, x1 - x0 + 1));
  let count = 0;
  for (let x = x0; x <= x1; x++) {
    let n = 0;
    // 這一列的字是斜的時，y 範圍隨 x 移動
    const dy = shear * (x - xRef);
    const ya = Math.max(0, Math.round(y0 + dy));
    const yb = Math.min(H - 1, Math.round(y1 + dy));
    for (let y = ya; y <= yb; y++) n += ink[y * W + x];
    cols[x - x0] = n;
    count += n;
  }
  if (!count) return { count: 0 };
  let a = -1;
  let b = -1;
  for (let i = 0; i < cols.length; i++)
    if (cols[i]) {
      if (a < 0) a = i;
      b = i;
    }
  if (rightmost) {
    let run = 0;
    let i = b;
    for (; i >= a; i--) {
      if (cols[i]) run = 0;
      else if (++run > gap) break;
    }
    const start = Math.max(a, i + run + 1);
    if (b - start >= 20) a = start;
  }
  return { count, x0: x0 + a, x1: x0 + b };
}

/**
 * 把多格貼成一條直的長圖（格與格之間留白），OCR 一次讀完，再用每行的座標分回各格。
 * cells: [{ idx, x0, y0, x1, y1 }]（表格座標）
 */
function stripOf(bin, cells, { scale, gap = 40, pad = 10 }) {
  const margin = 24;
  const items = cells.map((c) => ({ ...c, w: Math.round((c.x1 - c.x0 + 1) * scale), h: Math.round((c.y1 - c.y0 + 1 + pad * 2) * scale) }));
  const W = Math.max(60, ...items.map((i) => i.w)) + margin * 2;
  const H = items.reduce((t, i) => t + i.h + gap, gap);
  const c = canvasOf(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, H);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  let y = gap;
  const slots = [];
  for (const it of items) {
    // 這格的字可能是斜的（右邊比左邊高或低）：畫的時候用 y 方向的剪切把它扳平，格子以外裁掉
    const sh = it.shear || 0;
    const xr = it.xRef || 0;
    const srcW = it.x1 - it.x0 + 1;
    const top0 = it.y0 - pad + sh * (it.x0 - xr); // 格子左緣的上緣
    g.save();
    g.beginPath();
    g.rect(margin, y, it.w, it.h);
    g.clip();
    g.setTransform(scale, -sh * scale, 0, scale, margin - scale * it.x0, y - scale * top0 + sh * scale * it.x0);
    const span = Math.abs(sh) * srcW + 2;
    const srcY = Math.floor(Math.min(top0, top0 + sh * srcW) - 2);
    const srcH = Math.ceil(it.y1 - it.y0 + 1 + pad * 2 + span * 2 + 4);
    g.drawImage(bin, it.x0, srcY, srcW, srcH, it.x0, srcY, srcW, srcH);
    g.restore();
    // 長條圖座標 → 表格座標：x = (sx - margin) / scale + x0
    slots.push({ idx: it.idx, y0: y, y1: y + it.h, x0: it.x0, scale, margin });
    y += it.h + gap;
  }
  return { canvas: c, slots };
}

/**
 * 辨識一條長圖；回傳 Map(idx → { text, conf, words:[{ text, conf, x0, x1 }] })，x 為表格座標
 */
async function ocrStrip(worker, strip, { whitelist = '', psm = '6' }) {
  if (!strip.slots.length) return new Map();
  const blob = await new Promise((r) => strip.canvas.toBlob(r, 'image/png'));
  await worker.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: whitelist, preserve_interword_spaces: '1' });
  let data;
  try {
    ({ data } = await worker.recognize(blob, {}, { text: true, blocks: true }));
  } finally {
    await worker.setParameters({ tessedit_char_whitelist: '', preserve_interword_spaces: '0', tessedit_pageseg_mode: '3' });
  }
  const out = new Map();
  const lines = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) lines.push(l);
  for (const l of lines) {
    const cy = (l.bbox.y0 + l.bbox.y1) / 2;
    let slot = strip.slots.find((s) => cy >= s.y0 - 6 && cy <= s.y1 + 6);
    if (!slot) slot = strip.slots.reduce((a, s) => (Math.abs((s.y0 + s.y1) / 2 - cy) < Math.abs((a.y0 + a.y1) / 2 - cy) ? s : a));
    const toX = (sx) => (sx - slot.margin) / slot.scale + slot.x0;
    const words = (l.words || [])
      .map((w) => ({ text: (w.text || '').trim(), conf: w.confidence || 0, x0: toX(w.bbox.x0), x1: toX(w.bbox.x1) }))
      .filter((w) => w.text);
    if (!words.length) continue;
    const cur = out.get(slot.idx) || { text: '', conf: 100, words: [] };
    cur.words.push(...words);
    cur.words.sort((a, b) => a.x0 - b.x0);
    cur.text = cur.words.map((w) => w.text).join(' ');
    cur.conf = Math.min(cur.conf, ...words.map((w) => w.conf));
    out.set(slot.idx, cur);
  }
  return out;
}

// ─────────── 字的種類

const stripNoise = (t) => t.replace(/[^\d,.*xX%]/g, '');
const HAN = /\p{Script=Han}/u;
const MONEY_WORD = /^[*xX%¥£«+#]\s?\d|\d[,.]\d{2,3}/; // 純數字（日期、帳號）不算金額
/** 看起來是印的金額：有星號／幣別符號開頭，或「數字,數字」「數字.數字」 */
export const looksMoney = (t) => /\d{2,}/.test(t) && !/[\p{Script=Han}(（)）]/u.test(t) && MONEY_WORD.test(t);
const looksDigits = (t) => !HAN.test(t) && (t.replace(/\D/g, '').length >= 5 || /^[\d|lIO]{2,}$/.test(t));
const looksMemo = (t) => /[(（《)）》]/.test(t) || HAN.test(t);

/** 金額文字：有清楚的「.兩位小數」就切到那裡（溢到隔壁欄的字會變成尾巴的雜訊）；否則整段交給候選值推算 */
export function firstMoney(text) {
  const t = String(text || '').replace(/\s+/g, '');
  const m = /(\d[\d,]*)\.(\d{2})(?!\d)/.exec(t);
  if (m) return `${m[1]}.${m[2]}`;
  return stripNoise(t).replace(/^[^\d*]+/, '');
}

// 一個「字」裡有兩個金額（*15.00 *358,220.00 黏在一起）：依字元位置拆開
const MONEY_PARTS = /[*xX%¥£«+#]?\d[\d,]*(?:\.\d{1,2})?/g;
function splitMoney(w) {
  const parts = [...w.text.matchAll(MONEY_PARTS)].filter((m) => /\d{2,}/.test(m[0]));
  if (parts.length < 2) return [w];
  const n = w.text.length;
  return parts.map((m) => ({ text: m[0], conf: w.conf, x0: w.x0 + ((w.x1 - w.x0) * m.index) / n, x1: w.x0 + ((w.x1 - w.x0) * (m.index + m[0].length)) / n }));
}

/** 相鄰很近（不到 gap 像素）、都是數字或金額的字合併成一個 */
export function mergeClose(words, gap) {
  const out = [];
  for (const w of words) {
    const last = out[out.length - 1];
    const numeric = (t) => !HAN.test(t) && /\d/.test(t);
    // 兩段都像金額（*371, ＋ 451.00）時容許更大的縫（中間可能有沒讀到的字）
    const g = looksMoney(last?.text || '') && looksMoney(w.text) ? gap * 2.5 : gap;
    if (last && numeric(last.text) && numeric(w.text) && w.x0 - last.x1 < g) {
      last.text += w.text;
      last.x1 = Math.max(last.x1, w.x1);
      last.conf = Math.min(last.conf, w.conf);
    } else out.push({ ...w });
  }
  return out;
}

/**
 * 依字的種類與順序把一列的字分成：日期、摘要、金額、備註說明（括號）、結存、備註。
 * @param words 已依 x 排序 [{text,x0,x1,conf}]
 * @param xs 這一列的八條欄線位置（只當參考）
 * @param W 表格寬
 */
export function assignWords(words, xs, W) {
  const tol = W * 0.045;
  const out = { date: [], summary: [], amount: [], memo: [], bal: [], note: [], side: null, sideSure: false };
  let i = 0;
  // 日期：開頭的數字串（可能被拆成兩截），要在摘要欄右線之前
  while (i < words.length && looksDigits(words[i].text) && words[i].x1 < xs[3] && !looksMoney(words[i].text)) out.date.push(words[i++]);
  // 摘要：到第一個金額／括號說明為止，而且不超過摘要欄右線太多
  while (i < words.length) {
    const w = words[i];
    if (looksMoney(w.text) || /[(（《]/.test(w.text) || w.x0 > xs[3] + tol) break;
    if (HAN.test(w.text) && w.x0 > xs[3] - tol) break;
    out.summary.push(w);
    i++;
  }
  const rest = words.slice(i);
  const moneys = rest.filter((w) => looksMoney(w.text));
  // 結存：最後一個金額（備註裡不會有金額）
  const bal = moneys.length ? moneys[moneys.length - 1] : null;
  if (bal) out.bal.push(bal);
  const others = rest.filter((w) => w !== bal);
  for (const w of others) {
    if (bal && w.x0 >= bal.x1 - 2) out.note.push(w);
    else if (!bal && w.x0 >= xs[6] - tol && !looksMoney(w.text)) out.note.push(w);
    else if (looksMoney(w.text)) out.amount.push(w);
    else if (looksMemo(w.text) || w.x0 < (bal ? bal.x0 : xs[5])) out.memo.push(w);
    else out.note.push(w);
  }
  // 支出或存入：金額印在說明的左邊＝支出，右邊＝存入；沒有說明就看位置（相對支出／存入分隔線）
  if (out.amount.length) {
    const a = out.amount[0];
    const memo = out.memo[0];
    if (memo) {
      out.side = a.x1 <= memo.x0 + 4 ? 'out' : 'in';
      out.sideSure = true;
    } else {
      const xc = (a.x0 + a.x1) / 2;
      out.side = xc < xs[4] ? 'out' : 'in';
      out.sideSure = Math.abs(xc - xs[4]) > W * 0.08;
    }
  }
  return out;
}

/**
 * 讀一張存摺照片：攤平、分格、辨識。
 * @param blob 照片
 * @returns { ok, why?, rows:[{ idx, y0, y1, cells:{date,summary,memo,amount,bal,note,date_num,summary_kind,amount_num,bal_num}, side, sideSure, conf, thumb }], size, deg }
 */
export async function readPassbookTable(blob, { onStep, thumbWidth = 1000, debugStrips = null } = {}) {
  const bmp = await createImageBitmap(blob);
  try {
    const rect = await rectifyPassbook(bmp, { onStep });
    if (!rect.ok) return { ok: false, why: rect.why, rows: [] };
    onStep?.('分欄分列');
    const { table, canvas } = rect;
    const W = table.width;
    const H = table.height;
    const lay = layoutTable(table);
    const debug = { stage1: { aligned: rect.aligned, matched: rect.matched, v: rect.vlines, h: rect.hlines }, stage2: { v: (lay.vlines || []).map((l) => [Math.round(l.mid), Math.round(l.strength)]), xs: lay.xs?.map(Math.round), h: (lay.hlines || []).map((l) => [Math.round(l.mid), Math.round(l.strength)]), region: lay.region, matched: lay.matched } };
    if (!lay.ok) return { ok: false, why: lay.why, rows: [], debug, canvas };
    if (!lay.rows.length) return { ok: false, why: '表格裡沒有讀到任何一列', rows: [], debug, canvas };
    const bin = binaryCanvas(lay.ink, W, H);
    const hs = lay.rows.map((r) => r.y1 - r.y0 + 1).sort((a, b) => a - b);
    const medH = hs[Math.floor(hs.length / 2)];
    const scale = Math.min(2.5, Math.max(0.6, 44 / medH));
    const pad = Math.max(6, Math.round(medH * 0.25));
    const worker = await ocrWorker();
    const rows = lay.rows.map((r, idx) => ({ idx, y0: r.y0, y1: r.y1, shear: r.shear, xRef: r.xRef, xs: r.xs, shear: r.shear || 0, xRef: r.xRef || 0, cells: {}, conf: {}, side: null, sideSure: false }));
    const strips = {};
    const keepStrip = (key, strip) => {
      if (debugStrips?.includes(key)) strips[key] = strip.canvas.toDataURL('image/png');
    };
    const total = 5;
    let step = 0;
    const tick = (what) => onStep?.(`辨識 ${what}（${++step}/${total}）`);
    // 1. 整列一起讀（框線左邊多留一點：日期常印到列號欄）
    tick('整列文字');
    const rowCells = rows
      .map((r) => {
        const e = inkExtent(lay.ink, W, Math.max(0, Math.round(r.xs[0] - W * 0.04)), r.y0, Math.min(W - 1, Math.round(r.xs[7] + W * 0.01)), r.y1, { shear: r.shear, xRef: r.xRef });
        return e.count >= 6 ? { idx: r.idx, x0: Math.max(0, e.x0 - 6), x1: Math.min(W - 1, e.x1 + 6), y0: r.y0, y1: r.y1, shear: r.shear, xRef: r.xRef } : null;
      })
      .filter(Boolean);
    const wideStrip = stripOf(bin, rowCells, { scale, pad });
    keepStrip('row', wideStrip);
    const wide = await ocrStrip(worker, wideStrip, {});
    const dateCells = [];
    const summaryCells = [];
    const moneyCells = [];
    const range = (ws) => ({ x0: Math.max(0, Math.round(Math.min(...ws.map((w) => w.x0)) - 8)), x1: Math.min(W - 1, Math.round(Math.max(...ws.map((w) => w.x1)) + 8)) });
    for (const r of rows) {
      const v = wide.get(r.idx);
      if (!v) continue;
      const words = mergeClose(v.words.sort((a, b) => a.x0 - b.x0), Math.max(12, medH * 0.5)).flatMap(splitMoney);
      const a = assignWords(words, r.xs, W);
      const text = (ws) => ws.map((w) => w.text).join(' ');
      const conf = (ws) => (ws.length ? Math.min(...ws.map((w) => w.conf)) : undefined);
      r.cells = { date: text(a.date), summary: text(a.summary), memo: text(a.memo), amount: text(a.amount), bal: text(a.bal), note: text(a.note), raw: v.text };
      r.conf = { date: conf(a.date), summary: conf(a.summary), memo: conf(a.memo), amount: conf(a.amount), bal: conf(a.bal), note: conf(a.note) };
      r.side = a.side;
      r.sideSure = a.sideSure;
      if (a.date.length) dateCells.push({ idx: r.idx, ...range(a.date), y0: r.y0, y1: r.y1, shear: r.shear, xRef: r.xRef });
      if (a.summary.length) summaryCells.push({ idx: r.idx, ...range(a.summary), y0: r.y0, y1: r.y1, shear: r.shear, xRef: r.xRef });
      if (a.amount.length) moneyCells.push({ idx: r.idx, key: 'amount', ...range(a.amount), y0: r.y0, y1: r.y1, shear: r.shear, xRef: r.xRef });
      if (a.bal.length) moneyCells.push({ idx: r.idx, key: 'bal', ...range(a.bal), y0: r.y0, y1: r.y1, shear: r.shear, xRef: r.xRef });
    }
    // 3. 摘要：限定交易別的字
    tick('摘要');
    {
      const st = stripOf(bin, summaryCells, { scale, pad });
      for (const [idx, v] of await ocrStrip(worker, st, { whitelist: SUMMARY })) {
        rows[idx].cells.summary_kind = v.text;
        rows[idx].conf.summary_kind = v.conf;
      }
    }
    // 3b. 另外用欄位裁切再讀一次結存（結存欄，取最右邊那團墨水）與金額（支出＋存入欄）：
    //     整列辨識有時把結存拆掉或漏掉，兩種讀法都當候選值交給帳鏈挑；日期沒找到的也用欄位裁切
    const tol = W * 0.045;
    const m2 = Math.max(3, Math.round(W / 700));
    for (const r of rows) {
      const c = r.cells;
      const e = inkExtent(lay.ink, W, r.xs[5] - tol, r.y0, r.xs[6] - m2, r.y1, { rightmost: true, shear: r.shear, xRef: r.xRef });
      if (e.count >= 6) moneyCells.push({ idx: r.idx, key: 'bal', x0: Math.max(0, e.x0 - 6), x1: Math.min(W - 1, e.x1 + 6), y0: r.y0, y1: r.y1, shear: r.shear, xRef: r.xRef, fallback: true });
      for (const [ci, side] of [[3, 'out'], [4, 'in']]) {
        const e2 = inkExtent(lay.ink, W, r.xs[ci] - tol, r.y0, r.xs[ci + 1] - m2, r.y1, { rightmost: true, shear: r.shear, xRef: r.xRef });
        if (e2.count >= 6) moneyCells.push({ idx: r.idx, key: 'amount', side, x0: Math.max(0, e2.x0 - 6), x1: Math.min(W - 1, e2.x1 + 6), y0: r.y0, y1: r.y1, shear: r.shear, xRef: r.xRef, fallback: true });
      }
      if (!c.date) {
        const e = inkExtent(lay.ink, W, Math.max(0, Math.round(r.xs[0] - W * 0.04)), r.y0, Math.round(r.xs[2] + W * 0.02), r.y1, { shear: r.shear, xRef: r.xRef });
        if (e.count >= 6) dateCells.push({ idx: r.idx, x0: e.x0 - 6, x1: Math.min(W - 1, e.x1 + 6), y0: r.y0, y1: r.y1, shear: r.shear, xRef: r.xRef, fallback: true });
      }
    }
    // 4. 金額、結存：只讀數字（精準）
    tick('金額數字');
    {
      const st = stripOf(bin, moneyCells.map((c, i) => ({ ...c, idx: i })), { scale, pad });
      keepStrip('money', st);
      for (const [i, v] of await ocrStrip(worker, st, { whitelist: MONEY })) {
        const c = moneyCells[i];
        const r = rows[c.idx];
        if (c.fallback) {
          // 欄位裁切讀到的：要像金額（有千分位或小數）才採用，放進 _alt 當另一組候選值
          const t = firstMoney(v.text);
          if (!/\d,\d{3}|\d\.\d{2}/.test(t) || !/\d{3,}/.test(t)) continue;
          if (c.key === 'amount') {
            // 支出欄與存入欄都讀到時，以整列辨識判定的方向為準；沒有判定就兩個都留著
            if (r.side && r.sideSure && r.side !== c.side) continue;
            if (!r.side) {
              r.side = c.side;
              r.sideSure = false;
            }
          }
          r.cells[c.key + '_alt'] = r.cells[c.key + '_alt'] ? r.cells[c.key + '_alt'] + ' ' + t : t;
          r.conf[c.key + '_alt'] = v.conf;
          if (!r.cells[c.key]) r.cells[c.key] = v.text;
          continue;
        }
        r.cells[c.key + '_num'] = firstMoney(v.text);
        r.conf[c.key + '_num'] = v.conf;
      }
    }
    // 5. 日期：只讀數字
    tick('日期');
    {
      const st = stripOf(bin, dateCells, { scale, pad });
      keepStrip('date', st);
      for (const [idx, v] of await ocrStrip(worker, st, { whitelist: DIGITS })) {
        rows[idx].cells.date_num = v.text.replace(/\s+/g, '');
        rows[idx].conf.date_num = v.conf;
        rows[idx].cells.date = rows[idx].cells.date || v.text;
      }
    }
    // 縮圖：每列切一條，寬度統一
    const tw = Math.min(thumbWidth, W);
    const ts = tw / W;
    for (const r of rows) {
      const y0 = Math.max(0, r.y0 - pad);
      const y1 = Math.min(H - 1, r.y1 + pad);
      const c = canvasOf(tw, Math.max(8, Math.round((y1 - y0 + 1) * ts)));
      const g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      // 斜的列扳平再縮
      const sh = r.shear || 0;
      const top0 = y0 - sh * (r.xRef || 0); // x=0 處的上緣
      g.setTransform(ts, -sh * ts, 0, ts, 0, -ts * top0);
      const span = Math.abs(sh) * W + 2;
      const srcY = Math.floor(Math.min(top0, top0 + sh * W) - 2);
      const srcH = Math.ceil(y1 - y0 + 1 + span * 2 + 4);
      g.drawImage(canvas, 0, srcY, W, srcH, 0, srcY, W, srcH);
      g.setTransform(1, 0, 0, 1, 0, 0);
      r.thumb = c.toDataURL('image/jpeg', 0.82);
    }
    const digits = (t) => (t || '').replace(/\D/g, '').length;
    const han = (t) => ((t || '').match(/\p{Script=Han}/gu) || []).length;
    const keep = (r) => {
      const c = r.cells;
      return digits(c.bal_num) >= 4 || digits(c.bal_alt) >= 4 || digits(c.amount_num) >= 3 || digits(c.amount_alt) >= 3 || (digits(c.date_num) >= 4 && (han(c.summary_kind || c.summary) >= 2 || han(c.memo) >= 2));
    };
    return { ok: true, deg: rect.deg, rows: rows.filter(keep).map(({ idx, y0, y1, xs, cells, conf, side, sideSure, thumb }) => ({ idx, y0, y1, xs, cells, conf, side, sideSure, thumb })), size: { W, H }, debug, canvas, strips };
  } finally {
    bmp.close?.();
  }
}

export { colorMasks, COLUMN_KEYS };
