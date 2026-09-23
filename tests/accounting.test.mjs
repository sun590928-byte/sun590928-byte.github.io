// 帳務引擎、自動分錄、折舊、存貨、會員、金流與存摺對帳、電子發票、檔名、行事曆
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_ACCOUNTS, accountMap } from '../erp/js/lib/coa.js';
import { validateEntry, trialBalance, incomeStatement, balanceSheet, generalLedger, voucherKind, nextVoucherNo, closingEntry, renumberMonth } from '../erp/js/lib/ledger.js';
import { salesJournal, payoutJournal, depreciationJournal, cogsJournal, documentJournal, mergeGenerated } from '../erp/js/lib/autojournal.js';
import { schedule, defaultResidual, depreciationForMonth, assetSummary } from '../erp/js/lib/assets.js';
import { theoreticalUsage, stockLevels, averageCosts, productCosts, supplierStats, priceHistory } from '../erp/js/lib/inventory.js';
import { buildProfiles, memberKey, campaignStats, firstVisits, tierOf } from '../erp/js/lib/customers.js';
import { normalizeEcpayTx, normalizePayouts, dailyCardRecon, payoutRecon, matchPayoutsToBank, matchCardOrders } from '../erp/js/lib/payments.js';
import { normalizeBank, autoMatch, reconciliation, bookLines } from '../erp/js/lib/bank.js';
import { parseMofInvoices } from '../erp/js/lib/einvoice.js';
import { parseDocName, archiveName, archiveFolder } from '../erp/js/lib/docname.js';
import { classifyExpense, isValidTaxId } from '../erp/js/lib/classify.js';
import { buildCalendar, shiftWeekend } from '../erp/js/lib/taxcal.js';
import { buildJournalEntries } from '../erp/js/lib/journalimport.js';
import { makeZip, crc32 } from '../erp/js/lib/zip.js';
import { unzip } from '../erp/js/lib/xlsx.js';
import { periodPnl } from '../erp/js/lib/pnl.js';
import { decodeBytes, parseCSV } from '../erp/js/lib/csv.js';
import { detectHeaderRow, autoMap, extract } from '../erp/js/lib/importer.js';
import { normalizeSales } from '../erp/js/lib/pos.js';

const accounts = DEFAULT_ACCOUNTS;
const E = (date, lines, extra = {}) => ({ id: Math.random().toString(36).slice(2), date, voucher_no: '', description: '', lines, ...extra });
const L = (account, debit, credit, memo = '') => ({ account, debit, credit, memo });

test('coa: 科目代號唯一、方向正確、費用對應營所稅欄位', () => {
  const codes = accounts.map((a) => a.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const a of accounts) {
    if (a.contra) continue;
    const debitType = ['asset', 'cogs', 'expense', 'nonop_expense', 'tax'].includes(a.type);
    assert.equal(a.side, debitType ? 'debit' : 'credit', a.code);
  }
  assert.equal(accountMap(accounts).get('1512').side, 'credit');
  assert.equal(accountMap(accounts).get('4192').side, 'debit');
  assert.ok(accounts.filter((a) => a.type === 'expense').every((a) => a.tax_line), '費用皆有申報欄位');
});

test('ledger: 驗證、試算表、損益表、資產負債表平衡', () => {
  const accMap = accountMap(accounts);
  assert.deepEqual(validateEntry(E('2026-08-21', [L('1101', 100, 0), L('4101', 0, 90)]), accMap), ['借貸不平衡：借 100／貸 90']);
  assert.ok(validateEntry(E('2026-08-21', [L('9999', 100, 0), L('4101', 0, 100)]), accMap)[0].includes('不存在'));
  const entries = [
    E('2026-08-20', [L('1103', 300000, 0), L('1511', 180000, 0), L('3101', 0, 480000)], { source: 'opening' }),
    E('2026-08-21', [L('1101', 1050, 0), L('4101', 0, 1000), L('2131', 0, 50)]),
    E('2026-08-31', [L('6111', 25000, 0), L('1103', 0, 25000)]),
    E('2026-08-31', [L('6124', 2727, 0), L('1512', 0, 2727)]),
    E('2026-09-02', [L('1101', 525, 0), L('4101', 0, 500), L('2131', 0, 25)]),
  ];
  const tb = trialBalance(entries, accounts, { from: '2026-09-01', to: '2026-09-30' });
  assert.ok(tb.balanced);
  assert.equal(tb.totals.periodDr, 525);
  const r1101 = tb.rows.find((r) => r.code === '1101');
  assert.equal(r1101.openDr, 1050);
  assert.equal(r1101.closeDr, 1575);
  const is = incomeStatement(entries, accounts, { from: '2026-08-01', to: '2026-08-31' });
  assert.equal(is.netRevenue, 1000);
  assert.equal(is.opexTotal, 27727);
  assert.equal(is.netIncome, -26727);
  const bs = balanceSheet(entries, accounts, { asOf: '2026-09-30' });
  assert.ok(bs.balanced, `diff ${bs.diff}`);
  assert.equal(bs.totalAssets, 300000 - 25000 + 180000 - 2727 + 1050 + 525);
  assert.equal(bs.assetsNon.find((r) => r.code === '1512').amount, -2727);
  const gl = generalLedger(entries, accounts, { from: '2026-09-01', to: '2026-09-30', codes: ['1101'] });
  assert.equal(gl.get('1101').opening, 1050);
  assert.equal(gl.get('1101').closing, 1575);
  // 年底結帳後損益表仍顯示全年、資產負債表仍平衡
  const ce = closingEntry(entries, accounts, 2026);
  const withClosing = [...entries, { ...ce, id: 'c', voucher_no: '11512-0001' }];
  assert.equal(incomeStatement(withClosing, accounts, { from: '2026-01-01', to: '2026-12-31' }).netIncome, -26727 + 500);
  const bs2 = balanceSheet(withClosing, accounts, { asOf: '2026-12-31' });
  assert.ok(bs2.balanced, `closing diff ${bs2.diff}`);
  assert.ok(trialBalance(withClosing, accounts, { to: '2026-12-31' }).balanced);
});

test('ledger: 傳票種類與編號', () => {
  assert.equal(voucherKind(E('2026-09-01', [L('1101', 100, 0), L('4101', 0, 100)])), '現金收入傳票');
  assert.equal(voucherKind(E('2026-09-01', [L('6118', 100, 0), L('1103', 0, 100)])), '現金支出傳票');
  assert.equal(voucherKind(E('2026-09-01', [L('1111', 100, 0), L('4101', 0, 100)])), '轉帳傳票');
  const list = [{ voucher_no: '11509-0001' }, { voucher_no: '11509-0007' }, { voucher_no: '11508-0020' }];
  assert.equal(nextVoucherNo(list, '2026-09-15'), '11509-0008');
  assert.equal(nextVoucherNo(list, '2026-10-01'), '11510-0001');
  const rn = renumberMonth([{ date: '2026-09-05', voucher_no: 'x' }, { date: '2026-09-01', voucher_no: 'y' }], '2026-09');
  assert.deepEqual(rn.map((e) => e.voucher_no), ['11509-0001', '11509-0002']);
});

function loadSales() {
  const { text } = decodeBytes(readFileSync(new URL('./fixtures/synthetic-pos-big5.csv', import.meta.url)));
  const rows = parseCSV(text);
  const { index } = detectHeaderRow(rows, 'sales');
  return normalizeSales(extract(rows, index, autoMap(rows[index], 'sales'))).lines;
}

test('autojournal: POS 日營收分錄借貸平衡、作廢不入帳、營業稅 5% 內含', () => {
  const lines = loadSales().filter((l) => l.date >= '2026-08-21');
  const cat = (l) => (/巴斯克/.test(l.item_raw) ? 'food' : /豆/.test(l.item_raw) ? 'retail' : /抹茶/.test(l.item_raw) ? 'non_coffee' : 'coffee');
  const entries = salesJournal(lines, { categoryOf: cat, vatMode: 'general' });
  assert.equal(entries.length, new Set(lines.map((l) => l.date)).size);
  const accMap = accountMap(accounts);
  for (const e of entries) assert.deepEqual(validateEntry(e, accMap), [], e.date);
  const receipts = lines.filter((l) => !l.void_reason).reduce((t, l) => t + l.amount, 0);
  const debits = entries.reduce((t, e) => t + e.lines.reduce((s, x) => s + x.debit, 0) - e.lines.filter((x) => x.account === '4192').reduce((s, x) => s + x.debit, 0), 0);
  assert.equal(debits, receipts, '收款合計 = 有效營收');
  const is = incomeStatement(entries.map((e, i) => ({ ...e, id: String(i) })), accounts, {});
  const tax = entries.flatMap((e) => e.lines).filter((x) => x.account === '2131').reduce((t, x) => t + x.credit - x.debit, 0);
  assert.ok(Math.abs(is.netRevenue + tax - receipts) < 0.01, '未稅收入 + 銷項稅 = 含稅收款');
  assert.ok(Math.abs(tax - receipts * 5 / 105) < entries.length, '稅額約為 5/105');
  const small = salesJournal(lines, { categoryOf: cat, vatMode: 'small' });
  assert.ok(!small.flatMap((e) => e.lines).some((x) => x.account === '2131'), '小規模不分列銷項稅');
});

test('autojournal: 撥款、折舊、月底成本、憑證、自動分錄合併', () => {
  const accMap = accountMap(accounts);
  const po = payoutJournal({ id: 'p1', provider: 'ecpay', payout_date: '2026-09-01', gross: 1000, fee: 25, net: 975 });
  assert.deepEqual(validateEntry(po, accMap), []);
  assert.deepEqual(po.lines.map((l) => [l.account, l.debit, l.credit]), [['1103', 975, 0], ['6131', 25, 0], ['1111', 0, 1000]]);
  const dep = depreciationJournal('2026-09', [{ name: '咖啡機', amount: 2727, accum: '1512' }, { name: '冰箱', amount: 500, accum: '1522' }]);
  assert.deepEqual(validateEntry(dep, accMap), []);
  assert.equal(dep.date, '2026-09-30');
  const cg = cogsJournal('2026-09', [{ account: '1211', name: '咖啡豆', book: 12000, counted: 4000 }, { account: '1212', name: '乳品', book: 3000, counted: 3500 }], { boss_treat: 300, scrap: 200 });
  assert.deepEqual(validateEntry(cg, accMap), []);
  const net = (code) => cg.lines.filter((l) => l.account === code).reduce((t, l) => t + l.debit - l.credit, 0);
  assert.equal(net('1211'), -8000);
  assert.equal(net('5101'), 8000 - 500);
  assert.equal(net('6120'), 300);
  assert.equal(net('5105'), 200);
  assert.equal(net('5106'), -500, '盤盈');
  const doc = documentJournal({ id: 'd1', doc_date: '2026-09-03', vendor_name: '鮮乳坊', amount_total: 1050, tax_amount: 50, account: '1212', pay_account: '2191' });
  assert.deepEqual(validateEntry(doc, accMap), []);
  assert.deepEqual(doc.lines.map((l) => l.account), ['1212', '1261', '2191']);
  const existing = [{ id: 'a', source: 'pos', source_ref: '2026-08-21', date: '2026-08-21', voucher_no: '11508-0001', lines: [L('1101', 1, 0), L('4101', 0, 1)], description: 'x' }, { id: 'b', source: 'pos', source_ref: '2026-08-22', date: '2026-08-22', voucher_no: '11508-0002', lines: [], description: 'y' }, { id: 'c', source: 'pos', source_ref: '2026-07-31', date: '2026-07-31', voucher_no: '11507-0001', lines: [], description: 'z' }];
  let n = 0;
  const res = mergeGenerated(existing, [{ date: '2026-08-21', source: 'pos', source_ref: '2026-08-21', description: 'x2', lines: [L('1101', 2, 0), L('4101', 0, 2)] }, { date: '2026-08-23', source: 'pos', source_ref: '2026-08-23', description: 'n', lines: [L('1101', 3, 0), L('4101', 0, 3)] }], { source: 'pos', lockedMonths: new Set(['2026-07']), makeId: () => 'new' + n++, nextNo: nextVoucherNo });
  assert.equal(res.upserts.length, 2);
  assert.equal(res.upserts[0].id, 'a');
  assert.equal(res.upserts[0].voucher_no, '11508-0001', '沿用傳票號');
  assert.equal(res.upserts[1].voucher_no, '11508-0003');
  assert.deepEqual(res.removes, ['b'], '來源消失的移除、鎖定月份保留');
});

test('assets: 平均法、殘值 = 成本/(年數+1)、最後一期補尾差', () => {
  assert.equal(defaultResidual(180000, 5), 30000);
  const s = schedule({ name: '咖啡機', category: 'machine', acquired_on: '2026-07-15', cost: 180000, life_years: 5 });
  assert.equal(s.length, 60);
  assert.equal(s[0].month, '2026-07');
  assert.equal(s[0].amount, 2500);
  assert.equal(s[59].accum, 150000);
  assert.equal(s[59].book, 30000);
  const odd = schedule({ name: 'x', acquired_on: '2026-01-01', cost: 10000, life_years: 3, residual: 0 });
  assert.equal(odd.reduce((t, r) => t + r.amount, 0), 10000);
  const dis = schedule({ name: 'y', acquired_on: '2026-01-01', cost: 12000, life_years: 1, residual: 0, disposed_on: '2026-03-10' });
  assert.equal(dis.length, 3);
  assert.deepEqual(depreciationForMonth([{ id: 'a', name: '咖啡機', category: 'machine', acquired_on: '2026-07-15', cost: 180000, life_years: 5 }], '2026-09'), [{ id: 'a', name: '咖啡機', amount: 2500, accum: '1512' }]);
  const sum = assetSummary([{ id: 'a', name: '咖啡機', category: 'machine', acquired_on: '2026-07-15', cost: 180000, life_years: 5 }], '2026-09');
  assert.equal(sum[0].accum, 7500);
  assert.equal(sum[0].thisYear, 7500);
});

test('inventory: 配方耗用、報廢量、加權平均成本、安全庫存', () => {
  const items = [{ id: 'bean', name: '花季豆', gl_account: '1211', safety_stock: 500 }, { id: 'milk', name: '鮮奶', gl_account: '1212', safety_stock: 2000 }];
  const moves = [
    { item_id: 'bean', date: '2026-08-20', type: 'purchase', qty: 1000, amount: 1000 },
    { item_id: 'bean', date: '2026-09-01', type: 'purchase', qty: 1000, amount: 1400 },
    { item_id: 'milk', date: '2026-08-20', type: 'purchase', qty: 4000, amount: 400, supplier_id: 's1', order_date: '2026-08-18', yield_score: 98 },
  ];
  const recipes = [{ product_id: 'latte', item_id: 'bean', qty: 18 }, { product_id: 'latte', item_id: 'milk', qty: 200 }];
  const lines = [
    { date: '2026-09-02', qty: 10, item_raw: '拿鐵', void_reason: null },
    { date: '2026-09-02', qty: 2, item_raw: '拿鐵', void_reason: 'boss_treat' },
    { date: '2026-09-03', qty: 1, item_raw: '拿鐵', void_reason: 'scrap' },
    { date: '2026-09-03', qty: 5, item_raw: '拿鐵', void_reason: 'pos_void' },
  ];
  const usage = theoreticalUsage(lines, recipes, () => 'latte');
  assert.equal(usage.get('bean').consume, 12 * 18);
  assert.equal(usage.get('bean').scrap, 18);
  assert.equal(usage.get('milk').byReason.boss_treat, 400);
  const avg = averageCosts(items, moves);
  assert.equal(avg.get('bean').avg, 1.2);
  const lv = stockLevels(items, moves, usage, { asOf: '2026-09-03', lookbackDays: 14 });
  const bean = lv.find((x) => x.item.id === 'bean');
  assert.equal(bean.onHand, 2000 - 216 - 18);
  assert.equal(bean.status, 'ok');
  const milk = lv.find((x) => x.item.id === 'milk');
  assert.equal(milk.onHand, 4000 - 2400 - 200);
  assert.equal(milk.status, 'low');
  const pc = productCosts([{ id: 'latte' }], recipes, (id) => avg.get(id).avg);
  assert.ok(Math.abs(pc.get('latte') - (18 * 1.2 + 200 * 0.1)) < 0.01);
  const st = supplierStats([{ id: 's1', name: '鮮乳坊' }], items, moves);
  assert.equal(st[0].avgLead, 2);
  assert.equal(st[0].avgYield, 98);
  const ph = priceHistory(moves, 'bean');
  assert.equal(ph.stats.latest, 1.4);
  assert.ok(Math.abs(ph.stats.changeVsPrev - 0.4) < 1e-9);
});

test('customers: 會員鍵、輪廓、分群、等級、行銷活動 ROI', () => {
  assert.equal(memberKey('0912-345-678'), '0912345678');
  assert.equal(memberKey('+886912345678'), '0912345678');
  assert.equal(memberKey('VIP 001'), 'VIP001');
  assert.deepEqual(tierOf(5200), { tier: '金卡', next: { name: '黑卡', gap: 6800 } });
  const lines = [];
  for (let i = 0; i < 8; i++) lines.push({ date: `2026-09-${String(10 + i).padStart(2, '0')}`, time: '09:30', order_no: 'o' + i, member: '0912345678', revenue: 150, qty: 1, amount: 150, item_raw: '燕麥拿鐵', option_raw: '燕麥奶 少冰', note: '' });
  lines.push({ date: '2026-07-01', time: '15:00', order_no: 'x', member: '0987654321', revenue: 90, qty: 1, amount: 90, item_raw: '美式', option_raw: '', note: '' });
  const ps = buildProfiles(lines, [{ member_no: '0912-345-678', name: '王小姐' }], { asOf: '2026-09-20' });
  const p = ps.find((x) => x.key === '0912345678');
  assert.equal(p.name, '王小姐');
  assert.equal(p.spend, 1200);
  assert.equal(p.segment, '忠實常客');
  assert.deepEqual(p.prefs.slice(0, 2), ['燕麥奶', '少冰']);
  assert.equal(p.favHour, '09');
  assert.equal(ps.find((x) => x.key === '0987654321').segment, '流失風險');
  const fv = firstVisits(lines);
  const c = campaignStats({ start_date: '2026-09-10', end_date: '2026-09-12', keywords: '燕麥', marketing_cost: 100 }, lines, { firstVisit: fv, grossMargin: 0.7 });
  assert.equal(c.orders, 3);
  assert.equal(c.revenue, 450);
  assert.equal(c.newCustomers, 1);
  assert.equal(c.cac, 100);
  assert.ok(Math.abs(c.roi - (450 * 0.7 - 100) / 100) < 1e-9);
});

test('payments: 綠界交易、撥款核對、存摺比對', () => {
  const ec = parseCSV(readFileSync(new URL('./fixtures/synthetic-ecpay-tx.csv', import.meta.url), 'utf8').replace(/^﻿/, ''));
  const raw = extract(ec, 0, autoMap(ec[0], 'ecpay_tx'));
  const { rows: txs } = normalizeEcpayTx(raw);
  assert.equal(txs.length, 110);
  assert.ok(txs.every((t) => t.ok && t.payout_date));
  const lines = loadSales();
  const daily = dailyCardRecon(lines, txs);
  assert.ok(daily.every((d) => Math.abs(d.diff) < 0.5), '合成資料的刷卡逐日應相符');
  const m = matchCardOrders(lines.filter((l) => !l.void_reason), txs);
  assert.equal(m.unmatchedTx.length, 0);
  const byPay = new Map();
  for (const t of txs) byPay.set(t.payout_date, (byPay.get(t.payout_date) || 0) + t.net);
  const payouts = normalizePayouts([...byPay].map(([d, net], i) => ({ payout_date: d, net: String(net), fee: '0', _row: i })), { provider: 'ecpay' }).rows;
  assert.ok(payoutRecon(txs, payouts).every((r) => r.diff === 0));
  const bank = [{ id: 'b1', date: payouts[0].payout_date, deposit: payouts[0].net, withdrawal: 0 }, { id: 'b2', date: '2030-01-01', deposit: 5, withdrawal: 0 }];
  const mb = matchPayoutsToBank(payouts, bank);
  assert.equal(mb[0].bank.id, 'b1');
  assert.equal(mb.filter((x) => x.bank).length, 1);
});

test('bank: 正負金額欄、自動勾稽、調節表', () => {
  const { rows } = normalizeBank([
    { _row: 2, date: '2026/09/01', description: '期初', amount: '0' },
    { _row: 3, date: '2026/09/02', description: '綠界撥款', deposit: '975', balance: '10975' },
    { _row: 4, date: '2026/09/05', description: '台電自動扣繳', withdrawal: '1,200', balance: '9775' },
    { _row: 5, date: '2026/09/30', description: '利息', amount: '3', balance: '9778' },
  ]);
  assert.equal(rows.length, 3);
  const entries = [
    { id: 'o', date: '2026-08-31', voucher_no: '11508-0001', lines: [L('1103', 10000, 0), L('3101', 0, 10000)] },
    { id: 'p', date: '2026-09-01', voucher_no: '11509-0001', lines: [L('1103', 975, 0), L('6131', 25, 0), L('1111', 0, 1000)] },
    { id: 'q', date: '2026-09-29', voucher_no: '11509-0002', lines: [L('6111', 500, 0), L('1103', 0, 500)] },
  ];
  const books = bookLines(entries, '1103');
  const matches = autoMatch(rows, books);
  assert.equal(matches.get(rows[0].id), 'p#0');
  const rec = reconciliation({ bankLines: rows, books, matches, asOf: '2026-09-30' });
  assert.equal(rec.bankBalance, 9778);
  assert.equal(rec.bookBalance, 10475);
  assert.equal(rec.outstanding.length, 1, '未兌現 500');
  assert.equal(rec.bankOnlyOut.length, 1, '台電扣款帳上未記');
  assert.equal(rec.bankOnlyIn.length, 1, '利息帳上未記');
  assert.equal(rec.adjBank, 9278);
  assert.equal(rec.adjBook, 10475 + 3 - 1200);
  assert.equal(rec.diff, 0);
});

test('einvoice: 財政部 M/D 格式、B2B 進項稅額、建議科目', () => {
  const text = ['表頭=M|載具名稱|載具號碼|發票日期|商店統編|商店店名|發票號碼|總金額|發票狀態|買方統編|', '明細=D|發票號碼|小計|品項名稱|', 'M|手機條碼|/ABC123|20260902|12345678|鮮乳坊股份有限公司|AB12345678|2100|開立|90000000|', 'D|AB12345678|2100|鮮乳 946ml x10|', 'M|手機條碼|/ABC123|20260903|22222222|台灣電力公司|CD87654321|1500|開立||', 'D|CD87654321|1500|電費|'].join('\n');
  const inv = parseMofInvoices(text, { businessTaxId: '90000000' });
  assert.equal(inv.length, 2);
  assert.equal(inv[0].date, '2026-09-02');
  assert.equal(inv[0].tax, 100);
  assert.equal(inv[0].deductible, true);
  assert.equal(inv[0].suggested_account, '1212');
  assert.equal(inv[1].tax, 0);
  assert.equal(inv[1].suggested_account, '6118');
});

test('classify / docname / 統編檢查', () => {
  assert.equal(classifyExpense({ vendor: '中華電信', items: ['光世代月租'] }).account, '6115');
  assert.equal(classifyExpense({ vendor: '好市多', items: ['鮮奶油', '牛奶'] }).account, '1212');
  assert.ok(classifyExpense({ vendor: '全聯' }).confidence <= 0.4);
  assert.equal(isValidTaxId('04595257'), true);
  assert.equal(isValidTaxId('04595258'), false);
  assert.equal(isValidTaxId('10458575'), true, '第 7 碼為 7 的特例');
  const a = parseDocName('20260901_全聯_鮮乳2瓶_356.jpg');
  assert.deepEqual([a.date, a.vendor, a.summary, a.amount], ['2026-09-01', '全聯', '鮮乳2瓶', 356]);
  const b = parseDocName('1150905-好市多-NT$1,280-AB12345678.JPG');
  assert.deepEqual([b.date, b.vendor, b.amount, b.invoice_no, b.ext], ['2026-09-05', '好市多', 1280, 'AB12345678', '.jpg']);
  const c = parseDocName('2026.09.10 台電 電費 1500元.png');
  assert.deepEqual([c.date, c.vendor, c.summary, c.amount], ['2026-09-10', '台電', '電費', 1500]);
  assert.equal(archiveName({ doc_date: '2026-09-01', vendor_name: '全聯/福利中心', summary: '鮮乳', invoice_no: 'AB12345678', amount_total: 356 }), '20260901_全聯_福利中心_鮮乳_AB12345678_356元.jpg');
  assert.equal(archiveFolder('2026-09-01'), '115年/09月');
});

test('taxcal: 依型態產生期限、週末順延', () => {
  assert.equal(shiftWeekend('2026-11-15'), '2026-11-16', '週日順延週一');
  const gen = buildCalendar(2026, { orgType: 'company', vatMode: 'general', hasEmployees: true });
  const vat = gen.filter((i) => i.title.startsWith('營業稅申報'));
  assert.equal(vat.length, 6);
  assert.ok(vat.some((i) => i.date === '2026-09-15' && i.title.includes('7–8 月')));
  assert.ok(gen.some((i) => i.title.startsWith('營所稅暫繳')));
  const small = buildCalendar(2026, { orgType: 'sole', vatMode: 'small', hasEmployees: false, paysRentToIndividual: false });
  assert.ok(!small.some((i) => i.title.startsWith('營業稅申報')));
  assert.equal(small.filter((i) => i.title.startsWith('小規模')).length, 4);
  assert.ok(!small.some((i) => i.title.startsWith('營所稅暫繳')));
  assert.ok(!small.some((i) => i.title.includes('扣繳')));
});

test('journalimport: 依傳票號組回分錄、無傳票號時累計至平衡、科目對應', () => {
  const rows = [
    { _row: 4, date: '2026-08-21', voucher_no: 'V1', account_code: '1101', account_name: '現金', debit: '1,000', credit: '', memo: '開店零用金' },
    { _row: 5, date: '', voucher_no: '', account_code: '', account_name: '資本', debit: '', credit: '1000', memo: '' },
    { _row: 6, date: '2026-08-22', voucher_no: 'V2', account_code: '', account_name: '租金支出', debit: '25000', credit: '', memo: '8月租金' },
    { _row: 7, date: '2026-08-22', voucher_no: 'V2', account_code: '', account_name: '神秘科目', debit: '', credit: '25000', memo: '' },
  ];
  const r = buildJournalEntries(rows, accounts);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries[0].lines.map((l) => l.account), ['1101', '3101']);
  assert.deepEqual(r.unresolved, [['神秘科目', 1]]);
  const r2 = buildJournalEntries(rows, accounts, { overrides: { 神秘科目: '1103' } });
  assert.equal(r2.entries[1].lines[1].account, '1103');
  const nov = buildJournalEntries([{ _row: 1, date: '2026-09-01', account_code: '6118', debit: '500' }, { _row: 2, date: '2026-09-01', account_code: '1101', credit: '500' }, { _row: 3, date: '2026-09-01', account_code: '6115', debit: '300' }, { _row: 4, date: '2026-09-01', account_code: '1101', credit: '300' }], accounts);
  assert.equal(nov.entries.length, 2);
  const bad = buildJournalEntries([{ _row: 1, date: '2026-09-01', voucher_no: 'X', account_code: '6118', debit: '500' }, { _row: 2, voucher_no: 'X', account_code: '1101', credit: '400' }], accounts);
  assert.equal(bad.entries.length, 0);
  assert.equal(bad.errors.length, 1);
});

test('zip: 產生的 ZIP 可被讀回（含中文路徑）', async () => {
  const blob = makeZip([{ name: '115年/09月/20260901_全聯_356元.jpg', data: new Uint8Array([1, 2, 3, 4]) }, { name: 'a.txt', data: new TextEncoder().encode('午月') }]);
  const z = await unzip(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(z.names, ['115年/09月/20260901_全聯_356元.jpg', 'a.txt']);
  assert.equal(await z.read('a.txt'), '午月');
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('pnl: 固定／變動成本、健康度、損益兩平', () => {
  const entries = [
    E('2026-09-10', [L('1101', 100000, 0), L('4101', 0, 100000)]),
    E('2026-09-30', [L('5101', 30000, 0), L('1211', 0, 30000)]),
    E('2026-09-30', [L('6111', 20000, 0), L('6101', 25000, 0), L('6118', 5000, 0), L('1103', 0, 50000)]),
  ];
  const p = periodPnl(entries, accounts, { from: '2026-09-01', to: '2026-09-30' });
  assert.equal(p.revenue, 100000);
  assert.equal(p.fixed, 45000);
  assert.equal(p.variable, 35000);
  assert.equal(p.operatingIncome, 20000);
  assert.equal(p.ratios.prime, 0.55);
  assert.ok(Math.abs(p.breakEven - 45000 / 0.65) < 1e-6);
});
