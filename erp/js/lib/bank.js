// 銀行存摺對帳：匯入網銀明細、與帳上銀行存款科目逐筆勾稽、產生銀行存款餘額調節表。

import { parseDate, daysBetween } from './dates.js';
import { parseAmount, round2 } from './money.js';
import { fnv1a } from './text.js';
import { postings } from './ledger.js';

export function normalizeBank(rawRows, { batchId = '', bankAccountId = 'main' } = {}) {
  const out = [];
  const skipped = [];
  const seen = new Map();
  for (const r of rawRows) {
    const date = parseDate(r.date);
    if (!date) {
      skipped.push({ row: r._row, reason: '日期無法辨識' });
      continue;
    }
    let w = Math.abs(parseAmount(r.withdrawal) ?? 0);
    let d = Math.abs(parseAmount(r.deposit) ?? 0);
    if (!w && !d) {
      const a = parseAmount(r.amount);
      if (a === null || a === 0) {
        skipped.push({ row: r._row, reason: '無金額' });
        continue;
      }
      if (a > 0) d = a;
      else w = -a;
    }
    const balance = parseAmount(r.balance);
    const base = [bankAccountId, date, r.description, w, d, balance ?? ''].join('|');
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    out.push({
      id: 'bk_' + fnv1a(base) + '_' + n,
      batch_id: batchId,
      bank_account_id: bankAccountId,
      date,
      description: String(r.description || '').trim(),
      withdrawal: round2(w),
      deposit: round2(d),
      balance: balance === null ? null : round2(balance),
      note: String(r.note || '').trim(),
      counterparty: String(r.counterparty || '').trim(),
      match_key: null,
    });
  }
  return { rows: out, skipped };
}

// 帳上銀行科目的過帳明細
export function bookLines(entries, glAccount, { to } = {}) {
  return postings(entries, { to })
    .filter((p) => p.account === glAccount)
    .map((p) => ({ key: `${p.entry.id}#${p.i}`, entry_id: p.entry.id, i: p.i, date: p.date, voucher_no: p.voucher_no, memo: p.memo, debit: p.debit, credit: p.credit }));
}

/**
 * 自動勾稽：金額相同、日期差 ±windowDays，挑最近者。已勾稽者保留。
 * @returns Map(bankLineId → bookKey)
 */
export function autoMatch(bankLines, books, { windowDays = 5 } = {}) {
  const result = new Map();
  const usedBook = new Set();
  for (const b of bankLines) {
    if (b.match_key) {
      result.set(b.id, b.match_key);
      usedBook.add(b.match_key);
    }
  }
  const sorted = [...bankLines].filter((b) => !b.match_key).sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const b of sorted) {
    const amt = b.deposit || b.withdrawal;
    const isDep = b.deposit > 0;
    const cand = books
      .filter((k) => !usedBook.has(k.key) && k.key !== b.match_rejected && Math.abs((isDep ? k.debit : k.credit) - amt) < 0.5 && Math.abs(daysBetween(k.date, b.date)) <= windowDays)
      .sort((x, y) => Math.abs(daysBetween(x.date, b.date)) - Math.abs(daysBetween(y.date, b.date)))[0];
    if (cand) {
      result.set(b.id, cand.key);
      usedBook.add(cand.key);
    }
  }
  return result;
}

const near = (a, b) => Math.abs(a - b) < 0.5;
const hasBal = (b) => b.balance !== null && b.balance !== undefined && b.balance !== '';
// 這一筆之前的結存：結存 − 存入 ＋ 支出
const balBefore = (b) => round2(Number(b.balance) - (b.deposit || 0) + (b.withdrawal || 0));

// 同一天的幾筆照存摺上的先後排：上一筆的結存 ＝ 下一筆的「之前結存」，接成一條鏈。
// prevBal：前一天最後一筆的結存（不知道就給 null）。接不起來的（沒有結存、或剛好打平繞一圈）照原本順序。
function chainDay(day, prevBal) {
  if (day.length < 2 || !day.every(hasBal)) return day;
  const rest = [...day];
  const out = [];
  // 起點：之前結存等於前一天的結存；不知道前一天時，找「之前結存」不是同一天其他筆結存的那筆
  const pickStart = (target) => {
    if (target !== null) {
      const i = rest.findIndex((b) => near(balBefore(b), target));
      if (i >= 0) return i;
    }
    const i = rest.findIndex((b) => !rest.some((o) => o !== b && near(Number(o.balance), balBefore(b))));
    return i >= 0 ? i : 0;
  };
  let cur = rest.splice(pickStart(prevBal), 1)[0];
  out.push(cur);
  while (rest.length) {
    const i = rest.findIndex((b) => near(balBefore(b), Number(cur.balance)));
    cur = rest.splice(i >= 0 ? i : pickStart(null), 1)[0];
    out.push(cur);
  }
  return out;
}

/**
 * 存摺順序：依日期，同一天的照結存帳鏈排（最後一筆＝當天結存）。
 * 系統沒有存每列在存摺上的位置（雲端資料庫取回來的順序也不一定是匯入順序），所以不能照結存大小或讀取順序排。
 * 不同存摺帳戶各自接鏈。
 */
export function passbookOrder(bankLines) {
  const byDate = new Map();
  for (const b of bankLines) {
    const k = `${b.date}`;
    if (!byDate.has(k)) byDate.set(k, []);
    byDate.get(k).push(b);
  }
  const prev = new Map(); // 帳戶 → 前一天最後的結存
  const out = [];
  for (const date of [...byDate.keys()].sort()) {
    const accts = new Map();
    for (const b of byDate.get(date)) {
      const a = b.bank_account_id || 'main';
      if (!accts.has(a)) accts.set(a, []);
      accts.get(a).push(b);
    }
    for (const [a, day] of accts) {
      const ordered = chainDay(day, prev.has(a) ? prev.get(a) : null);
      const last = [...ordered].reverse().find(hasBal);
      if (last) prev.set(a, Number(last.balance));
      out.push(...ordered);
    }
  }
  return out;
}

/**
 * 銀行存款餘額調節表
 * @param openingBank 對帳起始日前一日的存摺餘額（若明細含餘額欄則自動推算）
 * 存摺餘額＝截止日以前最後一筆的結存；同一天有好幾筆時是存摺上當天最後一筆（passbookOrder）
 */
export function reconciliation({ bankLines, books, matches, asOf, openingBank = 0 }) {
  const lines = passbookOrder(bankLines.filter((b) => b.date <= asOf));
  const withBal = lines.filter((b) => b.balance !== null && b.balance !== undefined);
  const bankBalance = withBal.length ? withBal[withBal.length - 1].balance : round2(openingBank + lines.reduce((t, b) => t + b.deposit - b.withdrawal, 0));
  const matchedBook = new Set([...matches.entries()].filter(([bid]) => lines.some((b) => b.id === bid)).map(([, k]) => k));
  const bookUpTo = books.filter((k) => k.date <= asOf);
  const bookBalance = round2(bookUpTo.reduce((t, k) => t + k.debit - k.credit, 0));
  const firstBankDate = lines.length ? lines[0].date : asOf;
  // 帳上有、銀行未入：在途存款、未兌現支出（僅計算存摺期間內的帳）
  const depositsInTransit = bookUpTo.filter((k) => k.debit > 0 && !matchedBook.has(k.key) && k.date >= firstBankDate);
  const outstanding = bookUpTo.filter((k) => k.credit > 0 && !matchedBook.has(k.key) && k.date >= firstBankDate);
  // 銀行有、帳上未記
  const bankOnlyIn = lines.filter((b) => b.deposit > 0 && !matches.has(b.id));
  const bankOnlyOut = lines.filter((b) => b.withdrawal > 0 && !matches.has(b.id));
  const sum = (arr, f) => round2(arr.reduce((t, x) => t + f(x), 0));
  const adjBank = round2(bankBalance + sum(depositsInTransit, (k) => k.debit) - sum(outstanding, (k) => k.credit));
  const adjBook = round2(bookBalance + sum(bankOnlyIn, (b) => b.deposit) - sum(bankOnlyOut, (b) => b.withdrawal));
  return {
    asOf,
    bankBalance,
    bookBalance,
    depositsInTransit,
    outstanding,
    bankOnlyIn,
    bankOnlyOut,
    adjBank,
    adjBook,
    diff: round2(adjBank - adjBook),
    matchedCount: matchedBook.size,
  };
}
