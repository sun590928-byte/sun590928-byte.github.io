// 11/20 需求 4～6（營業稅 401）：申報前檢查列出發票與傳票、媒體檔格式 22 含稅換算、延後申報的發票 1261 留到申報那一期再沖、合併憑證每行自己的日期（全為合成資料）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inputItems,
  assignPeriods,
  inputTaxLedger,
  settlementEntry,
  computeTax,
  mediaInputValue,
  summarizeMedia,
  parseMediaFile,
  reconcileMedia,
  mediaInputRecords,
  buildMediaFile,
  taxInIncl,
  periodKeyOf,
  entry1261,
} from '../erp/js/lib/vat.js';
import { autoReview } from '../erp/js/lib/autoreview.js';
import { DEFAULT_ACCOUNTS } from '../erp/js/lib/coa.js';

const SHOP = '12345675';
const SELLER = '10047514';
const SELLER2 = '10324679';
const opts = { taxId: SHOP, vatMode: 'general' };

// 81 字元的媒體檔資料（合成）
function rec(fmt, ym, buyer, seller, inv, amount, taxType, tax, ded) {
  const pad = (s, n) => String(s).padStart(n, '0');
  return [fmt, '000000000', '0000001', ym, String(buyer).padEnd(8, ' '), String(seller).padEnd(8, ' '), inv.padEnd(10, ' '), pad(amount, 12), taxType, pad(tax, 10), ded, '     ', ' ', ' ', ' '].join('');
}

test('5 格式 22：含稅 ÷ 1.05 換算稅額，預設進項稅額不再少 6 元', () => {
  const text = [
    rec('25', '11509', SHOP, SELLER, 'QA20000001', 182200, '1', 9110, '1'),
    rec('22', '11510', SHOP, SELLER2, 'EF14768620', 126, '1', 0, '1'), // 二聯式收銀機發票：含稅 126、稅額 0
    rec('35', '11510', '', SHOP, 'XA20000001', 1050, '1', 0, ' '),
  ].join('\r\n');
  const { rows } = parseMediaFile(text);
  assert.equal(rows[1].amount, 126, '解析保留原始資料（含稅）');
  assert.equal(rows[1].tax, 0);
  const sm = summarizeMedia(rows);
  assert.equal(sm.inputs.expense.tax, 9116, '9,110＋格式 22 換算的 6');
  assert.equal(sm.inputs.expense.amount, 182200 + 120);
  assert.equal(sm.inputs.tax, 9116);
  // 換算
  assert.deepEqual(mediaInputValue(rows[1]), { ...rows[1], amount: 120, tax: 6, amount_incl: 126, derived: true });
  assert.equal(mediaInputValue(rows[0]), rows[0], '其他格式不變');
  assert.equal(mediaInputValue({ ...rows[1], tax_type: '3' }).derived, undefined, '免稅不換算');
  assert.equal(mediaInputValue({ ...rows[1], tax: 6, amount: 120 }).amount, 120, '已有稅額的不再換算');
  assert.deepEqual([taxInIncl(126), taxInIncl(574), taxInIncl(105), taxInIncl(10)], [6, 27, 5, 0]);

  // 媒體核對：系統憑證存含稅 126＋稅 6 → 一致（以前一直顯示「不一致」）
  const parts = [{ invoice_no: 'EF14768620', doc_id: 'd1', status: 'posted', total: 126, tax: 6, ex: 120, ded_code: '1', period: '2026-09', label: '興源' }];
  const r = reconcileMedia(rows.filter((x) => x.fmt[0] === '2'), parts, { periodKey: '2026-09' });
  assert.deepEqual(r.matched.find((x) => x.filed.invoice_no === 'EF14768620').diffs, []);
  // 系統稅額填錯（5）→ 照樣看得出不一致
  const bad = reconcileMedia([rows[1]], [{ ...parts[0], tax: 5, ex: 121 }]);
  assert.ok(bad.matched[0].diffs.some((d) => d.includes('可扣抵稅額 系統 5／申報 6')), bad.matched[0].diffs.join('；'));
});

test('5 產生媒體檔：格式 22 寫含稅、稅額 0，解析換算回來和憑證相同', () => {
  const items = [
    { date: '2026-11-03', invoice_no: 'EF14768620', vendor: '測試五金', vendor_tax_id: SELLER2, buyer_tax_id: SHOP, invoice_type: '二聯式收銀機發票', account: '6133', total: 126, tax: 6, ex: 120, check: { ok: true }, tax_type: '1', ded_code: '1' },
    { date: '2026-11-04', invoice_no: 'EF14768621', vendor: '測試五金', vendor_tax_id: SELLER2, buyer_tax_id: SHOP, invoice_type: '二聯式收銀機發票', account: '6133', total: 210, tax: 9, ex: 201, check: { ok: true }, tax_type: '1', ded_code: '1' }, // 稅額填 9（應是 10）
    { date: '2026-11-05', invoice_no: 'QA20000002', vendor: '測試烘豆', vendor_tax_id: SELLER, buyer_tax_id: SHOP, invoice_type: '電子發票', account: '1211', total: 1050, tax: 50, ex: 1000, check: { ok: true }, tax_type: '1', ded_code: '1' },
  ];
  const r = mediaInputRecords(items, { taxId: SHOP });
  assert.deepEqual(r.records.map((x) => [x.fmt, x.invoice_no, x.amount, x.tax]), [['22', 'EF14768620', 126, 0], ['22', 'EF14768621', 210, 0], ['25', 'QA20000002', 1000, 50]]);
  assert.ok(r.records.every((x) => !('book_tax' in x)), '暫存欄位不寫進資料');
  assert.deepEqual(r.cautions.map((x) => x.reason), ['格式 22（二聯式收銀機發票）申報時稅額依含稅 210 ÷ 1.05 算出 10 元，和憑證的稅額 9 元不同']);
  const built = buildMediaFile({ regNo: '123456789', records: r.records });
  assert.deepEqual(built.errors, []);
  const { rows } = parseMediaFile(built.text);
  const f22 = rows.find((x) => x.invoice_no === 'EF14768620');
  assert.deepEqual([f22.fmt, f22.amount, f22.tax], ['22', 126, 0], '檔案裡是含稅、稅額 0');
  const sm = summarizeMedia(rows);
  assert.equal(sm.inputs.expense.tax, 6 + 10 + 50);
  // 拆成兩行（不同科目）的格式 22 發票合成一筆含稅金額
  const split = mediaInputRecords([{ ...items[0], total: 84, tax: 4, ex: 80 }, { ...items[0], account: '1214', total: 42, tax: 2, ex: 40 }], { taxId: SHOP });
  assert.deepEqual(split.records.map((x) => [x.amount, x.tax]), [[126, 0]]);
  assert.deepEqual(split.cautions, []);
});

test('5 自動覆核：已申報媒體檔的格式 22 帶入換算後的稅額（不是 0）', () => {
  const accounts = DEFAULT_ACCOUNTS.map((a) => ({ ...a, active: true }));
  const settings = { tax_id: SHOP, vat_mode: 'general', capitalize_threshold: 80000 };
  const filed = parseMediaFile(rec('22', '11510', SHOP, SELLER2, 'EF14768620', 126, '1', 0, '1')).rows.map(mediaInputValue);
  const doc = { id: 'doc_x', status: 'inbox', kind: 'receipt', original_name: '20261016_測試五金_EF14768620_126.png', account: '6133', pay_account: '2134' };
  const r = autoReview(doc, { filed, accounts, settings, today: '2026-11-20' });
  assert.equal(r.patch.invoice_no, 'EF14768620');
  assert.equal(r.patch.amount_total, 126);
  assert.equal(r.patch.tax_amount, 6);
});

test('6 合併憑證每一行自己的日期：歸期、媒體檔所屬年月用這一行的日期', () => {
  const merged = {
    id: 'dm', status: 'posted', entry_id: 'em', doc_date: '2026-10-16', vendor_name: '測試百貨', vendor_tax_id: SELLER, buyer_tax_id: SHOP, invoice_type: '電子發票', amount_total: 903, tax_amount: 43,
    lines: [
      { invoice_no: 'DC51882770', date: '2026-08-05', account: '6133', amount: 378, tax: 18, deductible: true },
      { invoice_no: 'DC51882771', date: '', account: '6133', amount: 525, tax: 25, deductible: true },
    ],
  };
  const items = inputItems([merged], []);
  assert.deepEqual(items.map((x) => [x.id, x.date]), [['dm:0', '2026-08-05'], ['dm:1', '2026-10-16']]);
  const a = assignPeriods(items, []);
  assert.deepEqual(a.map((x) => [x.id, x.period, x.late]), [['dm:0', '2026-07', false], ['dm:1', '2026-09', false]]);
  const r = mediaInputRecords(a.map((x) => ({ ...x, check: { ok: true }, tax_type: '1', ded_code: '1' })), { taxId: SHOP });
  assert.deepEqual(r.records.map((x) => [x.invoice_no, x.ym]), [['DC51882770', '2026-08'], ['DC51882771', '2026-10']]);
});

// 7–8 期申報時把宜得利 3 張（稅 44）延到 9–10 期；大創 DC51882770 在 10/16 的合併傳票裡、實際在 7–8 期申報（稅 18）
function scenario({ lineDate = '2026-08-05' } = {}) {
  const base = { status: 'posted', vendor_tax_id: SELLER, buyer_tax_id: SHOP, invoice_type: '電子發票', account: '6133', deductible: true };
  const docs = [
    { ...base, id: 'dx', entry_id: 'ex', doc_date: '2026-08-10', vendor_name: '測試烘豆', invoice_no: 'XA00000001', amount_total: 2100, tax_amount: 100 },
    { ...base, id: 'dy1', entry_id: 'ey1', doc_date: '2026-08-23', vendor_name: '測試家居', invoice_no: 'YD00000001', amount_total: 420, tax_amount: 20 },
    { ...base, id: 'dy2', entry_id: 'ey2', doc_date: '2026-08-23', vendor_name: '測試家居', invoice_no: 'YD00000002', amount_total: 294, tax_amount: 14 },
    { ...base, id: 'dy3', entry_id: 'ey3', doc_date: '2026-08-23', vendor_name: '測試家居', invoice_no: 'YD00000003', amount_total: 210, tax_amount: 10 },
    { ...base, id: 'dz', entry_id: 'ez', doc_date: '2026-09-15', vendor_name: '測試乳品', invoice_no: 'ZA00000001', amount_total: 4200, tax_amount: 200 },
    {
      ...base, id: 'dm', entry_id: 'em', doc_date: '2026-10-16', vendor_name: '測試百貨', amount_total: 903, tax_amount: 43,
      lines: [
        { invoice_no: 'DC51882770', date: lineDate, account: '6133', amount: 378, tax: 18, deductible: true },
        { invoice_no: 'DC51882771', account: '6133', amount: 525, tax: 25, deductible: true },
      ],
    },
  ];
  const je = (id, date, tax, total) => ({ id, date, voucher_no: `${Number(date.slice(0, 4)) - 1911}${date.slice(5, 7)}-${id}`, description: `進貨 ${id}`, source: 'document', status: 'posted', lines: [{ account: '6133', debit: total - tax, credit: 0 }, { account: '1261', debit: tax, credit: 0 }, { account: '2134', debit: 0, credit: total }] });
  const entries = [je('ex', '2026-08-10', 100, 2100), je('ey1', '2026-08-23', 20, 420), je('ey2', '2026-08-23', 14, 294), je('ey3', '2026-08-23', 10, 210), je('ez', '2026-09-15', 200, 4200), je('em', '2026-10-16', 43, 903)];
  const filings = [
    { id: '2026-07', status: 'filed', claimed: ['dx'], filed_inputs: [{ fmt: '25', invoice_no: 'XA00000001', amount: 2000, tax: 100, tax_type: '1', ded_code: '1' }, { fmt: '25', invoice_no: 'DC51882770', amount: 360, tax: 18, tax_type: '1', ded_code: '1' }] },
    { id: '2026-09', status: 'filed', claimed: ['dy1', 'dy2', 'dy3', 'dz', 'dm:1'] },
  ];
  return { docs, entries, filings, items: assignPeriods(inputItems(docs, []), filings) };
}

test('6 延後申報：7–8 期 1261 檢查不再差 44，宜得利列「延後申報（下期扣抵）」；結轉只沖本期申報的', () => {
  const s = scenario();
  assert.deepEqual(s.items.map((x) => [x.id, x.period]), [['dm:0', '2026-07'], ['dx', '2026-07'], ['dy1', '2026-09'], ['dy2', '2026-09'], ['dy3', '2026-09'], ['dz', '2026-09'], ['dm:1', '2026-09']]);
  const L = inputTaxLedger('2026-07', { items: s.items, entries: s.entries, opts });
  assert.deepEqual([L.book, L.expected, L.diff], [144, 144, 0], '帳上 1261 = 本期分錄所附發票（含延後的 44）');
  assert.deepEqual(L.diffEntries, []);
  assert.deepEqual(L.deferredOut.map((x) => x.invoice_no), ['YD00000001', 'YD00000002', 'YD00000003']);
  assert.equal(L.deferredOut.reduce((t, x) => t + x.okTax, 0), 44);
  assert.deepEqual(L.postedLater.map((x) => [x.invoice_no, x.entry.id]), [['DC51882770', 'em']], '大創：本期申報、分錄在 10/16');
  assert.equal(L.credit, 118, '只沖本期申報的 100＋18；延後的 44 留在 1261');
  assert.deepEqual(L.carry.out.map((o) => [o.id, o.tax, o.period]), [['dy1', 20, '2026-09'], ['dy2', 14, '2026-09'], ['dy3', 10, '2026-09']]);
  assert.deepEqual(L.carry.pre.map((o) => [o.id, o.tax]), [['dm:0', 18]]);
  // 結轉分錄：沒有尾差
  const tax78 = computeTax({ output: 0, inputExpense: 118, inputAsset: 0, prevCf: 0 });
  const st78 = settlementEntry('2026-07', { bookOutput: 0, bookInput: L.credit, tax: tax78, carry: L.carry });
  assert.ok(!st78.lines.some((l) => l.memo === '營業稅尾差'), JSON.stringify(st78.lines));
  assert.deepEqual(st78.lines.find((l) => l.account === '1261'), { account: '1261', debit: 0, credit: 118, memo: '沖轉本期進項稅額（延後申報的 44 元留到申報的那一期再沖）' });
  assert.deepEqual(st78.vat_carry, L.carry);

  // 9–10 期：宜得利 44 從 1261 沖、大創 18 已在 7–8 期先沖 → 都不算差額，結轉也沒有尾差
  const closing78 = { ...st78, id: 'st78', voucher_no: '11508-9999', status: 'posted' };
  const entries = [...s.entries, closing78];
  const M = inputTaxLedger('2026-09', { items: s.items, entries, opts });
  assert.deepEqual([M.book, M.expected, M.diff], [243, 243, 0]);
  assert.deepEqual(M.claimedEarlier.map((x) => [x.invoice_no, x.pre]), [['DC51882770', true]]);
  assert.deepEqual(M.deferredIn.map((x) => [x.invoice_no, x.onBooks]), [['YD00000001', true], ['YD00000002', true], ['YD00000003', true]]);
  assert.equal(M.credit, 200 + 25 + 44, '本期申報的 269');
  assert.deepEqual(M.carry, { out: [], pre: [] });
  const priorInput = entry1261({ lines: entries.filter((e) => e.date < '2026-09-01').flatMap((e) => e.lines) });
  assert.equal(M.carryIn, 26, '期初應留：延後的 44 − 先沖的 18');
  assert.equal(priorInput, 26, '帳上期初 1261 也是 26 → 前期稅額皆已結轉');
  const tax910 = computeTax({ output: 0, inputExpense: 269, inputAsset: 0, prevCf: tax78.cf });
  const st910 = settlementEntry('2026-09', { bookOutput: 0, bookInput: M.credit, tax: tax910, carry: M.carry });
  assert.ok(!st910.lines.some((l) => l.memo === '營業稅尾差'), JSON.stringify(st910.lines));
  // 兩期結轉後 1261 歸零
  const all = [...entries, { ...st910, id: 'st910', status: 'posted' }];
  assert.equal(entry1261({ lines: all.flatMap((e) => e.lines) }), 0);
});

test('6 舊的結轉分錄（沒有 vat_carry，已把當期 1261 全部沖完）：之後的期別不再沖第二次', () => {
  const s = scenario();
  // 7–8 期舊做法：沖掉帳上全部 144
  const legacy = { id: 'old78', date: '2026-08-31', source: 'vat', source_ref: '2026-07', status: 'posted', voucher_no: '11508-9998', lines: [{ account: '1261', debit: 0, credit: 144 }, { account: '1262', debit: 144, credit: 0 }] };
  const M = inputTaxLedger('2026-09', { items: s.items, entries: [...s.entries, legacy], opts });
  assert.deepEqual([M.diff, M.carryIn], [0, 0], '期初應留 0，與帳上一致');
  assert.deepEqual(M.deferredIn.map((x) => x.onBooks), [false, false, false], '宜得利的 1261 已被舊結轉沖掉');
  assert.deepEqual(M.claimedEarlier.map((x) => x.pre), [false], '大創沒有先沖過');
  assert.equal(M.credit, 243, '只沖帳上本期的 243，1261 不會變負數');
  // 前期沒有結轉：延後的 44 還在帳上，本期要沖
  const N = inputTaxLedger('2026-09', { items: s.items, entries: s.entries, opts });
  assert.deepEqual(N.deferredIn.map((x) => x.onBooks), [true, true, true]);
  assert.equal(N.credit, 243 + 44);
});

test('4 1261 差額：列出是哪幾張傳票；期初開帳不算差額', () => {
  const s = scenario();
  const manual = { id: 'eman', date: '2026-09-20', voucher_no: '11509-0042', description: '手動補記', source: 'manual', status: 'posted', lines: [{ account: '6133', debit: 100 }, { account: '1261', debit: 7 }, { account: '1101', credit: 107 }] };
  const wrong = s.entries.map((e) => (e.id === 'ez' ? { ...e, lines: e.lines.map((l) => (l.account === '1261' ? { ...l, debit: 210 } : l)) } : e));
  const M = inputTaxLedger('2026-09', { items: s.items, entries: [...wrong, manual], opts });
  assert.equal(M.diff, 17);
  assert.deepEqual(M.diffEntries.map((d) => [d.entry.voucher_no, d.book, d.expected, d.diff, d.items.map((x) => x.invoice_no)]), [['11509-ez', 210, 200, 10, ['ZA00000001']], ['11509-0042', 7, 0, 7, []]]);
  // 作廢的分錄、別期的分錄不算
  assert.equal(inputTaxLedger('2026-09', { items: s.items, entries: [...s.entries, { ...manual, status: 'void' }], opts }).diff, 0);
  // 期初開帳的 1261（營收起算日前的進項稅額）
  const opening = { id: 'eop', date: '2026-08-20', source: 'opening', status: 'posted', lines: [{ account: '1261', debit: 300 }, { account: '3101', credit: 300 }] };
  const O = inputTaxLedger('2026-07', { items: s.items, entries: [...s.entries, opening], opts });
  assert.deepEqual([O.book, O.expected, O.diff, O.opening, O.credit], [444, 444, 0, 300, 418]);
});

test('6 沒有每行日期時，大創照已申報清單歸 7–8 期（延後扣抵標記），檢查結果相同', () => {
  const s = scenario({ lineDate: '' });
  const d = s.items.find((x) => x.id === 'dm:0');
  assert.deepEqual([d.date, d.period, d.late], ['2026-10-16', '2026-07', true]);
  assert.equal(periodKeyOf(d.date), '2026-09');
  const L = inputTaxLedger('2026-07', { items: s.items, entries: s.entries, opts });
  assert.equal(L.diff, 0);
  assert.equal(L.credit, 118);
});
