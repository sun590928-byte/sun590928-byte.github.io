// 存摺照片的表格幾何：找出表格線 → 用四個角把照片攤平成正的表格 → 定出欄位與每一列的位置。
// 純計算（只處理像素陣列，不碰 DOM），可在 Node 測試；畫布、OCR 在 vision.js / passbookvision.js。
//
// 淡水信用合作社的存摺內頁：八條直線分出 列號｜日期｜摘要｜支出金額｜存入金額｜結存金額｜備註，上下各有橫線；
// 字是黑色點陣印字，手寫註記是藍筆，底紋浮水印很淡。表格線在照片裡常常不是綠色（白平衡偏掉），
// 所以不用顏色找線，改用「又細又長的深色線」。

const lumOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

/**
 * 把 RGBA 像素分成：亮度、藍色（手寫）。
 * @param img {width,height,data}
 */
export function colorMasks(img) {
  const { width: W, height: H, data: d } = img;
  const lum = new Uint8Array(W * H);
  const blue = new Uint8Array(W * H);
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    const r = d[i];
    const g = d[i + 1];
    const b = d[i + 2];
    lum[p] = lumOf(r, g, b);
    if (b - r > 25 && b >= g - 4) blue[p] = 1;
  }
  return { W, H, lum, blue };
}

/** 積分影像（Float64），I[(y+1)*(W+1)+x+1] = 左上角到 (x,y) 的總和 */
export function integral(src, W, H) {
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    const o = y * W;
    const io = (y + 1) * (W + 1);
    const ip = y * (W + 1);
    for (let x = 0; x < W; x++) {
      row += src[o + x];
      I[io + x + 1] = I[ip + x + 1] + row;
    }
  }
  return I;
}

const boxSum = (I, W, x0, y0, x1, y1) => I[(y1 + 1) * (W + 1) + x1 + 1] - I[y0 * (W + 1) + x1 + 1] - I[(y1 + 1) * (W + 1) + x0] + I[y0 * (W + 1) + x0];

/**
 * 自適應二值化：比周圍 (2R+1)² 區塊平均暗 k 倍以下的像素才算「深色」。藍筆不算。
 * @returns Uint8Array（1＝深色）
 */
export function darkMask({ W, H, lum, blue }, { radius = null, k = 0.72 } = {}) {
  const R = radius || Math.max(8, Math.round(Math.max(W, H) / 60));
  const I = integral(lum, W, H);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    const y0 = Math.max(0, y - R);
    const y1 = Math.min(H - 1, y + R);
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (blue[p]) continue;
      const x0 = Math.max(0, x - R);
      const x1 = Math.min(W - 1, x + R);
      const mean = boxSum(I, W, x0, y0, x1, y1) / ((x1 - x0 + 1) * (y1 - y0 + 1));
      if (lum[p] < mean * k) out[p] = 1;
    }
  }
  return out;
}

/**
 * 細長線的像素：沿 axis 方向、允許小縫隙、連續 minLen 以上的深色像素（兩側各看一格，容許微斜），
 * 而且兩旁 half 格外都是淺色（粗線、陰影邊緣不算）。字的筆畫短、不會被當成線。
 */
export function lineMask(dark, W, H, { axis = 'v', minLen, gap = 4, maxThick = 7 } = {}) {
  const out = new Uint8Array(W * H);
  const along = axis === 'v' ? H : W;
  const across = axis === 'v' ? W : H;
  const at = axis === 'v' ? (a, c) => a * W + c : (a, c) => c * W + a; // (along, across) → index
  const half = Math.ceil(maxThick / 2);
  const on = new Uint8Array(along);
  for (let c = 0; c < across; c++) {
    for (let a = 0; a < along; a++) {
      on[a] = dark[at(a, c)] || (c > 0 && dark[at(a, c - 1)]) || (c + 1 < across && dark[at(a, c + 1)]) ? 1 : 0;
    }
    const mark = (from, to) => {
      if (to - from + 1 < minLen) return;
      for (let a = from; a <= to; a++) {
        const p = at(a, c);
        if (!dark[p]) continue;
        const l = c - half >= 0 ? dark[at(a, c - half)] : 0;
        const r = c + half < across ? dark[at(a, c + half)] : 0;
        if (l || r) continue;
        out[p] = 1;
      }
    };
    let s = -1;
    let miss = 0;
    for (let a = 0; a <= along; a++) {
      const v = a < along ? on[a] : 0;
      if (v) {
        if (s < 0) s = a;
        miss = 0;
      } else if (s >= 0) {
        if (++miss > gap || a === along) {
          mark(s, a - miss);
          s = -1;
          miss = 0;
        }
      }
    }
  }
  return out;
}

/** 一維投影裡的峰：高於 thr 且在 ±minSep/2 內最大；回傳重心位置 */
export function peaks1D(profile, { thr, minSep = 6 } = {}) {
  const n = profile.length;
  const half = Math.max(1, Math.round(minSep / 2));
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = profile[i];
    if (v < thr) continue;
    let isMax = true;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) if (profile[j] > v || (profile[j] === v && j < i)) isMax = false;
    if (!isMax) continue;
    let sw = 0;
    let sx = 0;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) {
      sw += profile[j];
      sx += profile[j] * j;
    }
    out.push({ at: sw ? sx / sw : i, strength: v });
  }
  return out;
}

/**
 * 找直的表格線（沿各種角度投影，整條線加總，中間斷掉也沒關係）。
 * axis='v'：直線 x = mid + a·(y − center)；axis='h'：橫線 y = mid + a·(x − center)。
 * @param mask lineMask 的結果（只有線的像素）
 * @param box  只看這個範圍 {x0,y0,x1,y1}
 * @returns [{ axis, a, mid, center, strength, at(t) }]（依 mid 排序）
 */
export function findRules(mask, W, H, { axis = 'v', thr, maxDeg = 8, stepDeg = 0.5, minGap = 8, box = null } = {}) {
  const bx0 = box ? box.x0 : 0;
  const by0 = box ? box.y0 : 0;
  const bx1 = box ? box.x1 : W - 1;
  const by1 = box ? box.y1 : H - 1;
  const pts = [];
  for (let y = by0; y <= by1; y++) {
    const o = y * W;
    for (let x = bx0; x <= bx1; x++) if (mask[o + x]) pts.push(axis === 'v' ? x : y, axis === 'v' ? y : x);
  }
  const across = axis === 'v' ? W : H; // 投影軸的長度
  const alongLen = axis === 'v' ? by1 - by0 + 1 : bx1 - bx0 + 1;
  const center = axis === 'v' ? (by0 + by1) / 2 : (bx0 + bx1) / 2;
  const threshold = thr ?? alongLen * 0.2;
  const found = [];
  for (let deg = -maxDeg; deg <= maxDeg + 1e-9; deg += stepDeg) {
    const t = Math.tan((deg * Math.PI) / 180);
    const bins = new Float32Array(across + 2);
    for (let i = 0; i < pts.length; i += 2) {
      const b = Math.round(pts[i] - (pts[i + 1] - center) * t); // 投影到中線位置
      if (b >= 0 && b < across) bins[b] += 1;
    }
    const sm = new Float32Array(across);
    for (let i = 0; i < across; i++) sm[i] = bins[i] + (i > 0 ? bins[i - 1] : 0) + (i + 1 < across ? bins[i + 1] : 0);
    for (const pk of peaks1D(sm, { thr: threshold, minSep: minGap })) found.push({ mid: pk.at, a: t, strength: pk.strength });
  }
  // 同一條線在相近角度都會出峰：留最強的
  found.sort((p, q) => q.strength - p.strength);
  const kept = [];
  for (const f of found) if (!kept.some((k) => Math.abs(k.mid - f.mid) < minGap)) kept.push(f);
  return kept.map((l) => ({ axis, a: l.a, mid: l.mid, center, strength: l.strength, at: (t) => l.mid + l.a * (t - center) })).sort((p, q) => p.mid - q.mid);
}

/** 兩條線的交點：v: x = mv + av·(y − cv)，h: y = mh + ah·(x − ch) */
export function intersect(v, h) {
  const x = (v.mid + v.a * (h.mid - h.a * h.center - v.center)) / (1 - v.a * h.a);
  return { x, y: h.at(x) };
}

/** 四點對應的投影轉換（DLT），回傳 3×3（列優先） */
export function homography(src, dst) {
  const A = [];
  const B = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    B.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    B.push(v);
  }
  const h = solve(A, B);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

function solve(A, B) {
  const n = B.length;
  const M = A.map((row, i) => [...row, B[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / d;
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

export function applyH(m, x, y) {
  const w = m[6] * x + m[7] * y + m[8];
  return { x: (m[0] * x + m[1] * y + m[2]) / w, y: (m[3] * x + m[4] * y + m[5]) / w };
}

/**
 * 以投影轉換把原圖攤平：輸出的每個像素反查原圖（雙線性內插）。
 * @param src {width,height,data(RGBA)}
 * @param Hinv 輸出座標 → 原圖座標
 */
export function warp(src, Hinv, outW, outH) {
  const { width: SW, height: SH, data: s } = src;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = Hinv;
  for (let v = 0; v < outH; v++) {
    for (let u = 0; u < outW; u++) {
      const w = m6 * u + m7 * v + m8;
      const x = (m0 * u + m1 * v + m2) / w;
      const y = (m3 * u + m4 * v + m5) / w;
      const o = (v * outW + u) * 4;
      if (x < 0 || y < 0 || x >= SW - 1 || y >= SH - 1) {
        out[o] = out[o + 1] = out[o + 2] = 255;
        out[o + 3] = 255;
        continue;
      }
      const x0 = x | 0;
      const y0 = y | 0;
      const fx = x - x0;
      const fy = y - y0;
      const i00 = (y0 * SW + x0) * 4;
      const i10 = i00 + 4;
      const i01 = i00 + SW * 4;
      const i11 = i01 + 4;
      for (let c = 0; c < 3; c++) out[o + c] = (s[i00 + c] * (1 - fx) + s[i10 + c] * fx) * (1 - fy) + (s[i01 + c] * (1 - fx) + s[i11 + c] * fx) * fy;
      out[o + 3] = 255;
    }
  }
  return { width: outW, height: outH, data: out };
}

/** 一維投影裡連續高於 thr 的區段 [s, e]；短於 minLen 的丟掉、相隔小於 mergeGap 的合併 */
export function bands1D(profile, { thr, minLen = 3, mergeGap = 0 } = {}) {
  const out = [];
  let s = -1;
  for (let i = 0; i <= profile.length; i++) {
    const on = i < profile.length && profile[i] >= thr;
    if (on && s < 0) s = i;
    if (!on && s >= 0) {
      if (out.length && s - out[out.length - 1][1] - 1 <= mergeGap) out[out.length - 1][1] = i - 1;
      else out.push([s, i - 1]);
      s = -1;
    }
  }
  return out.filter(([a, b]) => b - a + 1 >= minLen);
}

// 淡信存摺內頁的八條直線（左框線＝0、右框線＝1）：列號｜日期｜摘要｜支出金額｜存入金額｜結存金額｜備註
export const COLUMN_FRACS = [0, 0.031, 0.119, 0.283, 0.473, 0.673, 0.885, 1];
export const COLUMN_KEYS = ['no', 'date', 'summary', 'out', 'in', 'bal', 'note'];

/**
 * 把偵測到的直線位置對齊到八條線：任兩條偵測到的線當作某兩條已知線，推出全部位置，看有幾條對得上
 * （一條偵測到的線只能對一條已知線）；對得上最多的那組為準，缺的線用推算位置補。
 * @returns { ok, xs:[8], matched, scale }
 */
export function alignRules(input, { fracs = COLUMN_FRACS, minMatch = 4, tolFrac = 0.025 } = {}) {
  const items = input.map((v) => (typeof v === 'number' ? { mid: v, strength: 1 } : v));
  const mids = items.map((l) => l.mid);
  const weight = new Map(items.map((l) => [l.mid, Math.sqrt(Math.max(1, l.strength))]));
  const n = fracs.length;
  let best = null;
  for (let i = 0; i < mids.length; i++)
    for (let j = i + 1; j < mids.length; j++)
      for (let a = 0; a < n; a++)
        for (let b = a + 1; b < n; b++) {
          const scale = (mids[j] - mids[i]) / (fracs[b] - fracs[a]);
          if (!(scale > 0)) continue;
          const x0 = mids[i] - fracs[a] * scale;
          const tol = scale * tolFrac;
          const used = new Set();
          let matched = 0;
          let score = 0;
          const snapped = fracs.map((f) => {
            const x = x0 + f * scale;
            let hit = null;
            for (const m of mids) if (!used.has(m) && Math.abs(m - x) <= tol && (hit === null || Math.abs(m - x) < Math.abs(hit - x))) hit = m;
            if (hit !== null) {
              used.add(hit);
              matched++;
              score += weight.get(hit) * (1 - (Math.abs(hit - x) / tol) ** 2);
            }
            return hit ?? x;
          });
          if (matched >= 2 && (!best || score > best.score)) best = { matched, score, scale, xs: snapped };
        }
  if (!best || best.matched < minMatch) return { ok: false, xs: null, matched: best?.matched || 0 };
  return { ok: true, xs: best.xs, matched: best.matched, scale: best.scale, score: best.score };
}

const medianOf = (arr) => {
  const a = [...arr].sort((p, q) => p - q);
  return a.length ? a[Math.floor(a.length / 2)] : 0;
};

/** 只留明顯的線：強度至少是最強那條的 ratio 倍 */
export function strongLines(lines, ratio = 0.3) {
  const max = Math.max(0, ...lines.map((l) => l.strength));
  return lines.filter((l) => l.strength >= max * ratio);
}

/**
 * 第一階段：在縮小的照片上找最明顯的直線與橫線，用最外側的兩條直線、最上下的兩條橫線定出四個角。
 * 不需要知道是哪幾條線：攤平後所有線都會變成直的、間距回到印刷的比例，第二階段再對齊八條線。
 * @returns { ok, why, corners:[tl,tr,br,bl], vlines, hlines, W, H }
 */
export function detectTable(img) {
  const m = colorMasks(img);
  const { W, H } = m;
  const dark = darkMask(m, { k: 0.85 });
  const vmask = lineMask(dark, W, H, { axis: 'v', minLen: Math.max(10, Math.round(H / 45)) });
  const all = findRules(vmask, W, H, { axis: 'v', thr: H * 0.18, minGap: Math.max(6, W / 120) });
  const vl = strongLines(all, 0.35);
  if (vl.length < 3) return { ok: false, why: `只找到 ${vl.length} 條直線`, vlines: vl, hlines: [], W, H };
  // 粗略對齊八條線（容許 5%）：框的左右邊界用推算出的框線位置，斜度依各線斜度對 x 線性外推（透視下斜度會漸變）
  const al = alignRules(all.slice().sort((p, q) => q.strength - p.strength).slice(0, 16), { minMatch: 5, tolFrac: 0.04 });
  const slopeAt = (x) => {
    const pts = al.ok ? al.xs.map((xx) => all.find((l) => Math.abs(l.mid - xx) < 0.5)).filter(Boolean) : vl;
    if (pts.length < 3) return medianOf(pts.map((l) => l.a));
    const n = pts.length;
    const sx = pts.reduce((t, l) => t + l.mid, 0);
    const sa = pts.reduce((t, l) => t + l.a, 0);
    const sxx = pts.reduce((t, l) => t + l.mid * l.mid, 0);
    const sxa = pts.reduce((t, l) => t + l.mid * l.a, 0);
    const den = n * sxx - sx * sx;
    const m = den ? (n * sxa - sx * sa) / den : 0;
    return m * x + (sa - m * sx) / n;
  };
  const synth = (x) => all.find((l) => Math.abs(l.mid - x) < 0.5) || { a: slopeAt(x), mid: x, center: H / 2, at: (t) => x + slopeAt(x) * (t - H / 2) };
  let left;
  let right;
  if (al.ok) {
    const pad = al.scale * 0.06;
    left = synth(al.xs[0] - pad);
    right = synth(al.xs[7] + pad);
  } else {
    const pad = (vl[vl.length - 1].mid - vl[0].mid) * 0.45;
    left = synth(vl[0].mid - pad);
    right = synth(vl[vl.length - 1].mid + pad);
  }
  const x0 = Math.round(Math.min(left.at(0), left.at(H - 1)));
  const x1 = Math.round(Math.max(right.at(0), right.at(H - 1)));
  const box = { x0: Math.max(0, x0), y0: 0, x1: Math.min(W - 1, x1), y1: H - 1 };
  const hmask = lineMask(dark, W, H, { axis: 'h', minLen: Math.max(10, Math.round(W / 45)) });
  const hl = strongLines(findRules(hmask, W, H, { axis: 'h', thr: (box.x1 - box.x0) * 0.4, minGap: Math.max(6, H / 150), box }), 0.3);
  if (hl.length < 2) return { ok: false, why: `只找到 ${hl.length} 條橫線`, vlines: vl, hlines: hl, W, H };
  const top = hl[0];
  const bottom = hl[hl.length - 1];
  const corners = [intersect(left, top), intersect(right, top), intersect(right, bottom), intersect(left, bottom)];
  const width = Math.hypot(corners[1].x - corners[0].x, corners[1].y - corners[0].y);
  const height = Math.hypot(corners[3].x - corners[0].x, corners[3].y - corners[0].y);
  if (width < W * 0.2 || height < H * 0.2) return { ok: false, why: '表格太小', vlines: vl, hlines: hl, W, H, corners };
  return { ok: true, corners, vlines: vl, hlines: hl, W, H, width, height, aligned: al.ok, matched: al.matched };
}

/**
 * 攤平後的表格：定出各欄的 x 邊界、交易列區域與每一列的 y 範圍。
 * @param img 攤平後的彩色圖
 * @returns { ok, why, cols:[{key,x0,x1}], rows:[{y0,y1}], region:{y0,y1}, ink, xs }
 */
export function layoutTable(img, { rowMinH = null } = {}) {
  const m = colorMasks(img);
  const { W, H } = m;
  const dark = darkMask(m, { k: 0.85 });
  const vmask = lineMask(dark, W, H, { axis: 'v', minLen: Math.max(10, Math.round(H / 45)) });
  const vl = findRules(vmask, W, H, { axis: 'v', thr: H * 0.15, maxDeg: 2, stepDeg: 0.25, minGap: Math.max(6, W / 120) })
    .sort((p, q) => q.strength - p.strength)
    .slice(0, 14)
    .sort((p, q) => p.mid - q.mid);
  const al = alignRules(vl, { minMatch: 5, tolFrac: 0.02 });
  if (!al.ok) return { ok: false, why: `直線只對上 ${al.matched} 條（找到 ${vl.length} 條）`, vlines: vl };
  const xs = al.xs;
  const cols = COLUMN_KEYS.map((key, i) => ({ key, x0: Math.round(xs[i]), x1: Math.round(xs[i + 1]) }));
  const hmask = lineMask(dark, W, H, { axis: 'h', minLen: Math.max(10, Math.round(W / 45)) });
  const hl = strongLines(findRules(hmask, W, H, { axis: 'h', thr: (xs[7] - xs[0]) * 0.4, maxDeg: 2, stepDeg: 0.25, minGap: Math.max(6, H / 150), box: { x0: Math.max(0, Math.round(xs[0])), y0: 0, x1: Math.min(W - 1, Math.round(xs[7])), y1: H - 1 } }), 0.3);
  const ys = hl.map((l) => l.mid);
  // 交易列在最長的兩條橫線之間
  let region = { y0: 0, y1: H - 1 };
  let best = 0;
  for (let i = 0; i + 1 < ys.length; i++) {
    const gap = ys[i + 1] - ys[i];
    if (gap > best) {
      best = gap;
      region = { y0: Math.round(ys[i]) + 3, y1: Math.min(H - 1, Math.round(ys[i + 1]) + 2) };
    }
  }
  // 攤平後欄線仍可能微彎（裝訂處紙面不平）：每條欄線沿高度逐段追蹤，得到每個 y 的實際位置
  const paths = xs.map((x, i) => {
    const near = Math.min(i > 0 ? x - xs[i - 1] : Infinity, i + 1 < xs.length ? xs[i + 1] - x : Infinity);
    const win = Math.max(8, Math.min(Math.round(W / 50), Math.round(near * 0.4)));
    return trackLine(vmask, W, H, x, { y0: 0, y1: H - 1, win, band: Math.max(40, Math.round(H / 26)) });
  });
  // 墨水：深色但去掉表格線附近的像素（沿追蹤到的路徑去 ±thin；橫線直接去）
  const ink = darkMask(m, { k: 0.72 });
  const thin = Math.max(2, Math.round(W / 700));
  for (const path of paths)
    for (let y = 0; y < H; y++) {
      const xc = Math.round(path[y]);
      for (let dx = -thin; dx <= thin; dx++) {
        const xx = xc + dx;
        if (xx >= 0 && xx < W) ink[y * W + xx] = 0;
      }
    }
  for (const y of ys)
    for (let dy = -thin; dy <= thin; dy++) {
      const yy = Math.round(y) + dy;
      if (yy < 0 || yy >= H) continue;
      ink.fill(0, yy * W, yy * W + W);
    }
  // 列：用「日期」與「結存」兩欄的墨水量來切（每一列一定有、而且是數字，高度一致）；
  // 門檻取投影的相對值，淡淡的底紋不算字
  const margin = thin + 2;
  const yEnd = Math.min(H - 1, region.y1 + Math.round(H / 70)); // 下框線下面多看一點：最後一列常印到框線上
  const count = (ci) => {
    const out = new Float32Array(H);
    for (let y = region.y0; y <= yEnd; y++) {
      const cx0 = Math.round(paths[ci][y]) + margin;
      const cx1 = Math.round(paths[ci + 1][y]) - margin;
      let n = 0;
      const o = y * W;
      for (let x = cx0; x <= cx1; x++) n += ink[o + x];
      out[y] = n;
    }
    return out;
  };
  const profD = count(1);
  const profB = count(5);
  const minH = rowMinH || Math.max(10, Math.round(H / 200));
  // 橫線去掉後，印在線上的字會被切成上下兩段：線寬大小的空隙視為同一列
  const lineGap = 2 * thin + 3;
  const single = singleHeight(profD, minH, lineGap);
  // 同一列左右兩邊的字可能不在同一高度（下半頁常是另一批列印、紙放斜了，右邊比左邊高或低半列）：
  // 由左到右逐欄估每一欄相對日期欄的位移（分段），疊加前先對齊，分列才不會左右各切到不同列
  const colX = (ci, y) => (paths[ci][y] + paths[ci + 1][y]) / 2;
  const ymid = Math.round((region.y0 + region.y1) / 2);
  const shifts = columnShifts([{ x: colX(1, ymid), prof: profD }, { x: colX(2, ymid), prof: count(2) }, { x: colX(3, ymid), prof: count(3) }, { x: colX(4, ymid), prof: count(4) }, { x: colX(5, ymid), prof: profB }], {
    y0: region.y0,
    y1: region.y1,
    win: Math.round(H / 6),
    pitch: Math.max(single * 1.4, minH * 2),
  });
  const shiftB = shifts[4];
  const prof = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const yb = Math.round(y + shiftB[y]);
    prof[y] = profD[y] + (yb >= 0 && yb < H ? profB[yb] : 0);
  }
  // 分列只看框線以內（框線下面是下一張表的表頭）
  const profIn = prof.slice();
  profIn.fill(0, region.y1 + 1);
  let bands = segmentRows(profIn, { minH, single, mergeGap: lineGap });
  // 比正常列矮很多的段是被切到一半的字（表格下緣）：不當一列
  const hs = bands.map(([a, b]) => b - a + 1).sort((x, y) => x - y);
  const med = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
  if (bands.length >= 4) bands = bands.filter(([a, b]) => b - a + 1 >= med * 0.6);
  // 最後一列印到下框線上：框線下面緊接著的墨水（最多半列高）接回最後一列
  if (bands.length) {
    const last = bands[bands.length - 1];
    if (region.y1 - last[1] <= med * 0.5) {
      const limit = Math.min(yEnd, region.y1 + Math.round(med * 0.45));
      let end = last[1];
      let gap = 0;
      for (let y = region.y1 + 1; y <= limit; y++) {
        if (prof[y] > 0) {
          end = y;
          gap = 0;
        } else if (++gap > lineGap) break;
      }
      if (end > last[1]) last[1] = end;
    }
  }
  // 列的 y 範圍以日期欄為準；shear＝每往右 1px 字的位置往下多少（負＝右邊比較高；各欄位移的最小平方直線），xRef＝日期欄中心
  const rows = bands.map(([y0, y1]) => {
    const yc = Math.round((y0 + y1) / 2);
    const xs = paths.map((path) => path[yc]);
    const pts = [1, 2, 3, 4, 5].map((ci, k) => [colX(ci, yc), shifts[k][yc]]);
    const mx = pts.reduce((t, q) => t + q[0], 0) / pts.length;
    const my = pts.reduce((t, q) => t + q[1], 0) / pts.length;
    const den = pts.reduce((t, q) => t + (q[0] - mx) ** 2, 0);
    const shear = den > 0 ? pts.reduce((t, q) => t + (q[0] - mx) * (q[1] - my), 0) / den : 0;
    return { y0, y1, xs, shear, xRef: pts[0][0] };
  });
  return { ok: true, cols, rows, region, ink, xs, paths, matched: al.matched, vlines: vl, hlines: hl };
}

/**
 * 各欄的字相對第一欄（日期欄）的垂直位移：每一段（win 高、重疊一半）由左到右逐欄找讓 prof_k(y+s) 和 prof_0(y) 最相關的 s，
 * 搜尋範圍以前一欄外推的位置為中心、不超過 ±0.4 列距（投影是週期性的，不限制會差一個列距）；
 * 相關太弱（那一欄那一段幾乎沒字）就用外推值。回傳每欄一個 Float32Array(H)：prof_k(y + shift_k[y]) 對應 prof_0(y)。
 * @param profs [{ x, prof }] 由左到右，第一個是基準欄
 */
export function columnShifts(profs, { y0, y1, win, pitch }) {
  const H = profs[0].prof.length;
  const half = Math.max(20, Math.floor(win / 2));
  const maxS = Math.max(4, Math.round(pitch * 0.4));
  const centers = [];
  for (let c = y0 + half; c <= y1 - half / 2; c += half) centers.push(c);
  if (!centers.length) centers.push(Math.round((y0 + y1) / 2));
  const base = profs[0].prof;
  const perWin = centers.map((c) => {
    const ya = Math.max(y0, c - half);
    const yb = Math.min(y1, c + half);
    const out = [0];
    for (let k = 1; k < profs.length; k++) {
      const pk = profs[k].prof;
      const dx = profs[k].x - profs[0].x;
      const dxPrev = profs[k - 1].x - profs[0].x;
      const pred = k >= 2 && dxPrev > 0 ? (out[k - 1] * dx) / dxPrev : 0;
      let best = Math.round(pred);
      let bestV = 0;
      for (let sft = Math.round(pred) - maxS; sft <= Math.round(pred) + maxS; sft++) {
        let v = 0;
        for (let y = ya; y <= yb; y++) {
          const yy = y + sft;
          if (yy >= 0 && yy < H) v += base[y] * pk[yy];
        }
        if (v > bestV) {
          bestV = v;
          best = sft;
        }
      }
      let eA = 0;
      let eB = 0;
      for (let y = ya; y <= yb; y++) {
        eA += base[y] * base[y];
        const yy = y + best;
        if (yy >= 0 && yy < H) eB += pk[yy] * pk[yy];
      }
      const norm = eA > 0 && eB > 0 ? bestV / Math.sqrt(eA * eB) : 0;
      out.push(norm >= 0.25 ? best : pred);
    }
    return out;
  });
  return profs.map((_, k) => {
    const vals = perWin.map((w) => w[k]);
    // 去掉單一視窗的離群值（鄰近三段的中位數）
    const sm = vals.map((v, i) => [vals[i - 1] ?? v, v, vals[i + 1] ?? v].sort((p, q) => p - q)[1]);
    const out = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      if (y <= centers[0]) out[y] = sm[0];
      else if (y >= centers[centers.length - 1]) out[y] = sm[sm.length - 1];
      else {
        let i = 0;
        while (centers[i + 1] < y) i++;
        const t = (y - centers[i]) / (centers[i + 1] - centers[i]);
        out[y] = sm[i] + (sm[i + 1] - sm[i]) * t;
      }
    }
    return out;
  });
}

/**
 * 沿著高度追蹤一條欄線：每 band 高的一段在 ±win 內找線的像素最多的 x（要和上一段連續），
 * 找不到的段用鄰近段內插；回傳每個 y 的 x（Float32Array(H)）。
 */
export function trackLine(vmask, W, H, x0, { y0, y1, win, band }) {
  const pts = [];
  let prev = x0;
  for (let ys = y0; ys <= y1; ys += band) {
    const ye = Math.min(y1, ys + band - 1);
    const lo = Math.max(0, Math.round(prev - win));
    const hi = Math.min(W - 1, Math.round(prev + win));
    const prof = new Float32Array(hi - lo + 1);
    for (let y = ys; y <= ye; y++) {
      const o = y * W;
      for (let x = lo; x <= hi; x++) prof[x - lo] += vmask[o + x];
    }
    let best = -1;
    let bestV = 0;
    for (let i = 0; i < prof.length; i++) {
      const v = prof[i] + (i > 0 ? prof[i - 1] : 0) + (i + 1 < prof.length ? prof[i + 1] : 0);
      // 一樣強時取離上一段近的
      if (v > bestV || (v === bestV && best >= 0 && Math.abs(lo + i - prev) < Math.abs(lo + best - prev))) {
        bestV = v;
        best = i;
      }
    }
    const yc = (ys + ye) / 2;
    if (bestV >= (ye - ys + 1) * 0.3) {
      // 重心
      let sw = 0;
      let sx = 0;
      for (let i = Math.max(0, best - 2); i <= Math.min(prof.length - 1, best + 2); i++) {
        sw += prof[i];
        sx += prof[i] * (lo + i);
      }
      const xc = sw ? sx / sw : lo + best;
      pts.push({ y: yc, x: xc });
      prev = xc;
    }
  }
  const path = new Float32Array(H);
  if (!pts.length) {
    path.fill(x0);
    return path;
  }
  for (let y = 0; y < H; y++) {
    if (y <= pts[0].y) path[y] = pts[0].x;
    else if (y >= pts[pts.length - 1].y) path[y] = pts[pts.length - 1].x;
    else {
      let k = 0;
      while (pts[k + 1].y < y) k++;
      const a = pts[k];
      const b = pts[k + 1];
      path[y] = a.x + ((b.x - a.x) * (y - a.y)) / (b.y - a.y || 1);
    }
  }
  return path;
}

const percentile = (arr, q) => {
  const a = [...arr].sort((p, q2) => p - q2);
  return a.length ? a[Math.min(a.length - 1, Math.floor(a.length * q))] : 0;
};

/** 投影的門檻：最高那群的一成（字很多墨、底紋很少） */
function profileThreshold(prof, floor = 6) {
  const nz = [...prof].filter((v) => v > 0);
  return Math.max(floor, percentile(nz, 0.9) * 0.1);
}

/** 單列（一行數字）的高度：日期欄各段高度的較矮四分之一 */
export function singleHeight(profD, minH, mergeGap = 2) {
  const bands = bands1D(profD, { thr: profileThreshold(profD), minLen: minH, mergeGap });
  const hs = bands.map(([a, b]) => b - a + 1);
  return hs.length ? percentile(hs, 0.25) : 0;
}

/**
 * 把墨水投影切成一列一列：先取連續區段，再用「單列高度」與「列距」把黏在一起的列拆開。
 * 單列高度取較矮的那四分之一的區段（黏在一起的會比較高）；列距取相鄰單列的起點差。
 */
function periodicCuts(prof, a, b, pitch, single) {
  let best = null;
  const lo = Math.max(2, Math.round(single * 0.5)); // 第一條切線離段首至少半列
  for (let p = pitch * 0.88; p <= pitch * 1.12; p += 0.5) {
    for (let ph = lo; ph < lo + p; ph += 1) {
      const cuts = [];
      let cost = 0;
      for (let y = a + ph; y <= b - lo; y += p) {
        const yy = Math.round(y);
        cuts.push(yy);
        cost += Math.min(prof[yy - 1], prof[yy], prof[yy + 1]);
      }
      if (!cuts.length) continue;
      const mean = cost / cuts.length;
      if (!best || mean < best.mean - 1e-9 || (Math.abs(mean - best.mean) < 1e-9 && cuts.length > best.cuts.length)) best = { cuts, mean };
    }
  }
  return best ? best.cuts : [];
}

export function segmentRows(prof, { minH, single: singleHint = 0, mergeGap = 2 }) {
  const bands = bands1D(prof, { thr: profileThreshold(prof), minLen: minH, mergeGap });
  if (bands.length < 2) return bands;
  const hs = bands.map(([a, b]) => b - a + 1).sort((p, q) => p - q);
  const single = singleHint || (hs.length >= 4 ? hs[Math.floor(hs.length * 0.25)] : hs[0]);
  const starts = [];
  for (let i = 0; i + 1 < bands.length; i++) {
    const h0 = bands[i][1] - bands[i][0] + 1;
    const h1 = bands[i + 1][1] - bands[i + 1][0] + 1;
    const d = bands[i + 1][0] - bands[i][0];
    if (h0 <= single * 1.35 && h1 <= single * 1.35 && d < single * 2.6) starts.push(d);
  }
  const pitch = starts.length ? medianOf(starts) : single * 1.3;
  const out = [];
  for (const [a, b] of bands) {
    const h = b - a + 1;
    if (h <= single * 1.6) {
      out.push([a, b]);
      continue;
    }
    // 黏在一起的幾列：找一組等距的切線（列距上下 12%），讓切線落在墨水最少的地方
    let s = a;
    for (const cut of periodicCuts(prof, a, b, pitch, single)) {
      out.push([s, cut]);
      s = cut + 1;
    }
    out.push([s, b]);
  }
  return out.filter(([a, b]) => b - a + 1 >= Math.max(3, Math.round(minH / 2)));
}
