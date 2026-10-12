// 電子發票證明聯的二維條碼（財政部規格）：左邊 QR 有發票號碼、日期、未稅／含稅金額、買賣方統編與部分品項，
// 右邊 QR 以「**」開頭接續品項。讀 QR 是精準資料，不需要辨識文字。
//
// 左 QR 固定欄位（77 碼）：字軌號碼(10) 開立日期(7，民國 yyyMMdd) 隨機碼(4) 銷售額(8，16 進位未稅) 總計額(8，16 進位含稅)
//   買方統編(8，無則 00000000) 賣方統編(8) 加密驗證(24)
// 之後以「:」分隔：營業人自用區(10) : 本 QR 品目筆數 : 交易品目總筆數 : 中文編碼(0 Big5／1 UTF-8／2 Base64) : 品名:數量:單價 …

const HEAD = /^([A-Z]{2}\d{8})(\d{7})(\d{4})([0-9A-Fa-f]{8})([0-9A-Fa-f]{8})(\d{8})(\d{8})/;

const td = (enc) => {
  try {
    return new TextDecoder(enc);
  } catch {
    return new TextDecoder('utf-8');
  }
};

function decodeText(bytes, encoding) {
  if (encoding === '0') return td('big5').decode(bytes);
  if (encoding === '2') {
    try {
      const bin = atob(new TextDecoder('latin1').decode(bytes).trim());
      return new TextDecoder('utf-8').decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    } catch {
      return '';
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

// 以 ':'（0x3A）切開位元組；Big5 的第二個位元組不會是 0x3A，所以不會切壞中文
function splitColon(bytes) {
  const out = [];
  let start = 0;
  for (let i = 0; i <= bytes.length; i++) {
    if (i === bytes.length || bytes[i] === 0x3a) {
      out.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  return out;
}

function parseItems(parts, encoding) {
  const items = [];
  for (let i = 0; i < parts.length; i += 3) {
    const name = decodeText(parts[i] || new Uint8Array(), encoding).trim();
    if (!name) continue;
    const qty = Number(new TextDecoder('latin1').decode(parts[i + 1] || new Uint8Array()));
    const price = Number(new TextDecoder('latin1').decode(parts[i + 2] || new Uint8Array()));
    items.push({ name, qty: Number.isFinite(qty) ? qty : null, amount: Number.isFinite(qty) && Number.isFinite(price) ? Math.round(qty * price * 100) / 100 : null, price: Number.isFinite(price) ? price : null });
  }
  return items;
}

const asBytes = (x) => (x instanceof Uint8Array ? x : typeof x === 'string' ? Uint8Array.from(x, (c) => c.charCodeAt(0) & 0xff) : new Uint8Array(x || []));

/**
 * 解析左邊 QR。
 * @param raw QR 內容（位元組陣列或字串）
 * @returns {{ invoice_no, date, random, sales_ex, total, tax, buyer_tax_id, seller_tax_id, encoding, items, itemCount }} 或 null
 */
export function parseLeftQR(raw) {
  const bytes = asBytes(raw);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 77));
  const m = HEAD.exec(head);
  if (!m) return null;
  const roc = m[2];
  const y = Number(roc.slice(0, 3)) + 1911;
  const mo = Number(roc.slice(3, 5));
  const d = Number(roc.slice(5, 7));
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const salesEx = parseInt(m[4], 16);
  const total = parseInt(m[5], 16);
  const buyer = m[6] === '00000000' ? '' : m[6];
  const parts = bytes.length > 77 ? splitColon(bytes.subarray(77)) : [];
  // parts[0] 是 77 碼後到第一個冒號之間（通常空），之後：自用區、本 QR 筆數、總筆數、編碼、品目…
  const rest = parts.slice(1);
  const latin = (b) => new TextDecoder('latin1').decode(b || new Uint8Array()).trim();
  const encoding = latin(rest[3]) || '1';
  return {
    invoice_no: m[1],
    date: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
    random: m[3],
    sales_ex: salesEx,
    total,
    // 有買方統編（B2B）時，總計額－銷售額＝營業稅；沒有買方統編時銷售額通常等於含稅金額。
    // 有些店家銷售額欄填 0 或含稅金額：差額不像 5% 時視為不明（null），交給其他來源判斷
    tax: !buyer ? 0 : salesEx > 0 && Math.abs(total - salesEx - (total - Math.round(total / 1.05))) <= 1 ? total - salesEx : null,
    buyer_tax_id: buyer,
    seller_tax_id: m[7],
    encoding,
    itemCount: Number(latin(rest[2])) || null,
    items: parseItems(rest.slice(4), encoding),
  };
}

/** 右邊 QR（「**」開頭）：只有品目，編碼沿用左邊 QR */
export function parseRightQR(raw, encoding = '1') {
  const bytes = asBytes(raw);
  if (bytes[0] !== 0x2a || bytes[1] !== 0x2a) return null;
  return { items: parseItems(splitColon(bytes.subarray(2)), encoding) };
}

export function isRightQR(raw) {
  const b = asBytes(raw);
  return b[0] === 0x2a && b[1] === 0x2a;
}

/**
 * 把一張照片掃到的所有 QR 組成發票：左 QR 各成一張，右 QR 併到最近、位在其右側的左 QR。
 * @param codes [{ bytes, x, y }]（x、y 為 QR 中心位置）
 * @returns 依發票號碼去重後的發票清單
 */
export function assembleInvoices(codes) {
  const lefts = [];
  const rights = [];
  for (const c of codes) {
    const l = parseLeftQR(c.bytes);
    if (l) lefts.push({ ...l, x: c.x ?? 0, y: c.y ?? 0 });
    else if (isRightQR(c.bytes)) rights.push(c);
  }
  const byNo = new Map();
  for (const l of lefts) if (!byNo.has(l.invoice_no)) byNo.set(l.invoice_no, l);
  const invoices = [...byNo.values()];
  for (const r of rights) {
    let best = null;
    let bestD = Infinity;
    for (const l of invoices) {
      const dx = (r.x ?? 0) - l.x;
      const dist = Math.hypot(dx, (r.y ?? 0) - l.y) + (dx < 0 ? 1e6 : 0);
      if (dist < bestD) {
        bestD = dist;
        best = l;
      }
    }
    if (!best) continue;
    const more = parseRightQR(r.bytes, best.encoding)?.items || [];
    const seen = new Set(best.items.map((i) => `${i.name}|${i.qty}|${i.price}`));
    for (const it of more) if (!seen.has(`${it.name}|${it.qty}|${it.price}`)) best.items.push(it);
  }
  return invoices.map(({ x, y, ...inv }) => inv);
}
