// 憑證檔名：解析「已命名」照片的檔名（日期／廠商／金額／發票號），並產生統一的歸檔名稱。
// 例：20260901_全聯_鮮乳_356.jpg、1150901-全聯-356元.jpg、2026-09-01 AB12345678 全聯 NT$356.jpg

import { parseDate } from './dates.js';
import { INVOICE_RE } from './classify.js';
import { slug } from './text.js';

export function parseDocName(fileName) {
  const ext = (/\.[a-z0-9]+$/i.exec(fileName) || [''])[0];
  let s = fileName.slice(0, fileName.length - ext.length).normalize('NFKC');
  const out = { date: null, invoice_no: null, amount: null, vendor: '', summary: '', ext: ext.toLowerCase() };
  const inv = INVOICE_RE.exec(s.toUpperCase());
  if (inv) {
    out.invoice_no = inv[1] + inv[2];
    const at = s.toUpperCase().indexOf(inv[0]);
    s = s.slice(0, at) + ' ' + s.slice(at + inv[0].length);
  }
  // 日期：8 碼西元、7 碼民國，或含分隔符號
  const dm = /(?<!\d)((?:20\d{2}|1[01]\d)[-_./年]?\d{2}[-_./月]?\d{2})日?(?!\d)/.exec(s);
  if (dm) {
    const d = parseDate(dm[1].replace(/[_.年月]/g, '-').replace(/-{2,}/g, '-'));
    if (d) {
      out.date = d;
      s = s.replace(dm[0], ' ');
    }
  }
  // 金額：帶 $ / NT / 元 者優先，否則取最後一個數字
  const money = /(?:NT\$?|\$|＄)\s*([\d,]+(?:\.\d+)?)|([\d,]+(?:\.\d+)?)\s*元/i.exec(s);
  if (money) {
    out.amount = Number((money[1] || money[2]).replace(/,/g, ''));
    s = s.replace(money[0], ' ');
  } else {
    const nums = [...s.matchAll(/(?<![\d.])(\d{1,3}(?:,\d{3})+|\d+)(?![\d.])/g)];
    if (nums.length) {
      const last = nums[nums.length - 1];
      out.amount = Number(last[1].replace(/,/g, ''));
      s = s.slice(0, last.index) + ' ' + s.slice(last.index + last[0].length);
    }
  }
  const tokens = s.split(/[\s_\-－—–·・|｜,，]+/).map((t) => t.trim()).filter((t) => t && !/^(發票|收據|憑證|單據|img|dsc|photo|scan|掃描)$/i.test(t));
  out.vendor = tokens[0] || '';
  out.summary = tokens.slice(1).join(' ');
  return out;
}

// 歸檔名稱：YYYYMMDD_廠商_摘要_發票號_金額元.ext（Windows 不允許的字元會被替換）
export function archiveName({ doc_date, vendor_name, summary, invoice_no, amount_total }, ext = '.jpg') {
  const parts = [
    (doc_date || '00000000').replace(/-/g, ''),
    slug(vendor_name || '未知廠商').slice(0, 20),
    summary ? slug(summary).slice(0, 20) : null,
    invoice_no || null,
    amount_total !== null && amount_total !== undefined && amount_total !== '' ? `${Math.round(Number(amount_total))}元` : null,
  ].filter(Boolean);
  return parts.join('_') + ext;
}

// 歸檔資料夾：憑證/民國年/月/
export function archiveFolder(date) {
  if (!date) return '待分類';
  return `${Number(date.slice(0, 4)) - 1911}年/${date.slice(5, 7)}月`;
}
