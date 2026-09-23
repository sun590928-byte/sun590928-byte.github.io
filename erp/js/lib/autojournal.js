// 自動分錄：POS 日營收、金流撥款、折舊、月底存貨成本（含招待／測試／報廢成本重分類）、憑證進貨。
// 產生的分錄帶 source / source_ref，重新產生時沿用原傳票號，已鎖定月份不覆寫。

import { round2 } from './money.js';
import { REVENUE_ACCOUNT_BY_CATEGORY, DEBIT_ACCOUNT_BY_PAYMENT } from './coa.js';
import { VOID_REASONS, PAYMENT_TYPES, CATEGORIES } from './pos.js';

function add(map, key, v) {
  map.set(key, round2((map.get(key) || 0) + v));
}

/**
 * POS 營收：每營業日一張轉帳傳票。
 * @param lines 已篩選營收期間的銷售明細
 * @param categoryOf (line) => 品類（依品項整併後的主檔）
 * @param vatMode 'general'（一般稅額 5% 內含）| 'small'（小規模，營業稅另計費用）| 'none'
 */
export function salesJournal(lines, { categoryOf, vatMode = 'general', paymentAccounts = DEBIT_ACCOUNT_BY_PAYMENT } = {}) {
  const byDate = new Map();
  for (const l of lines) {
    if (l.void_reason) continue;
    let d = byDate.get(l.date);
    if (!d) byDate.set(l.date, (d = { debits: new Map(), gross: new Map(), discount: 0, count: 0, orders: new Set(), unknownPay: 0 }));
    d.count++;
    if (l.order_no) d.orders.add(l.order_no);
    const payAcc = paymentAccounts[l.payment] || paymentAccounts.unknown;
    if (l.payment === 'unknown') d.unknownPay += l.amount;
    add(d.debits, payAcc, l.amount);
    if (l.amount < 0 || l.is_adjustment) {
      d.discount = round2(d.discount - l.amount);
      continue;
    }
    const cat = categoryOf ? categoryOf(l) : 'other';
    const revAcc = REVENUE_ACCOUNT_BY_CATEGORY[cat] || '4105';
    if (revAcc === '2151') {
      add(d.gross, revAcc, l.amount); // 寄杯售價即預收金額，不拆折扣
      continue;
    }
    const gross = Math.max(l.gross || 0, l.amount);
    add(d.gross, revAcc, gross);
    d.discount = round2(d.discount + (gross - l.amount));
  }
  const entries = [];
  for (const [date, d] of [...byDate.entries()].sort()) {
    const lines = [];
    const receipts = round2([...d.debits.values()].reduce((a, b) => a + b, 0));
    for (const [acc, amt] of d.debits) {
      if (Math.abs(amt) < 0.005) continue;
      const memo = acc === paymentAccounts.unknown && d.unknownPay ? '含付款方式未標示者（暫列）' : '';
      if (amt > 0) lines.push({ account: acc, debit: amt, credit: 0, memo });
      else lines.push({ account: acc, debit: 0, credit: -amt, memo });
    }
    const taxable = vatMode === 'general';
    const div = taxable ? 1.05 : 1;
    let revenueEx = 0;
    const prepaid = d.gross.get('2151') || 0;
    for (const [acc, amt] of d.gross) {
      if (acc === '2151') {
        lines.push({ account: acc, debit: 0, credit: amt, memo: '寄杯／儲值售出（預收）' });
        continue;
      }
      const ex = Math.round(amt / div);
      revenueEx += ex;
      lines.push({ account: acc, debit: 0, credit: ex, memo: '' });
    }
    let discountEx = 0;
    if (d.discount > 0.004) {
      discountEx = Math.round(d.discount / div);
      lines.push({ account: '4192', debit: discountEx, credit: 0, memo: '折扣／優惠' });
    }
    if (taxable) {
      const tax = round2(receipts - prepaid - (revenueEx - discountEx));
      if (Math.abs(tax) > 0.004) lines.push({ account: '2131', debit: tax < 0 ? -tax : 0, credit: tax > 0 ? tax : 0, memo: '銷項稅額（5% 內含）' });
    } else {
      const diff = round2(receipts - prepaid - (revenueEx - discountEx));
      if (Math.abs(diff) > 0.004) lines.push({ account: '4105', debit: diff < 0 ? -diff : 0, credit: diff > 0 ? diff : 0, memo: '尾差' });
    }
    entries.push({
      date,
      description: `POS 營收 ${date}（${d.orders.size || d.count} ${d.orders.size ? '單' : '筆'}）`,
      source: 'pos',
      source_ref: date,
      lines: lines.filter((x) => x.debit || x.credit),
    });
  }
  return entries;
}

const PROVIDER_ACCOUNT = { ecpay: '1111', linepay: '1112', mobile: '1113', jkopay: '1113', platform: '1114' };
export const PROVIDERS = { ecpay: '綠界（信用卡）', linepay: 'LINE Pay', jkopay: '街口支付', mobile: '其他行動支付', platform: '外送平台' };

// 撥款入帳：借 銀行存款、手續費；貸 在途款項
export function payoutJournal(p, { bankAccount = '1103' } = {}) {
  const fee = round2(Math.abs(Number(p.fee) || 0));
  const net = round2(Number(p.net) || 0);
  const gross = round2(Number(p.gross) || net + fee);
  const lines = [{ account: bankAccount, debit: net, credit: 0, memo: `${PROVIDERS[p.provider] || p.provider} 撥款` }];
  if (fee) lines.push({ account: p.provider === 'platform' ? '6129' : '6131', debit: fee, credit: 0, memo: '金流手續費' });
  lines.push({ account: PROVIDER_ACCOUNT[p.provider] || '1113', debit: 0, credit: round2(net + fee), memo: '' });
  const diff = round2(gross - net - fee);
  return {
    date: p.payout_date,
    description: `${PROVIDERS[p.provider] || p.provider} 撥款入帳${p.ref ? '（' + p.ref + '）' : ''}${Math.abs(diff) > 0.5 ? `；交易總額 ${gross} 與撥款+手續費差 ${diff}` : ''}`,
    source: 'payout',
    source_ref: p.id,
    lines,
  };
}

// 折舊：每月一張，逐項資產一行
export function depreciationJournal(ym, items) {
  const lines = [];
  let total = 0;
  for (const it of items) {
    if (!it.amount) continue;
    total += it.amount;
    lines.push({ account: it.accum, debit: 0, credit: it.amount, memo: it.name });
  }
  if (!total) return null;
  lines.unshift({ account: '6124', debit: round2(total), credit: 0, memo: '本月折舊' });
  const [y, m] = ym.split('-');
  const last = new Date(Date.UTC(+y, +m, 0)).getUTCDate();
  return { date: `${ym}-${String(last).padStart(2, '0')}`, description: `${Number(y) - 1911} 年 ${Number(m)} 月 提列折舊`, source: 'depreciation', source_ref: ym, lines };
}

export const COGS_ACCOUNT_BY_INVENTORY = { 1211: '5101', 1212: '5101', 1213: '5101', 1214: '5102', 1215: '5104', 1216: '5103' };

/**
 * 月底存貨成本（定期盤存）：本月耗用 = 帳面存貨 − 期末盤點。
 * voidCost：{ boss_treat, boss_test, scrap } 理論成本，自銷貨成本重分類至交際費／研究發展費／報廢損失。
 */
export function cogsJournal(ym, rows, voidCost = {}) {
  const lines = [];
  const cogsTotals = new Map();
  for (const r of rows) {
    const used = round2(r.book - r.counted);
    if (Math.abs(used) < 0.005) continue;
    const cogsAcc = COGS_ACCOUNT_BY_INVENTORY[r.account] || '5101';
    if (used > 0) {
      lines.push({ account: cogsAcc, debit: used, credit: 0, memo: `${r.name} 本月耗用` });
      lines.push({ account: r.account, debit: 0, credit: used, memo: '' });
      add(cogsTotals, cogsAcc, used);
    } else {
      lines.push({ account: r.account, debit: -used, credit: 0, memo: `${r.name} 盤盈` });
      lines.push({ account: '5106', debit: 0, credit: -used, memo: '存貨盤盈' });
    }
  }
  let available = cogsTotals.get('5101') || 0;
  for (const [reason, amount] of Object.entries(voidCost)) {
    const acc = VOID_REASONS[reason]?.costAccount;
    const amt = round2(Math.min(amount || 0, available));
    if (!acc || amt <= 0) continue;
    available = round2(available - amt);
    lines.push({ account: acc, debit: amt, credit: 0, memo: `${VOID_REASONS[reason].label}耗用成本（自銷貨成本轉出）` });
    lines.push({ account: '5101', debit: 0, credit: amt, memo: '' });
  }
  if (!lines.length) return null;
  const [y, m] = ym.split('-');
  const last = new Date(Date.UTC(+y, +m, 0)).getUTCDate();
  return { date: `${ym}-${String(last).padStart(2, '0')}`, description: `${Number(y) - 1911} 年 ${Number(m)} 月 存貨盤點與銷貨成本`, source: 'cogs', source_ref: ym, lines };
}

// 支出憑證 → 分錄（借 費用/存貨 + 進項稅額；貸 付款來源）
export function documentJournal(doc, { payAccount = '1101', deductible = true } = {}) {
  const total = round2(Number(doc.amount_total) || 0);
  if (!total || !doc.account) return null;
  const tax = deductible ? round2(Number(doc.tax_amount) || 0) : 0;
  const lines = [{ account: doc.account, debit: round2(total - tax), credit: 0, memo: doc.summary || doc.vendor_name || '' }];
  if (tax) lines.push({ account: '1261', debit: tax, credit: 0, memo: '進項稅額' });
  lines.push({ account: doc.pay_account || payAccount, debit: 0, credit: total, memo: '' });
  return {
    date: doc.doc_date,
    description: [doc.vendor_name, doc.summary, doc.invoice_no].filter(Boolean).join('｜'),
    source: 'document',
    source_ref: doc.id,
    lines,
  };
}

/**
 * 合併自動分錄：同 source+source_ref 者更新內容但保留 id／傳票號；鎖定月份跳過。
 * @returns {{ upserts: object[], removes: string[], skippedLocked: number }}
 */
export function mergeGenerated(existing, generated, { source, lockedMonths = new Set(), makeId, nextNo, scopeRefs = null }) {
  const bySrc = new Map(existing.filter((e) => e.source === source).map((e) => [e.source_ref, e]));
  const upserts = [];
  let skippedLocked = 0;
  const seen = new Set();
  const pool = [...existing];
  for (const g of generated) {
    seen.add(g.source_ref);
    if (lockedMonths.has(g.date.slice(0, 7))) {
      skippedLocked++;
      continue;
    }
    const old = bySrc.get(g.source_ref);
    if (old) {
      if (JSON.stringify(old.lines) === JSON.stringify(g.lines) && old.date === g.date && old.description === g.description) continue;
      upserts.push({ ...old, ...g, id: old.id, voucher_no: old.date.slice(0, 7) === g.date.slice(0, 7) ? old.voucher_no : nextNo(pool, g.date), updated_at: new Date().toISOString() });
    } else {
      const e = { ...g, id: makeId(), voucher_no: nextNo(pool, g.date), status: 'posted', created_at: new Date().toISOString() };
      pool.push(e);
      upserts.push(e);
    }
  }
  // 來源已不存在（例如刪除匯入批次）→ 移除自動分錄
  const removes = [];
  for (const [ref, e] of bySrc) {
    if (seen.has(ref)) continue;
    if (scopeRefs && !scopeRefs.has(ref)) continue;
    if (lockedMonths.has(e.date.slice(0, 7))) continue;
    removes.push(e.id);
  }
  return { upserts, removes, skippedLocked };
}

export { PAYMENT_TYPES, CATEGORIES };
