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

/**
 * 銀行存款餘額調節表
 * @param openingBank 對帳起始日前一日的存摺餘額（若明細含餘額欄則自動推算）
 */
export function reconciliation({ bankLines, books, matches, asOf, openingBank = 0 }) {
  const lines = bankLines.filter((b) => b.date <= asOf).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
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
