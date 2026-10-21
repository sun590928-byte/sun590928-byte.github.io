// 科目表匯入、付款方式（依科目表／資料夾）、憑證拆分入帳、申報代號、申報媒體檔解析與核對（全為合成資料）
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ACCOUNTS, parseAccountsRows, diffAccounts, payAccountsOf, payAccountForFolder, STATEMENT_FOLDER, accountMap } from '../erp/js/lib/coa.js';
import { parseCSV } from '../erp/js/lib/csv.js';
import { documentJournal, payoutJournal } from '../erp/js/lib/autojournal.js';
import { normalizePayment } from '../erp/js/lib/pos.js';
import { validateEntry } from '../erp/js/lib/ledger.js';
import { deductibility, taxCodes, impliedTax, docParts, inputItems, assignPeriods, parseMediaFile, summarizeMedia, reconcileMedia, INVOICE_NO_RE } from '../erp/js/lib/vat.js';

const accMap = accountMap(DEFAULT_ACCOUNTS);

test('coa: 匯入科目表 CSV，自動修正類別與申報欄位、比對差異', () => {
  const csv = `代號,名稱,類別,餘額方向,成本性質,營所稅申報欄位,說明
1101,零用金-門市收銀,資產,借,—,,每日收銀現金營收
1102,零用金-會計行政,資產,借,—,,
1115,應收帳款－外送平台未撥款項,營業費用,借,—,,Uber Eats
1512,累計折舊－生財器具,資產,貸,—,,
2133,其他應付款-負責人代墊,負債,貸,—,,
6133,雜項費用,營業費用,借,固定,借,金額不大
6136,營業費用-規費,營業費用,借,固定,借,商標權
abc,壞資料,資產,借,—,,
1101,重複,資產,借,—,,`;
  const current = [
    { code: '1101', name: '零用金-會計行政', type: 'asset', side: 'debit', active: true },
    { code: '1102', name: '零用金-門市收銀', type: 'asset', side: 'debit', active: true },
    { code: '6102', name: '薪資支出－計時人員', type: 'expense', side: 'debit', active: true },
    { code: '6199', name: '其他費用', type: 'expense', side: 'debit', active: true },
  ];
  const r = parseAccountsRows(parseCSV(csv), current);
  assert.equal(r.accounts.length, 7);
  assert.equal(r.errors.length, 2, '壞代號、重複代號');
  const by = Object.fromEntries(r.accounts.map((a) => [a.code, a]));
  assert.equal(by['1115'].type, 'asset', '1xxx 不會是營業費用');
  assert.equal(by['6133'].tax_line, '其他費用', '「借」不是申報欄位');
  assert.equal(by['1512'].contra, true, '累計折舊為抵銷科目');
  assert.equal(by['1512'].side, 'credit');
  assert.equal(r.fixes.length, 3);
  const d = diffAccounts(current, r.accounts, new Set(['6199']));
  assert.deepEqual(d.added.map((a) => a.code), ['1115', '1512', '2133', '6133', '6136']);
  assert.deepEqual(d.renamed.map((x) => x.code), ['1101', '1102'], '名稱對調');
  assert.deepEqual(d.missing, [
    { code: '6102', name: '薪資支出－計時人員', used: false },
    { code: '6199', name: '其他費用', used: true },
  ]);
});

test('coa: 付款方式依科目表、上傳資料夾對應付款來源', () => {
  const pays = payAccountsOf(DEFAULT_ACCOUNTS).map(([c]) => c);
  assert.deepEqual(pays, ['1101', '1102', '1103', '1104', '1111', '1112', '1113', '1114', '1115', '2111', '2133', '2134', '2191']);
  assert.equal(payAccountForFolder('員工代墊支出', DEFAULT_ACCOUNTS), '2134');
  assert.equal(payAccountForFolder('負責人代墊支出', DEFAULT_ACCOUNTS), '2133');
  assert.equal(payAccountForFolder('主要帳戶', DEFAULT_ACCOUNTS), '1103');
  assert.equal(payAccountForFolder('零用金-會計行政', DEFAULT_ACCOUNTS), '1102');
  assert.equal(payAccountForFolder('其他類型', DEFAULT_ACCOUNTS), null);
  const mine = [...DEFAULT_ACCOUNTS.filter((a) => a.code !== '1104'), { code: '1104', name: '銀行存款-山海北區', type: 'asset', active: true }];
  assert.equal(payAccountForFolder('山海銀行', mine), '1104', '依科目名稱關鍵字比對銀行');
  assert.equal(payAccountForFolder('月結廠商', mine), '2111');
  assert.ok(STATEMENT_FOLDER.test('存摺明細') && STATEMENT_FOLDER.test('營業額明細') && !STATEMENT_FOLDER.test('員工代墊支出'));
  // 科目代號改了也找得到（依名稱）
  const swapped = DEFAULT_ACCOUNTS.map((a) => (a.code === '2134' ? { ...a, code: '2135' } : a));
  assert.equal(payAccountForFolder('員工代墊支出', swapped), '2135');
  // 老闆把 2133 改名「其他應付款-負責人借款」：仍是付款方式（依代號，不靠名稱），資料夾也對得到
  const renamed = DEFAULT_ACCOUNTS.map((a) => (a.code === '2133' ? { ...a, name: '其他應付款-負責人借款' } : a));
  assert.ok(payAccountsOf(renamed).some(([c]) => c === '2133'), '改名後的 2133 仍在付款方式');
  assert.equal(payAccountForFolder('負責人代墊支出', renamed), '2133');
  assert.ok(!payAccountsOf(DEFAULT_ACCOUNTS).some(([c]) => ['2131', '2132', '2101', '2501'].includes(c)), '稅額、借款科目不是付款來源');
  // 停用的科目不出現，但目前選用中的保留
  const off = DEFAULT_ACCOUNTS.map((a) => (a.code === '1104' ? { ...a, active: false } : a));
  assert.ok(!payAccountsOf(off).some(([c]) => c === '1104'));
  assert.ok(payAccountsOf(off, '1104').some(([c]) => c === '1104'));
});

test('pos／撥款: 台灣Pay、外送平台對應新的應收科目', () => {
  assert.equal(normalizePayment('台灣Pay'), 'taiwanpay');
  assert.equal(normalizePayment('全支付'), 'mobile');
  const p = payoutJournal({ id: 'po1', provider: 'platform', payout_date: '2026-09-10', gross: 1000, fee: 300, net: 700 });
  assert.equal(p.lines.find((l) => l.credit).account, '1115');
  const t = payoutJournal({ id: 'po2', provider: 'taiwanpay', payout_date: '2026-09-10', gross: 500, fee: 5, net: 495 });
  assert.equal(t.lines.find((l) => l.credit).account, '1114');
  // 手續費以發票入帳：撥款只記實撥，手續費發票（借 手續費＋進項稅額／貸 未撥款項）沖掉剩下的應收
  const e = payoutJournal({ id: 'po3', provider: 'ecpay', payout_date: '2026-09-10', gross: 10000, fee: 907, net: 9093 }, { feeByInvoice: true });
  assert.deepEqual(e.lines.map((l) => [l.account, l.debit, l.credit]), [['1103', 9093, 0], ['1111', 0, 9093]]);
  const inv = documentJournal({ id: 'd', doc_date: '2026-08-31', amount_total: 907, tax_amount: 43, account: '6131', pay_account: '1111' }, { deductible: true });
  assert.deepEqual(inv.lines.map((l) => [l.account, l.debit, l.credit]), [['6131', 864, 0], ['1261', 43, 0], ['1111', 0, 907]]);
});

test('憑證拆分: 7 張代墊收據分屬多科目、一張照片兩張發票', () => {
  const bundle = {
    id: 'doc_b', doc_date: '2026-08-21', vendor_name: '多家彙總', amount_total: 10000, pay_account: '2134',
    lines: [
      { account: '1215', amount: 6891, tax: 0, memo: '咖啡材料行 濾紙' },
      { account: '6133', amount: 2784, tax: 0, memo: '園藝、印刷、印章、五金' },
      { invoice_no: 'QC10000006', account: '6133', amount: 325, tax: 15, deductible: true, memo: '麵包店' },
    ],
  };
  const e = documentJournal(bundle);
  assert.deepEqual(validateEntry({ ...e, id: 'x' }, accMap), []);
  assert.deepEqual(e.lines.map((l) => [l.account, l.debit, l.credit]), [['1215', 6891, 0], ['6133', 2784, 0], ['6133', 310, 0], ['1261', 15, 0], ['2134', 0, 10000]]);
  assert.match(e.description, /QC10000006/);
  // 咖啡機：訂金＋尾款兩張發票，申報為不可扣抵之固定資產 → 稅額併入成本
  const machine = {
    id: 'doc_m', doc_date: '2026-08-14', vendor_name: '設備商', amount_total: 308000, pay_account: '1103', account: '1511',
    lines: [
      { invoice_no: 'QM10000001', account: '1511', amount: 92400, tax: 4400, deductible: false, ded_code: '4', tax_type: '3' },
      { invoice_no: 'QM10000002', account: '1511', amount: 215600, tax: 10267, deductible: false, ded_code: '4', tax_type: '3' },
    ],
  };
  const m = documentJournal(machine);
  assert.deepEqual(m.lines.map((l) => [l.account, l.debit, l.credit]), [['1511', 92400, 0], ['1511', 215600, 0], ['1103', 0, 308000]]);
  assert.match(m.description, /QM10000001\+QM10000002/);
  assert.deepEqual(docParts(machine).map((p) => p.key), ['doc_m:0', 'doc_m:1']);
});

test('申報代號: 課稅別、扣抵代號、手動指定優先、收銀機推算稅額', () => {
  const opts = { taxId: '12345675', vatMode: 'general' };
  const inv = { invoice_no: 'AB12345678', tax: 50, account: '1211', buyer_tax_id: '12345675', deductible: true };
  const ok = deductibility(inv, opts).ok;
  assert.deepEqual(taxCodes(inv, ok), { tax_type: '1', ded_code: '1' });
  const asset = { ...inv, account: '1511' };
  assert.deepEqual(taxCodes(asset, deductibility(asset, opts).ok), { tax_type: '1', ded_code: '2' });
  const meal = { ...inv, account: '6127' };
  assert.deepEqual(taxCodes(meal, deductibility(meal, opts).ok), { tax_type: '1', ded_code: '3' });
  // 免稅（鮮乳）：有本店統編但稅額 0
  const milk = { invoice_no: 'QQ10000008', tax: 0, account: '1212', buyer_tax_id: '12345675' };
  assert.deepEqual(taxCodes(milk, deductibility(milk, opts).ok), { tax_type: '3', ded_code: '3' });
  // 手動指定：扣抵代號 4 → 不可扣抵
  const forced = { ...asset, ded_code: '4', tax_type: '3' };
  assert.equal(deductibility(forced, opts).ok, false);
  assert.deepEqual(taxCodes(forced, false), { tax_type: '3', ded_code: '4' });
  assert.equal(deductibility({ ...inv, account: '6127', ded_code: '1' }, opts).ok, true, '老闆指定可扣抵者優先');
  // 收銀機發票載明本店統編、未印稅額
  assert.equal(impliedTax({ invoice_type: '收銀機發票', invoice_no: 'QF10000007', buyer_tax_id: '12345675', amount_total: 130, tax_amount: 0 }, '12345675'), 6);
  assert.equal(impliedTax({ invoice_type: '收銀機發票', invoice_no: 'QF10000007', buyer_tax_id: '', amount_total: 130 }, '12345675'), null);
  assert.ok(INVOICE_NO_RE.test('BBX1234567') && INVOICE_NO_RE.test('AB12345678') && !INVOICE_NO_RE.test('ABC1234567'));
});

// 合成的申報媒體檔（81 字元固定寬度）
function rec(fmt, ym, buyer, seller, inv, amount, taxType, tax, ded) {
  const pad = (s, n) => String(s).padStart(n, '0');
  return [fmt, '000000000', '0000001', ym, String(buyer).padEnd(8, ' '), String(seller).padEnd(8, ' '), inv.padEnd(10, ' '), pad(amount, 12), taxType, pad(tax, 10), ded, '     ', ' ', ' ', ' '].join('');
}

test('申報媒體檔: 解析、彙總、與系統憑證核對', () => {
  const shop = '12345675';
  const text = [
    rec('25', '11508', shop, '22222222', 'QS10000003', 7770, '1', 389, '1'),
    rec('25', '11508', shop, '33333333', 'QM10000001', 88000, '3', 0, '4'),
    rec('25', '11508', shop, '33333333', 'QM10000002', 205333, '3', 0, '4'),
    rec('22', '11508', shop, '55555555', 'QD10000005', 574, '1', 0, '3'),
    rec('25', '11507', shop, '44444444', 'QN10000004', 286, '1', 14, '1'),
    rec('25', '11508', shop, '11111111', 'ZZ00000001', 100, '1', 5, '1'),
    rec('35', '11508', '', shop, 'DV02087700', 0, 'F', 0, ' '),
    rec('35', '11508', '', shop, 'DV02087719', 1050, '1', 0, ' '),
    rec('35', '11508', '21214464', shop, 'DV02087745', 362, '1', 18, ' '),
  ].join('\r\n');
  const { rows, errors } = parseMediaFile(text);
  assert.equal(errors.length, 0);
  assert.equal(rows.length, 9);
  assert.deepEqual(rows[0], { fmt: '25', ym: '2026-08', buyer: shop, seller: '22222222', invoice_no: 'QS10000003', amount: 7770, tax_type: '1', tax: 389, ded_code: '1' });
  const sm = summarizeMedia(rows);
  assert.deepEqual(sm.periods, ['2026-07']);
  assert.equal(sm.inputs.expense.tax, 389 + 14 + 5);
  assert.equal(sm.inputs.nonDeductible.amount, 88000 + 205333 + 574);
  assert.equal(sm.outputs.voided, 1);
  assert.equal(sm.outputs.b2b.tax, 18);
  assert.equal(sm.outputs.salesEx, 362 + 1000);
  assert.equal(sm.outputs.tax, 18 + 50);

  // 系統：咖啡豆已入帳、咖啡機（拆兩張）待入帳、濾紙已入帳但稅額填錯、另有一張本期已入帳但沒申報
  const parts = [
    { invoice_no: 'QS10000003', status: 'posted', total: 8159, tax: 389, ex: 7770, ded_code: '1', period: '2026-07', label: '咖啡豆商' },
    { invoice_no: 'QM10000001', status: 'reviewed', total: 92400, tax: 4400, ex: 88000, ded_code: '4', label: '設備商' },
    { invoice_no: 'QM10000002', status: 'reviewed', total: 215600, tax: 10267, ex: 205333, ded_code: '4', label: '設備商' },
    { invoice_no: 'QN10000004', status: 'posted', total: 300, tax: 0, ex: 300, ded_code: '3', period: '2026-07', label: 'momo' },
    { invoice_no: 'AA99999999', status: 'posted', total: 210, tax: 10, ex: 200, ded_code: '1', period: '2026-07', label: '未申報' },
  ];
  const r = reconcileMedia(rows.filter((x) => x.fmt[0] === '2'), parts, { periodKey: '2026-07' });
  assert.equal(r.matched.length, 4);
  assert.deepEqual(r.matched.find((x) => x.filed.invoice_no === 'QS10000003').diffs, []);
  assert.deepEqual(r.matched.find((x) => x.filed.invoice_no === 'QM10000001').diffs, []);
  const momo = r.matched.find((x) => x.filed.invoice_no === 'QN10000004');
  assert.ok(momo.diffs.some((s) => s.includes('可扣抵稅額')) && momo.diffs.some((s) => s.includes('扣抵代號')));
  assert.deepEqual(r.filedOnly.map((x) => x.invoice_no), ['QD10000005', 'ZZ00000001']);
  assert.deepEqual(r.bookedOnly.map((x) => x.invoice_no), ['AA99999999']);
});

test('進項期別: 已申報清單內的發票歸到申報期，拆分憑證每張發票各一行', () => {
  const docs = [
    { id: 'doc_m', status: 'posted', entry_id: 'je1', doc_date: '2026-09-05', vendor_name: '設備商', amount_total: 308000, account: '1511', lines: [{ invoice_no: 'QM10000001', account: '1511', amount: 92400, tax: 4400 }, { invoice_no: 'QM10000002', account: '1511', amount: 215600, tax: 10267 }] },
    { id: 'doc_x', status: 'posted', entry_id: 'je2', doc_date: '2026-08-31', invoice_no: 'QN10000004', amount_total: 300, tax_amount: 14, account: '1215' },
  ];
  const items = inputItems(docs, []);
  assert.deepEqual(items.map((x) => x.id), ['doc_x', 'doc_m:0', 'doc_m:1']);
  const filings = [{ id: '2026-07', status: 'filed', claimed: [], filed_inputs: [{ invoice_no: 'QM10000001' }, { invoice_no: 'QM10000002' }] }];
  const a = assignPeriods(items, filings);
  assert.equal(a.find((x) => x.id === 'doc_m:0').period, '2026-07', '9 月入帳但已在 7–8 月申報');
  assert.equal(a.find((x) => x.id === 'doc_x').period, '2026-09', '8 月憑證未申報 → 順延到 9–10 月');
  assert.equal(a.find((x) => x.id === 'doc_x').late, true);
});
