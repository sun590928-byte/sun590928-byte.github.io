// 11/20 需求 1、2、6：日記簿修改保留付款科目與手續費、固定資產連結現有資產（避免重複）、合併憑證每一行自己的日期（全為合成資料）
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ACCOUNTS, accountMap } from '../erp/js/lib/coa.js';
import { validateEntry } from '../erp/js/lib/ledger.js';
import { documentJournal, depreciationJournal, mergeGenerated } from '../erp/js/lib/autojournal.js';
import { applyDocEdit, docEditRows, describeChanges, sameLines, keepEntryLines, entryPayAccount, isYmd } from '../erp/js/lib/docedit.js';
import { assetMatches, linkModeOf, hasAssetAccount, docAssetParts, docInvoiceNos, assetInvoiceNos, depreciationForMonth } from '../erp/js/lib/assets.js';

const accMap = accountMap(DEFAULT_ACCOUNTS);
const OPTS = { taxId: '12345675', vatMode: 'general', payAccount: '2134', accounts: new Set(DEFAULT_ACCOUNTS.map((a) => a.code)) };
const sig = (ls) => ls.map((l) => [l.account, l.debit, l.credit]);
const L = (account, debit, credit = 0, memo = '') => ({ account, debit, credit, memo });
const rowsOf = (doc, patch = []) => docEditRows(doc, OPTS).map((r, i) => ({ ...r, ...(patch[i] || {}) }));

// 例 1（濾水設備）：憑證的付款方式還是預設的零用金 1102，傳票後來改成銀行存款 1103（銀行付款）
const RO = { id: 'doc_zz_ro', status: 'posted', entry_id: 'je_zz_ro', doc_date: '2026-11-10', vendor_name: '測試淨水行', summary: '純水機濾心', invoice_no: 'ZR11200001', amount_total: 2100, tax_amount: 100, account: '6116', pay_account: '1102', deductible: true, tax_type: '1', ded_code: '1' };
const RO_LINES = [L('6116', 2000, 0, '純水機濾心'), L('1261', 100, 0, '進項稅額'), L('1103', 0, 2100, '銀行轉帳')];
// 例 2（銀行付款加匯費）：銀行付款另付匯費 30，傳票多一行手續費 6131
const BW = { id: 'doc_zz_bw', status: 'posted', entry_id: 'je_zz_bw', doc_date: '2026-11-12', vendor_name: '測試糖漿行', summary: '糖漿 3 瓶', invoice_no: 'ZB11200001', amount_total: 1575, tax_amount: 75, account: '1217', pay_account: '2134', deductible: true, tax_type: '1', ded_code: '1' };
const BW_LINES = [L('1217', 1500, 0, '糖漿 3 瓶'), L('1261', 75, 0, '進項稅額'), L('6131', 30, 0, '匯費'), L('1103', 0, 1605, '')];

test('11/20-1 傳票的付款方式：貸方金額最大的那一行', () => {
  assert.equal(entryPayAccount(RO_LINES), '1103');
  assert.equal(entryPayAccount([L('6116', 2100), L('1103', 0, 1500), L('1102', 0, 600)]), '1103');
  assert.equal(entryPayAccount([L('6116', 10)]), '');
  assert.equal(entryPayAccount([]), '');
});

test('11/20-1 例 1：重新產生分錄保留原本的付款科目 1103，不換成憑證預設的 1102', () => {
  // 舊行為（沒給傳票的行）：付款科目被換成憑證的 1102 → 這就是老闆遇到的問題
  const before = applyDocEdit(RO, { rows: rowsOf(RO) }, OPTS);
  assert.deepEqual(sig(before.journal.lines).at(-1), ['1102', 0, 2100]);
  // 新：照傳票原本的 1103
  const r = applyDocEdit(RO, { rows: rowsOf(RO) }, { ...OPTS, entryLines: RO_LINES });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(sig(r.journal.lines), [['6116', 2000, 0], ['1261', 100, 0], ['1103', 0, 2100]]);
  assert.ok(sameLines(r.journal.lines, RO_LINES), '沒改東西時分錄和原本一樣');
  assert.equal(r.journal.lines[2].memo, '銀行轉帳', '付款行的說明也保留');
  assert.equal(r.doc.pay_account, '1103', '憑證的付款方式改成跟傳票一致');
  assert.ok(r.changes.includes('付款方式 1102 → 1103'));
  assert.deepEqual(r.keep.kept, [2]);
  // 改扣抵代號 1 → 3：費用含稅、付款科目仍是 1103
  const r3 = applyDocEdit(RO, { rows: rowsOf(RO, [{ ded_code: '3' }]) }, { ...OPTS, entryLines: RO_LINES });
  assert.deepEqual(sig(r3.journal.lines), [['6116', 2100, 0], ['1103', 0, 2100]]);
  assert.deepEqual(validateEntry({ date: RO.doc_date, lines: r3.journal.lines }, accMap), []);
  // 使用者在視窗把付款方式改成 1101：才換
  const r1 = applyDocEdit(RO, { rows: rowsOf(RO), pay_account: '1101' }, { ...OPTS, entryLines: RO_LINES });
  assert.deepEqual(sig(r1.journal.lines).at(-1), ['1101', 0, 2100]);
  assert.equal(r1.doc.pay_account, '1101');
});

test('11/20-1 例 2：手續費 30 那一行保留，付款金額照原本（借貸平衡）', () => {
  const same = applyDocEdit(BW, { rows: rowsOf(BW) }, { ...OPTS, entryLines: BW_LINES });
  assert.deepEqual(same.errors, []);
  assert.deepEqual(sig(same.journal.lines), [['1217', 1500, 0], ['1261', 75, 0], ['6131', 30, 0], ['1103', 0, 1605]]);
  assert.ok(sameLines(same.journal.lines, BW_LINES));
  assert.deepEqual(same.keep.kept, [2, 3], '手續費與付款行標「保留原傳票」');
  assert.equal(same.journal.lines[2].memo, '匯費');
  // 拆成兩行（糖漿 1050＋甜點原料 525）：費用重算，手續費與付款行不變
  const split = applyDocEdit(
    BW,
    {
      rows: [
        { invoice_no: 'ZB11200001', account: '1217', amount: 1050, tax: 50, tax_type: '1', ded_code: '1', memo: '糖漿 2 瓶' },
        { invoice_no: 'ZB11200002', account: '1214', amount: 525, tax: 25, tax_type: '1', ded_code: '1', memo: '果泥' },
      ],
    },
    { ...OPTS, entryLines: BW_LINES },
  );
  assert.deepEqual(split.errors, []);
  assert.deepEqual(sig(split.journal.lines), [['1217', 1000, 0], ['1214', 500, 0], ['1261', 75, 0], ['6131', 30, 0], ['1103', 0, 1605]]);
  assert.deepEqual(validateEntry({ date: BW.doc_date, lines: split.journal.lines }, accMap), []);
  // 扣抵代號改 3：稅額併入費用，手續費仍在
  const r3 = applyDocEdit(BW, { rows: rowsOf(BW, [{ ded_code: '3' }]) }, { ...OPTS, entryLines: BW_LINES });
  assert.deepEqual(sig(r3.journal.lines), [['1217', 1575, 0], ['6131', 30, 0], ['1103', 0, 1605]]);
  assert.deepEqual(validateEntry({ date: BW.doc_date, lines: r3.journal.lines }, accMap), []);
});

test('11/20-1 付款行有兩行、金額要調整、傳票以前手動改過', () => {
  // 兩個付款來源：金額最大的那一行是主要付款方式，金額不變就原樣保留
  const two = [L('6116', 2000), L('1261', 100), L('1103', 0, 1500), L('1102', 0, 600)];
  const r = applyDocEdit(RO, { rows: rowsOf(RO) }, { ...OPTS, entryLines: two });
  assert.deepEqual(sig(r.journal.lines), [['6116', 2000, 0], ['1261', 100, 0], ['1103', 0, 1500], ['1102', 0, 600]]);
  // 重新產生的費用變多（直接呼叫）：主要付款行補差額
  const k = keepEntryLines([L('6116', 1100), L('2134', 0, 1100)], [L('6116', 1000), L('6131', 30), L('1103', 0, 1030)], { docAccounts: new Set(['6116']), oldTotal: 1000 });
  assert.deepEqual(sig(k.lines), [['6116', 1100, 0], ['6131', 30, 0], ['1103', 0, 1130]]);
  // 調整後變 0 以下：併成一行
  const k2 = keepEntryLines([L('6116', 1000), L('2134', 0, 1000)], [L('6116', 1000), L('1103', 0, 980), L('1102', 0, 20)], { docAccounts: new Set(['6116']), oldTotal: 1000 });
  assert.deepEqual(sig(k2.lines), [['6116', 1000, 0], ['1103', 0, 980], ['1102', 0, 20]]);
  // 以前手動把費用科目改成 6112：分不出哪一行是手續費 → 額外的行不保留，列出來提醒；付款科目仍保留
  const drift = [L('6112', 2000), L('1261', 100), L('1103', 0, 2100)];
  const d = applyDocEdit(RO, { rows: rowsOf(RO) }, { ...OPTS, entryLines: drift });
  assert.deepEqual(sig(d.journal.lines), [['6116', 2000, 0], ['1261', 100, 0], ['1103', 0, 2100]]);
  assert.deepEqual(sig(d.keep.dropped), [['6112', 2000, 0]]);
  assert.equal(d.keep.mismatch, -2000);
  assert.deepEqual(validateEntry({ date: RO.doc_date, lines: d.journal.lines }, accMap), []);
  // 沒有貸方的怪傳票：照憑證產生
  const none = keepEntryLines([L('6116', 1000), L('2134', 0, 1000)], [L('6116', 1000)], { docAccounts: new Set(['6116']), oldTotal: 1000 });
  assert.deepEqual(sig(none.lines), [['6116', 1000, 0], ['2134', 0, 1000]]);
});

test('11/20-6 合併憑證每一行自己的日期：存在 doc.lines[i].date，分錄日期不變', () => {
  const rows = [
    { invoice_no: 'ZB11200001', account: '1217', amount: 1050, tax: 50, tax_type: '1', ded_code: '1', memo: '糖漿', date: '' },
    { invoice_no: 'DC00000001', account: '6133', amount: 525, tax: 25, tax_type: '1', ded_code: '1', memo: '小碟', date: '2026-08-25' },
  ];
  const r = applyDocEdit(BW, { rows }, { ...OPTS, entryLines: BW_LINES });
  assert.deepEqual(r.errors, []);
  assert.equal(r.doc.lines[1].date, '2026-08-25');
  assert.ok(!('date' in r.doc.lines[0]), '空白＝憑證日期，不存欄位');
  assert.equal(r.doc.doc_date, BW.doc_date);
  assert.equal(r.journal.date, BW.doc_date, '傳票日期不變');
  // documentJournal 不看行日期
  const noDate = { ...r.doc, lines: r.doc.lines.map(({ date, ...p }) => p) };
  assert.deepEqual(documentJournal(r.doc, { deductible: true }), documentJournal(noDate, { deductible: true }));
  // 再打開：帶出這一行的日期；修改紀錄寫出來
  assert.deepEqual(docEditRows(r.doc, OPTS).map((x) => x.date), ['', '2026-08-25']);
  assert.ok(r.changes.includes('新增第 2 行：6133 525（稅 25） 扣抵代號 1 日期 2026-08-25'), r.changes.join('｜'));
  const again = applyDocEdit(r.doc, { rows: docEditRows(r.doc, OPTS) }, OPTS);
  assert.equal(again.doc.lines[1].date, '2026-08-25', '再存一次日期還在');
  assert.deepEqual(again.changes, []);
  const moved = applyDocEdit(r.doc, { rows: docEditRows(r.doc, OPTS).map((x, i) => (i === 0 ? { ...x, date: '2026-11-01' } : { ...x, date: '' })) }, OPTS);
  assert.deepEqual(moved.changes, ['第 1 行日期 （空白） → 2026-11-01', '第 2 行日期 2026-08-25 → （空白）']);
  assert.ok(!('date' in moved.doc.lines[1]));
  // 格式檢查
  const err = (date, rs = rows) => applyDocEdit(BW, { rows: rs.map((x, i) => (i === 1 ? { ...x, date } : x)) }, OPTS).errors.join('｜');
  assert.match(err('2026-02-30'), /第 2 行日期 2026-02-30 格式不對/);
  assert.match(err('2026/08/25'), /格式不對/);
  assert.equal(err('2026-08-25'), '');
  // 只有一行時不用填（要改日期改上面的日期）
  const one = [{ ...rows[0], amount: 1575, tax: 75, date: '2026-08-01' }];
  assert.match(applyDocEdit(BW, { rows: one }, OPTS).errors.join('｜'), /只有一行時不用填這一行的日期/);
  assert.deepEqual(applyDocEdit(BW, { rows: [{ ...one[0], date: BW.doc_date }] }, OPTS).errors, []);
  assert.ok(isYmd('2028-02-29') && !isYmd('2026-13-01') && !isYmd('') && !isYmd('20260825'));
});

// 例：磨豆機（測試）先在「固定資產」登錄，之後憑證歸檔又入帳同一張發票
const GRINDER = { id: 'fa_zz_grinder', name: '磨豆機（測試）', category: 'machine', acquired_on: '2026-09-03', cost: 100000, tax_amount: 5000, supplier: '測試器材有限公司', invoice_no: 'ZS11200001', doc_ids: [], purchase_entry_id: null };
const INVOICE = { id: 'doc_zz_grinder', status: 'reviewed', doc_date: '2026-09-05', vendor_name: '測試器材', invoice_no: 'ZS11200001', amount_total: 105000, tax_amount: 5000, account: '1511', deductible: true, pay_account: '1103' };

test('11/20-2 固定資產發票：發票號碼相同、廠商＋金額相近 → 可能重複', () => {
  assert.ok(hasAssetAccount(INVOICE) && !hasAssetAccount({ ...INVOICE, account: '6135' }));
  assert.ok(hasAssetAccount({ ...INVOICE, account: '', lines: [{ account: '6133', amount: 5000 }, { account: '1521', amount: 100000 }] }));
  assert.deepEqual(docAssetParts(INVOICE), { cost: 100000, tax: 5000, gross: 105000, accounts: ['1511'] });
  assert.deepEqual(docInvoiceNos({ invoice_no: 'zs-11200001', lines: [{ invoice_no: 'ZS11200002' }] }), ['ZS11200001', 'ZS11200002']);
  assert.deepEqual(assetInvoiceNos({ invoice_no: 'ZS11200001+ZS11200002' }), ['ZS11200001', 'ZS11200002']);
  const other = { id: 'fa_zz_ice', name: '製冰機（測試）', category: 'equipment', acquired_on: '2026-09-04', cost: 30000, supplier: '另一家' };
  const m = assetMatches(INVOICE, [other, GRINDER]);
  assert.deepEqual(m.map((x) => [x.asset.id, x.reasons]), [['fa_zz_grinder', ['發票號碼相同（ZS11200001）']]]);
  // 沒有發票號碼：廠商（去掉「有限公司」）＋金額相同、日期差 2 天
  const noInv = assetMatches({ ...INVOICE, invoice_no: null }, [{ ...GRINDER, invoice_no: '' }]);
  assert.deepEqual(noInv.map((x) => x.reasons), [['廠商、金額相同，取得日期相差 2 天']]);
  assert.equal(noInv[0].strength, 1);
  // 差 30 天、已報廢、別家廠商：不算
  assert.deepEqual(assetMatches({ ...INVOICE, invoice_no: null, doc_date: '2026-10-05' }, [{ ...GRINDER, invoice_no: '' }]), []);
  assert.deepEqual(assetMatches(INVOICE, [{ ...GRINDER, disposed_on: '2026-10-01' }]), []);
  assert.deepEqual(assetMatches({ ...INVOICE, invoice_no: null }, [{ ...GRINDER, invoice_no: '', supplier: '完全不同' }]), []);
  // 資產沒填廠商：只看金額＋日期（較弱）
  assert.equal(assetMatches({ ...INVOICE, invoice_no: null }, [{ ...GRINDER, invoice_no: '', supplier: '' }])[0].strength, 0.5);
  // 已附在資產上
  assert.equal(assetMatches(INVOICE, [{ ...GRINDER, doc_ids: [INVOICE.id] }])[0].strength, 3);
});

test('11/20-2 連結現有資產時怎麼入帳：沒有購置分錄→入帳當購置分錄；已記了這張→只連結；看不出來→問', () => {
  assert.equal(linkModeOf(GRINDER, INVOICE, []), 'post');
  const pe = { id: 'je_zz_pe', date: '2026-09-03', description: '購置｜磨豆機（測試）｜ZS11200001', attachments: [] };
  assert.equal(linkModeOf({ ...GRINDER, purchase_entry_id: 'je_zz_pe' }, INVOICE, [pe]), 'link');
  assert.equal(linkModeOf({ ...GRINDER, purchase_entry_id: 'je_zz_pe', invoice_no: '' }, INVOICE, [{ ...pe, description: '購置' }]), 'ask');
  assert.equal(linkModeOf({ ...GRINDER, purchase_entry_id: 'je_zz_pe', invoice_no: '' }, INVOICE, [{ ...pe, description: '購置', attachments: [INVOICE.id] }]), 'link');
  assert.equal(linkModeOf({ ...GRINDER, purchase_entry_id: 'je_gone' }, INVOICE, [pe]), 'post', '購置分錄已刪除');
});

test('11/20-2 重複的資產刪掉後：已結帳鎖定的 9、10 月折舊不動，只有 11 月起重算（所以要手動做 11 月調整分錄）', () => {
  const dup = { ...GRINDER, id: 'fa_zz_dup', note: '入帳時自動建立', acquired_on: '2026-09-05' };
  const months = ['2026-09', '2026-10', '2026-11'];
  const gen = (assets) => months.map((ym) => depreciationJournal(ym, depreciationForMonth(assets, ym))).filter(Boolean);
  assert.equal(depreciationForMonth([GRINDER], '2026-09')[0].amount, 1389, '100,000 元、5 年、殘值 1/6 → 每月 1,389');
  let n = 0;
  const first = mergeGenerated([], gen([GRINDER, dup]), { source: 'depreciation', makeId: () => `je_zz_d${++n}`, nextNo: () => 'X', scopeRefs: new Set(months) });
  const existing = first.upserts;
  assert.deepEqual(existing.map((e) => e.lines[0].debit), [2778, 2778, 2778], '重複時每月多提 1,389');
  const after = mergeGenerated(existing, gen([GRINDER]), { source: 'depreciation', lockedMonths: new Set(['2026-09', '2026-10']), makeId: () => 'je_new', nextNo: () => 'X', scopeRefs: new Set(months) });
  assert.equal(after.skippedLocked, 2);
  assert.deepEqual(after.removes, []);
  assert.deepEqual(after.upserts.map((e) => [e.source_ref, e.lines[0].debit]), [['2026-11', 1389]], '只有 11 月重算');
  // 只剩重複的那一項被刪、本來那項也沒了的月份：鎖定月份的分錄也不會被刪
  const gone = mergeGenerated(existing, [], { source: 'depreciation', lockedMonths: new Set(['2026-09', '2026-10']), makeId: () => 'je_new', nextNo: () => 'X', scopeRefs: new Set(months) });
  assert.deepEqual(gone.removes, [existing[2].id]);
});
