// 金額工具：新台幣以整數元為主，保留兩位小數避免手續費等小數誤差累積。

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function roundInt(n) {
  return Math.round(Number(n) + (n >= 0 ? Number.EPSILON : -Number.EPSILON));
}

// 接受 "NT$1,234"、"1,234.00"、"(1,234)"、"－123"、"$ -50"、"1 234 元"
export function parseAmount(input) {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  let s = String(input).normalize('NFKC').trim();
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) {
    neg = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/NT\$|NTD|TWD|\$|元|塊|,|\s/gi, '').replace(/[−–—]/g, '-');
  if (s.endsWith('-')) {
    neg = !neg;
    s = s.slice(0, -1);
  }
  if (!/^[-+]?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  return neg ? -n : n;
}

const nf0 = new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('zh-TW', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function fmt(n, { blankZero = false } = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return '';
  if (blankZero && Math.abs(n) < 0.005) return '';
  const r = round2(n);
  return Number.isInteger(r) ? nf0.format(r) : nf2.format(r);
}

export function fmtMoney(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return (n < 0 ? '−$' : '$') + fmt(Math.abs(n));
}

export function pct(n, digits = 1) {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return (n * 100).toFixed(digits) + '%';
}

export function sum(arr, fn = (x) => x) {
  let s = 0;
  for (const x of arr) s += Number(fn(x)) || 0;
  return round2(s);
}

// 將總額依權重拆分為整數，確保加總不變（最大餘數法）
export function allocate(total, weights) {
  const wsum = weights.reduce((a, b) => a + b, 0);
  if (!wsum) return weights.map(() => 0);
  if (total < 0) return allocate(-total, weights).map((x) => -x);
  const raw = weights.map((w) => (total * w) / wsum);
  const base = raw.map((x) => Math.floor(x));
  let rest = Math.round(total - base.reduce((a, b) => a + b, 0));
  const order = raw.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0]);
  for (let k = 0; k < order.length && rest > 0; k++, rest--) base[order[k][1]]++;
  return base;
}
