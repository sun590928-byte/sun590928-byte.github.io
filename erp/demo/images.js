// 預覽版的憑證照片：在瀏覽器用 canvas 畫出「電子發票證明聯」（含財政部格式的 QR 碼）與收據，
// 讓「本機辨識」真的能讀到 QR 碼。全部是虛構資料。

import qrcode from './vendor/qrcode.mjs';

const FONT = '"Microsoft JhengHei", "PingFang TC", "Noto Sans TC", "Noto Sans CJK TC", sans-serif';
const hex8 = (n) => Math.round(n).toString(16).toUpperCase().padStart(8, '0');
const roc = (ymd) => `${Number(ymd.slice(0, 4)) - 1911}${ymd.slice(5, 7)}${ymd.slice(8, 10)}`;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const utf8 = (s) => String.fromCharCode(...new TextEncoder().encode(s));

/** 財政部電子發票左右兩個 QR 碼的內容 */
export function invoiceQrText(inv) {
  const items = inv.items.map((i) => `${i.name}:${i.qty}:${i.price}`);
  const left = items.slice(0, 2);
  const right = items.slice(2);
  const enc = (inv.random + inv.invoice_no + 'DEMOENCRYPTIONKEY0000000').slice(0, 24);
  const head = `${inv.invoice_no}${roc(inv.date)}${inv.random}${hex8(inv.buyer ? inv.sales_ex : inv.total)}${hex8(inv.total)}${inv.buyer || '00000000'}${inv.seller}${enc}`;
  return {
    left: `${head}:**********:${left.length}:${items.length}:1:${left.join(':')}`,
    right: `**${right.join(':') || ':'}`,
  };
}

function drawQr(g, text, x, y, size) {
  const q = qrcode(0, 'L');
  q.addData(utf8(text), 'Byte');
  q.make();
  const n = q.getModuleCount();
  const quiet = 3;
  const cell = Math.floor(size / (n + quiet * 2));
  const real = cell * (n + quiet * 2);
  g.fillStyle = '#fff';
  g.fillRect(x, y, real, real);
  g.fillStyle = '#111';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect(x + (c + quiet) * cell, y + (r + quiet) * cell, cell, cell);
  return real;
}

// 一維條碼（裝飾用：期別＋發票號碼＋隨機碼）
function drawBars(g, seedText, x, y, w, h) {
  let s = 0;
  for (const ch of seedText) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  g.fillStyle = '#111';
  let cx = x;
  while (cx < x + w) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const bw = 1 + (s % 3);
    if ((s >> 4) % 2) g.fillRect(cx, y, bw, h);
    cx += bw + 1;
  }
}

// 把紙張畫在桌面上（略為傾斜），看起來像手機拍的照片
function photo(paperW, paperH, drawPaper, { tilt = 0, bg = '#c9c2b6' } = {}) {
  const W = paperW + 140;
  const H = paperH + 140;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, bg);
  grad.addColorStop(1, '#a9a196');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.save();
  g.translate(W / 2, H / 2);
  g.rotate((tilt * Math.PI) / 180);
  g.translate(-paperW / 2, -paperH / 2);
  g.shadowColor = 'rgba(0,0,0,.28)';
  g.shadowBlur = 18;
  g.shadowOffsetY = 6;
  g.fillStyle = '#fbfaf6';
  g.fillRect(0, 0, paperW, paperH);
  g.shadowColor = 'transparent';
  drawPaper(g);
  g.restore();
  return c;
}

const text = (g, s, x, y, size, { weight = 400, align = 'left', color = '#1a1a1a' } = {}) => {
  g.font = `${weight} ${size}px ${FONT}`;
  g.textAlign = align;
  g.fillStyle = color;
  g.fillText(s, x, y);
};

/**
 * 電子發票證明聯（格式 25；有買方統編時印稅額）
 * @param inv { seller_name, seller, buyer, invoice_no, date, time, random, total, sales_ex, tax, items: [{name, qty, price}] }
 */
export function drawInvoice(inv, { tilt = 1.2 } = {}) {
  const PW = 560;
  const lines = inv.items.length;
  const PH = 980 + lines * 34;
  return photo(PW, PH, (g) => {
    const cx = PW / 2;
    text(g, inv.seller_name, cx, 70, 30, { weight: 700, align: 'center' });
    text(g, '電子發票證明聯', cx, 128, 40, { weight: 700, align: 'center' });
    const y = Number(inv.date.slice(0, 4)) - 1911;
    const m = Number(inv.date.slice(5, 7));
    const p1 = m % 2 ? m : m - 1;
    text(g, `${y}年${String(p1).padStart(2, '0')}-${String(p1 + 1).padStart(2, '0')}月`, cx, 186, 40, { weight: 700, align: 'center' });
    text(g, `${inv.invoice_no.slice(0, 2)}-${inv.invoice_no.slice(2)}`, cx, 240, 40, { weight: 700, align: 'center' });
    text(g, `${inv.date} ${inv.time}${inv.buyer ? '      格式:25' : ''}`, 40, 290, 22);
    text(g, `隨機碼:${inv.random}`, 40, 324, 22);
    text(g, `總計:${fmt(inv.total)}`, PW - 40, 324, 22, { align: 'right' });
    text(g, `賣方:${inv.seller}`, 40, 358, 22);
    if (inv.buyer) text(g, `買方:${inv.buyer}`, PW - 40, 358, 22, { align: 'right' });
    drawBars(g, inv.invoice_no + inv.random, 40, 378, PW - 80, 56);
    const q = invoiceQrText(inv);
    const size = 230;
    drawQr(g, q.left, 30, 452, size);
    drawQr(g, q.right, PW - 30 - size, 452, size);
    // 交易明細
    let ty = 452 + size + 46;
    g.strokeStyle = '#999';
    g.setLineDash([6, 5]);
    g.beginPath();
    g.moveTo(30, ty - 26);
    g.lineTo(PW - 30, ty - 26);
    g.stroke();
    g.setLineDash([]);
    text(g, '交易明細', 40, ty, 24, { weight: 700 });
    ty += 38;
    for (const it of inv.items) {
      text(g, it.name, 40, ty, 22);
      text(g, `${it.qty} x ${fmt(it.price)}`, PW - 170, ty, 22, { align: 'right' });
      text(g, fmt(it.qty * it.price), PW - 40, ty, 22, { align: 'right' });
      ty += 34;
    }
    ty += 10;
    if (inv.buyer) {
      text(g, `銷售額(應稅): ${fmt(inv.sales_ex)}`, 40, ty, 22);
      text(g, `稅額: ${fmt(inv.tax)}`, PW - 40, ty, 22, { align: 'right' });
      ty += 34;
    }
    text(g, `總計: ${fmt(inv.total)}`, 40, ty, 26, { weight: 700 });
    text(g, '退貨請持證明聯辦理', PW - 40, ty, 18, { align: 'right', color: '#666' });
  }, { tilt });
}

/** 免用統一發票收據（房租、小店）：手寫風格、紅色印章 */
export function drawReceipt(r, { tilt = -1.6 } = {}) {
  const PW = 620;
  const PH = 560 + r.items.length * 40;
  return photo(PW, PH, (g) => {
    text(g, '收　據', PW / 2, 70, 44, { weight: 700, align: 'center' });
    text(g, `${Number(r.date.slice(0, 4)) - 1911} 年 ${Number(r.date.slice(5, 7))} 月 ${Number(r.date.slice(8, 10))} 日`, PW - 40, 120, 22, { align: 'right' });
    text(g, `茲收到　${r.payer}`, 40, 170, 26);
    let y = 230;
    g.strokeStyle = '#555';
    g.strokeRect(36, y - 34, PW - 72, r.items.length * 40 + 60);
    for (const it of r.items) {
      text(g, it.name, 56, y, 24);
      text(g, `NT$ ${fmt(it.amount)}`, PW - 56, y, 24, { align: 'right' });
      y += 40;
    }
    text(g, `合計　新臺幣 ${r.total_words} 元整`, 56, y + 6, 24, { weight: 700 });
    text(g, `NT$ ${fmt(r.total)}`, PW - 56, y + 6, 24, { weight: 700, align: 'right' });
    text(g, `收款人：${r.vendor}`, 40, PH - 90, 24);
    if (r.tax_id) text(g, `統一編號：${r.tax_id}`, 40, PH - 54, 20, { color: '#444' });
    // 印章
    g.save();
    g.translate(PW - 130, PH - 110);
    g.rotate(-0.15);
    g.strokeStyle = 'rgba(196,40,40,.85)';
    g.lineWidth = 4;
    g.strokeRect(-56, -56, 112, 112);
    text(g, r.stamp.slice(0, 2), 0, -8, 30, { weight: 700, align: 'center', color: 'rgba(196,40,40,.85)' });
    text(g, r.stamp.slice(2, 4), 0, 32, 30, { weight: 700, align: 'center', color: 'rgba(196,40,40,.85)' });
    g.restore();
  }, { tilt, bg: '#b7b9b3' });
}

const CN = '零壹貳參肆伍陸柒捌玖';
/** 1600 → 壹仟陸佰 */
export function chineseAmount(n) {
  const units = [['萬', 10000], ['仟', 1000], ['佰', 100], ['拾', 10]];
  let out = '';
  let rest = Math.round(n);
  let zero = false;
  for (const [u, v] of units) {
    const d = Math.floor(rest / v);
    rest %= v;
    if (d) {
      if (zero) out += '零';
      out += CN[d] + u;
      zero = false;
    } else if (out) zero = true;
  }
  if (rest) out += (zero ? '零' : '') + CN[rest];
  return out || '零';
}

export const toBlob = (canvas, type = 'image/jpeg', q = 0.9) => new Promise((ok) => canvas.toBlob(ok, type, q));
