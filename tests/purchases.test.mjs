// 進貨紀錄／供應商：品名自動分類、進貨單 → 異動與自動建檔、包裝折合、匯入分組、供應商匯入合併、匯入欄位對應
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { guessItemCategory, applyPurchase, normalizePurchaseRows, groupPurchases, toStockQty, completeLine, normalizeSupplierRows, findSupplier, findItem, purchaseIdOf, templateCSV } from '../erp/js/lib/purchases.js';
import { TARGETS, detectHeaderRow, autoMap, extract, guessTarget } from '../erp/js/lib/importer.js';
import { decodeBytes, parseCSV } from '../erp/js/lib/csv.js';
import { stockLevels, averageCosts, supplierStats, INVENTORY_CATEGORIES, suggestSku } from '../erp/js/lib/inventory.js';

const fx = (n) => fileURLToPath(new URL(`./fixtures/${n}`, import.meta.url));
function loadCsv(name, target) {
  const { text } = decodeBytes(readFileSync(fx(name)));
  const rows = parseCSV(text);
  const t = target || guessTarget(rows, name);
  const { index } = detectHeaderRow(rows, t);
  const m = autoMap(rows[index], t);
  return { t, m, headers: rows[index], raw: extract(rows, index, m) };
}

test('purchases: 品名自動分類（依 12XX 原料科目），提示優先', () => {
  const g = (n, h) => guessItemCategory(n, h).category;
  assert.equal(g('鮮乳 936ml'), 'dairy');
  assert.equal(g('衣索比亞耶加雪菲豆'), 'beans');
  assert.equal(g('巴西日曬豆'), 'beans');
  assert.equal(g('紙杯 12oz'), 'packaging');
  assert.equal(g('抹茶粉'), 'tea_syrup');
  assert.equal(g('無鹽奶油'), 'bakery');
  assert.equal(g('濾掛禮盒'), 'retail');
  assert.deepEqual(guessItemCategory('洗碗精'), { category: 'other', sure: false });
  assert.equal(g('xx', '1214'), 'bakery');
  assert.equal(g('xx', '乳品'), 'dairy');
  assert.equal(g('xx', '1215 原料－包材耗材'), 'packaging');
  assert.equal(INVENTORY_CATEGORIES.other.gl, '1215');
  assert.equal(suggestSku('dairy', [{ sku: 'DY-002' }, { sku: 'BN-009' }]), 'DY-003');
});

test('purchases: 金額互推、包裝折合', () => {
  assert.deepEqual(completeLine({ qty: 12, unit_price: 85 }), { amount: 1020, amount_ex: 971.43, tax: 48.57, unit_price: 85 });
  assert.deepEqual(completeLine({ qty: 2, amount: 2200 }), { amount: 2200, amount_ex: 2095.24, tax: 104.76, unit_price: 1100 });
  assert.deepEqual(completeLine({ qty: 4, amount_ex: 1000, tax: 50 }), { amount: 1050, amount_ex: 1000, tax: 50, unit_price: 262.5 });
  assert.equal(completeLine({ qty: 1 }), null);
  const milk = { unit: 'ml', pack_type: '瓶', pack_size: 936 };
  assert.equal(toStockQty(milk, '瓶', 12), 11232);
  assert.equal(toStockQty(milk, 'ml', 500), 500);
  assert.equal(toStockQty(milk, '', 3), 3);
  assert.equal(toStockQty({ unit: '瓶', pack_type: '瓶', pack_size: 1 }, '瓶', 12), 12);
});

test('purchases: 進貨單 → 異動、自動建檔、既有品項更新、固定編號', () => {
  const mk = () => ({
    items: [{ id: 'bean', name: '花季配方豆', unit: 'g', category: 'beans', gl_account: '1211', pack_type: 'kg', pack_size: 1000, supplier_id: null }],
    suppliers: [{ id: 's1', name: '鮮乳坊股份有限公司', short_name: '鮮乳坊', tax_id: '12345678' }],
  });
  const doc = { invoice_no: 'AB12345678', invoice_date: '2026-09-05', date: '2026-09-06', order_date: '2026-09-03', supplier_name: '鮮乳坊', lines: [{ name: '鮮乳 936ml', unit: '瓶', qty: 12, unit_price: 85 }, { name: '花季配方豆', unit: 'kg', qty: 2, amount: 2200 }] };
  const ctx = mk();
  const res = applyPurchase(doc, ctx);
  assert.equal(res.supplier.id, 's1');
  assert.equal(res.newSupplier, null);
  assert.equal(res.skipped.length, 0);
  assert.equal(res.purchaseId, purchaseIdOf({ invoice_no: 'ab12345678' }));
  // 新品項：乳品、單位瓶、包裝瓶、編號 DY-001、主要供應商、含稅／未稅包裝價
  assert.equal(res.newItems.length, 1);
  const milk = res.newItems[0];
  assert.equal(milk.category, 'dairy');
  assert.equal(milk.unit, '瓶');
  assert.equal(milk.pack_type, '瓶');
  assert.equal(milk.sku, 'DY-001');
  assert.equal(milk.supplier_id, 's1');
  assert.equal(milk.last_unit_price, 85);
  assert.equal(milk.pack_price_inc, 85);
  assert.equal(milk.pack_price_ex, 80.95);
  assert.equal(milk.last_purchase_date, '2026-09-06');
  assert.equal(milk.auto_category, false);
  assert.ok(ctx.items.includes(milk), '新品項加進 ctx.items，後面的單看得到');
  // 異動：兩行，kg → g 折合 1000
  assert.equal(res.moves.length, 2);
  const [m0, m1] = res.moves;
  assert.equal(m0.item_id, milk.id);
  assert.equal(m0.qty, 12);
  assert.equal(m0.pack_qty, 12);
  assert.equal(m0.amount, 1020);
  assert.equal(m0.amount_ex, 971.43);
  assert.equal(m0.tax, 48.57);
  assert.equal(m0.type, 'purchase');
  assert.equal(m0.order_date, '2026-09-03');
  assert.equal(m0.invoice_date, '2026-09-05');
  assert.equal(m1.item_id, 'bean');
  assert.equal(m1.qty, 2000);
  assert.equal(m1.unit_price, 1100);
  assert.ok(res.moves.every((m) => m.purchase_id === res.purchaseId && m.supplier_id === 's1' && m.invoice_no === 'AB12345678'));
  // 既有品項更新最近進貨
  assert.equal(res.updatedItems.length, 1);
  assert.equal(res.updatedItems[0].last_unit_price, 1100);
  assert.equal(res.updatedItems[0].last_price_unit, 'kg');
  assert.equal(res.updatedItems[0].pack_price_inc, 1100);
  assert.equal(res.updatedItems[0].supplier_id, 's1');
  // 同一張單再套用一次 → 異動編號相同（重複匯入會被當成已存在）
  const again = applyPurchase(doc, mk());
  assert.deepEqual(again.moves.map((m) => m.id), res.moves.map((m) => m.id));
  // 同品名兩行也不會撞號
  const twice = applyPurchase({ ...doc, lines: [doc.lines[0], doc.lines[0]] }, mk());
  assert.equal(new Set(twice.moves.map((m) => m.id)).size, 2);
  // 進貨自動進庫存：期初 0 + 進貨 2000 g
  const lv = stockLevels(ctx.items, res.moves, new Map(), { asOf: '2026-09-30' });
  assert.equal(lv.find((x) => x.item.id === 'bean').purchased, 2000);
  assert.equal(averageCosts(ctx.items, res.moves).get('bean').avg, 1.1);
  assert.equal(supplierStats(ctx.suppliers, ctx.items, res.moves)[0].avgLead, 3);
  // 沒見過的供應商自動建立；沒品名、沒金額的行列入 skipped
  const r2 = applyPurchase({ invoice_date: '2026-09-07', supplier_name: '豆舍', supplier_tax_id: '23456789', lines: [{ name: '', qty: 1, amount: 10 }, { name: '耶加雪菲', qty: 1 }, { name: '耶加雪菲', unit: 'kg', qty: 1, amount: 650 }] }, mk());
  assert.equal(r2.newSupplier.name, '豆舍');
  assert.equal(r2.newSupplier.tax_id, '23456789');
  assert.equal(r2.skipped.length, 2);
  assert.equal(r2.moves.length, 1);
  assert.equal(r2.moves[0].date, '2026-09-07');
});

test('purchases: 匯入列依發票分成進貨單、重複列略過、供應商自動建立；進貨單分組含舊資料', () => {
  const { t, m, raw } = loadCsv('synthetic-purchases.csv');
  assert.equal(t, 'purchases');
  for (const k of ['invoice_no', 'invoice_date', 'date', 'supplier', 'supplier_tax_id', 'item', 'unit', 'unit_price', 'qty', 'amount', 'category', 'note']) assert.notEqual(m[k], undefined, `欄位 ${k} 要能自動對應`);
  assert.equal(TARGETS.purchases.validate(m), null);
  const suppliers = [{ id: 's2', name: '豆舍咖啡烘焙有限公司', short_name: '豆舍', tax_id: '23456789' }];
  const r = normalizePurchaseRows(raw, { items: [], suppliers, sourceFile: '進貨.csv', batchId: 'b1' });
  assert.equal(r.docs.length, 2);
  assert.equal(r.rows.length, 5);
  assert.equal(r.skipped.length, 1);
  assert.ok(r.skipped[0].reason.includes('沒有金額'), r.skipped[0].reason);
  assert.equal(r.newItems.length, 5);
  assert.deepEqual(r.newItems.map((i) => i.category), ['beans', 'beans', 'packaging', 'packaging', 'tea_syrup']);
  assert.equal(r.newSups.length, 1);
  assert.equal(r.newSups[0].name, '好包材');
  const d1 = r.docs.find((d) => d.invoice_no === 'CD11112222');
  assert.equal(d1.supplier.id, 's2');
  assert.equal(d1.date, '2026-09-11');
  assert.equal(d1.invoice_date, '2026-09-10');
  assert.ok(r.rows.every((x) => x.batch_id === 'b1' && x.source_file === '進貨.csv'));
  assert.ok(r.newItems.every((i) => i.source_file === '進貨.csv'));
  // 分組：匯入的 2 張 + 舊資料（只有發票號碼）1 張 + 沒有任何單據資訊的 1 行
  const legacy = [
    { id: 'old1', item_id: r.newItems[0].id, type: 'purchase', date: '2026-08-01', qty: 1, amount: 100, invoice_no: 'ZZ00000001', supplier_id: 's2' },
    { id: 'old2', item_id: r.newItems[1].id, type: 'purchase', date: '2026-08-02', qty: 1, amount: 200, invoice_no: 'ZZ00000001', supplier_id: 's2' },
    { id: 'old3', item_id: r.newItems[1].id, type: 'purchase', date: '2026-08-03', qty: 1, amount: 300 },
    { id: 'c1', item_id: r.newItems[1].id, type: 'consume', date: '2026-08-03', qty: 1 },
  ];
  const groups = groupPurchases([...r.rows, ...legacy], { items: r.newItems, suppliers: [...suppliers, ...r.newSups] });
  assert.equal(groups.length, 4);
  const g1 = groups.find((g) => g.invoice_no === 'CD11112222');
  assert.equal(g1.lines.length, 2);
  assert.equal(g1.total, 8050);
  assert.equal(g1.supplierName, '豆舍');
  assert.equal(g1.summary, '衣索比亞耶加雪菲豆、巴西日曬豆');
  const old = groups.find((g) => g.invoice_no === 'ZZ00000001');
  assert.equal(old.lines.length, 2);
  assert.equal(old.date, '2026-08-02');
  assert.equal(groups.find((g) => g.id === 'one|old3').total, 300);
});

test('suppliers: 匯入比對（統編／抬頭／簡稱）、合併不蓋空白、欄位對應、範本', () => {
  const { t, m, raw } = loadCsv('synthetic-suppliers.csv');
  assert.equal(t, 'suppliers');
  for (const f of TARGETS.suppliers.fields) assert.notEqual(m[f.key], undefined, `欄位 ${f.key} 要能自動對應`);
  const existing = [{ id: 's1', name: '鮮乳坊股份有限公司', short_name: '鮮乳坊', tax_id: '12345678', phone: '02-0000-0000', note: '舊備註' }];
  const r = normalizeSupplierRows(raw, { suppliers: existing, batchId: 'b1' });
  assert.equal(r.rows.length, 3);
  assert.equal(r.unchanged, 0);
  const upd = r.rows.find((x) => x.id === 's1');
  assert.equal(upd.phone, '02-2345-6789');
  assert.equal(upd.contact, '王小明');
  assert.equal(upd.account_number, '0123456789012');
  assert.equal(upd.batch_id, undefined, '既有供應商不掛批次（刪除批次不會刪到）');
  const good = r.rows.find((x) => x.short_name === '好包材');
  assert.equal(good.tax_id, '');
  assert.equal(good.batch_id, 'b1');
  assert.equal(good.note, '最低訂購 2 箱');
  // 再匯一次：全部相同 → 不變動
  const r2 = normalizeSupplierRows(raw, { suppliers: [...existing.map((x) => ({ ...x, ...upd })), ...r.rows.filter((x) => x.id !== 's1')] });
  assert.equal(r2.rows.length, 0);
  assert.equal(r2.unchanged, 3);
  // 比對
  assert.equal(findSupplier(r.rows, { name: '豆舍' })?.name, '豆舍咖啡烘焙有限公司');
  assert.equal(findSupplier(r.rows, { taxId: '23456789' })?.short_name, '豆舍');
  assert.equal(findSupplier(r.rows, { name: '不存在' }), null);
  assert.equal(findItem([{ id: 'a', name: '鮮乳 936ml', sku: 'DY-001' }], 'dy-001')?.id, 'a');
  // 檔名判斷與範本
  assert.equal(guessTarget([[]], '供應商名單.xlsx'), 'suppliers');
  assert.equal(guessTarget([[]], '2026-09 進貨明細.csv'), 'purchases');
  assert.equal(guessTarget([[]], '採購發票.csv'), 'purchases');
  const tpl = templateCSV('suppliers');
  assert.deepEqual(autoMap(tpl[0], 'suppliers').account_number, tpl[0].indexOf('匯款帳號'));
  const tp = templateCSV('purchases');
  const pm = autoMap(tp[0], 'purchases');
  assert.equal(pm.qty, tp[0].indexOf('數量'));
  assert.equal(pm.amount, tp[0].indexOf('含稅金額'));
  assert.equal(pm.invoice_no, tp[0].indexOf('發票號碼'));
});
