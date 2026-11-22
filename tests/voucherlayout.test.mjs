// 11/20 需求 10：傳票列印每張固定半張 A4，一頁上下兩張；分錄太多的單獨一整頁（排法固定）
import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutVoucherSheets, voucherSize, HALF_MAX_LINES } from '../erp/js/lib/voucherlayout.js';

const v = (id, n) => ({ id, lines: Array.from({ length: n }, () => ({ account: '6112', debit: 1, credit: 0 })) });
const shape = (sheets) => sheets.map((s) => `${s.kind}:${s.items.map((e) => e.id).join('+')}`);

test('半頁行數上限：上限內印半頁、超過印整頁', () => {
  assert.equal(voucherSize(v('a', HALF_MAX_LINES)), 'half');
  assert.equal(voucherSize(v('b', HALF_MAX_LINES + 1)), 'full');
  assert.equal(voucherSize(v('c', 2), { forceFull: new Set(['c']) }), 'full', '畫面量到放不下的改整頁');
  assert.equal(voucherSize({ id: 'd' }), 'half', '沒有分錄行也不出錯');
});

test('依序兩張一頁；整頁傳票前落單的半頁自己一頁，之後重新從上半頁排', () => {
  assert.deepEqual(shape(layoutVoucherSheets([v('1', 2), v('2', 3), v('3', 4)])), ['half:1+2', 'half:3']);
  assert.deepEqual(shape(layoutVoucherSheets([v('1', 3), v('2', 30), v('3', 2), v('4', HALF_MAX_LINES), v('5', HALF_MAX_LINES + 1), v('6', 4)])), ['half:1', 'full:2', 'half:3+4', 'full:5', 'half:6']);
  assert.deepEqual(shape(layoutVoucherSheets([v('1', 40), v('2', 40)])), ['full:1', 'full:2']);
  assert.deepEqual(shape(layoutVoucherSheets([v('1', 2), v('2', 2)], { forceFull: new Set(['1']) })), ['full:1', 'half:2']);
  assert.deepEqual(layoutVoucherSheets([]), []);
});
