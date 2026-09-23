// 日期工具：同時接受西元與民國年，內部一律存 YYYY-MM-DD（字串比較即可排序）。

const pad = (n) => String(n).padStart(2, '0');

function valid(y, m, d) {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function normYear(y) {
  y = Number(y);
  if (y < 1000) return y + 1911; // 民國年
  return y;
}

function parseTime(s) {
  if (!s) return null;
  const t = String(s).normalize('NFKC');
  const m = /(上午|下午|AM|PM|am|pm)?\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?/.exec(t);
  if (!m) return null;
  let h = Number(m[2]);
  const mer = (m[1] || m[5] || '').toLowerCase();
  if ((mer === '下午' || mer === 'pm') && h < 12) h += 12;
  if ((mer === '上午' || mer === 'am') && h === 12) h = 0;
  if (h > 23 || Number(m[3]) > 59) return null;
  return `${pad(h)}:${m[3]}`;
}

// 回傳 { date: 'YYYY-MM-DD', time: 'HH:MM' | null } 或 null
export function parseDateTime(input) {
  if (input === null || input === undefined) return null;
  let s = String(input).normalize('NFKC').trim();
  if (!s) return null;
  // Excel 序號（從 xlsx 讀到的未格式化日期）
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const serial = Number(s);
    if (serial > 20000 && serial < 80000) {
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
      const frac = serial % 1;
      return {
        date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
        time: frac ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : null,
      };
    }
  }
  let m;
  // 2026/08/21、2026-8-21、115/08/21、2026年8月21日、115.08.21
  if ((m = /^(\d{2,4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?(.*)$/.exec(s))) {
    const y = normYear(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (valid(y, mo, d)) return { date: `${y}-${pad(mo)}-${pad(d)}`, time: parseTime(m[4]) };
  }
  // 20260821 或 1150821（可接時間）
  if ((m = /^(\d{7,8})(?:[T\s_-]*(\d{2}):?(\d{2})(?::?\d{2})?)?$/.exec(s))) {
    const raw = m[1];
    const y = normYear(raw.length === 8 ? raw.slice(0, 4) : raw.slice(0, 3));
    const mo = Number(raw.slice(-4, -2));
    const d = Number(raw.slice(-2));
    if (valid(y, mo, d)) return { date: `${y}-${pad(mo)}-${pad(d)}`, time: m[2] ? `${m[2]}:${m[3]}` : null };
  }
  // 08/21/2026（月/日/年）
  if ((m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(.*)$/.exec(s))) {
    const y = Number(m[3]);
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (valid(y, mo, d)) return { date: `${y}-${pad(mo)}-${pad(d)}`, time: parseTime(m[4]) };
  }
  return null;
}

export function parseDate(input) {
  const r = parseDateTime(input);
  return r ? r.date : null;
}

export { parseTime };

export function toDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function fromDate(dt) {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function addDays(ymd, n) {
  const dt = toDate(ymd);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromDate(dt);
}

export function daysBetween(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}

export function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export const monthKey = (ymd) => ymd.slice(0, 7);
export const monthStart = (ym) => `${ym}-01`;
export function monthEnd(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}
export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}
export function eachMonth(fromYm, toYm) {
  const out = [];
  for (let m = fromYm; m <= toYm; m = addMonths(m, 1)) out.push(m);
  return out;
}

// 0=週一 … 6=週日
export function weekdayIndex(ymd) {
  return (toDate(ymd).getUTCDay() + 6) % 7;
}
export const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];

export function rocYear(ymd) {
  return Number(ymd.slice(0, 4)) - 1911;
}
export function fmtROC(ymd) {
  if (!ymd) return '';
  return `${rocYear(ymd)}/${ymd.slice(5, 7)}/${ymd.slice(8, 10)}`;
}
export function fmtMonthROC(ym) {
  return `${Number(ym.slice(0, 4)) - 1911} 年 ${Number(ym.slice(5, 7))} 月`;
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 本地時間戳記 YYYYMMDDHHmm（檔名用）
export function nowStamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
}
