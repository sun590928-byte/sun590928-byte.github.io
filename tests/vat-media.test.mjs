// 11/12 需求 二-2～二-4（稅務）：不可扣抵自動判斷、產生申報媒體檔（與解析互為反向）、國稅局進項發票 vs ERP 入帳（全為合成資料）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deductibility,
  taxCodes,
  nonDeductibleByRule,
  mediaRecord,
  mediaInputRecords,
  normalizeSalesInvoices,
  mediaSalesRecords,
  parseBlankRanges,
  mediaBlankRecords,
  buildMediaFile,
  parseMediaFile,
  summarizeMedia,
  einvoiceGaps,
  inputMediaFormat,
  inputItems,
  overclaimed,
  reconcileMedia,
  assignPeriods,
} from '../erp/js/lib/vat.js';
import { documentJournal } from '../erp/js/lib/autojournal.js';
import { autoReview } from '../erp/js/lib/autoreview.js';
import { buildVendorKB } from '../erp/js/lib/vendorkb.js';
import { assembleInvoices } from '../erp/js/lib/einvoiceqr.js';
import { DEFAULT_ACCOUNTS } from '../erp/js/lib/coa.js';

// 合成統編（通過檢查碼）
const SHOP = '12345675';
const SELLER = '10047514';
const SELLER2 = '10324679';
const BUYER = '10332598';
const opts = { taxId: SHOP, vatMode: 'general' };

test('二-2 不可扣抵：伙食費 6126 一律 3；水電電信沒有本店統編 3；老闆指定的代號優先', () => {
  const inv = { invoice_no: 'QA10000001', tax: 50, buyer_tax_id: SHOP, deductible: true };
  // 伙食費（員工餐）：有本店統編也不可扣抵
  const meal = { ...inv, account: '6126' };
  assert.equal(deductibility(meal, opts).ok, false);
  assert.match(deductibility(meal, opts).reason, /伙食/);
  assert.deepEqual(taxCodes(meal, deductibility(meal, opts).ok), { tax_type: '1', ded_code: '3' });
  assert.equal(deductibility({ ...meal, ded_code: '1' }, opts).ok, true, '老闆指定扣抵代號 1 優先');
  // 水電瓦斯、郵電：沒有買方統編 → 3；買方不是本店 → 3；有本店統編 → 照常 1
  for (const account of ['6118', '6115']) {
    const none = { ...inv, account, buyer_tax_id: '' };
    assert.equal(deductibility(none, opts).ok, false, `${account} 沒有本店統編`);
    assert.match(deductibility(none, opts).reason, /沒有載明本店統編/);
    assert.equal(taxCodes(none, false).ded_code, '3');
    assert.equal(deductibility({ ...inv, account, buyer_tax_id: BUYER }, opts).ok, false, `${account} 買方不是本店`);
    const mine = { ...inv, account };
    assert.equal(deductibility(mine, opts).ok, true, `${account} 有本店統編可扣抵`);
    assert.equal(taxCodes(mine, true).ded_code, '1');
    assert.equal(deductibility({ ...none, ded_code: '1' }, opts).ok, true, '帳單上其實有本店統編：老闆選 1 就可扣抵');
  }
  // 其他費用不受影響（沒有買方統編、但勾可扣抵的三聯式）
  assert.equal(deductibility({ ...inv, account: '6116', buyer_tax_id: '' }, opts).ok, true);
  assert.equal(nonDeductibleByRule({ account: '6116' }, SHOP), '');
  // 入帳分錄：不可扣抵的稅額併入費用，不進 1261
  const ok = deductibility(meal, opts).ok;
  const je = documentJournal({ id: 'd1', doc_date: '2026-11-03', vendor_name: '便當店', invoice_no: 'QA10000001', amount_total: 1050, tax_amount: 50, account: '6126', pay_account: '2134' }, { deductible: ok });
  assert.deepEqual(je.lines.map((l) => [l.account, l.debit, l.credit]), [['6126', 1050, 0], ['2134', 0, 1050]]);
});

test('二-2 自動覆核：伙食費、水電沒有本店統編 → 不可扣抵並寫出原因', () => {
  const accounts = DEFAULT_ACCOUNTS.map((a) => ({ ...a, active: true }));
  const settings = { tax_id: SHOP, vat_mode: 'general', capitalize_threshold: 80000 };
  // 電子發票左邊 QR（與 recognition 測試相同的組法）：號碼、民國日期、隨機碼、未稅、含稅（16 進位）、買方、賣方
  const hex = (n) => n.toString(16).toUpperCase().padStart(8, '0');
  const leftQR = (buyer, seller) => assembleInvoices([{ bytes: new TextEncoder().encode(`QA12345678${'1151103'}1234${hex(1000)}${hex(1050)}${buyer || '00000000'}${seller}${'A'.repeat(24)}:**********:1:1:1:品項:1:1050`) }]);
  const doc = { id: 'doc_1', status: 'inbox', kind: 'receipt', original_name: 'IMG_0001.jpg', account: '6199', pay_account: '2134' };
  const posted = (o) => ({ id: 'p' + Math.random(), status: 'posted', kind: 'receipt', ...o });
  const kbMeal = buildVendorKB([posted({ vendor_name: '測試便當', vendor_tax_id: SELLER, account: '6126' }), posted({ vendor_name: '測試便當', vendor_tax_id: SELLER, account: '6126' })]);
  const r = autoReview(doc, { qr: leftQR(SHOP, SELLER), kb: kbMeal, accounts, settings, today: '2026-11-12' });
  assert.equal(r.patch.account, '6126');
  assert.equal(r.patch.deductible, false, '伙食費不可扣抵');
  assert.ok(r.reasons.some((x) => /伙食/.test(x)), r.reasons.join('；'));
  const kbPower = buildVendorKB([posted({ vendor_name: '測試電力', vendor_tax_id: SELLER2, account: '6118' }), posted({ vendor_name: '測試電力', vendor_tax_id: SELLER2, account: '6118' })]);
  const withShop = autoReview(doc, { qr: leftQR(SHOP, SELLER2), kb: kbPower, accounts, settings, today: '2026-11-12' });
  assert.equal(withShop.patch.account, '6118');
  assert.equal(withShop.patch.deductible, true, '水電帳單有本店統編照常可扣抵');
});

// 本期進項（營業稅頁的 items 形狀）
const items = [
  { date: '2026-11-03', invoice_no: 'QA10000001', vendor: '測試烘豆', vendor_tax_id: SELLER, buyer_tax_id: SHOP, invoice_type: '電子發票', account: '1211', ex: 1000, tax: 50, total: 1050, check: { ok: true }, tax_type: '1', ded_code: '1' },
  { date: '2026-11-05', invoice_no: 'QA10000002', vendor: '測試便當', vendor_tax_id: SELLER2, buyer_tax_id: SHOP, invoice_type: '電子發票', account: '6126', ex: 200, tax: 10, total: 210, check: { ok: false, reason: '伙食費' }, tax_type: '1', ded_code: '3' },
  { date: '2026-11-06', invoice_no: 'QB10000003', vendor: '設備行', vendor_tax_id: SELLER, buyer_tax_id: SHOP, invoice_type: '三聯式發票', account: '1511', ex: 100000, tax: 5000, total: 105000, check: { ok: true }, tax_type: '1', ded_code: '2' },
  { date: '2026-09-20', invoice_no: 'QC10000004', vendor: '逾期扣抵', vendor_tax_id: SELLER2, buyer_tax_id: SHOP, invoice_type: '收銀機發票', account: '1212', ex: 300, tax: 0, total: 300, check: { ok: false, reason: '未載明稅額' }, tax_type: '3', ded_code: '3' },
  { date: '2026-11-07', invoice_no: '', vendor: '市場', account: '1214', ex: 500, tax: 0, total: 500, check: { ok: false, reason: '沒有統一發票號碼' }, tax_type: '1', ded_code: '3' },
  { date: '2026-11-08', invoice_no: 'QD10000005', vendor: '超商', vendor_tax_id: SELLER, buyer_tax_id: '', account: '6133', ex: 100, tax: 0, total: 100, check: { ok: false, reason: '未載明本店統編' }, tax_type: '1', ded_code: '3' },
  { date: '2026-11-09', invoice_no: 'QE10000006', vendor: '缺統編', vendor_tax_id: '', buyer_tax_id: SHOP, account: '1211', ex: 100, tax: 5, total: 105, check: { ok: true }, tax_type: '1', ded_code: '1' },
];

test('二-3 進項：只列本店統編的發票；格式代號；缺賣方統編列為問題', () => {
  const r = mediaInputRecords(items, { taxId: SHOP });
  assert.deepEqual(r.records.map((x) => [x.fmt, x.invoice_no, x.amount, x.tax_type, x.tax, x.ded_code, x.ym]), [
    ['25', 'QA10000001', 1000, '1', 50, '1', '2026-11'],
    ['25', 'QA10000002', 200, '1', 10, '3', '2026-11'],
    ['21', 'QB10000003', 100000, '1', 5000, '2', '2026-11'],
    ['25', 'QC10000004', 300, '3', 0, '3', '2026-09'],
  ]);
  assert.deepEqual(r.skipped.map((x) => x.reason.slice(0, 4)), ['收據（沒', '沒有載明']);
  assert.deepEqual(r.problems.map((x) => x.reason), ['缺賣方統編（8 碼），請到憑證補上']);
  assert.equal(inputMediaFormat({ invoice_type: '二聯式發票' }), '22');
  assert.equal(inputMediaFormat({ invoice_type: '' }), '25');
});

test('二-3 空白發票號碼：區間寫法、重疊與錯誤', () => {
  const { ranges, errors } = parseBlankRanges('AB12345650-AB12345699\nAC00000010～19\nAD00000001\n ab 12345700 ab12345749 ');
  assert.deepEqual(ranges, [
    { start: 'AB12345650', end: 'AB12345699', count: 50 },
    { start: 'AC00000010', end: 'AC00000019', count: 10 },
    { start: 'AD00000001', end: 'AD00000001', count: 1 },
    { start: 'AB12345700', end: 'AB12345749', count: 50 },
  ]);
  assert.deepEqual(errors, []);
  const bad = parseBlankRanges('AB12345699-AB12345650\nAB12345650-AB12345699\nAB12345690-AB12345720\nAB1234\nAB12345650-AC12345660');
  assert.equal(bad.ranges.length, 1);
  assert.equal(bad.errors.length, 4);
  assert.ok(bad.errors.some((e) => e.includes('訖號比起號小')) && bad.errors.some((e) => e.includes('重疊')) && bad.errors.some((e) => e.includes('看不懂')) && bad.errors.some((e) => e.includes('字軌不同')));
});

test('二-3 產生申報媒體檔 → 解析回來資料相同（進項＋銷項＋空白發票）', () => {
  const inp = mediaInputRecords(items, { taxId: SHOP });
  const sales = normalizeSalesInvoices([
    { invoice_no: 'XY10000001', date: '2026/11/01', buyer_tax_id: '', total: '105', status: '開立' },
    { invoice_no: 'XY10000002', date: '2026/11/02', buyer_tax_id: BUYER, amount: '2000', tax: '100', total: '2100', status: '開立' },
    { invoice_no: 'XY-10000003', date: '2026/11/02', total: '50', status: '作廢' },
    { invoice_no: 'XY10000004', date: '2026/12/31', buyer_tax_id: BUYER, total: '1050' },
    { invoice_no: 'XY10000005', date: '2026/10/31', total: '99' },
  ]);
  const sr = mediaSalesRecords(sales, { taxId: SHOP, start: '2026-11-01', end: '2026-12-31' });
  assert.equal(sr.outside, 1, '10 月那張不在本期');
  const { ranges } = parseBlankRanges('XY10000050-XY10000099\nXY10000006');
  const blanks = mediaBlankRecords(ranges, { taxId: SHOP, ym: '2026-12', fmt: '35' });
  const built = buildMediaFile({ regNo: '123456789', records: [...blanks, ...sr.records, ...inp.records] });
  assert.deepEqual(built.errors, []);
  assert.equal(built.count, 4 + 4 + 2);
  // 每筆 81 字元、ASCII、CRLF 結尾；流水號從 1 起、依格式代號排序
  assert.ok(built.text.endsWith('\r\n'));
  const lines = built.text.split('\r\n').filter(Boolean);
  assert.ok(lines.every((l) => l.length === 81 && /^[\x20-\x7E]+$/.test(l)));
  assert.deepEqual(lines.map((l) => l.slice(11, 18)), ['0000001', '0000002', '0000003', '0000004', '0000005', '0000006', '0000007', '0000008', '0000009', '0000010']);
  assert.ok(lines.every((l) => l.slice(2, 11) === '123456789'));
  assert.deepEqual(lines.map((l) => l.slice(0, 2)), ['21', '25', '25', '25', '35', '35', '35', '35', '35', '35']);
  // 空白發票彙加：課稅別 D、第 24–31 位是訖號、第 80 位 A
  const blankLine = lines.find((l) => l.slice(39, 49) === 'XY10000050');
  assert.equal(blankLine.slice(18, 23), '11512');
  assert.equal(blankLine.slice(23, 31), '10000099');
  assert.equal(blankLine.slice(31, 39), SHOP);
  assert.equal(blankLine.slice(61, 62), 'D');
  assert.equal(blankLine.slice(79, 80), 'A');
  assert.equal(blankLine.slice(49, 61), '000000000000');
  const single = lines.find((l) => l.slice(39, 49) === 'XY10000006');
  assert.equal(single.slice(23, 31), '        ', '單張空白發票不彙加');
  assert.equal(single.slice(79, 80), ' ');
  // 逾期扣抵的進項：所屬年月是發票開立月份
  assert.equal(lines.find((l) => l.slice(39, 49) === 'QC10000004').slice(18, 23), '11509');

  // 反向：解析回來與原始資料相同
  const { rows, errors } = parseMediaFile(built.text);
  assert.deepEqual(errors, []);
  const strip = ({ label, ...x }) => ({ ...x, buyer: x.agg === 'A' ? '' : x.buyer });
  const expected = [...blanks, ...sr.records, ...inp.records].map(strip);
  const key = (x) => x.fmt + x.ym + x.invoice_no;
  assert.deepEqual([...rows].sort((a, b) => (key(a) < key(b) ? -1 : 1)), [...expected].sort((a, b) => (key(a) < key(b) ? -1 : 1)));

  const sm = summarizeMedia(rows);
  assert.deepEqual(sm.periods, ['2026-09', '2026-11']);
  assert.equal(sm.period, '2026-11', '申報期別以銷項為準（逾期進項不影響）');
  assert.deepEqual(sm.salesPeriods, ['2026-11']);
  assert.equal(sm.inputs.count, 4);
  assert.deepEqual([sm.inputs.expense.amount, sm.inputs.expense.tax], [1000, 50]);
  assert.deepEqual([sm.inputs.asset.amount, sm.inputs.asset.tax], [100000, 5000]);
  assert.deepEqual([sm.inputs.nonDeductible.count, sm.inputs.nonDeductible.amount], [2, 500]);
  assert.deepEqual([sm.outputs.b2b.count, sm.outputs.b2b.amount, sm.outputs.b2b.tax], [2, 3000, 150]);
  assert.deepEqual([sm.outputs.b2c.count, sm.outputs.b2c.amountIncl], [1, 105]);
  assert.equal(sm.outputs.voided, 1);
  assert.equal(sm.outputs.blank, 51, '50 張彙加＋1 張');
  assert.equal(sm.outputs.blankRecords, 2);
  assert.equal(sm.outputs.salesEx, 3000 + 100);
  assert.equal(sm.outputs.tax, 150 + 5);
});

test('二-3 媒體檔資料不能寫入：稅籍編號、負數、超過位數', () => {
  const base = { fmt: '25', regNo: '123456789', seq: 1, ym: '2026-11', buyer: SHOP, seller: SELLER, invoice_no: 'QA10000001', amount: 1000, tax_type: '1', tax: 50, ded_code: '1' };
  assert.equal(mediaRecord(base).line.length, 81);
  assert.match(mediaRecord({ ...base, regNo: '12345' }).error, /稅籍編號/);
  assert.match(mediaRecord({ ...base, amount: -100 }).error, /銷售額不能是負數/);
  assert.match(mediaRecord({ ...base, tax: 12345678901 }).error, /稅額/);
  assert.match(mediaRecord({ ...base, invoice_no: 'QA1000000123' }).error, /發票號碼/);
  const r = buildMediaFile({ regNo: '123456789', records: [base, { ...base, invoice_no: 'QA10000002', amount: -1, label: '退貨' }] });
  assert.equal(r.count, 1);
  assert.deepEqual(r.errors.map((e) => e.label), ['退貨']);
});

test('二-4 國稅局進項發票 vs ERP：沒入帳、金額不符、各種入帳方式', () => {
  const einv = [
    { id: 'i1', invoice_no: 'QA10000001', date: '2026-11-03', total: 1050, tax: 50 }, // 照片已入帳、金額相同
    { id: 'i2', invoice_no: 'QA10000002', date: '2026-11-04', total: 2100, tax: 100 }, // 照片已入帳、金額不同
    { id: 'i3', invoice_no: 'QA10000003', date: '2026-11-05', total: 315, tax: 15 }, // ERP 沒有
    { id: 'i4', invoice_no: 'QA10000004', date: '2026-11-06', total: 525, tax: 25 }, // 照片上傳了但還沒入帳
    { id: 'i5', invoice_no: 'QA10000005', date: '2026-11-07', total: 630, tax: 30, entry_id: 'e5' }, // 電子發票本身入帳
    { id: 'i6', invoice_no: 'QA10000006', date: '2026-11-08', total: 105000, tax: 5000 }, // 固定資產購置分錄
    { id: 'i7', invoice_no: 'QA10000007', date: '2026-11-09', total: 210, tax: 10 }, // 手動分錄摘要有寫發票號碼
    { id: 'i8', invoice_no: 'QA10000008', date: '2026-11-10', total: 100, tax: 5, voided: true }, // 國稅局作廢、ERP 已入帳
    { id: 'i9', invoice_no: 'QA10000009', date: '2026-11-11', total: 840, tax: 40, entry_id: 'gone' }, // 分錄已刪
  ];
  const docs = [
    { id: 'd1', status: 'posted', entry_id: 'e1', doc_date: '2026-11-03', vendor_name: '測試烘豆', invoice_no: 'QA10000001', amount_total: 1050, tax_amount: 50 },
    { id: 'd2', status: 'posted', entry_id: 'e2', doc_date: '2026-11-04', vendor_name: '測試乳品', invoice_no: 'QA10000002', amount_total: 2000, tax_amount: 0 },
    { id: 'd4', status: 'reviewed', doc_date: '2026-11-06', vendor_name: '測試包材', invoice_no: 'QA10000004', amount_total: 525 },
    { id: 'd8', status: 'posted', entry_id: 'e8', doc_date: '2026-11-10', vendor_name: '作廢的', invoice_no: 'QA10000008', amount_total: 100, tax_amount: 5 },
  ];
  const assets = [{ id: 'fa1', name: '磨豆機', invoice_no: 'QA10000006', purchase_entry_id: 'e6' }];
  const entries = ['e1', 'e2', 'e5', 'e6', 'e8'].map((id) => ({ id, status: 'posted', lines: [] })).concat([{ id: 'e7', status: 'posted', voucher_no: '115110001', description: '雜支 QA10000007', lines: [] }, { id: 'ev', status: 'void', description: 'QA10000003', lines: [] }]);
  const g = einvoiceGaps(einv, { docs, assets, entries });
  assert.equal(g.total, 8);
  assert.deepEqual(g.booked.map((x) => [x.inv.invoice_no, x.book.kind]), [['QA10000001', 'doc'], ['QA10000005', 'einv'], ['QA10000006', 'asset'], ['QA10000007', 'journal']]);
  assert.deepEqual(g.missing.map((x) => [x.inv.invoice_no, x.pending?.doc_id || null]), [['QA10000003', null], ['QA10000004', 'd4'], ['QA10000009', null]], '作廢分錄的摘要不算入帳；分錄已刪也算沒入帳');
  assert.deepEqual(g.mismatch.map((x) => [x.inv.invoice_no, x.diffs]), [['QA10000002', ['金額 國稅局 2100／ERP 2000', '稅額 國稅局 100／ERP 0']]]);
  assert.deepEqual(g.voidedBooked.map((x) => x.inv.invoice_no), ['QA10000008']);
});

test('拆分明細逐行判斷：同一個發票號碼兩行都列進項；1261 只和可扣抵那幾行比', () => {
  // 一張發票分兩個科目：咖啡豆可扣抵（稅 50 → 1261）、員工餐不可扣抵（稅 10 併入費用）
  const split = {
    id: 'ds', status: 'posted', entry_id: 'es', doc_date: '2026-11-03', vendor_name: '測試商行', vendor_tax_id: SELLER, buyer_tax_id: SHOP, invoice_no: 'QS10000001', amount_total: 1260, tax_amount: 60,
    lines: [
      { invoice_no: 'QS10000001', account: '1211', amount: 1050, tax: 50, deductible: true, ded_code: '1', tax_type: '1' },
      { invoice_no: 'QS10000001', account: '6126', amount: 210, tax: 10, deductible: false, ded_code: '3', tax_type: '1' },
    ],
  };
  const plain = { id: 'dp', status: 'posted', entry_id: 'ep', doc_date: '2026-11-04', invoice_no: 'QS10000002', buyer_tax_id: SHOP, amount_total: 105, tax_amount: 5, account: '6120', deductible: true };
  const dupPhoto = { id: 'dd', status: 'posted', entry_id: 'ed', doc_date: '2026-11-05', invoice_no: 'QS10000001', amount_total: 1260, tax_amount: 60, account: '1211' };
  const einv = [{ id: 'iv', invoice_no: 'QS10000001', date: '2026-11-03', total: 1260, tax: 60, entry_id: 'es' }];
  const items = inputItems([split, plain, dupPhoto], einv);
  assert.deepEqual(items.map((x) => [x.id, x.invoice_no, x.account, x.tax]), [['ds:0', 'QS10000001', '1211', 50], ['ds:1', 'QS10000001', '6126', 10], ['dp', 'QS10000002', '6120', 5]], '同張憑證的兩行都列；別張照片、電子發票的同號碼不重複');
  const all = assignPeriods(items, []);
  const checked = all.map((x) => ({ ...x, check: deductibility(x, opts) }));
  assert.deepEqual(checked.map((x) => x.check.ok), [true, false, false]);
  const entries = [
    { id: 'es', status: 'posted', lines: [{ account: '1211', debit: 1000 }, { account: '6126', debit: 210 }, { account: '1261', debit: 50 }, { account: '2134', credit: 1260 }] },
    { id: 'ep', status: 'posted', lines: [{ account: '6120', debit: 105 }, { account: '2134', credit: 105 }] },
  ];
  assert.deepEqual(overclaimed(checked, all, entries, opts), [], '拆分憑證一行可扣抵、一行不可：1261 等於可扣抵的稅額，不算列錯');
  // 分錄把不可扣抵那行的稅額也列進 1261 → 只標那一行；一般憑證不可扣抵卻列了 1261 → 標出
  entries[0].lines[2].debit = 60;
  entries[1].lines = [{ account: '6120', debit: 100 }, { account: '1261', debit: 5 }, { account: '2134', credit: 105 }];
  assert.deepEqual(overclaimed(checked, all, entries, opts).map((x) => x.id), ['ds:1', 'dp']);

  // 申報媒體檔核對：同一張發票的兩行合計後比（申報一筆可扣抵 50、一筆不可扣抵）
  const parts = [
    { invoice_no: 'QS10000001', doc_id: 'ds', status: 'posted', total: 1050, tax: 50, ex: 1000, ded_code: '1' },
    { invoice_no: 'QS10000001', doc_id: 'ds', status: 'posted', total: 210, tax: 10, ex: 200, ded_code: '3' },
  ];
  const filed = [
    { fmt: '25', invoice_no: 'QS10000001', amount: 1000, tax_type: '1', tax: 50, ded_code: '1' },
    { fmt: '25', invoice_no: 'QS10000001', amount: 200, tax_type: '1', tax: 10, ded_code: '3' },
  ];
  const rc = reconcileMedia(filed, parts);
  assert.equal(rc.matched.length, 1);
  assert.deepEqual(rc.matched[0].diffs, []);
  assert.deepEqual(reconcileMedia([{ ...filed[0], amount: 1200 }], parts).matched[0].diffs, [], '申報合成一筆 1,200／稅 50 也對得上');

  // 國稅局 vs ERP：拆分兩行合計 1,260 與國稅局相同，不算金額不符
  const g = einvoiceGaps([{ id: 'iv2', invoice_no: 'QS10000001', date: '2026-11-03', total: 1260, tax: 60 }], { docs: [split], entries: [{ id: 'es', status: 'posted', lines: [] }] });
  assert.deepEqual([g.booked.length, g.mismatch.length], [1, 0]);

  // 媒體檔：同號碼、同代號的行合成一筆；代號不同照寫兩筆並提醒
  const lineItems = checked.filter((x) => x.invoice_no === 'QS10000001').map((x) => ({ ...x, vendor_tax_id: SELLER, ex: x.total - x.tax, tax_type: '1', ded_code: x.check.ok ? '1' : '3' }));
  const mixed = mediaInputRecords(lineItems, { taxId: SHOP });
  assert.deepEqual(mixed.records.map((r) => [r.ded_code, r.amount, r.tax]), [['1', 1000, 50], ['3', 200, 10]]);
  assert.equal(mixed.cautions.length, 1);
  const same = mediaInputRecords(lineItems.map((x) => ({ ...x, ded_code: '1', check: { ok: true } })), { taxId: SHOP });
  assert.deepEqual(same.records.map((r) => [r.ded_code, r.amount, r.tax]), [['1', 1200, 60]]);
  assert.equal(same.cautions.length, 0);
});
