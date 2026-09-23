// 金流對帳：POS 刷卡營收 ↔ 綠界刷卡明細 ↔ 撥款明細 ↔ 銀行存摺入帳。

import { parseDateTime, parseDate, addDays, daysBetween } from './dates.js';
import { parseAmount, round2 } from './money.js';
import { fnv1a, normalizeText } from './text.js';

const FAIL = /失敗|取消|退款|退刷|未付款|未完成|授權失敗|逾期|作廢|fail|cancel|refund|void|unpaid/i;

export function normalizeEcpayTx(rawRows, { batchId = '' } = {}) {
  const out = [];
  const skipped = [];
  const seen = new Map();
  for (const r of rawRows) {
    const dt = parseDateTime(r.datetime);
    const amount = parseAmount(r.amount);
    if (!dt || amount === null) {
      skipped.push({ row: r._row, reason: !dt ? '日期無法辨識' : '金額無法辨識' });
      continue;
    }
    const fee = Math.abs(parseAmount(r.fee) ?? 0);
    const netRaw = parseAmount(r.net);
    const status = String(r.status || '').trim();
    const base = r.provider_no || `${r.order_no}|${dt.date}|${dt.time}|${amount}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    out.push({
      id: 'ec_' + fnv1a(base) + (n > 1 ? '_' + n : ''),
      batch_id: batchId,
      provider: 'ecpay',
      date: dt.date,
      time: dt.time,
      order_no: String(r.order_no || '').trim(),
      provider_no: String(r.provider_no || '').trim(),
      amount,
      fee,
      net: netRaw !== null ? netRaw : round2(amount - fee),
      status,
      ok: !FAIL.test(status) && amount > 0,
      payout_date: parseDate(r.payout_date),
      method: String(r.method || '').trim(),
      card_last4: String(r.card_last4 || '').replace(/\D/g, '').slice(-4),
      note: String(r.note || '').trim(),
    });
  }
  return { rows: out, skipped };
}

export function guessProvider(text) {
  const s = normalizeText(text);
  if (/line/.test(s)) return 'linepay';
  if (/街口|jko/.test(s)) return 'jkopay';
  if (/uber|foodpanda|熊貓|外送/.test(s)) return 'platform';
  if (/綠界|ecpay|信用卡|刷卡/.test(s)) return 'ecpay';
  return null;
}

export function normalizePayouts(rawRows, { batchId = '', provider = 'ecpay' } = {}) {
  const out = [];
  const skipped = [];
  for (const r of rawRows) {
    const date = parseDate(r.payout_date);
    let gross = parseAmount(r.gross);
    const fee = Math.abs(parseAmount(r.fee) ?? 0);
    let net = parseAmount(r.net);
    if (!date || (gross === null && net === null)) {
      skipped.push({ row: r._row, reason: !date ? '日期無法辨識' : '金額無法辨識' });
      continue;
    }
    if (net === null) net = round2(gross - fee);
    if (gross === null) gross = round2(net + fee);
    const prov = guessProvider(r.provider) || provider;
    const ref = String(r.ref || '').trim();
    out.push({
      id: 'po_' + fnv1a([prov, date, ref, gross, net, fee].join('|')),
      batch_id: batchId,
      provider: prov,
      payout_date: date,
      gross,
      fee,
      net,
      period_from: parseDate(r.period_from),
      period_to: parseDate(r.period_to),
      tx_count: parseAmount(r.tx_count),
      ref,
      note: String(r.note || '').trim(),
    });
  }
  return { rows: out, skipped };
}

// 每日：POS 刷卡營收 vs 綠界交易
export function dailyCardRecon(lines, txs, { from, to } = {}) {
  const days = new Map();
  const get = (d) => {
    if (!days.has(d)) days.set(d, { date: d, pos: 0, posOrders: new Set(), ecpay: 0, ecpayCount: 0, fee: 0, failed: 0 });
    return days.get(d);
  };
  for (const l of lines) {
    if (l.payment !== 'card' || l.void_reason) continue;
    if ((from && l.date < from) || (to && l.date > to)) continue;
    const d = get(l.date);
    d.pos += l.amount;
    if (l.order_no) d.posOrders.add(l.order_no);
  }
  for (const t of txs) {
    if ((from && t.date < from) || (to && t.date > to)) continue;
    const d = get(t.date);
    if (!t.ok) {
      d.failed++;
      continue;
    }
    d.ecpay += t.amount;
    d.ecpayCount++;
    d.fee += t.fee;
  }
  return [...days.values()]
    .map((d) => ({ ...d, pos: round2(d.pos), ecpay: round2(d.ecpay), fee: round2(d.fee), posOrders: d.posOrders.size, diff: round2(d.ecpay - d.pos) }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

// 逐筆比對：訂單號相同優先，其次同日同金額
export function matchCardOrders(lines, txs) {
  const orders = new Map();
  for (const l of lines) {
    if (l.payment !== 'card' || l.void_reason) continue;
    const k = l.order_no || `${l.date}|${l.time}`;
    const o = orders.get(k) || { key: k, order_no: l.order_no, date: l.date, time: l.time, amount: 0 };
    o.amount = round2(o.amount + l.amount);
    orders.set(k, o);
  }
  const pos = [...orders.values()];
  const byNo = new Map(pos.filter((o) => o.order_no).map((o) => [o.order_no, o]));
  const used = new Set();
  const matches = [];
  const unmatchedTx = [];
  for (const t of txs.filter((x) => x.ok)) {
    let o = t.order_no && byNo.get(t.order_no);
    if (o && used.has(o.key)) o = null;
    if (!o) o = pos.find((p) => !used.has(p.key) && p.date === t.date && Math.abs(p.amount - t.amount) < 0.5);
    if (o) {
      used.add(o.key);
      matches.push({ tx: t, order: o, diff: round2(t.amount - o.amount) });
    } else unmatchedTx.push(t);
  }
  return { matches, unmatchedTx, unmatchedPos: pos.filter((p) => !used.has(p.key)) };
}

// 撥款核對：同撥款日的交易淨額加總 vs 撥款金額
export function payoutRecon(txs, payouts) {
  const byDate = new Map();
  for (const t of txs) {
    if (!t.ok || !t.payout_date) continue;
    const s = byDate.get(t.payout_date) || { gross: 0, fee: 0, net: 0, count: 0 };
    s.gross += t.amount;
    s.fee += t.fee;
    s.net += t.net;
    s.count++;
    byDate.set(t.payout_date, s);
  }
  return payouts
    .filter((p) => p.provider === 'ecpay')
    .map((p) => {
      const s = byDate.get(p.payout_date);
      return { payout: p, expectedNet: s ? round2(s.net) : null, expectedCount: s ? s.count : 0, diff: s ? round2(p.net - s.net) : null };
    });
}

// 撥款 ↔ 銀行入帳：金額相同、撥款日前 1 天至後 5 天
export function matchPayoutsToBank(payouts, bankLines) {
  const used = new Set();
  const res = [];
  for (const p of [...payouts].sort((a, b) => (a.payout_date < b.payout_date ? -1 : 1))) {
    const cand = bankLines
      .filter((b) => !used.has(b.id) && b.deposit > 0 && Math.abs(b.deposit - p.net) < 1 && daysBetween(p.payout_date, b.date) >= -1 && daysBetween(p.payout_date, b.date) <= 5)
      .sort((a, b) => Math.abs(daysBetween(p.payout_date, a.date)) - Math.abs(daysBetween(p.payout_date, b.date)))[0];
    if (cand) used.add(cand.id);
    res.push({ payout: p, bank: cand || null });
  }
  return res;
}

// 在途款項餘額：已入 POS 刷卡但尚未撥款
export function inTransit(lines, payouts, { provider = 'ecpay', payment = 'card', asOf } = {}) {
  const sales = round2(lines.filter((l) => l.payment === payment && !l.void_reason && (!asOf || l.date <= asOf)).reduce((t, l) => t + l.amount, 0));
  const paid = round2(payouts.filter((p) => p.provider === provider && (!asOf || p.payout_date <= asOf)).reduce((t, p) => t + p.gross, 0));
  return { sales, paid, pending: round2(sales - paid) };
}

export { addDays };
