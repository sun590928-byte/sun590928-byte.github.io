// 單元測試：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodeBytes, parseCSV, toCSV, detectDelimiter } from '../erp/js/lib/csv.js';
import { readXlsx, serialToDate } from '../erp/js/lib/xlsx.js';
import { parseDateTime, monthEnd, addMonths, weekdayIndex, fmtROC } from '../erp/js/lib/dates.js';
import { parseAmount, allocate, fmt } from '../erp/js/lib/money.js';
import { dice, levRatio, compactKey } from '../erp/js/lib/text.js';
import { detectHeaderRow, autoMap, extract, guessTarget, headerSignature } from '../erp/js/lib/importer.js';
import { normalizeSales, detectVoid, normalizePayment, guessCategory, DEFAULT_VOID_RULES } from '../erp/js/lib/pos.js';
import { analyzeName, analyzeDuplicates } from '../erp/js/lib/dedupe.js';

const fx = (n) => new URL(`./fixtures/${n}`, import.meta.url);

test('csv: Big5 解碼、標題列、引號與換行', () => {
  const { text, encoding } = decodeBytes(readFileSync(fx('synthetic-pos-big5.csv')));
  assert.equal(encoding, 'big5');
  const rows = parseCSV(text);
  assert.match(rows[0][0], /銷售明細報表/);
  assert.deepEqual(rows[1].slice(0, 3), ['結帳時間', '訂單編號', '品項名稱']);
  const q = parseCSV('a,b\n"x, y","say ""hi""\nnext"\n="00123",3\n');
  assert.deepEqual(q[1], ['x, y', 'say "hi"\nnext']);
  assert.equal(q[2][0], '00123');
  assert.equal(detectDelimiter('a;b;c\n1;2;3'), ';');
  assert.equal(detectDelimiter('a\tb\n1\t2'), '\t');
  assert.ok(toCSV([['品項', 'x,y']]).startsWith('﻿品項,"x,y"'));
});

test('xlsx: 讀取工作表、共用字串、日期格式、公式快取', async () => {
  const sheets = await readXlsx(readFileSync(fx('sample-books.xlsx')));
  assert.deepEqual(sheets.map((s) => s.name), ['日記簿', '固定資產']);
  const rows = sheets[0].rows;
  assert.equal(rows[0][0], '午月會計系統（測試檔）');
  assert.deepEqual(rows[2].slice(0, 3), ['日期', '傳票號碼', '科目代號']);
  assert.equal(rows[3][0], '2026-08-21');
  assert.equal(rows[5][0], '2026-08-22 14:30');
  assert.equal(rows[5][6], '8月租金 & 管理費 <A>');
  assert.equal(sheets[1].rows[1][1], '2026-07-01');
  assert.equal(serialToDate(46255), '2026-08-21');
});

test('dates: 西元/民國/Excel 序號/上下午', () => {
  assert.deepEqual(parseDateTime('2026/08/21 14:35:12'), { date: '2026-08-21', time: '14:35' });
  assert.deepEqual(parseDateTime('115/08/21'), { date: '2026-08-21', time: null });
  assert.deepEqual(parseDateTime('1150821'), { date: '2026-08-21', time: null });
  assert.deepEqual(parseDateTime('20260821 0935'), { date: '2026-08-21', time: '09:35' });
  assert.deepEqual(parseDateTime('2026年8月21日 下午 02:05'), { date: '2026-08-21', time: '14:05' });
  assert.deepEqual(parseDateTime('46255.5'), { date: '2026-08-21', time: '12:00' });
  assert.equal(parseDateTime('2026/02/30'), null);
  assert.equal(parseDateTime('12345678'), null);
  assert.equal(monthEnd('2028-02'), '2028-02-29');
  assert.equal(addMonths('2026-11', 3), '2027-02');
  assert.equal(weekdayIndex('2026-09-21'), 0); // 週一
  assert.equal(fmtROC('2026-09-22'), '115/09/22');
});

test('money: 解析各式金額、最大餘數分配', () => {
  assert.equal(parseAmount('NT$1,234'), 1234);
  assert.equal(parseAmount('(1,234.50)'), -1234.5);
  assert.equal(parseAmount('－120'.normalize('NFKC')), -120);
  assert.equal(parseAmount('1,000元'), 1000);
  assert.equal(parseAmount('abc'), null);
  assert.deepEqual(allocate(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(allocate(-10, [1, 1]), [-5, -5]);
  assert.equal(fmt(1234.5), '1,234.50');
});

test('text: 相似度', () => {
  assert.equal(compactKey(' 冰 拿鐵 ( 大 ) '), '冰拿鐵大');
  assert.ok(dice('巴斯克乳酪蛋糕', '流星巴斯克') > 0.3);
  assert.ok(levRatio('美式', '美式咖啡') >= 0.5);
});

test('importer: 自動找表頭與欄位對應', () => {
  const { text } = decodeBytes(readFileSync(fx('synthetic-pos-big5.csv')));
  const rows = parseCSV(text);
  assert.equal(guessTarget(rows, '銷售明細.csv'), 'sales');
  const { index } = detectHeaderRow(rows, 'sales');
  assert.equal(index, 1);
  const m = autoMap(rows[index], 'sales');
  assert.equal(m.datetime, 0);
  assert.equal(m.order_no, 1);
  assert.equal(m.item, 2);
  assert.equal(m.option, 3);
  assert.equal(m.qty, 4);
  assert.equal(m.unit_price, 5);
  assert.equal(m.amount, 6);
  assert.equal(m.payment, 7);
  assert.equal(m.note, 8);
  assert.equal(m.member, 9);
  assert.equal(headerSignature(rows[index]), headerSignature([...rows[index]]));
  const ec = parseCSV(readFileSync(fx('synthetic-ecpay-tx.csv'), 'utf8').replace(/^﻿/, ''));
  assert.equal(guessTarget(ec, '綠界刷卡明細-20260801-20260922.csv'), 'ecpay_tx');
  assert.equal(guessTarget(ec, '綠界刷卡撥款明細-20260801-20260922.csv'), 'payouts');
  const em = autoMap(ec[0], 'ecpay_tx');
  assert.equal(em.order_no, 0);
  assert.equal(em.provider_no, 1);
  assert.equal(em.datetime, 2);
  assert.equal(em.amount, 3);
  assert.equal(em.fee, 4);
  assert.equal(em.payout_date, 6);
  const bank = [['交易日期', '摘要', '支出金額', '存入金額', '餘額', '備註']];
  const bm = autoMap(bank[0], 'bank');
  assert.deepEqual([bm.date, bm.description, bm.withdrawal, bm.deposit, bm.balance, bm.note], [0, 1, 2, 3, 4, 5]);
});

function loadSales() {
  const { text } = decodeBytes(readFileSync(fx('synthetic-pos-big5.csv')));
  const rows = parseCSV(text);
  const { index } = detectHeaderRow(rows, 'sales');
  const raw = extract(rows, index, autoMap(rows[index], 'sales'));
  return normalizeSales(raw, { batchId: 'b1' });
}

test('pos: 正規化、同單沿用日期付款、作廢規則、合計列略過', () => {
  const { lines, skipped } = loadSales();
  assert.ok(lines.length > 900);
  assert.ok(skipped.some((s) => s.reason === '合計列'));
  assert.ok(lines.every((l) => /^\d{4}-\d{2}-\d{2}$/.test(l.date)));
  const cont = lines.find((l) => l.order_no === 'A1001' && l.item_raw === '抹茶拿鐵');
  assert.equal(cont.date, '2026-08-10');
  assert.equal(cont.payment, 'cash');
  const treat = lines.filter((l) => l.note === '老闆招待');
  assert.ok(treat.length > 0);
  assert.ok(treat.every((l) => l.void_reason === 'boss_treat' && l.revenue === 0 && l.qty > 0));
  assert.ok(lines.filter((l) => l.note === '報廢').every((l) => l.void_reason === 'scrap'));
  const disc = lines.find((l) => l.item_raw === '整單折扣');
  assert.equal(disc.amount, -10);
  assert.equal(disc.is_adjustment, true);
  assert.equal(new Set(lines.map((l) => l.id)).size, lines.length, '行鍵唯一');
  const again = loadSales().lines;
  assert.deepEqual(again.map((l) => l.id), lines.map((l) => l.id), '重複匯入行鍵相同');
});

test('pos: 付款方式、品類、作廢偵測', () => {
  assert.equal(normalizePayment('LINE Pay'), 'linepay');
  assert.equal(normalizePayment('信用卡(綠界)'), 'card');
  assert.equal(normalizePayment('悠遊卡'), 'ecard');
  assert.equal(normalizePayment('寄杯扣抵'), 'prepaid');
  assert.equal(normalizePayment('現金'), 'cash');
  assert.equal(guessCategory('氣泡美式'), 'coffee');
  assert.equal(guessCategory('抹茶拿鐵'), 'non_coffee');
  assert.equal(guessCategory('拿鐵'), 'coffee');
  assert.equal(guessCategory('咖啡豆 花季 100g'), 'retail');
  assert.equal(guessCategory('咖啡巴斯克'), 'food');
  assert.equal(guessCategory('寄杯 美式10杯'), 'prepaid');
  assert.equal(detectVoid({ item_raw: '拿鐵', payment_raw: '老闆招待' }, DEFAULT_VOID_RULES).reason, 'boss_treat');
  assert.equal(detectVoid({ item_raw: '拿鐵', note: '取消' }, DEFAULT_VOID_RULES), null, '取消只看狀態欄');
  assert.equal(detectVoid({ item_raw: '拿鐵', status_raw: '已取消' }, DEFAULT_VOID_RULES).reason, 'pos_void');
});

test('dedupe: 名稱分析', () => {
  assert.deepEqual(analyzeName('冰美式咖啡').core, '美式');
  assert.deepEqual(analyzeName('冰美式咖啡').attrs.temp, '冰');
  assert.equal(analyzeName('拿鐵(冰)').core, '拿鐵');
  assert.equal(analyzeName('Latte').core, '拿鐵');
  assert.equal(analyzeName('Iced Americano').core, '美式');
  assert.equal(analyzeName('冰釀咖啡').core, '冷萃');
  assert.equal(analyzeName('冷萃冰釀').core, '冷萃', '同義詞替換後的重複詞收斂');
  assert.equal(analyzeName('冰滴咖啡').core, '冰滴');
  assert.equal(analyzeName('熱可可').attrs.temp, '熱');
  assert.equal(analyzeName('熱可可').core, '可可');
  assert.equal(analyzeName('拿鐵 大杯 少冰').core, '拿鐵');
});

test('dedupe: 找出改名的疑似同品項', () => {
  const { lines } = loadSales();
  const { clusters, names } = analyzeDuplicates(lines);
  const find = (a, b) => clusters.find((c) => c.members.some((m) => m.name === a) && c.members.some((m) => m.name === b));
  assert.ok(find('美式咖啡', '美式'), '美式咖啡 ↔ 美式');
  assert.ok(find('冰拿鐵', '拿鐵(冰)'), '冰拿鐵 ↔ 拿鐵(冰)');
  assert.ok(find('冰拿鐵', 'Latte'), '冰拿鐵 ↔ Latte');
  assert.ok(find('冰釀咖啡', '冷萃冰釀'), '冰釀咖啡 ↔ 冷萃冰釀');
  assert.ok(find('流星巴斯克', '巴斯克乳酪蛋糕'), '流星巴斯克 ↔ 巴斯克乳酪蛋糕');
  assert.ok(!find('抹茶拿鐵', '冰拿鐵'), '抹茶拿鐵不應與拿鐵同群');
  const us = find('美式咖啡', '美式');
  assert.equal(us.suggestedName, '美式', '建議名稱為最新名稱');
  assert.ok(us.pairs[0].reasons.some((r) => r.includes('前後接續')));
  assert.ok(names.length >= 10);
});
