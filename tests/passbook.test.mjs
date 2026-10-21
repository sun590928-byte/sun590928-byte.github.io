// 存摺照片辨識結果解析與帳鏈核對（全為合成資料）
import test from 'node:test';
import assert from 'node:assert/strict';
import { moneyCandidates, parsePassbookText, verifyChain, toBankLine, alreadyImported, suggestBankAccount, bankHistory } from '../erp/js/lib/passbook.js';

test('存摺金額：各種讀錯的寫法都列出正確候選值', () => {
  assert.deepEqual(moneyCandidates('*28,797.00'), [28797]);
  assert.deepEqual(moneyCandidates('*346,661.p0'), [346661], '.00 被讀成 .p0');
  assert.ok(moneyCandidates('262000').includes(2620), '.00 黏在後面');
  assert.ok(moneyCandidates('x442183.000').includes(442183), '.000');
  assert.ok(moneyCandidates('425.769.0017.').includes(425769), '小數點後多出雜訊、千分位寫成點');
  assert.ok(moneyCandidates('16.596').includes(16596), '千分位寫成點、沒讀到小數');
  assert.deepEqual(moneyCandidates('*310,667.60'), [310667], '.00 讀成 .60');
});

// 合成存摺內頁（照片辨識後的樣子：有雜訊、有讀錯的數字、有手寫註記、有一列結存沒讀到）
const PAGE1 = `日 期 摘 要 支出金額 存入金額 結存金額 備註
帳號:9999999-11-0000001 *100,000.00 本數:0
1150901網銀1150831 *2,500.00 (8月代墊) *97,500.00 營業部 46
1150901電匯 (綠界科技股) *1,989.00 x99,489.0O 9/1
1150902現金 (0901銷) 3,275.00 wITLASLOO
150903現金 (0902銷) *1,590.00 *104,354.00 水碓分
1150903網銀 x5,000.00 (房租) *99,354.00
*435.00
1150904現金 (0903銷) *855.00 *100,644.00
代收票據明細表 受託日 票據號碼`;

test('存摺照片：逐列解析並用結存核對（讀錯的金額、沒讀到的結存都能補回）', () => {
  const page = parsePassbookText(PAGE1, { year: 2026, from: '2026-09-01', to: '2026-09-04' });
  assert.deepEqual(page.opening, [100000], '表頭承前頁結存（帳號不當金額）');
  const rows = verifyChain([page]);
  const brief = rows.map((r) => [r.status, r.date, r.withdrawal || -r.deposit, r.balance]);
  assert.deepEqual(brief, [
    ['ok', '2026-09-01', 2500, 97500],
    ['ok', '2026-09-01', -1989, 99489],
    ['corrected', '2026-09-02', -3275, 102764],
    ['ok', '2026-09-03', -1590, 104354],
    ['ok', '2026-09-03', 5000, 99354],
    ['corrected', '2026-09-03', -435, 99789],
    ['ok', '2026-09-04', -855, 100644],
  ]);
  assert.equal(rows[0].summary, '網銀（8月代墊）');
  assert.equal(rows[3].memo, '0902銷');
  assert.match(rows[5].note, /日期沒讀到/);
});

test('存摺照片：對不上的列標「需確認」；下一張照片重印的列標重複', () => {
  const p1 = parsePassbookText(`帳號:9999999-11-0000001 *50,000.00 本數:0
1150910現金 (0909銷) *1,000.00 *51,000.00
1150911網銀 *2,000.00 (7月薪資) *49,000.00`, { year: 2026 });
  // 第二張：承前頁 49,000；重印上一頁最後一列；接著一列金額、結存都讀錯（實際 3,333／52,333）
  const p2 = parsePassbookText(`帳號:9999999-11-0000001 *49,000.00 本數:0
1150911網銀 *2,000.00 (7月薪資) *49,000.00
1150912電匯 (綠界科技股) *3,383.00 *52,833.00
1150912現金 (0911銷) *1,111.00 *53,444.00
1150913現金 (0912銷) *2,000.00 *55,444.00`, { year: 2026 });
  const rows = verifyChain([p1, p2]);
  assert.deepEqual(
    rows.map((r) => r.status),
    ['ok', 'ok', 'duplicate', 'check', 'check', 'ok'],
  );
  assert.equal(rows[3].page, 1);
  assert.match(rows[3].note, /對不上/);
});

test('存摺明細列：匯入格式、重複偵測、補登建議科目', () => {
  const r = { date: '2026-09-02', summary: '現金（0901銷）', memo: '0901銷', withdrawal: 0, deposit: 3275, balance: 102764 };
  const b = toBankLine(r, { bankAccountId: 'main', batchId: 'b1' });
  assert.equal(b.id, toBankLine({ ...r }, { bankAccountId: 'main' }).id, 'id 固定，重複匯入可辨識');
  assert.equal(b.description, '現金（0901銷）');
  assert.ok(alreadyImported(r, [b]));
  assert.ok(!alreadyImported({ ...r, balance: 1 }, [b]));
  assert.equal(suggestBankAccount(b).account, '1101', '門市現金營收存入');
  assert.equal(suggestBankAccount({ description: '電匯（綠界科技股）', deposit: 1989 }).account, '1111');
  assert.equal(suggestBankAccount({ description: '網銀（8月代墊）', withdrawal: 2500 }).account, '2134');
  assert.equal(suggestBankAccount({ description: '網銀（7月薪資）', withdrawal: 2000 }).account, '6101');
  assert.equal(suggestBankAccount({ description: '現金（會計零用金）', withdrawal: 5000 }).account, '1102');
  assert.equal(suggestBankAccount({ description: '網銀', withdrawal: 123 }).account, '1291', '用途不明先記暫付款');
  const hist = bankHistory([{ source: 'bank', description: '網銀（房東）', lines: [{ account: '6111', debit: 35000 }, { account: '1103', credit: 35000 }] }], '1103');
  assert.equal(suggestBankAccount({ description: '網銀（房東）', withdrawal: 35000 }, hist).account, '6111', '以前補登過的照舊');
});
