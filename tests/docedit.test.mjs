// 11/12 需求 二-1：日記簿「修改」直接改憑證的課稅別、扣抵代號、拆分明細，存檔同步憑證、分錄與 401
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ACCOUNTS, accountMap } from '../erp/js/lib/coa.js';
import { validateEntry } from '../erp/js/lib/ledger.js';
import { documentJournal } from '../erp/js/lib/autojournal.js';
import { inputItems, assignPeriods, deductibility, taxCodes } from '../erp/js/lib/vat.js';
import { sourceDocumentOf, checkRow, docEditRows, applyDocEdit, describeChanges, sameLines, filedPeriodsFor, assetGroups, isBlankRow } from '../erp/js/lib/docedit.js';

const accMap = accountMap(DEFAULT_ACCOUNTS);
const OPTS = { taxId: '12345675', vatMode: 'general', payAccount: '2134', accounts: new Set(DEFAULT_ACCOUNTS.map((a) => a.code)) };
const lines = (e) => e.lines.map((l) => [l.account, l.debit, l.credit]);
// 已入帳的憑證：發票 1,050（稅 50），咖啡豆，扣抵代號 1
const DOC = { id: 'doc_t1', status: 'posted', entry_id: 'je_t1', doc_date: '2026-09-25', vendor_name: '測試商行', summary: '咖啡豆禮盒', invoice_no: 'JE11120001', amount_total: 1050, tax_amount: 50, account: '1211', pay_account: '2134', deductible: true, tax_type: '1', ded_code: '1', archived_name: 'x.png' };
const ENTRY = { id: 'je_t1', date: '2026-09-25', voucher_no: '11509-0007', source: 'document', source_ref: 'doc_t1', status: 'posted', attachments: ['doc_t1'], ...documentJournal(DOC, { deductible: true }) };
const rowsOf = (doc, patch = []) => docEditRows(doc, OPTS).map((r, i) => ({ ...r, ...(patch[i] || {}) }));

test('docedit: 找分錄的來源憑證；憑證刪除、電子發票入帳、改連別張時改用一般編輯器', () => {
  assert.equal(sourceDocumentOf(ENTRY, [DOC]), DOC);
  assert.equal(sourceDocumentOf(ENTRY, []), null, '憑證已刪除');
  assert.equal(sourceDocumentOf({ ...ENTRY, source_ref: 'einv_1' }, [DOC]), null, '電子發票入帳（source_ref 是電子發票）');
  assert.equal(sourceDocumentOf(ENTRY, [{ ...DOC, entry_id: 'je_other' }]), null, '憑證已改連到別張分錄');
  assert.equal(sourceDocumentOf(ENTRY, [{ ...DOC, status: 'reviewed', entry_id: null }]), null, '憑證已取消入帳');
  assert.equal(sourceDocumentOf({ ...ENTRY, source: 'manual' }, [DOC]), null, '手動分錄');
  assert.equal(sourceDocumentOf(null, [DOC]), null);
});

test('docedit: 沒改任何東西時，重新產生的分錄與入帳時相同', () => {
  const r = applyDocEdit(DOC, { rows: rowsOf(DOC) }, OPTS);
  assert.deepEqual(r.errors, []);
  assert.ok(sameLines(r.journal.lines, ENTRY.lines));
  assert.deepEqual(r.changes, []);
  assert.equal(r.journal.description, ENTRY.description);
});

test('docedit: 扣抵代號 1→3 稅額併入費用；3→1 稅額回到進項稅額 1261', () => {
  const to3 = applyDocEdit(DOC, { rows: rowsOf(DOC, [{ ded_code: '3' }]) }, OPTS);
  assert.deepEqual(to3.errors, []);
  assert.deepEqual(lines(to3.journal), [['1211', 1050, 0], ['2134', 0, 1050]]);
  assert.equal(to3.doc.ded_code, '3');
  assert.equal(to3.doc.deductible, false);
  assert.equal(to3.doc.tax_amount, 50, '發票上的稅額保留，只是不扣抵');
  assert.deepEqual(validateEntry({ ...ENTRY, lines: to3.journal.lines }, accMap), []);
  assert.deepEqual(to3.changes, ['扣抵代號 1 → 3']);
  const back = applyDocEdit(to3.doc, { rows: rowsOf(to3.doc, [{ ded_code: '1' }]) }, OPTS);
  assert.deepEqual(back.errors, []);
  assert.deepEqual(lines(back.journal), [['1211', 1000, 0], ['1261', 50, 0], ['2134', 0, 1050]]);
  assert.equal(back.doc.deductible, true);
  // 401 進項清單讀憑證：代號跟著變
  const item = (d) => inputItems([d], [])[0];
  const i3 = item(to3.doc);
  assert.equal(i3.ded_code, '3');
  assert.equal(deductibility(i3, OPTS).ok, false);
  const i1 = item(back.doc);
  assert.equal(i1.ded_code, '1');
  assert.equal(deductibility(i1, OPTS).ok, true);
});

test('docedit: 拆成兩行不同科目（一張可扣抵、一張交際費不可扣抵）', () => {
  const rows = [
    { invoice_no: 'JE11120001', account: '1211', amount: '600', tax: '30', tax_type: '1', ded_code: '1', memo: '咖啡豆' },
    { invoice_no: 'je-11120002', account: '6120', amount: '450', tax: '20', tax_type: '1', ded_code: '3', memo: '招待禮盒' },
    { invoice_no: '', account: '', amount: '', tax: '', tax_type: '1', ded_code: '1', memo: '' }, // 空白列略過
  ];
  const r = applyDocEdit(DOC, { rows }, OPTS);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(lines(r.journal), [['1211', 570, 0], ['6120', 450, 0], ['1261', 30, 0], ['2134', 0, 1050]]);
  assert.match(r.journal.description, /JE11120001\+JE11120002/);
  assert.equal(r.doc.lines.length, 2);
  assert.deepEqual(r.doc.lines.map((p) => [p.invoice_no, p.deductible, p.ded_code]), [['JE11120001', true, '1'], ['JE11120002', false, '3']]);
  assert.equal(r.doc.tax_amount, 50);
  assert.equal(r.doc.invoice_no, 'JE11120001');
  assert.equal(r.doc.account, '1211', '憑證主科目保留（入帳檢查要用）');
  assert.ok(r.changes.includes('拆分明細 1 行 → 2 行'));
  const items = inputItems([r.doc], []);
  assert.deepEqual(items.map((x) => [x.invoice_no, x.tax, x.ded_code, deductibility(x, OPTS).ok]), [['JE11120001', 30, '1', true], ['JE11120002', 20, '3', false]]);
  assert.deepEqual(items.map((x) => x.id), ['doc_t1:0', 'doc_t1:1']);
  // 再改回一行：拆分取消
  const one = applyDocEdit(r.doc, { rows: [{ invoice_no: 'JE11120001', account: '1211', amount: 1050, tax: 50, tax_type: '1', ded_code: '1', memo: '咖啡豆禮盒' }] }, OPTS);
  assert.deepEqual(one.errors, []);
  assert.equal(one.doc.lines, null);
  assert.deepEqual(lines(one.journal), [['1211', 1000, 0], ['1261', 50, 0], ['2134', 0, 1050]]);
  assert.ok(one.changes.some((c) => c.startsWith('取消拆分')));
});

test('docedit: 存檔前的檢查（合計、代號衝突、撞號、電子發票號碼、科目）', () => {
  const err = (rows, opts = OPTS, doc = DOC) => applyDocEdit(doc, { rows }, opts).errors.join('｜');
  const base = { invoice_no: 'JE11120001', account: '1211', amount: 1050, tax: 50, tax_type: '1', ded_code: '1', memo: '' };
  assert.match(err([{ ...base, amount: 1000 }]), /明細合計 1000 與憑證金額 1050 不符/);
  assert.match(err([{ ...base, invoice_no: '' }]), /扣抵代號 1 是「可扣抵」，但沒有統一發票號碼/);
  assert.match(err([{ ...base, tax: '' }]), /未載明稅額/);
  assert.match(err([{ ...base, tax_type: '3' }]), /課稅別 3（免稅）/);
  assert.match(err([{ ...base, account: '1511', ded_code: '2', invoice_no: '' }]), /改成 4/);
  assert.equal(err([{ ...base, invoice_no: '', tax: '', ded_code: '3' }]), '', '收據：代號 3 沒問題');
  assert.match(err([{ ...base, invoice_no: 'AB123' }]), /格式不對/);
  assert.match(err([{ ...base, account: '9999' }]), /9999 不存在/);
  assert.match(err([{ ...base, account: '' }]), /沒有會計項目/);
  assert.match(err([{ ...base, tax: 2000 }]), /稅額 2000 不合理/);
  assert.match(err([]), /至少要有一行/);
  const taken = { ...OPTS, takenInvoiceNos: new Set(['ZZ00000009', 'JE11120001']) };
  assert.match(err([{ ...base, invoice_no: 'ZZ00000009' }], taken), /已經由別張憑證入帳/);
  assert.equal(err([base], taken), '', '原本就是這個號碼的不擋（舊資料）');
  assert.match(err([{ ...base, invoice_no: 'JE11120003' }], { ...OPTS, linkedInvoiceNo: 'JE11120001' }), /連著電子發票 JE11120001/);
  // 非一般稅額營業人：不能選可扣抵
  assert.match(err([base], { ...OPTS, vatMode: 'small' }), /非一般稅額營業人/);
});

test('docedit: 代號沒填的舊憑證帶入自動判斷；可否扣抵由扣抵代號決定', () => {
  const legacy = { ...DOC, tax_type: '', ded_code: '' };
  assert.deepEqual(docEditRows(legacy, OPTS).map((r) => [r.tax_type, r.ded_code]), [['1', '1']]);
  const receipt = { ...DOC, invoice_no: null, tax_amount: null, tax_type: '', ded_code: '', deductible: false };
  assert.deepEqual(docEditRows(receipt, OPTS).map((r) => [r.tax_type, r.ded_code, r.memo]), [['1', '3', '咖啡豆禮盒']]);
  // 交際費：沒指定代號依規則不可扣抵；老闆指定 1 時以代號為準（與入帳、401 相同）
  const treat = { ...DOC, account: '6120', ded_code: '' };
  assert.equal(checkRow(treat, { ...docEditRows(treat, OPTS)[0], ded_code: '' }, OPTS).ok, false);
  assert.equal(checkRow(treat, { ...docEditRows(treat, OPTS)[0], ded_code: '1' }, OPTS).ok, true);
  // 原本勾「不可扣抵」的憑證，改代號 1 → 可扣抵（不再被舊的勾選卡住）
  const was3 = { ...DOC, deductible: false, ded_code: '3' };
  assert.equal(applyDocEdit(was3, { rows: rowsOf(was3, [{ ded_code: '1' }]) }, OPTS).doc.deductible, true);
  assert.ok(isBlankRow({ invoice_no: ' ', account: '', amount: '', tax: '', memo: '' }));
  assert.ok(!isBlankRow({ amount: '10' }));
  assert.deepEqual(taxCodes({ account: '1511', tax: 10, buyer_tax_id: '1' }, true), { tax_type: '1', ded_code: '2' });
});

test('docedit: 已申報 401 的期別要提醒（不自動改申報紀錄）', () => {
  const after = { ...DOC, doc_date: '2026-11-02' };
  assert.deepEqual(filedPeriodsFor([DOC, after], [{ id: '2026-09', status: 'draft' }]), []);
  assert.deepEqual(filedPeriodsFor([DOC, after], [{ id: '2026-09', status: 'filed', filed_on: '2026-11-10' }]).map((f) => [f.id, f.label, f.filed_on]), [['2026-09', '115 年 9–10 月', '2026-11-10']]);
  assert.deepEqual(filedPeriodsFor([DOC, after], [{ id: '2026-11', status: 'paid' }]).map((f) => f.id), ['2026-11'], '日期改到已申報的期別');
  assert.deepEqual(filedPeriodsFor([DOC], [{ id: '2026-07', status: 'filed', claimed: ['doc_t1:1'] }]).map((f) => f.id), ['2026-07'], '扣抵清單列了這張');
  assert.deepEqual(filedPeriodsFor([DOC], [{ id: '2026-07', status: 'filed', filed_inputs: [{ invoice_no: 'JE11120001' }] }]).map((f) => f.id), ['2026-07'], '媒體檔列了這張發票');
  assert.deepEqual(filedPeriodsFor([DOC], [{ id: '2026-07', status: 'filed', claimed: ['doc_t10'] }]), [], '別張憑證');
  // 401 歸屬期別：已申報期別的扣抵清單沒有這張 → 延到下一個未申報期別
  const late = assignPeriods(inputItems([DOC], []), [{ id: '2026-09', status: 'filed', claimed: [] }]);
  assert.equal(late[0].period, '2026-11');
});

test('docedit: 固定資產成本跟著扣抵改（代號 2 未稅、4 含稅）', () => {
  const machine = { ...DOC, account: '1511', amount_total: 105000, tax_amount: 5000, ded_code: '2' };
  assert.deepEqual(assetGroups(machine).get('1511'), { cost: 100000, tax: 5000, invoices: ['JE11120001'] });
  const r = applyDocEdit(machine, { rows: rowsOf(machine, [{ ded_code: '4' }]) }, OPTS);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(lines(r.journal), [['1511', 105000, 0], ['2134', 0, 105000]]);
  assert.deepEqual(assetGroups(r.doc).get('1511'), { cost: 105000, tax: 0, invoices: ['JE11120001'] });
  assert.equal(assetGroups({ ...DOC }).size, 0);
});

test('docedit: 修改紀錄、付款方式與日期', () => {
  const r = applyDocEdit(DOC, { rows: rowsOf(DOC, [{ memo: '咖啡豆 2kg', account: '1213' }]), pay_account: '1101', date: '2026-09-26' }, OPTS);
  assert.deepEqual(r.errors, []);
  assert.equal(r.doc.summary, '咖啡豆 2kg');
  assert.equal(r.doc.pay_account, '1101');
  assert.equal(r.doc.doc_date, '2026-09-26');
  assert.equal(r.journal.date, '2026-09-26');
  assert.deepEqual(lines(r.journal), [['1213', 1000, 0], ['1261', 50, 0], ['1101', 0, 1050]]);
  assert.deepEqual(describeChanges(DOC, r.doc, OPTS), ['會計項目 1211 → 1213', '摘要 咖啡豆禮盒 → 咖啡豆 2kg', '付款方式 2134 → 1101', '日期 2026-09-25 → 2026-09-26']);
  assert.ok(sameLines([{ account: 'a', debit: 1, credit: 0, memo: 'x' }], [{ account: 'a', debit: 1, credit: 0, memo: 'y' }]));
  assert.ok(!sameLines([{ account: 'a', debit: 1, credit: 0 }], [{ account: 'a', debit: 2, credit: 0 }]));
});
