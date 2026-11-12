// 單元測試：BOM 配方表（11/12 需求 二-7～二-9）—— 不用先整併就能設配方、匯入／匯出、還沒設配方的提醒、合併時帶配方
import test from 'node:test';
import assert from 'node:assert/strict';
import { needsRecipe, bomRows, missingRecipes, recipeGaps, recipeCosts, replaceRecipe, planRecipeCarryOver, resolveProductId, parseRecipeSheet, recipeSheetRows, rawProductId, RECIPE_HEADER } from '../erp/js/lib/bom.js';
import { theoreticalUsage } from '../erp/js/lib/inventory.js';
import { aliasKey } from '../erp/js/lib/dedupe.js';

// 和 state.js getProductIndex().of() 一樣：合併過的寫法 → 品項，其他 → 'raw:' 原始品名
const makeIdx = (products = [], aliases = []) => {
  const byId = new Map(products.map((p) => [p.id, p]));
  const aliasToProductId = new Map(aliases.map(([raw, pid]) => [aliasKey(raw), pid]));
  return {
    products,
    byId,
    aliasToProductId,
    of(l) {
      const pid = aliasToProductId.get(aliasKey(l.item_raw));
      if (pid) return { id: pid, name: byId.get(pid).name, category: byId.get(pid).category || 'coffee', mapped: true };
      return { id: 'raw:' + aliasKey(l.item_raw), name: l.item_raw, category: /寄杯/.test(l.item_raw) ? 'prepaid' : 'coffee', mapped: false };
    },
  };
};
const line = (id, date, item_raw, qty = 1, extra = {}) => ({ id, date, item_raw, qty, revenue: 100 * qty, ...extra });

const ITEMS = [
  { id: 'bean', sku: 'BN-001', name: '花季配方豆', unit: 'g' },
  { id: 'milk', sku: 'DY-001', name: '鮮乳 936ml', unit: 'ml' },
  { id: 'cup', sku: 'PK-001', name: '冰杯 16oz', unit: '個' },
];

test('BOM：需要配方的銷售行排除整單折扣、POS 作廢、數量 0 與寄杯售出；招待／測試／報廢仍要配方', () => {
  assert.equal(needsRecipe(line('a', '2026-09-01', '冰拿鐵')), true);
  assert.equal(needsRecipe(line('a', '2026-09-01', '冰拿鐵', 1, { void_reason: 'boss_treat' })), true);
  assert.equal(needsRecipe(line('a', '2026-09-01', '整單折扣', 1, { is_adjustment: true })), false);
  assert.equal(needsRecipe(line('a', '2026-09-01', '冰拿鐵', 1, { void_reason: 'pos_void' })), false);
  assert.equal(needsRecipe(line('a', '2026-09-01', '冰拿鐵', 0)), false);
  assert.equal(needsRecipe(line('a', '2026-09-01', '寄杯 10 杯'), { category: 'prepaid' }), false);
});

test('BOM：品名列表——沒合併的品名直接列、合併過的只列一次並列出 POS 寫法；期間、新品名、不需配方', () => {
  const idx = makeIdx([{ id: 'p_latte', name: '拿鐵', category: 'coffee' }], [['拿鐵(冰)', 'p_latte'], ['Latte', 'p_latte']]);
  const lines = [
    line('1', '2026-08-01', '美式'), // 期間外：只用來判斷第一次出現
    line('2', '2026-09-10', '美式', 2),
    line('3', '2026-09-10', '拿鐵(冰)', 3),
    line('4', '2026-09-11', 'Latte', 1),
    line('5', '2026-09-12', '拿鐵(冰)', 1, { void_reason: 'boss_test', revenue: 0 }),
    line('6', '2026-09-20', '季節氣泡飲', 1),
    line('7', '2026-09-20', '提袋', 1),
    line('8', '2026-09-20', '寄杯 10 杯', 1),
    line('9', '2026-09-20', '整單折扣', 1, { is_adjustment: true, revenue: -50 }),
  ];
  const recipes = [{ id: 'p_latte|bean', product_id: 'p_latte', item_id: 'bean', qty: 18 }];
  const rows = bomRows(lines, (l) => idx.of(l), recipes, { from: '2026-09-01', to: '2026-09-30', skip: [rawProductId('提袋')], newSince: '2026-09-15' });
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.deepEqual(Object.keys(by).sort(), ['季節氣泡飲', '拿鐵', '提袋', '美式'].sort(), '寄杯與整單折扣不列');
  assert.equal(by['美式'].id, 'raw:美式');
  assert.equal(by['美式'].qty, 2, '期間外的不算份數');
  assert.equal(by['美式'].first, '2026-08-01');
  assert.equal(by['美式'].isNew, false);
  assert.equal(by['拿鐵'].qty, 4);
  assert.equal(by['拿鐵'].otherQty, 1, '老闆測試另計');
  assert.deepEqual(by['拿鐵'].spellings, ['拿鐵(冰)', 'Latte']);
  assert.equal(by['拿鐵'].hasRecipe, true);
  assert.equal(by['季節氣泡飲'].isNew, true);
  assert.equal(by['提袋'].skipped, true);
  assert.deepEqual(missingRecipes(rows).map((r) => r.name).sort(), ['季節氣泡飲', '美式'].sort());
});

test('BOM：匯入 POS 後找出還沒設配方的品名，第一次出現的標新品名', () => {
  const idx = makeIdx();
  const before = [line('1', '2026-09-01', '美式')];
  const fresh = [line('2', '2026-09-22', '美式'), line('3', '2026-09-22', '季節氣泡飲'), line('4', '2026-09-22', '冰拿鐵')];
  const recipes = [{ id: 'raw:冰拿鐵|bean', product_id: rawProductId('冰拿鐵'), item_id: 'bean', qty: 18 }];
  const seen = new Set(before.map((l) => idx.of(l).id));
  const gaps = recipeGaps(fresh, (l) => idx.of(l), recipes, { seen });
  assert.deepEqual(gaps.map((g) => [g.name, g.isNew]), [['季節氣泡飲', true], ['美式', false]], '冰拿鐵已設配方，新品名排前面');
});

test('BOM：沒合併的品名設的配方，耗用與理論成本照算（以 raw: id 對上）', () => {
  const idx = makeIdx();
  const recipes = [
    { id: 'a', product_id: rawProductId('冰拿鐵'), item_id: 'bean', qty: 18 },
    { id: 'b', product_id: rawProductId('冰拿鐵'), item_id: 'milk', qty: 200 },
  ];
  const lines = [line('1', '2026-09-01', '冰拿鐵', 2), line('2', '2026-09-02', '冰 拿鐵', 1, { void_reason: 'boss_treat' })];
  const usage = theoreticalUsage(lines, recipes, (l) => idx.of(l).id);
  assert.equal(usage.get('bean').consume, 54, '空白不同的寫法也對得上同一個配方');
  assert.equal(usage.get('milk').byReason.boss_treat, 200);
  const cost = recipeCosts(recipes, (id) => ({ bean: 1.2, milk: 0.08 })[id]);
  assert.equal(cost.get(rawProductId('冰拿鐵')), 37.6);
});

test('BOM：存配方＝換掉原本的原料清單', () => {
  const pid = rawProductId('冰拿鐵');
  const recipes = [
    { id: `${pid}|bean`, product_id: pid, item_id: 'bean', qty: 18 },
    { id: `${pid}|cup`, product_id: pid, item_id: 'cup', qty: 1 },
    { id: 'raw:美式|bean', product_id: 'raw:美式', item_id: 'bean', qty: 18 },
  ];
  const plan = replaceRecipe(recipes, pid, [{ item_id: 'bean', qty: 20 }, { item_id: 'milk', qty: 180 }], '冰拿鐵');
  assert.deepEqual(plan.remove, [`${pid}|cup`]);
  assert.deepEqual(plan.put.map((r) => [r.id, r.qty, r.product_name]), [[`${pid}|bean`, 20, '冰拿鐵'], [`${pid}|milk`, 180, '冰拿鐵']]);
});

test('BOM：整併時，原始品名的配方帶到還沒有配方的品項；品項已有配方就保留', () => {
  const hot = rawProductId('熱拿鐵');
  const ice = rawProductId('冰拿鐵');
  const recipes = [
    { id: `${hot}|bean`, product_id: hot, item_id: 'bean', qty: 18 },
    { id: `${hot}|milk`, product_id: hot, item_id: 'milk', qty: 200 },
    { id: `${ice}|bean`, product_id: ice, item_id: 'bean', qty: 20 },
  ];
  const moved = planRecipeCarryOver(recipes, [hot, ice, rawProductId('拿鐵')], 'p_latte', '拿鐵');
  assert.equal(moved.from, hot);
  assert.deepEqual(moved.put.map((r) => [r.id, r.product_id, r.qty, r.product_name]), [['p_latte|bean', 'p_latte', 18, '拿鐵'], ['p_latte|milk', 'p_latte', 200, '拿鐵']]);
  assert.deepEqual(moved.kept, [ice], '冰拿鐵的配方不同，告知沒套用');
  const kept = planRecipeCarryOver([...recipes, { id: 'p_latte|bean', product_id: 'p_latte', item_id: 'bean', qty: 16 }], [hot], 'p_latte');
  assert.deepEqual(kept.put, []);
  assert.deepEqual(kept.kept, [hot]);
  const same = planRecipeCarryOver([recipes[2], { id: 'x', product_id: 'raw:icelatte', item_id: 'bean', qty: 20 }], [ice, 'raw:icelatte'], 'p_latte');
  assert.deepEqual(same.kept, [], '配方一樣的不用提醒');
  assert.deepEqual(planRecipeCarryOver(recipes, [rawProductId('美式')], 'p_am'), { put: [], from: null, kept: [] });
});

test('BOM：匯入檔的品名對到品項或原始品名（還沒賣過的也收）', () => {
  const idx = makeIdx([{ id: 'p_latte', name: '拿鐵' }], [['拿鐵(冰)', 'p_latte']]);
  assert.equal(resolveProductId('拿鐵 (冰)', idx), 'p_latte', '合併過的寫法');
  assert.equal(resolveProductId('拿鐵', idx), 'p_latte', '寫合併後的名稱');
  assert.equal(resolveProductId('季節氣泡飲', idx), 'raw:季節氣泡飲');
  assert.equal(resolveProductId('  ', idx), null);
});

test('BOM：解析配方匯入表——表頭、沿用上一列品名、依編號或品名找原料、略過的列與原因', () => {
  const idx = makeIdx();
  const rows = [
    ['午月 BOM 配方表'],
    RECIPE_HEADER,
    ['冰拿鐵', 'BN-001', '', '18', 'g'],
    ['', '', '鮮乳 936ml', '200', 'ml'], // 品名留白沿用上一列
    ['', 'pk-001', '', '1', ''], // 編號不分大小寫、單位可留白
    ['熱拿鐵', '', '不存在的原料', '10', 'g'],
    ['熱拿鐵', 'BN-001', '', '0', 'g'],
    ['熱拿鐵', '', '鮮乳936ml', '200', '瓶'],
    ['冰拿鐵', 'BN-001', '', '20', 'g'],
    ['美式', '', '', '', ''], // 範本裡還沒填的品名：不算錯
    ['新品測試', '', '', '15', ''],
    ['季節氣泡飲', 'BN-001', '花季配方豆', '12.5', 'g'],
    ['', '', '', '', ''],
  ];
  const res = parseRecipeSheet(rows, { items: ITEMS, resolveProduct: (n) => resolveProductId(n, idx) });
  assert.equal(res.error, undefined);
  assert.deepEqual(
    res.products.map((p) => [p.id, p.lines.map((x) => `${x.item_id}:${x.qty}`).join(',')]),
    [
      ['raw:冰拿鐵', 'bean:18,milk:200,cup:1'],
      ['raw:季節氣泡飲', 'bean:12.5'],
    ],
  );
  assert.deepEqual(
    res.skipped.map((s) => s.row),
    [6, 7, 8, 9, 11],
  );
  assert.match(res.skipped[0].reason, /找不到原料「不存在的原料」/);
  assert.match(res.skipped[1].reason, /用量要填大於 0/);
  assert.match(res.skipped[2].reason, /單位寫「瓶」.*庫存單位「ml」/);
  assert.match(res.skipped[3].reason, /重複/);
  assert.match(res.skipped[4].reason, /有用量但沒有填原料/);
  assert.match(parseRecipeSheet([['品名', '價格']], { items: ITEMS, resolveProduct: () => 'x' }).error, /找不到表頭/);
});

test('BOM：匯出的表格可以直接再匯入（沒設配方的品名也列出來當範本）', () => {
  const idx = makeIdx([{ id: 'p_latte', name: '拿鐵' }], [['Latte', 'p_latte']]);
  const sheet = recipeSheetRows(
    [
      { name: '拿鐵', lines: [{ item_id: 'bean', qty: 18 }, { item_id: 'milk', qty: 200 }] },
      { name: '美式', lines: [] },
    ],
    ITEMS,
  );
  assert.deepEqual(sheet[0], RECIPE_HEADER);
  assert.deepEqual(sheet[1], ['拿鐵', 'BN-001', '花季配方豆', 18, 'g']);
  assert.deepEqual(sheet[3], ['美式', '', '', '', '']);
  const res = parseRecipeSheet(sheet, { items: ITEMS, resolveProduct: (n) => resolveProductId(n, idx) });
  assert.deepEqual(res.products, [{ id: 'p_latte', name: '拿鐵', lines: [{ item_id: 'bean', qty: 18 }, { item_id: 'milk', qty: 200 }] }]);
  assert.deepEqual(res.skipped, []);
});
