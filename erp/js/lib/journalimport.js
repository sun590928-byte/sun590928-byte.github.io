// 舊帳匯入：把「一列一行分錄」的試算表（例如先前的 AI 版會計系統）組回傳票。

import { parseDate } from './dates.js';
import { parseAmount, round2 } from './money.js';
import { findAccountByName } from './coa.js';
import { normalizeText } from './text.js';

export function accountLabel(r) {
  return `${String(r.account_code || '').trim()} ${String(r.account_name || '').trim()}`.trim();
}

export function resolveAccount(r, accounts, overrides = {}) {
  const label = accountLabel(r);
  if (overrides[label]) return accounts.find((a) => a.code === overrides[label]) || null;
  const code = String(r.account_code || '').trim();
  if (code) {
    const byCode = accounts.find((a) => a.code === code);
    if (byCode) return byCode;
  }
  return findAccountByName(accounts, r.account_name || '') || null;
}

/**
 * @returns {{ entries, unresolved: [label, count][], errors: string[] }}
 */
export function buildJournalEntries(rawRows, accounts, { overrides = {}, sourceTag = 'import' } = {}) {
  const unresolved = new Map();
  const rows = [];
  let prevDate = null;
  let prevVoucher = '';
  for (const r of rawRows) {
    let debit = Math.abs(parseAmount(r.debit) ?? 0);
    let credit = Math.abs(parseAmount(r.credit) ?? 0);
    if (!debit && !credit && r.amount) {
      const a = parseAmount(r.amount) ?? 0;
      const side = normalizeText(r.side);
      if (/貸|^cr?$|credit/.test(side)) credit = Math.abs(a);
      else if (/借|^dr?$|debit/.test(side)) debit = Math.abs(a);
      else if (a >= 0) debit = a;
      else credit = -a;
    }
    if (!debit && !credit) continue;
    const dateRaw = parseDate(r.date);
    const voucherRaw = String(r.voucher_no || '').trim();
    const date = dateRaw || prevDate;
    const voucher = voucherRaw || (!dateRaw ? prevVoucher : '');
    if (!date) continue;
    const acc = resolveAccount(r, accounts, overrides);
    const label = accountLabel(r);
    if (!acc) unresolved.set(label, (unresolved.get(label) || 0) + 1);
    rows.push({ date, voucher, account: acc?.code || null, label, debit: round2(debit), credit: round2(credit), memo: String(r.memo || '').trim(), partner: String(r.partner || '').trim(), row: r._row });
    prevDate = date;
    prevVoucher = voucher;
  }
  const groups = [];
  const hasVoucher = rows.some((x) => x.voucher);
  if (hasVoucher) {
    const map = new Map();
    for (const x of rows) {
      const k = x.voucher || `${x.date}#${x.row}`;
      if (!map.has(k)) {
        map.set(k, []);
        groups.push(map.get(k));
      }
      map.get(k).push(x);
    }
  } else {
    // 沒有傳票號：同日連續列累計至借貸平衡為一張
    let cur = [];
    let bal = 0;
    for (const x of rows) {
      if (cur.length && x.date !== cur[0].date && Math.abs(bal) > 0.004) {
        groups.push(cur);
        cur = [];
        bal = 0;
      }
      cur.push(x);
      bal = round2(bal + x.debit - x.credit);
      if (Math.abs(bal) < 0.005 && cur.some((y) => y.debit) && cur.some((y) => y.credit)) {
        groups.push(cur);
        cur = [];
        bal = 0;
      }
    }
    if (cur.length) groups.push(cur);
  }
  const entries = [];
  const errors = [];
  for (const g of groups) {
    const dr = round2(g.reduce((t, x) => t + x.debit, 0));
    const cr = round2(g.reduce((t, x) => t + x.credit, 0));
    const ref = g[0].voucher || `${g[0].date}#${g[0].row}`;
    if (Math.abs(dr - cr) > 0.004) {
      errors.push(`${ref}（第 ${g[0].row} 列起）借 ${dr} ≠ 貸 ${cr}，未匯入`);
      continue;
    }
    const memo = g.find((x) => x.memo)?.memo || '';
    entries.push({
      date: g[0].date,
      description: memo,
      source: sourceTag,
      source_ref: ref,
      original_voucher: g[0].voucher || '',
      lines: g.map((x) => ({ account: x.account, debit: x.debit, credit: x.credit, memo: x.memo === memo ? '' : x.memo, partner: x.partner })),
    });
  }
  return { entries, unresolved: [...unresolved.entries()], errors };
}
