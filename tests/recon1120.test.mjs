// 11/20 需求 3、7、9：存摺月底餘額抓當天最後一筆、刷卡逐日核對改用撥款明細的交易日期、POS 訂單事後作廢（全為合成資料）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { passbookOrder, reconciliation, autoMatch } from '../erp/js/lib/bank.js';
import { normalizePayouts, normalizeEcpayTx, dailyCardRecon, dailyCardReconByPayout, cardRecon, payoutTxDays } from '../erp/js/lib/payments.js';
import { decodeBytes, parseCSV } from '../erp/js/lib/csv.js';
import { detectHeaderRow, autoMap, extract, guessTarget } from '../erp/js/lib/importer.js';
import { normalizeSales, markVoid, clearVoid, reapplyVoids, planVoidUpdates, DEFAULT_VOID_RULES } from '../erp/js/lib/pos.js';
import { salesJournal, mergeGenerated } from '../erp/js/lib/autojournal.js';

const B = (id, date, withdrawal, deposit, balance, acct = 'main') => ({ id, bank_account_id: acct, date, description: '', withdrawal, deposit, balance, match_key: null });

// 7/29 存摺有 4 筆：前一天結存 100,000 → 存入 60,000（160,000）→ 存入 45,000（205,000）→ 支出 50,000（155,000）→ 支出 5,000（150,000）
const july = () => [B('a', '2026-07-28', 0, 100000, 100000), B('b', '2026-07-29', 0, 60000, 160000), B('c', '2026-07-29', 0, 45000, 205000), B('d', '2026-07-29', 50000, 0, 155000), B('e', '2026-07-29', 5000, 0, 150000)];

test('存摺：同一天 4 筆，月底餘額抓存摺上當天最後一筆（150,000），不是結存最大的（205,000）', () => {
  // 舊做法：同一天照結存大小排 → 最後一筆是 205,000，7 月多出假的差異 55,000
  const byBalance = [...july()].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.balance - y.balance));
  assert.equal(byBalance[byBalance.length - 1].balance, 205000);
  // 不管讀進來的順序（雲端資料庫照主鍵排、照結存排、倒過來），都照結存帳鏈排出存摺上的先後
  for (const order of [byBalance, [...july()].reverse(), [july()[2], july()[4], july()[0], july()[3], july()[1]]]) {
    const o = passbookOrder(order);
    assert.deepEqual(o.map((b) => b.id), ['a', 'b', 'c', 'd', 'e']);
    const rec = reconciliation({ bankLines: order, books: [], matches: new Map(), asOf: '2026-07-31' });
    assert.equal(rec.bankBalance, 150000);
  }
  // 和帳上餘額 150,000 比：沒有假的差異
  const books = [{ key: 'k1', date: '2026-07-28', debit: 100000, credit: 0 }, { key: 'k2', date: '2026-07-29', debit: 105000, credit: 0 }, { key: 'k3', date: '2026-07-29', debit: 0, credit: 55000 }];
  const lines = [...july()].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.balance - y.balance));
  const rec = reconciliation({ bankLines: lines, books, matches: autoMatch(lines, books), asOf: '2026-07-31' });
  assert.equal(rec.bankBalance, 150000);
  assert.equal(rec.bookBalance, 150000);
});

test('存摺：沒有前一天時找鏈頭；繞一圈接不起來的照原順序；不同帳戶各自接鏈', () => {
  // 第一天就有 3 筆（沒有前一天的結存）：之前結存 1,000 不是同一天任何一筆的結存 → 鏈頭
  // 1,000 → 支出 200（800）→ 存入 500（1,300）→ 支出 100（1,200）
  const first = [B('y', '2026-08-01', 100, 0, 1200), B('x', '2026-08-01', 0, 500, 1300), B('z', '2026-08-01', 200, 0, 800)];
  assert.deepEqual(passbookOrder(first).map((b) => b.id), ['z', 'x', 'y']);
  // 存 100 又提 100（結存繞回原值）、也沒有前一天：照原本順序，不會當掉
  const loop = [B('p', '2026-08-02', 0, 100, 1100), B('q', '2026-08-02', 100, 0, 1000)];
  assert.deepEqual(passbookOrder(loop).map((b) => b.id), ['p', 'q']);
  // 有前一天（結存 1,000）就接得起來
  assert.deepEqual(passbookOrder([B('q', '2026-08-02', 100, 0, 1000), B('p', '2026-08-02', 0, 100, 1100), B('o', '2026-08-01', 0, 1000, 1000)]).map((b) => b.id), ['o', 'p', 'q']);
  // 兩個帳戶同一天：各自照各自的鏈
  const two = [B('m2', '2026-08-03', 30, 0, 90, 'main'), B('s2', '2026-08-03', 0, 5, 60, 'sub'), B('m1', '2026-08-03', 0, 20, 120, 'main'), B('s1', '2026-08-03', 0, 5, 55, 'sub'), B('m0', '2026-08-02', 0, 100, 100, 'main'), B('s0', '2026-08-02', 0, 50, 50, 'sub')];
  const o = passbookOrder(two);
  assert.deepEqual(o.filter((b) => b.bank_account_id === 'main').map((b) => b.id), ['m0', 'm1', 'm2']);
  assert.deepEqual(o.filter((b) => b.bank_account_id === 'sub').map((b) => b.id), ['s0', 's1', 's2']);
  assert.equal(reconciliation({ bankLines: two.filter((b) => b.bank_account_id === 'main'), books: [], matches: new Map(), asOf: '2026-08-31' }).bankBalance, 90);
  // 沒有結存欄的列不重排
  const noBal = [B('n2', '2026-08-04', 10, 0, null), B('n1', '2026-08-04', 0, 20, null)];
  assert.deepEqual(passbookOrder(noBal).map((b) => b.id), ['n2', 'n1']);
});

// 合成的綠界信用卡撥款明細：每列一筆刷卡，有交易日期、請款日期、撥款日期
function payoutFixture() {
  const { text } = decodeBytes(new Uint8Array(readFileSync(new URL('./fixtures/synthetic-ecpay-payout-detail.csv', import.meta.url))));
  const rows = parseCSV(text);
  assert.equal(guessTarget(rows, '綠界信用卡刷卡撥款明細-202608.csv'), 'payouts');
  const { index } = detectHeaderRow(rows, 'payouts');
  const mapping = autoMap(rows[index], 'payouts');
  return { rows, index, mapping, raw: extract(rows, index, mapping) };
}

test('撥款明細：「交易日期」欄自動對應；依撥款日彙總，每筆撥款另記各交易日金額', () => {
  const { rows, index, mapping, raw } = payoutFixture();
  const head = rows[index];
  assert.equal(head[mapping.tx_date], '交易日期');
  assert.equal(head[mapping.payout_date], '撥款日期');
  assert.equal(head[mapping.gross], '交易金額');
  const { rows: payouts, skipped } = normalizePayouts(raw, { provider: 'ecpay' });
  assert.equal(payouts.length, 4);
  assert.ok(skipped.some((s) => /合計/.test(s.reason)));
  const p18 = payouts.find((p) => p.payout_date === '2026-08-18');
  assert.equal(p18.gross, 920);
  assert.equal(p18.tx_count, 4);
  assert.deepEqual(p18.tx_days, [{ date: '2026-08-11', gross: 920, fee: 21, net: 899, count: 4 }]);
  assert.equal(p18.period_from, '2026-08-11');
  // 同一筆撥款的 id 不變（重新匯入會當成同一筆，只補交易日期）
  const old = normalizePayouts(raw.map(({ tx_date, ...r }) => r), { provider: 'ecpay' }).rows;
  assert.deepEqual(old.map((p) => p.id).sort(), payouts.map((p) => p.id).sort());
  assert.ok(old.every((p) => !p.tx_days));
  // 一筆撥款含好幾個交易日、跨撥款日的同一交易日要加總
  const multi = normalizePayouts(
    [
      { payout_date: '2026-11-05', tx_date: '2026/11/01 10:00', tx_id: 'Z1', gross: '100', fee: '2', net: '98' },
      { payout_date: '2026-11-05', tx_date: '2026/11/02 10:00', tx_id: 'Z2', gross: '200', fee: '4', net: '196' },
      { payout_date: '2026-11-06', tx_date: '2026/11/02 23:50', tx_id: 'Z3', gross: '50', fee: '1', net: '49' },
    ],
    { provider: 'ecpay' },
  ).rows;
  const { days, coveredTo } = payoutTxDays(multi);
  assert.equal(days.get('2026-11-02').gross, 250);
  assert.equal(days.get('2026-11-02').count, 2);
  assert.equal(coveredTo, '2026-11-02');
});

test('刷卡逐日核對：撥款明細依交易日期比對 POS、最後交易日之後標「等下一期」、自動挑差異少的來源', () => {
  const sale = (date, order_no, amount, payment = 'card') => ({ date, order_no, amount, payment, void_reason: null });
  const lines = [sale('2026-11-01', 'A1', 100), sale('2026-11-02', 'A2', 200), sale('2026-11-02', 'A3', 50), sale('2026-11-03', 'A4', 300), sale('2026-11-03', 'C1', 80, 'cash')];
  const payouts = normalizePayouts(
    [
      { payout_date: '2026-11-05', tx_date: '2026-11-01', tx_id: 'Z1', gross: '100', fee: '2', net: '98' },
      { payout_date: '2026-11-05', tx_date: '2026-11-02', tx_id: 'Z2', gross: '200', fee: '4', net: '196' },
      { payout_date: '2026-11-06', tx_date: '2026-11-02', tx_id: 'Z3', gross: '50', fee: '1', net: '49' },
    ],
    { provider: 'ecpay' },
  ).rows;
  const byPayout = dailyCardReconByPayout(lines, payouts, { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(byPayout.map((d) => [d.date, d.pos, d.ecpay, d.diff, d.pending]), [
    ['2026-11-01', 100, 100, 0, false],
    ['2026-11-02', 250, 250, 0, false],
    ['2026-11-03', 300, 0, -300, true], // 11/3 的刷卡還沒撥款：等下一期撥款明細，不算差異
  ]);
  // 交易明細的日期跟 POS 差一天（例如時間欄抓到請款時間）：每天都對不上
  const txs = normalizeEcpayTx([
    { datetime: '2026/11/02 10:00', order_no: 'A1', amount: '100', status: '成功' },
    { datetime: '2026/11/03 10:00', order_no: 'A2', amount: '200', status: '成功' },
    { datetime: '2026/11/03 11:00', order_no: 'A3', amount: '50', status: '成功' },
    { datetime: '2026/11/04 10:00', order_no: 'A4', amount: '300', status: '成功' },
  ]).rows;
  const both = cardRecon(lines, txs, payouts, { from: '2026-11-01', to: '2026-11-30' });
  assert.deepEqual(both.has, { tx: true, payout: true });
  assert.equal(both.diffDays.tx, 4);
  assert.equal(both.diffDays.payout, 0);
  assert.equal(both.pendingDays, 1);
  assert.equal(both.auto, 'payout');
  assert.equal(both.source, 'payout');
  // 指定來源就照指定
  assert.equal(cardRecon(lines, txs, payouts, { from: '2026-11-01', to: '2026-11-30', source: 'tx' }).source, 'tx');
  // 只有交易明細 → 交易明細；只有撥款明細 → 撥款明細；兩種一樣好 → 交易明細
  assert.equal(cardRecon(lines, txs, [], { from: '2026-11-01', to: '2026-11-30' }).source, 'tx');
  assert.equal(cardRecon(lines, [], payouts, { from: '2026-11-01', to: '2026-11-30' }).source, 'payout');
  const goodTx = normalizeEcpayTx(lines.filter((l) => l.payment === 'card').map((l) => ({ datetime: `${l.date} 12:00`, order_no: l.order_no, amount: String(l.amount), status: '成功' }))).rows;
  const tie = cardRecon(lines, goodTx, payouts, { from: '2026-11-01', to: '2026-11-30' });
  assert.equal(tie.diffDays.tx, 0);
  assert.equal(tie.source, 'tx');
  // 作廢的 POS 刷卡不算
  const voided = lines.map((l) => (l.order_no === 'A4' ? { ...l, void_reason: 'pos_void' } : l));
  assert.equal(dailyCardRecon(voided, goodTx).find((d) => d.date === '2026-11-03').diff, 300);
});

// POS 合成資料：10/14 公休測試單 #0878、#0879（合計 540）匯入時是「已完成」
const POS_ROWS = [
  { datetime: '2026/10/14 10:05', order_no: '0878', item: '美式咖啡', qty: '2', unit_price: '120', amount: '240', payment: '信用卡', status: '已完成' },
  { datetime: '2026/10/14 10:06', order_no: '0879', item: '燕麥拿鐵', qty: '2', unit_price: '150', amount: '300', payment: '信用卡', status: '已完成' },
  { datetime: '2026/10/15 12:00', order_no: '0880', item: '美式咖啡', qty: '1', unit_price: '120', amount: '120', payment: '現金', status: '已完成' },
  { datetime: '2026/11/03 13:00', order_no: '0901', item: '燕麥拿鐵', qty: '1', unit_price: '150', amount: '150', payment: '現金', status: '已完成' },
  { datetime: '2026/11/03 13:30', order_no: '0902', item: '美式咖啡', qty: '1', unit_price: '120', amount: '120', payment: '現金', status: '已完成' },
];

test('事後作廢：手動標記作廢／取消作廢，記下原因與誰；重新套用規則不會蓋掉手動的', () => {
  const { lines } = normalizeSales(POS_ROWS, { rules: DEFAULT_VOID_RULES });
  const tests = lines.filter((l) => ['0878', '0879'].includes(l.order_no));
  const marked = markVoid(tests, { reason: 'pos_void', note: '公休測試單，10/27 綠界已作廢發票', by: 'tester', at: '2026-11-21T09:00:00.000Z' });
  assert.ok(marked.every((l) => l.void_reason === 'pos_void' && l.revenue === 0 && l.void_manual.by === 'tester' && l.void_manual.note.includes('測試單')));
  assert.equal(marked[0].void_log.length, 1);
  assert.equal(tests[0].void_reason, null, '不改原本的物件');
  assert.throws(() => markVoid(tests, { reason: 'nope' }));
  // 重新套用作廢規則：狀態欄還是「已完成」，但手動標記的不被改回有效
  const all = lines.map((l) => marked.find((m) => m.id === l.id) || l);
  const copy = all.map((l) => ({ ...l }));
  reapplyVoids(copy, DEFAULT_VOID_RULES);
  assert.equal(copy.filter((l) => l.void_reason).length, 2);
  // 取消作廢：規則本來就不算作廢 → 拿掉手動標記，回到依規則
  const cleared = clearVoid(marked, { rules: DEFAULT_VOID_RULES, by: 'tester', at: '2026-11-21T10:00:00.000Z' });
  assert.ok(cleared.every((l) => l.void_reason === null && l.revenue === l.amount && !l.void_manual && l.void_log.length === 2));
  // POS 狀態是「已作廢」的取消作廢 → 記成手動「不作廢」，重新套用規則也不會改回作廢
  const posVoided = normalizeSales([{ ...POS_ROWS[2], status: '已作廢' }], { rules: DEFAULT_VOID_RULES }).lines;
  assert.equal(posVoided[0].void_reason, 'pos_void');
  const kept = clearVoid(posVoided, { rules: DEFAULT_VOID_RULES });
  assert.equal(kept[0].void_manual.reason, null);
  reapplyVoids(kept, DEFAULT_VOID_RULES);
  assert.equal(kept[0].void_reason, null);
});

test('重新匯入：已匯入的訂單 POS 狀態變成作廢 → 更新那幾筆（不當重複略過），金額改 0 的也認得', () => {
  const first = normalizeSales(POS_ROWS, { rules: DEFAULT_VOID_RULES }).lines;
  // POS 重新匯出：#0878 狀態「已作廢」（其他欄位相同 → 同一個 id），#0879「已作廢」且金額變 0（id 不同）
  const again = normalizeSales(
    POS_ROWS.map((r) => (r.order_no === '0878' ? { ...r, status: '已作廢' } : r.order_no === '0879' ? { ...r, status: '已作廢', amount: '0' } : r)),
    { rules: DEFAULT_VOID_RULES },
  ).lines;
  const a878 = again.find((l) => l.order_no === '0878');
  const a879 = again.find((l) => l.order_no === '0879');
  assert.equal(a878.id, first.find((l) => l.order_no === '0878').id);
  assert.notEqual(a879.id, first.find((l) => l.order_no === '0879').id);
  const plan = planVoidUpdates(again, first, { batchId: 'b_re', at: '2026-11-21T09:00:00.000Z' });
  assert.deepEqual(plan.updates.map((l) => l.order_no).sort(), ['0878', '0879']);
  assert.ok(plan.updates.every((l) => l.void_reason === 'pos_void' && l.revenue === 0 && l.status_raw === '已作廢' && l.void_reimport.batch_id === 'b_re'));
  // 更新的是原本那一筆（原本的 id、原本的金額 300 保留作「作廢原價值」）
  const u879 = plan.updates.find((l) => l.order_no === '0879');
  assert.equal(u879.id, first.find((l) => l.order_no === '0879').id);
  assert.equal(u879.amount, 300);
  assert.ok(plan.consumed.has(a879.id), '金額變 0 的那列不再另外新增');
  // 再匯入一次：已經是作廢 → 不再更新；手動取消作廢過的也不動
  const after = first.map((l) => plan.updates.find((u) => u.id === l.id) || l);
  assert.equal(planVoidUpdates(again, after).updates.length, 0);
  const manual = first.map((l) => (l.order_no === '0878' ? clearVoid([{ ...l, status_raw: '已作廢' }], { rules: DEFAULT_VOID_RULES })[0] : l));
  assert.deepEqual(planVoidUpdates(again, manual).updates.map((l) => l.order_no), ['0879']);
});

test('事後作廢與鎖定月份：10 月已鎖定 → POS 營收傳票不重新產生（內容一字不差）；11 月未鎖定 → 那天的傳票重新產生', () => {
  const lines = normalizeSales(POS_ROWS, { rules: DEFAULT_VOID_RULES }).lines;
  const gen0 = salesJournal(lines, { categoryOf: () => 'coffee' });
  let n = 0;
  const made = mergeGenerated([], gen0, { source: 'pos', makeId: () => 'je_' + ++n, nextNo: () => 'V' + n });
  const existing = made.upserts.map((e) => ({ ...e, created_at: '2026-10-31T00:00:00.000Z' }));
  const before = JSON.stringify(existing);
  const marked = markVoid(lines.filter((l) => ['0878', '0879', '0902'].includes(l.order_no)), { reason: 'pos_void', by: 't' });
  const after = lines.map((l) => marked.find((m) => m.id === l.id) || l);
  const gen = salesJournal(after, { categoryOf: () => 'coffee' });
  const res = mergeGenerated(existing, gen, { source: 'pos', lockedMonths: new Set(['2026-06', '2026-07', '2026-08', '2026-09', '2026-10']), makeId: () => 'je_x', nextNo: () => 'X' });
  assert.equal(JSON.stringify(existing), before);
  assert.ok(res.upserts.every((e) => e.date.startsWith('2026-11')), '只有 11 月的傳票更新');
  assert.deepEqual(res.removes, []);
  const nov = res.upserts.find((e) => e.date === '2026-11-03');
  assert.equal(nov.voucher_no, existing.find((e) => e.date === '2026-11-03').voucher_no, '傳票號碼不變');
  const credit = nov.lines.reduce((t, l) => t + l.credit, 0);
  assert.equal(credit, 150, '11/3 只剩 #0901 的 150');
  assert.ok(res.skippedLocked >= 1);
});
