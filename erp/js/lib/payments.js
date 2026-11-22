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
  // 每列一筆刷卡（綠界「信用卡撥款明細」：有授權單號／卡號）：依金流、請款日彙總成一筆撥款，和存摺入帳的金額才對得上
  // 有「交易日期」欄時，每筆撥款另記各交易日的金額（tx_days），刷卡逐日核對可以改用撥款明細的交易日期比對
  const perTx = rawRows.some((r) => String(r.tx_id || '').trim() || parseDate(r.tx_date));
  const groups = new Map();
  for (const r of rawRows) {
    if (Object.values(r).some((v) => /小計|合計|總計/.test(String(v ?? '')))) {
      skipped.push({ row: r._row, reason: '小計／合計列，不匯入' });
      continue;
    }
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
    if (perTx) {
      const key = `${prov}|${date}`;
      const g = groups.get(key) || { batch_id: batchId, provider: prov, payout_date: date, gross: 0, fee: 0, net: 0, period_from: null, period_to: null, tx_count: 0, ref: '', note: '', _row: r._row, _days: new Map() };
      g.gross = round2(g.gross + gross);
      g.fee = round2(g.fee + fee);
      g.net = round2(g.net + net);
      g.tx_count++;
      const txDate = parseDate(r.tx_date);
      if (txDate) {
        const d = g._days.get(txDate) || { date: txDate, gross: 0, fee: 0, net: 0, count: 0 };
        d.gross = round2(d.gross + gross);
        d.fee = round2(d.fee + fee);
        d.net = round2(d.net + net);
        d.count++;
        g._days.set(txDate, d);
      }
      groups.set(key, g);
      continue;
    }
    out.push({
      _row: r._row,
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
  for (const { _days, ...g } of groups.values()) {
    g.id = 'po_' + fnv1a([g.provider, g.payout_date, 'tx', g.gross, g.net, g.fee].join('|'));
    g.note = `${g.tx_count} 筆刷卡彙總`;
    if (_days.size) {
      g.tx_days = [..._days.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      g.period_from = g.tx_days[0].date;
      g.period_to = g.tx_days[g.tx_days.length - 1].date;
    }
    out.push(g);
  }
  // 同一檔案裡完全相同的列（撥款日、金額都一樣）只留一筆：同一主鍵寫兩次會被資料庫拒絕
  const seen = new Map();
  for (const r of out) {
    const { _row, ...row } = r;
    if (seen.has(row.id)) skipped.push({ row: _row, reason: '與同檔另一列相同（撥款日、金額都一樣）' });
    else seen.set(row.id, row);
  }
  return { rows: [...seen.values()].sort((a, b) => (a.payout_date < b.payout_date ? -1 : a.payout_date > b.payout_date ? 1 : 0)), skipped };
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

// 撥款明細（綠界信用卡撥款明細，每列一筆刷卡）依「交易日期」加總。同一天的刷卡可能分在不同撥款日，所以要看全部撥款，不是只看期間內撥款的
export function payoutTxDays(payouts, { provider = 'ecpay' } = {}) {
  const days = new Map();
  let coveredTo = '';
  for (const p of payouts) {
    if (p.provider !== provider || !Array.isArray(p.tx_days)) continue;
    for (const d of p.tx_days) {
      const x = days.get(d.date) || { date: d.date, gross: 0, fee: 0, net: 0, count: 0 };
      x.gross = round2(x.gross + (Number(d.gross) || 0));
      x.fee = round2(x.fee + (Number(d.fee) || 0));
      x.net = round2(x.net + (Number(d.net) || 0));
      x.count += Number(d.count) || 0;
      days.set(d.date, x);
      if (d.date > coveredTo) coveredTo = d.date;
    }
  }
  return { days, coveredTo };
}

/**
 * 每日：POS 刷卡營收 vs 撥款明細的交易日期加總。
 * 撥款明細只含已撥款的刷卡：最後一個交易日之後的日子（例如月底刷卡、下個月才撥款）標 pending「等下一期撥款明細」，不算差異。
 */
export function dailyCardReconByPayout(lines, payouts, { from, to } = {}) {
  const { days: txDays, coveredTo } = payoutTxDays(payouts);
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
  for (const x of txDays.values()) {
    if ((from && x.date < from) || (to && x.date > to)) continue;
    const d = get(x.date);
    d.ecpay += x.gross;
    d.ecpayCount += x.count;
    d.fee += x.fee;
  }
  return [...days.values()]
    .map((d) => {
      const diff = round2(d.ecpay - d.pos);
      return { ...d, pos: round2(d.pos), ecpay: round2(d.ecpay), fee: round2(d.fee), posOrders: d.posOrders.size, diff, pending: !coveredTo || d.date > coveredTo };
    })
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

export const CARD_SOURCES = { tx: '綠界交易明細', payout: '撥款明細（交易日期）' };

/**
 * 刷卡逐日核對：兩種比對來源都算，並自動挑一個。
 * 只有一種有資料就用那種；兩種都有，用有差異天數少的（一樣多用交易明細）。source 指定時照指定。
 * @returns { source, auto, has: {tx, payout}, rows, bySource: {tx, payout}, diffDays: {tx, payout}, pendingDays }
 */
export function cardRecon(lines, txs, payouts, { from, to, source = '' } = {}) {
  const T = txs.filter((t) => (!from || t.date >= from) && (!to || t.date <= to));
  const bySource = { tx: dailyCardRecon(lines, T, { from, to }), payout: dailyCardReconByPayout(lines, payouts, { from, to }) };
  const has = { tx: T.length > 0, payout: bySource.payout.some((d) => d.ecpayCount > 0) };
  const isDiff = (d) => !d.pending && Math.abs(d.diff) >= 1;
  const diffDays = { tx: bySource.tx.filter(isDiff).length, payout: bySource.payout.filter(isDiff).length };
  const pendingDays = bySource.payout.filter((d) => d.pending && Math.abs(d.diff) >= 1).length;
  let auto = 'tx';
  if (has.payout && !has.tx) auto = 'payout';
  else if (has.payout && has.tx && diffDays.payout + pendingDays < diffDays.tx) auto = 'payout';
  const pick = CARD_SOURCES[source] ? source : auto;
  return { source: pick, auto, has, rows: bySource[pick], bySource, diffDays, pendingDays };
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
