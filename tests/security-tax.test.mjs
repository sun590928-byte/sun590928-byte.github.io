// 保管箱加密、加密備份、營業稅 401 工作表、申報目標日、寄杯銷項稅額、Excel 匯出
import test from 'node:test';
import assert from 'node:assert/strict';
import * as V from '../erp/js/lib/vault.js';
import { packBackup, unpackBackup } from '../erp/js/lib/backup.js';
import { periodKeyOf, periodInfo, periodsBetween, deductibility, inputItems, assignPeriods, posInvoiceBase, computeTax, settlementEntry, netMovement } from '../erp/js/lib/vat.js';
import { buildCalendar, internalTargets } from '../erp/js/lib/taxcal.js';
import { salesJournal } from '../erp/js/lib/autojournal.js';
import { validateEntry, trialBalance } from '../erp/js/lib/ledger.js';
import { DEFAULT_ACCOUNTS, accountMap } from '../erp/js/lib/coa.js';
import { makeXlsx, colName, sheetName } from '../erp/js/lib/xlsxw.js';
import { readXlsx } from '../erp/js/lib/xlsx.js';
import { journalSheet, trialSheet, incomeSheet, balanceSheetRows } from '../erp/js/lib/reportbook.js';

const FAST = { iterations: 1000 }; // 測試用較少迭代次數
const accMap = accountMap(DEFAULT_ACCOUNTS);

test('vault: 建立、解鎖、錯誤密碼、改密碼、復原碼重設', async () => {
  const { record, key, recoveryCode } = await V.createVault('午月咖啡2026', FAST);
  assert.match(recoveryCode, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
  assert.ok(!JSON.stringify(record).includes('午月咖啡2026'), '保管箱不含密碼');
  const secret = await V.encryptText(key, '拿鐵 120 元', 'wuyue:c:sales_lines');
  assert.ok(!new TextDecoder().decode(secret.data).includes('拿鐵'), '密文不含明文');
  const k2 = await V.unlockVault(record, '午月咖啡2026');
  assert.equal(await V.decryptText(k2, secret, 'wuyue:c:sales_lines'), '拿鐵 120 元');
  await assert.rejects(() => V.unlockVault(record, 'wrong-pass'), V.WrongPasscodeError);
  // 密文綁定用途：換位置解不開
  await assert.rejects(() => V.decryptText(k2, secret, 'wuyue:c:journal_entries'));
  // 改密碼：舊密碼失效、資料仍可解
  const changed = await V.changePasscode(record, '午月咖啡2026', 'NewPass-2026');
  await assert.rejects(() => V.unlockVault(changed.record, '午月咖啡2026'), V.WrongPasscodeError);
  const k3 = await V.unlockVault(changed.record, 'NewPass-2026');
  assert.equal(await V.decryptText(k3, secret, 'wuyue:c:sales_lines'), '拿鐵 120 元');
  // 復原碼（大小寫、空白、易混淆字元都可接受）→ 新密碼、新復原碼
  const typed = recoveryCode.toLowerCase().replace(/-/g, ' ');
  const rec = await V.recoverVault(changed.record, typed, 'Another-2026');
  assert.notEqual(rec.recoveryCode, recoveryCode);
  assert.equal(await V.decryptText(rec.key, secret, 'wuyue:c:sales_lines'), '拿鐵 120 元');
  await assert.rejects(() => V.recoverVault(rec.record, recoveryCode, 'x-2026-abc'), V.WrongPasscodeError, '舊復原碼失效');
  // 檔案加密
  const f = await V.encryptFile(rec.key, { name: '發票.jpg', type: 'image/jpeg' }, new Uint8Array([9, 8, 7]), 'wuyue:f:doc_1');
  const back = await V.decryptFile(rec.key, f, 'wuyue:f:doc_1');
  assert.equal(back.meta.name, '發票.jpg');
  assert.deepEqual([...back.bytes], [9, 8, 7]);
});

test('vault: 密碼強度檢查', () => {
  assert.deepEqual(V.passcodeProblems('午月咖啡2026'), []);
  assert.ok(V.passcodeProblems('1234').length);
  assert.ok(V.passcodeProblems('11111111').includes('太容易被猜到'));
  assert.ok(V.passcodeProblems('12345678').length);
});

test('backup: 加密備份含檔案，錯誤密碼無法開啟', async () => {
  const json = { app: 'wuyue-erp', version: 2, exported_at: '2026-09-23T00:00:00Z', data: { journal_entries: [{ id: 'je_1', description: '房租' }] } };
  const bytes = await packBackup(json, [{ id: 'doc_1', name: '收據.png', type: 'image/png', bytes: new Uint8Array([1, 2, 3]) }], '備份密碼-2026', FAST);
  assert.ok(!new TextDecoder().decode(bytes).includes('房租'));
  const out = await unpackBackup(bytes, '備份密碼-2026');
  assert.deepEqual(out.json, json);
  assert.deepEqual([...out.files[0].bytes], [1, 2, 3]);
  await assert.rejects(() => unpackBackup(bytes, 'nope'), V.WrongPasscodeError);
  // 舊版未加密 JSON 仍可讀
  const legacy = await unpackBackup(new TextEncoder().encode(JSON.stringify(json)));
  assert.deepEqual(legacy.json, json);
});

test('vat: 期別、期限與內部目標日', () => {
  assert.equal(periodKeyOf('2026-10-31'), '2026-09');
  assert.equal(periodKeyOf('2026-08-21'), '2026-07');
  const p = periodInfo('2026-09');
  assert.equal(p.end, '2026-10-31');
  assert.equal(p.legal, '2026-11-15');
  assert.equal(p.due, '2026-11-16', '11/15 週日順延');
  assert.equal(periodInfo('2026-11').due, '2027-01-15');
  assert.deepEqual(periodsBetween('2026-08-21', '2026-12-01').map((x) => x.key), ['2026-07', '2026-09', '2026-11']);
  assert.deepEqual(internalTargets('2026-11-16'), { prep: '2026-11-10', target: '2026-11-12' });
  assert.deepEqual(internalTargets('2026-09-15'), { prep: '2026-09-10', target: '2026-09-11' }, '9/12 週六提前到週五');
  assert.deepEqual(internalTargets('2026-11-10'), { prep: '2026-11-04', target: '2026-11-06' }, '10 日期限提前 3 天再避開週末');
});

test('taxcal: 商號一般稅額、自行申報目標日', () => {
  const items = buildCalendar(2026, { orgType: 'sole', vatMode: 'general', prepDay: 10, targetDay: 12 });
  const vat = items.find((i) => i.vatPeriod === '2026-09');
  assert.equal(vat.due, '2026-11-16');
  assert.equal(vat.target, '2026-11-12');
  assert.equal(vat.prep, '2026-11-10');
  assert.ok(!items.some((i) => i.title.startsWith('營所稅暫繳')), '商號免暫繳');
  assert.ok(items.some((i) => i.title.startsWith('營利事業所得稅結算申報') && i.detail.includes('免計算及繳納')));
  assert.ok(items.some((i) => i.title.includes('二代健保補充保費') && i.date === '2026-09-30'));
  const closing = items.find((i) => i.title === '8 月帳務結帳');
  assert.equal(closing.filing, false);
  assert.ok(items.every((i) => !i.filing || i.target <= i.due), '目標日不晚於法定期限');
});

test('vat: 進項可否扣抵', () => {
  const opts = { taxId: '12345675', vatMode: 'general' };
  const base = { invoice_no: 'AB12345678', tax: 50, account: '1211', deductible: true };
  assert.equal(deductibility(base, opts).ok, true);
  assert.equal(deductibility({ ...base, invoice_no: '' }, opts).ok, false);
  assert.equal(deductibility({ ...base, tax: 0 }, opts).ok, false);
  assert.match(deductibility({ ...base, account: '6120' }, opts).reason, /交際/);
  assert.match(deductibility({ ...base, account: '6127' }, opts).reason, /職工福利/);
  assert.match(deductibility({ ...base, buyer_tax_id: '87654321' }, opts).reason, /不是本店/);
  assert.equal(deductibility({ ...base, deductible: false }, opts).ok, false);
  assert.equal(deductibility({ ...base, invoice_type: '二聯式發票' }, opts).ok, false);
  assert.equal(deductibility(base, { ...opts, vatMode: 'small' }).ok, false);
});

test('vat: 進項清單去重、逾期順延、稅額計算與結轉分錄', () => {
  const docs = [
    { id: 'd1', status: 'posted', entry_id: 'e1', doc_date: '2026-09-02', invoice_no: 'AB00000001', amount_total: 1050, tax_amount: 50, account: '1211', deductible: true },
    { id: 'd2', status: 'posted', entry_id: 'e2', doc_date: '2026-10-05', invoice_no: 'AB00000002', amount_total: 210000, tax_amount: 10000, account: '1511', deductible: true },
    { id: 'd3', status: 'posted', entry_id: 'e3', doc_date: '2026-07-20', invoice_no: 'AB00000003', amount_total: 525, tax_amount: 25, account: '6118', deductible: true },
    { id: 'd4', status: 'inbox', doc_date: '2026-09-03', invoice_no: 'AB00000004', amount_total: 100, tax_amount: 5 },
  ];
  const einv = [{ id: 'i1', invoice_no: 'AB00000001', date: '2026-09-02', total: 1050, tax: 50, entry_id: 'e1' }, { id: 'i2', invoice_no: 'CD00000009', date: '2026-10-10', total: 315, tax: 15, entry_id: 'e9', account: '6120', deductible: true }];
  const items = inputItems(docs, einv);
  assert.deepEqual(items.map((x) => x.invoice_no), ['AB00000003', 'AB00000001', 'AB00000002', 'CD00000009'], '同發票號只算一次、未入帳不列');
  assert.equal(items.find((x) => x.id === 'd2').use, 'asset');
  // 7–8 月已申報但沒包含 d3 → 順延到 9–10 月
  const filings = [{ id: '2026-07', status: 'filed', claimed: [] }];
  const assigned = assignPeriods(items, filings);
  const d3 = assigned.find((x) => x.id === 'd3');
  assert.equal(d3.period, '2026-09');
  assert.equal(d3.late, true);
  const inP = assigned.filter((x) => x.period === '2026-09').map((x) => ({ ...x, check: deductibility(x, { taxId: '', vatMode: 'general' }) }));
  const ok = inP.filter((x) => x.check.ok);
  const expTax = ok.filter((x) => x.use === 'expense').reduce((t, x) => t + x.tax, 0);
  const astTax = ok.filter((x) => x.use === 'asset').reduce((t, x) => t + x.tax, 0);
  assert.equal(expTax, 75, '交際費 15 不扣抵');
  assert.equal(astTax, 10000);
  // 應繳
  const pay = computeTax({ output: 20000, inputExpense: 75, inputAsset: 0, prevCf: 1000 });
  assert.deepEqual([pay.payable, pay.cf, pay.refund], [18925, 0, 0]);
  // 溢付：固定資產部分可退，其餘留抵
  const over = computeTax({ output: 2000, inputExpense: 1500, inputAsset: 10000, prevCf: 700 });
  assert.equal(over.overpaid, 10200);
  assert.equal(over.refund, 10000);
  assert.equal(over.cf, 200);
  const e = settlementEntry('2026-09', { bookOutput: 2000, bookInput: 11500, tax: over });
  assert.deepEqual(validateEntry({ ...e, id: 'x' }, accMap), []);
  assert.equal(e.date, '2026-10-31');
  assert.ok(!e.lines.some((l) => l.memo === '營業稅尾差'), '帳上與工作表一致時沒有尾差');
  const e2 = settlementEntry('2026-09', { bookOutput: 20003, bookInput: 75, tax: pay });
  assert.deepEqual(validateEntry({ ...e2, id: 'y' }, accMap), []);
  assert.equal(e2.lines.find((l) => l.memo === '營業稅尾差').credit, 3);
  assert.equal(e2.lines.find((l) => l.account === '2132').credit, 18925);
  // 結轉後 2131、1261 歸零
  const entries = [
    { id: 'a', date: '2026-09-30', source: 'pos', lines: [{ account: '1101', debit: 20003, credit: 0 }, { account: '2131', debit: 0, credit: 20003 }] },
    { id: 'b', date: '2026-09-30', source: 'document', lines: [{ account: '1261', debit: 75, credit: 0 }, { account: '1101', debit: 0, credit: 75 }] },
    { ...e2, id: 'c' },
  ];
  assert.equal(netMovement(entries, '2131', { to: '2026-10-31' }), 0);
  assert.equal(netMovement(entries, '1261', { to: '2026-10-31' }), 0);
  assert.ok(trialBalance(entries, DEFAULT_ACCOUNTS, { to: '2026-10-31' }).balanced);
});

test('vat: POS 開立發票基礎（作廢、寄杯兌換不開發票）', () => {
  const lines = [
    { date: '2026-09-01', amount: 105, qty: 1, payment: 'cash' },
    { date: '2026-09-01', amount: 120, qty: 1, payment: 'cash', void_reason: 'boss_treat' },
    { date: '2026-09-01', amount: 100, qty: 1, payment: 'prepaid' },
    { date: '2026-09-01', amount: 1000, qty: 1, payment: 'cash', item_raw: '寄杯10杯' },
  ];
  const cat = (l) => (/寄杯/.test(l.item_raw || '') ? 'prepaid' : 'coffee');
  const sale = posInvoiceBase(lines, { categoryOf: cat, prepaidVat: 'sale' });
  assert.equal(sale.receipts, 1105);
  assert.equal(sale.excluded.redeem, 100);
  assert.equal(sale.voidByReason.boss_treat.amount, 120);
  assert.equal(sale.salesEx + sale.tax, 1105);
  const redeem = posInvoiceBase(lines, { categoryOf: cat, prepaidVat: 'redeem' });
  assert.equal(redeem.receipts, 205);
  assert.equal(redeem.excluded.prepaidSale, 1000);
});

test('autojournal: 寄杯售出時認列銷項稅額、兌換時不重複計稅', () => {
  const cat = (l) => (/寄杯/.test(l.item_raw) ? 'prepaid' : 'coffee');
  const day1 = [
    { date: '2026-09-01', item_raw: '寄杯10杯', amount: 1000, gross: 1000, qty: 1, payment: 'cash' },
    { date: '2026-09-01', item_raw: '美式', amount: 105, gross: 105, qty: 1, payment: 'cash' },
  ];
  const day2 = [
    { date: '2026-09-02', item_raw: '拿鐵', amount: 100, gross: 100, qty: 1, payment: 'prepaid' },
    { date: '2026-09-02', item_raw: '美式', amount: 105, gross: 105, qty: 1, payment: 'cash' },
  ];
  const [e1, e2] = salesJournal([...day1, ...day2], { categoryOf: cat, vatMode: 'general', prepaidVat: 'sale' });
  for (const e of [e1, e2]) assert.deepEqual(validateEntry({ ...e, id: e.date }, accMap), []);
  const tax = (e) => e.lines.filter((l) => l.account === '2131').reduce((t, l) => t + l.credit - l.debit, 0);
  assert.equal(tax(e1), 53, '寄杯 1000 的 48 + 美式 5');
  assert.equal(e1.lines.find((l) => l.account === '2151').credit, 952);
  assert.equal(tax(e2), 5, '兌換不計稅，只有美式');
  assert.equal(e2.lines.find((l) => l.account === '2151').debit, 95);
  // 兌換時才開發票的店：售出不計稅、兌換計稅
  const [r1, r2] = salesJournal([...day1, ...day2], { categoryOf: cat, vatMode: 'general', prepaidVat: 'redeem' });
  assert.equal(tax(r1), 5);
  assert.equal(r1.lines.find((l) => l.account === '2151').credit, 1000);
  assert.equal(tax(r2), 10);
});

test('xlsx: 寫出的活頁簿可被讀回（多工作表、中文、數字）', async () => {
  assert.equal(colName(0), 'A');
  assert.equal(colName(27), 'AB');
  const used = new Set();
  assert.equal(sheetName('試算表 115/09', used), '試算表 115 09');
  assert.equal(sheetName('試算表 115/09', used), '試算表 115 09_2');
  const blob = makeXlsx([
    { name: '日記簿', rows: [['日期', '摘要', '借方'], ['2026-09-01', 'A&B <咖啡豆>', 1234.5]], widths: [12, 20, 10] },
    { name: '試算表', rows: [['合計', 100]] },
  ]);
  const wb = await readXlsx(new Uint8Array(await blob.arrayBuffer()));
  assert.deepEqual(wb.map((s) => s.name), ['日記簿', '試算表']);
  assert.deepEqual(wb[0].rows[1], ['2026-09-01', 'A&B <咖啡豆>', '1234.5']);
});

test('reportbook: 帳冊工作表（日記簿、試算表、損益表、資產負債表）', () => {
  const entries = [
    { id: '1', date: '2026-09-01', voucher_no: '11509-0001', description: 'POS', source: 'pos', lines: [{ account: '1101', debit: 1050, credit: 0 }, { account: '4101', debit: 0, credit: 1000 }, { account: '2131', debit: 0, credit: 50 }] },
    { id: '2', date: '2026-09-02', voucher_no: '11509-0002', description: '房租', source: 'manual', attachments: ['d1'], lines: [{ account: '6111', debit: 25000, credit: 0 }, { account: '1103', debit: 0, credit: 25000 }] },
  ];
  const per = { from: '2026-09-01', to: '2026-09-30' };
  const meta = { business: '午月咖啡廳', period: '115 年 9 月' };
  const j = journalSheet(entries, DEFAULT_ACCOUNTS, per, meta);
  assert.equal(j.rows[0][0], '午月咖啡廳');
  assert.deepEqual(j.rows[j.rows.length - 1].slice(7, 9), [26050, 26050]);
  assert.equal(j.rows.find((r) => r[4] === '房租')[10], 1, '附件張數');
  const t = trialSheet(entries, DEFAULT_ACCOUNTS, per, meta);
  assert.ok(t.rows.some((r) => r[0] === '借貸平衡'));
  const i = incomeSheet(entries, DEFAULT_ACCOUNTS, per, meta);
  assert.ok(i.rows.some((r) => r[0] === '本期淨利（淨損）' && r[1] === -24000));
  const b = balanceSheetRows(entries, DEFAULT_ACCOUNTS, { asOf: '2026-09-30' }, meta);
  assert.ok(b.rows.some((r) => r[0] === '資產＝負債＋權益'));
});
