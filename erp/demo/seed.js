// 預覽版的示範資料（全部虛構）：以「打開當天」往回產生約四個月的營運資料，
// 每次打開都一樣（固定亂數種子），日期跟著今天走，所以任何時候打開都有「本月」「上個月」可以看。
// 只產生原始資料（POS 明細、刷卡交易、撥款、存摺、憑證、電子發票、存貨、會員…）；
// POS 營收、撥款、折舊分錄交給 ERP 自己的 syncAll() 產生，帳才會和正式版的算法一致。

import { normalizeSales } from '../js/lib/pos.js';
import { documentJournal } from '../js/lib/autojournal.js';
import { nextVoucherNo } from '../js/lib/ledger.js';
import { isValidTaxId, classifyExpense } from '../js/lib/classify.js';
import { parseDocName, archiveName } from '../js/lib/docname.js';
import { aliasKey } from '../js/lib/dedupe.js';
import { deductibility, taxCodes } from '../js/lib/vat.js';
import { addDays, eachDay, weekdayIndex, monthEnd, addMonths, eachMonth, today as todayLocal } from '../js/lib/dates.js';
import { fnv1a } from '../js/lib/text.js';
import { chineseAmount } from './images.js';

// ── 固定亂數
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
const round2 = (n) => Math.round(n * 100) / 100;
const vatOf = (total) => total - Math.round(total / 1.05);

// 合成統編（通過檢查碼、與任何真實商家無關的流水號）
function taxId(base) {
  for (let n = base; ; n++) if (isValidTaxId(String(n))) return String(n);
}
export const SHOP_TAX_ID = '12345675';

const VENDORS = {
  bean: { name: '森林烘豆坊有限公司', short: '森林烘豆坊', tax: taxId(80010000), track: 'QF', account: '1211', pay: '2111', terms: '月結 30 天' },
  milk: { name: '日日鮮乳品行', short: '日日鮮乳', tax: taxId(80020000), track: 'QM', account: '1212', pay: '2134', folder: '員工代墊支出', terms: '現結（員工代墊）' },
  tea: { name: '青山茶行', short: '青山茶行', tax: taxId(80030000), track: 'QT', account: '1213', pay: '1103', terms: '匯款' },
  bake: { name: '麥香烘焙材料行', short: '麥香烘焙', tax: taxId(80040000), track: 'QB', account: '1214', pay: '2111', terms: '月結 30 天' },
  pack: { name: '一品包材行', short: '一品包材', tax: taxId(80050000), track: 'QP', account: '1215', pay: '1103', terms: '匯款' },
  power: { name: '台灣電力公司', short: '台灣電力', tax: taxId(80060000), track: 'QW', account: '6118', pay: '1103' },
  tel: { name: '中華電信股份有限公司', short: '中華電信', tax: taxId(80070000), track: 'QC', account: '6115', pay: '1103' },
  costco: { name: '好市多股份有限公司', short: '好市多', tax: taxId(80080000), track: 'QK', account: '6133', pay: '2134', folder: '員工代墊支出' },
  daiso: { name: '大創百貨', short: '大創', tax: taxId(80090000), track: 'QD', account: '6135', pay: '2134', folder: '員工代墊支出' },
  acct: { name: '安心記帳士事務所', short: '安心記帳', tax: taxId(80100000), track: 'QA', account: '6132', pay: '1103' },
  equip: { name: '晨光咖啡器材有限公司', short: '晨光咖啡器材', tax: taxId(80110000), track: 'QE', account: '1511', pay: '1103', terms: '匯款' },
  ecpay: { name: '綠界科技股份有限公司', short: '綠界科技', tax: taxId(80120000), track: 'QG', account: '6131', pay: '1111' },
  linepay: { name: '連加網路商業股份有限公司', short: 'LINE Pay', tax: taxId(80130000), track: 'QL', account: '6131', pay: '1112' },
  jko: { name: '街口網路科技股份有限公司', short: '街口支付', tax: taxId(80140000), track: 'QJ', account: '6131', pay: '1113' },
  twpay: { name: '台灣行動支付股份有限公司', short: '台灣Pay', tax: taxId(80150000), track: 'QY', account: '6131', pay: '1114' },
  uber: { name: '優食台灣股份有限公司', short: 'Uber Eats', tax: taxId(80160000), track: 'QU', account: '6129', pay: '1115' },
  landlord: { name: '林房東', short: '林房東', receipt: true, account: '6111', pay: '1103' },
  hardware: { name: '早安五金行', short: '早安五金行', receipt: true, account: '6135', pay: '1101' },
};
const OTHER_COMPANY = taxId(80990000); // 「買方統編不是本店」的示範

const MENU = [
  { name: '美式咖啡', cat: 'coffee', price: 90, opts: ['熱', '冰'], w: 16 },
  { name: '拿鐵', cat: 'coffee', price: 120, opts: ['熱', '冰'], w: 18 },
  { name: '燕麥拿鐵', cat: 'coffee', price: 140, opts: ['熱', '冰'], w: 7, old: '燕麥奶拿鐵' },
  { name: '卡布奇諾', cat: 'coffee', price: 120, opts: ['熱'], w: 5 },
  { name: '手沖單品', cat: 'coffee', price: 180, opts: ['熱'], w: 6 },
  { name: '冰釀咖啡', cat: 'coffee', price: 130, opts: ['冰'], w: 6 },
  { name: '西西里咖啡', cat: 'coffee', price: 140, opts: ['冰'], w: 4 },
  { name: '抹茶拿鐵', cat: 'non_coffee', price: 150, opts: ['熱', '冰'], w: 7 },
  { name: '伯爵紅茶', cat: 'non_coffee', price: 100, opts: ['熱', '冰'], w: 4 },
  { name: '可可歐蕾', cat: 'non_coffee', price: 130, opts: ['熱', '冰'], w: 4 },
  { name: '檸檬氣泡飲', cat: 'non_coffee', price: 120, opts: ['冰'], w: 3 },
  { name: '巴斯克乳酪蛋糕', cat: 'food', price: 140, w: 8, old: '巴斯克' },
  { name: '奶油可頌', cat: 'food', price: 80, w: 7 },
  { name: '肉桂捲', cat: 'food', price: 95, w: 4 },
  { name: '原味司康', cat: 'food', price: 85, w: 4 },
  { name: '季節鹹派', cat: 'food', price: 160, w: 3 },
  { name: '濾掛咖啡包', cat: 'retail', price: 35, w: 2 },
  { name: '配方咖啡豆半磅', cat: 'retail', price: 450, w: 1 },
];
const DRINKS = MENU.filter((m) => m.cat === 'coffee' || m.cat === 'non_coffee');
const FOODS = MENU.filter((m) => m.cat === 'food' || m.cat === 'retail');

const INVENTORY = [
  { id: 'it_bean', name: '配方咖啡豆', category: 'coffee', unit: 'kg', gl_account: '1211', safety_stock: 3, reorder_qty: 5, supplier: 'bean', std_cost: 650 },
  { id: 'it_bean_so', name: '單品咖啡豆', category: 'coffee', unit: 'kg', gl_account: '1211', safety_stock: 1, reorder_qty: 2, supplier: 'bean', std_cost: 1050 },
  { id: 'it_milk', name: '鮮乳 936ml', category: 'dairy', unit: '瓶', gl_account: '1212', safety_stock: 12, reorder_qty: 24, supplier: 'milk', std_cost: 90 },
  { id: 'it_oat', name: '燕麥奶 1L', category: 'dairy', unit: '瓶', gl_account: '1212', safety_stock: 6, reorder_qty: 12, supplier: 'milk', std_cost: 129 },
  { id: 'it_matcha', name: '抹茶粉', category: 'tea', unit: 'kg', gl_account: '1213', safety_stock: 0.3, reorder_qty: 1, supplier: 'tea', std_cost: 1870 },
  { id: 'it_earl', name: '伯爵紅茶葉', category: 'tea', unit: 'kg', gl_account: '1213', safety_stock: 0.3, reorder_qty: 1, supplier: 'tea', std_cost: 1140 },
  { id: 'it_cheese', name: '奶油乳酪', category: 'food', unit: 'kg', gl_account: '1214', safety_stock: 2, reorder_qty: 4, supplier: 'bake', std_cost: 400 },
  { id: 'it_croissant', name: '冷凍可頌麵團', category: 'food', unit: '個', gl_account: '1214', safety_stock: 30, reorder_qty: 60, supplier: 'bake', std_cost: 21 },
  { id: 'it_cup', name: '12oz 紙杯', category: 'packaging', unit: '個', gl_account: '1215', safety_stock: 300, reorder_qty: 1000, supplier: 'pack', std_cost: 2.1 },
  { id: 'it_lid', name: '杯蓋', category: 'packaging', unit: '個', gl_account: '1215', safety_stock: 300, reorder_qty: 1000, supplier: 'pack', std_cost: 0.9 },
];
const RECIPES = {
  美式咖啡: [['it_bean', 0.018], ['it_cup', 1], ['it_lid', 1]],
  拿鐵: [['it_bean', 0.018], ['it_milk', 0.24], ['it_cup', 1], ['it_lid', 1]],
  燕麥拿鐵: [['it_bean', 0.018], ['it_oat', 0.24], ['it_cup', 1], ['it_lid', 1]],
  卡布奇諾: [['it_bean', 0.018], ['it_milk', 0.17], ['it_cup', 1], ['it_lid', 1]],
  手沖單品: [['it_bean_so', 0.02]],
  冰釀咖啡: [['it_bean', 0.03], ['it_cup', 1], ['it_lid', 1]],
  西西里咖啡: [['it_bean', 0.018], ['it_cup', 1], ['it_lid', 1]],
  抹茶拿鐵: [['it_matcha', 0.008], ['it_milk', 0.24], ['it_cup', 1], ['it_lid', 1]],
  伯爵紅茶: [['it_earl', 0.006], ['it_cup', 1], ['it_lid', 1]],
  可可歐蕾: [['it_milk', 0.24], ['it_cup', 1], ['it_lid', 1]],
  巴斯克乳酪蛋糕: [['it_cheese', 0.11]],
  奶油可頌: [['it_croissant', 1]],
};

const STAFF = ['阿安', '小哲', '佳佳'];
const SURNAMES = ['林', '陳', '張', '王', '李', '黃', '吳', '劉', '蔡', '楊', '許', '鄭'];
const GIVEN = ['宜君', '冠宇', '雅婷', '柏翰', '佩珊'];

/**
 * @returns {{ collections: Record<string, object[]>, images: Map<string, object>, range: {from, to, today} }}
 */
export function buildSeed({ today = todayLocal() } = {}) {
  const R = rng(20261020);
  const int = (a, b) => a + Math.floor(R() * (b - a + 1));
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const wpick = (list, w = (x) => x.w) => {
    const total = list.reduce((t, x) => t + w(x), 0);
    let r = R() * total;
    for (const x of list) if ((r -= w(x)) < 0) return x;
    return list[list.length - 1];
  };

  const curYm = today.slice(0, 7);
  const firstYm = addMonths(curYm, -3);
  const from = `${firstYm}-01`;
  const to = addDays(today, -1);
  const months = eachMonth(firstYm, curYm);
  const dayOf = (ym, d) => {
    const end = monthEnd(ym);
    const ymd = `${ym}-${pad(Math.min(d, Number(end.slice(8))))}`;
    return ymd <= to && ymd >= from ? ymd : null;
  };
  const inboxFrom = addDays(today, -9); // 最近 9 天的憑證還沒覆核，留給「本機辨識」示範

  const C = {
    settings: [],
    accounts: [],
    sales_lines: [],
    products: [],
    product_aliases: [],
    payment_tx: [],
    payouts: [],
    bank_accounts: [],
    bank_lines: [],
    journal_entries: [],
    documents: [],
    einvoices: [],
    fixed_assets: [],
    inventory_items: [],
    inventory_moves: [],
    recipes: [],
    suppliers: [],
    customers: [],
    campaigns: [],
    import_batches: [],
  };
  const images = new Map();

  C.settings.push({
    id: 'main',
    value: {
      business_name: '午月咖啡廳（示範）',
      tax_id: SHOP_TAX_ID,
      org_type: 'sole',
      vat_mode: 'general',
      revenue_start: from,
      vat_confirmed: true,
      filing_self: true,
      has_employees: true,
      auto_recognize: true,
      ocr_enabled: false,
      capitalize_threshold: 80000,
      fee_by_invoice: true,
      bank_gl: '1103',
      unknown_payment_account: '1101',
    },
  });

  // ── 品項主檔與別名（「燕麥奶拿鐵」是改名前的舊名，故意不對應，讓「品項整併」有東西可以合併）
  for (const m of MENU) {
    const id = 'p_' + fnv1a(m.name);
    C.products.push({ id, name: m.name, category: m.cat, price: m.price, active: true });
    C.product_aliases.push({ id: aliasKey(m.name), raw_name: m.name, product_id: id });
    if (m.old && m.old !== '燕麥奶拿鐵') C.product_aliases.push({ id: aliasKey(m.old), raw_name: m.old, product_id: id });
  }
  C.products.push({ id: 'p_' + fnv1a('拿鐵寄杯10杯'), name: '拿鐵寄杯10杯', category: 'prepaid', price: 1100, active: true });
  C.product_aliases.push({ id: aliasKey('拿鐵寄杯10杯'), raw_name: '拿鐵寄杯10杯', product_id: 'p_' + fnv1a('拿鐵寄杯10杯') });
  for (const [name, list] of Object.entries(RECIPES)) for (const [item, qty] of list) C.recipes.push({ id: `rc_${fnv1a(name + item)}`, product_id: 'p_' + fnv1a(name), item_id: item, qty });

  // ── 會員、活動
  for (let i = 1; i <= 60; i++) {
    const joined = addDays(from, -int(0, 200));
    C.customers.push({ id: 'cu_' + pad(i, 4), member_no: 'M' + pad(i, 4), name: SURNAMES[(i - 1) % SURNAMES.length] + GIVEN[Math.floor((i - 1) / SURNAMES.length) % GIVEN.length], birthday: `${pad(int(1, 12))}-${pad(int(1, 28))}`, preferences: pick(['燕麥奶', '少冰', '熱飲', '無糖', '']), joined_on: joined });
  }
  const camp = {
    oat: { id: 'cp_oat', name: '燕麥奶加購週', type: 'discount', start_date: dayOf(months[1], 8) || from, end_date: dayOf(months[1], 14) || from, keywords: '燕麥奶加購週', issued_qty: null, redeemed_qty: null, marketing_cost: 2000, note: '燕麥拿鐵折 20 元' },
    ig: { id: 'cp_ig', name: 'IG 打卡送司康', type: 'social', start_date: dayOf(months[2], 1) || from, end_date: dayOf(months[2], 10) || from, keywords: 'IG打卡', issued_qty: 120, redeemed_qty: null, marketing_cost: 1500, note: '打卡贈原味司康' },
    prepaid: { id: 'cp_prepaid', name: '拿鐵寄杯 10＋1', type: 'prepaid', start_date: from, end_date: to, keywords: '寄杯', issued_qty: null, redeemed_qty: null, marketing_cost: 0, note: '' },
  };
  C.campaigns.push(...Object.values(camp));

  // ── POS 銷售明細
  const PAY = [
    ['現金', 'cash', 38],
    ['信用卡', 'card', 26],
    ['LINE Pay', 'linepay', 16],
    ['街口支付', 'jkopay', 4],
    ['台灣Pay', 'taiwanpay', 4],
    ['Uber Eats', 'platform', 12],
  ];
  const HOURS = [[10, 6], [11, 12], [12, 14], [13, 11], [14, 12], [15, 13], [16, 9], [17, 6], [18, 3]];
  const raw = [];
  const orders = []; // { date, time, order_no, pay, total }
  for (const d of eachDay(from, to)) {
    const wd = weekdayIndex(d);
    if (wd === 2) continue; // 週三公休
    const mi = months.indexOf(d.slice(0, 7));
    const n = Math.round((wd >= 5 ? 58 : 36) * (1 + 0.07 * mi) * (0.85 + 0.3 * R()));
    const inOat = d >= camp.oat.start_date && d <= camp.oat.end_date && camp.oat.start_date !== from;
    const inIg = d >= camp.ig.start_date && d <= camp.ig.end_date && camp.ig.start_date !== from;
    for (let k = 1; k <= n; k++) {
      const h = wpick(HOURS, (x) => x[1])[0];
      const time = `${pad(h)}:${pad(int(0, 59))}:${pad(int(0, 59))}`;
      const order_no = `A${d.replace(/-/g, '')}${pad(k, 3)}`;
      const [payRaw, pay] = wpick(PAY, (x) => x[2]);
      const member = pay !== 'platform' && R() < 0.3 ? 'M' + pad(Math.min(60, 1 + Math.floor(Math.pow(R(), 1.8) * 60)), 4) : '';
      const staff = pick(STAFF);
      const channel = pay === 'platform' ? 'Uber Eats' : R() < 0.35 ? '外帶' : '內用';
      const voided = R() < 0.015;
      const items = [];
      const nd = R() < 0.72 ? 1 : 2;
      for (let j = 0; j < nd; j++) items.push(wpick(DRINKS));
      if (R() < 0.45) items.push(wpick(FOODS));
      let total = 0;
      for (const m of items) {
        let name = m.name;
        if (m.old && mi === 0) name = m.old; // 第一個月 POS 還是舊品名
        const opt = m.opts ? pick(m.opts) : '';
        const discount = inOat && m.name === '燕麥拿鐵' ? 20 : 0;
        const amount = m.price - discount;
        raw.push({ date: d, time, order_no, item: name, option: opt, category: '', qty: 1, unit_price: m.price, amount, discount, payment: payRaw, status: voided ? '已作廢' : '', note: discount ? '燕麥奶加購週' : '', member, staff, channel });
        total += amount;
      }
      if (inIg && R() < 0.2 && pay !== 'platform') raw.push({ date: d, time, order_no, item: '原味司康', option: '', qty: 1, unit_price: 0, amount: 0, discount: 0, payment: payRaw, status: voided ? '已作廢' : '', note: 'IG打卡贈送', member, staff, channel });
      if (!voided) orders.push({ date: d, time, order_no, pay, total });
    }
    // 寄杯：售出（預收）與兌換
    if (R() < 0.35) {
      const t = `${pad(int(11, 17))}:${pad(int(0, 59))}:00`;
      const no = `A${d.replace(/-/g, '')}9${pad(int(10, 99))}`;
      const payRaw = R() < 0.5 ? '現金' : '信用卡';
      raw.push({ date: d, time: t, order_no: no, item: '拿鐵寄杯10杯', option: '', category: '寄杯', qty: 1, unit_price: 1100, amount: 1100, discount: 0, payment: payRaw, status: '', note: '寄杯 10＋1', member: 'M' + pad(int(1, 20), 4), staff: pick(STAFF), channel: '內用' });
      orders.push({ date: d, time: t, order_no: no, pay: payRaw === '現金' ? 'cash' : 'card', total: 1100 });
    }
    for (let j = 0, m = int(0, 3); j < m; j++) {
      const t = `${pad(int(10, 18))}:${pad(int(0, 59))}:30`;
      raw.push({ date: d, time: t, order_no: `A${d.replace(/-/g, '')}8${pad(j, 2)}`, item: '拿鐵', option: pick(['熱', '冰']), qty: 1, unit_price: 120, amount: 120, discount: 0, payment: '寄杯扣抵', status: '', note: '寄杯兌換', member: 'M' + pad(int(1, 20), 4), staff: pick(STAFF), channel: '內用' });
    }
    // 老闆招待、老闆測試、報廢（金額作廢，數量留給原物料與成本分析）
    if (R() < 0.6) raw.push({ date: d, time: '15:20:00', order_no: `A${d.replace(/-/g, '')}700`, item: wpick(DRINKS).name, option: '熱', qty: 1, unit_price: 120, amount: 120, discount: 0, payment: '現金', status: '', note: '老闆招待', member: '', staff: '老闆', channel: '內用' });
    if (wd === 3) raw.push({ date: d, time: '09:40:00', order_no: `A${d.replace(/-/g, '')}701`, item: '桂花拿鐵（新品試作）', option: '熱', qty: 2, unit_price: 150, amount: 300, discount: 0, payment: '', status: '', note: '老闆測試', member: '', staff: '老闆', channel: '' });
    if (R() < 0.4) raw.push({ date: d, time: '19:05:00', order_no: `A${d.replace(/-/g, '')}702`, item: '奶油可頌', option: '', qty: int(1, 3), unit_price: 80, amount: 80, discount: 0, payment: '', status: '', note: '報廢（過期）', member: '', staff: pick(STAFF), channel: '' });
  }
  for (const ym of months) {
    const rows = raw.filter((r) => r.date.startsWith(ym));
    if (!rows.length) continue;
    const batchId = 'b_pos_' + ym.replace('-', '');
    const { lines } = normalizeSales(rows, { batchId });
    C.sales_lines.push(...lines);
    C.import_batches.push({ id: batchId, target: 'sales', file_name: `POS銷售明細_${ym.replace('-', '')}.csv`, encoding: 'big5', row_count: rows.length, added: lines.length, skipped: 0, date_from: rows[0].date, date_to: rows[rows.length - 1].date, imported_at: `${addDays(rows[rows.length - 1].date, 1)}T10:00:00+08:00` });
  }

  // ── 刷卡交易（綠界）與各金流撥款
  const FEE = { card: 0.0275, linepay: 0.022, jkopay: 0.025, taiwanpay: 0.015, platform: 0.3 };
  const PROVIDER = { card: 'ecpay', linepay: 'linepay', jkopay: 'jkopay', taiwanpay: 'taiwanpay', platform: 'platform' };
  const PAYOUT_WD = { card: 1, linepay: 3, jkopay: 2, taiwanpay: 4, platform: 0 }; // 撥款日：週二、週四、週三、週五、週一
  const nextPayout = (date, pay) => {
    // 交易所在週（週一～週日）結束後的下一個撥款日
    const weekEnd = addDays(date, 6 - weekdayIndex(date));
    return addDays(weekEnd, 1 + PAYOUT_WD[pay]);
  };
  const feeOf = (o) => Math.round(o.total * FEE[o.pay]);
  for (const o of orders.filter((x) => x.pay === 'card')) {
    const fee = feeOf(o);
    const id = 'ec_' + fnv1a(o.order_no);
    const pd = nextPayout(o.date, 'card');
    C.payment_tx.push({ id, batch_id: 'b_ec_' + o.date.slice(0, 7).replace('-', ''), provider: 'ecpay', date: o.date, time: o.time, order_no: o.order_no, provider_no: 'EC' + fnv1a(id).slice(0, 10).toUpperCase(), amount: o.total, fee, net: o.total - fee, status: '付款成功', ok: true, payout_date: pd <= to ? pd : null, method: '信用卡', card_last4: pad(int(0, 9999), 4), note: '' });
  }
  const payoutGroups = new Map();
  for (const o of orders) {
    if (!FEE[o.pay]) continue;
    const pd = nextPayout(o.date, o.pay);
    if (pd > to) continue;
    const k = `${o.pay}|${pd}`;
    const g = payoutGroups.get(k) || { pay: o.pay, payout_date: pd, gross: 0, fee: 0, n: 0, from: o.date, to: o.date };
    g.gross += o.total;
    g.fee += feeOf(o);
    g.n++;
    if (o.date < g.from) g.from = o.date;
    if (o.date > g.to) g.to = o.date;
    payoutGroups.set(k, g);
  }
  for (const g of payoutGroups.values()) {
    const provider = PROVIDER[g.pay];
    const ref = `${provider.toUpperCase()}-${g.payout_date.replace(/-/g, '')}`;
    C.payouts.push({ id: 'po_' + fnv1a(ref), batch_id: 'b_po', provider, payout_date: g.payout_date, gross: g.gross, fee: g.fee, net: g.gross - g.fee, period_from: g.from, period_to: g.to, tx_count: g.n, ref, note: '' });
  }
  C.import_batches.push({ id: 'b_ec', target: 'payment_tx', file_name: '綠界信用卡交易明細.xlsx', row_count: C.payment_tx.length, added: C.payment_tx.length, skipped: 0, date_from: from, date_to: to, imported_at: `${to}T21:00:00+08:00` });

  // ── 憑證：照片（第一次看到時才畫）、已入帳的產生分錄
  const docs = [];
  let invSeq = 1000;
  const invNo = (v) => (v.receipt ? null : `${v.track}${pad(10000000 + 37 * invSeq++ * 13, 8).slice(-8)}`);
  /**
   * @param v 廠商
   * @param date 發票日期
   * @param items [{ name, qty, price }]
   * @param o { summary, account, pay, buyer, folder, inv, status, note, tilt }
   */
  const addDoc = (v, date, items, o = {}) => {
    if (!date) return null;
    const total = Math.round(items.reduce((t, i) => t + i.qty * i.price, 0));
    const buyer = o.buyer === undefined ? SHOP_TAX_ID : o.buyer;
    const no = o.inv === undefined ? invNo(v) : o.inv;
    const tax = no && buyer ? vatOf(total) : 0;
    const id = 'doc_' + fnv1a(`${v.short}|${date}|${total}|${no || ''}|${o.summary || ''}`);
    const summary = o.summary || items.map((i) => i.name).join('').slice(0, 10);
    const status = o.status || (date >= inboxFrom ? 'inbox' : 'posted');
    const original_name = o.file || `${date.replace(/-/g, '')}-${no ? no + '-' : ''}${v.short}-${summary}${v.receipt && o.nameAmount ? '_' + total : ''}.jpg`;
    const d = {
      id,
      kind: 'receipt',
      status,
      original_name,
      mime: 'image/jpeg',
      file_ext: '.jpg',
      source_folder: o.folder ?? v.folder ?? '',
      created_at: `${addDays(date, 1)}T09:00:00+08:00`,
    };
    if (status === 'posted') {
      Object.assign(d, {
        doc_date: date,
        vendor_name: v.short,
        vendor_tax_id: v.tax || '',
        buyer_tax_id: buyer || '',
        invoice_type: no ? '電子發票' : '收據',
        invoice_no: no,
        amount_total: total,
        tax_amount: tax || null,
        summary,
        items: items.map((i) => ({ name: i.name, qty: i.qty, price: i.price, amount: i.qty * i.price })),
        account: o.account || v.account,
        pay_account: o.pay || v.pay,
        reviewed_by: 'user',
        confidence: 1,
      });
      const item = { invoice_no: no, tax, account: d.account, buyer_tax_id: d.buyer_tax_id, invoice_type: d.invoice_type, deductible: !!tax };
      const ok = deductibility(item, { taxId: SHOP_TAX_ID }).ok;
      Object.assign(d, { deductible: ok, ...taxCodes(item, ok) });
    } else {
      // 待覆核：只有檔名帶入的欄位（和實際上傳時一樣）
      const fn = parseDocName(original_name);
      Object.assign(d, { doc_date: fn.date, vendor_name: fn.vendor, invoice_no: fn.invoice_no, amount_total: fn.amount, tax_amount: null, summary: fn.summary, account: classifyExpense({ vendor: fn.vendor, text: fn.summary }).account, pay_account: o.pay || v.pay || '1101', confidence: fn.date && fn.amount ? 0.5 : 0.2, ai: null });
    }
    docs.push(d);
    const spec = no
      ? { kind: 'invoice', seller_name: v.name, seller: v.tax, buyer, invoice_no: no, date, time: `${pad(int(9, 19))}:${pad(int(0, 59))}:${pad(int(0, 59))}`, random: pad(int(0, 9999), 4), total, sales_ex: total - tax, tax, items, tilt: o.tilt }
      : { kind: 'receipt', vendor: v.name, tax_id: v.tax || '', payer: '午月咖啡廳', date, items: items.map((i) => ({ name: i.qty > 1 ? `${i.name} x${i.qty}` : i.name, amount: i.qty * i.price })), total, total_words: chineseAmount(total), stamp: (v.short + '收訖章').slice(0, 4), tilt: o.tilt };
    images.set(id, o.image || spec);
    return d;
  };

  const kg = (n) => Math.round(n * 10) / 10;
  for (const [mi, ym] of months.entries()) {
    // 設備：第一個月買咖啡機與製冰機（固定資產）；第二個月換磨豆機（未達 8 萬，列雜項購置）
    if (mi === 0) {
      addDoc(VENDORS.equip, dayOf(ym, 3), [{ name: '半自動義式咖啡機（雙孔）', qty: 1, price: 189000 }], { summary: '義式咖啡機', account: '1511' });
      addDoc(VENDORS.equip, dayOf(ym, 4), [{ name: '方冰製冰機 60kg', qty: 1, price: 99750 }], { summary: '製冰機', account: '1521' });
    }
    if (mi === 1) addDoc(VENDORS.equip, dayOf(ym, 16), [{ name: '定量磨豆機', qty: 1, price: 46200 }], { summary: '磨豆機', account: '6135' });
    for (const d of [3, 13, 23]) {
      const items = [{ name: '配方咖啡豆', qty: int(3, 5), price: 680 }];
      if (d === 13) items.push({ name: '單品咖啡豆（衣索比亞）', qty: 1, price: 1100 });
      addDoc(VENDORS.bean, dayOf(ym, d), items, { summary: `咖啡豆${items.reduce((t, i) => t + i.qty, 0)}kg` });
    }
    for (const d of [2, 9, 16, 23, 30]) addDoc(VENDORS.milk, dayOf(ym, d), [{ name: '鮮乳936ml', qty: int(14, 22), price: 95 }, { name: '燕麥奶1L', qty: int(5, 9), price: 135 }], { summary: '鮮乳燕麥奶' });
    addDoc(VENDORS.tea, dayOf(ym, 8), [{ name: '伯爵紅茶葉', qty: 1, price: 1200 }, { name: '抹茶粉', qty: 1, price: 1960 }], { summary: '茶葉抹茶粉' });
    for (const d of [6, 20]) addDoc(VENDORS.bake, dayOf(ym, d), [{ name: '奶油乳酪', qty: int(3, 4), price: 420 }, { name: '冷凍可頌麵團', qty: 60, price: 22 }, { name: '無鹽奶油', qty: 2, price: 310 }], { summary: '奶油乳酪可頌麵團' });
    addDoc(VENDORS.pack, dayOf(ym, 15), [{ name: '12oz紙杯', qty: 1000, price: 2.2 }, { name: '杯蓋', qty: 1000, price: 1 }, { name: '外帶提袋', qty: 200, price: 3 }], { summary: '紙杯杯蓋提袋' });
    addDoc(VENDORS.power, dayOf(ym, 18), [{ name: '電費（營業用）', qty: 1, price: 4800 + int(0, 1400) }], { summary: '電費' });
    addDoc(VENDORS.tel, dayOf(ym, 12), [{ name: '光世代 300M 月租', qty: 1, price: 1399 }], { summary: '網路費' });
    addDoc(VENDORS.landlord, dayOf(ym, 5), [{ name: `${Number(ym.slice(5))} 月店面租金`, qty: 1, price: 35000 }], { summary: '店租', nameAmount: true });
    addDoc(VENDORS.costco, dayOf(ym, 21), [{ name: '洗碗精', qty: 2, price: 259 }, { name: '廚房紙巾', qty: 1, price: 399 }, { name: '垃圾袋', qty: 1, price: 189 }], { summary: '清潔用品' });
    addDoc(VENDORS.acct, dayOf(ym, 25), [{ name: '記帳服務費', qty: 1, price: 3000 }], { summary: '記帳費' });
    if (mi === 1) addDoc(VENDORS.daiso, dayOf(ym, 11), [{ name: '收納盒', qty: 4, price: 49 }, { name: '量匙組', qty: 2, price: 49 }], { summary: '收納盒量匙' });
    // 金流手續費發票：已過完的月份才開（付款方式＝各金流未撥款項，手續費以發票入帳）
    const end = monthEnd(ym);
    if (end <= to) {
      const monthOrders = orders.filter((o) => o.date.startsWith(ym));
      for (const [pay, v] of [['card', VENDORS.ecpay], ['linepay', VENDORS.linepay], ['jkopay', VENDORS.jko], ['taiwanpay', VENDORS.twpay], ['platform', VENDORS.uber]]) {
        const fee = monthOrders.filter((o) => o.pay === pay).reduce((t, o) => t + feeOf(o), 0);
        if (fee) addDoc(v, end, [{ name: pay === 'platform' ? '平台服務費' : '金流手續費', qty: 1, price: fee }], { summary: pay === 'platform' ? '外送平台服務費' : '金流手續費', status: 'posted' });
      }
    }
  }
  // 待覆核的示範：重複、買方不是本店、一張照片兩張發票、沒有 QR 的收據
  const posted = docs.filter((d) => d.status === 'posted' && d.vendor_name === '森林烘豆坊').sort((a, b) => (a.doc_date < b.doc_date ? 1 : -1))[0];
  if (posted) {
    const img = images.get(posted.id);
    const dupDate = addDays(today, -3);
    addDoc(VENDORS.bean, dupDate, img.items, { inv: posted.invoice_no, file: `${dupDate.replace(/-/g, '')}-${posted.invoice_no}-森林烘豆坊-咖啡豆（重拍）.jpg`, image: { ...img, tilt: -2.4 }, status: 'inbox' });
  }
  addDoc(VENDORS.bake, addDays(today, -4), [{ name: '奶油乳酪', qty: 2, price: 420 }, { name: '鮮奶油1L', qty: 3, price: 210 }], { summary: '奶油乳酪鮮奶油', buyer: OTHER_COMPANY, status: 'inbox' });
  {
    const date = addDays(today, -2);
    const a = invNo(VENDORS.equip);
    const b = invNo(VENDORS.equip);
    const ia = [{ name: '磨豆機刀盤更換', qty: 1, price: 3800 }];
    const ib = [{ name: '咖啡機保養', qty: 1, price: 2500 }, { name: '濾水器濾心', qty: 2, price: 650 }];
    const ta = ia.reduce((t, i) => t + i.qty * i.price, 0);
    const tb = ib.reduce((t, i) => t + i.qty * i.price, 0);
    const sa = { kind: 'invoice', seller_name: VENDORS.equip.name, seller: VENDORS.equip.tax, buyer: SHOP_TAX_ID, invoice_no: a, date, time: '14:02:11', random: '4821', total: ta, sales_ex: ta - vatOf(ta), tax: vatOf(ta), items: ia };
    const sb = { kind: 'invoice', seller_name: VENDORS.equip.name, seller: VENDORS.equip.tax, buyer: SHOP_TAX_ID, invoice_no: b, date, time: '14:02:48', random: '0937', total: tb, sales_ex: tb - vatOf(tb), tax: vatOf(tb), items: ib };
    addDoc(VENDORS.equip, date, [...ia, ...ib], { inv: null, file: `${date.replace(/-/g, '')}-${a}+${b}-晨光咖啡器材-磨豆機刀盤及保養.jpg`, image: { kind: 'pair', invoices: [sa, sb] }, status: 'inbox' });
  }
  addDoc(VENDORS.hardware, addDays(today, -1), [{ name: '延長線', qty: 2, price: 180 }, { name: '掛勾', qty: 6, price: 15 }], { summary: '延長線掛勾', nameAmount: true, status: 'inbox' });

  // 已入帳憑證的分錄
  const entries = [];
  const addEntry = (e) => {
    const full = { id: 'je_' + fnv1a(`${e.date}|${e.description}|${entries.length}`), status: 'posted', attachments: [], created_at: `${e.date}T12:00:00+08:00`, ...e };
    full.voucher_no = nextVoucherNo(entries, e.date);
    entries.push(full);
    return full;
  };
  const sorted = [...docs].sort((a, b) => ((a.doc_date || '') < (b.doc_date || '') ? -1 : 1));
  for (const d of sorted.filter((x) => x.status === 'posted')) {
    const je = documentJournal(d, { deductible: d.deductible });
    const e = addEntry({ ...je, attachments: [d.id] });
    d.entry_id = e.id;
    d.archived_name = archiveName(d, '.jpg');
  }
  // 固定資產（入帳時自動建立的那種）
  for (const d of docs.filter((x) => x.status === 'posted' && ['1511', '1521'].includes(x.account))) {
    const tax = d.deductible ? Number(d.tax_amount) || 0 : 0;
    const fa = { id: 'fa_' + d.id.slice(4), name: d.summary, category: d.account === '1511' ? 'machine' : 'equipment', acquired_on: d.doc_date, cost: d.amount_total - tax, life_years: 5, residual: null, supplier: d.vendor_name, invoice_no: d.invoice_no, tax_amount: tax || null, pay_account: d.pay_account, doc_ids: [d.id], purchase_entry_id: d.entry_id, note: '入帳時自動建立' };
    C.fixed_assets.push(fa);
    d.asset_id = fa.id;
  }

  // ── 銀行：期初、撥款入帳、現金存入、房租水電、薪資、勞健保、月結貨款、員工代墊請款
  const bank = [];
  const bankLine = (date, description, { w = 0, dep = 0, counterparty = '' }) => bank.push({ date, description, withdrawal: w, deposit: dep, counterparty });
  const opening = 600000;
  C.bank_accounts.push({ id: 'main', name: '主要帳戶', bank: '示範銀行', last4: '0168', gl_account: '1103', opening_date: addDays(from, -1), opening_balance: opening });
  addEntry({ date: from, description: '期初開帳（業主投入資本）', source: 'manual', lines: [{ account: '1103', debit: opening, credit: 0, memo: '銀行存款期初' }, { account: '1101', debit: 10000, credit: 0, memo: '門市零用金' }, { account: '1102', debit: 5000, credit: 0, memo: '會計行政零用金' }, { account: '3101', debit: 0, credit: opening + 15000, memo: '' }] });
  for (const p of C.payouts) bankLine(p.payout_date, `${{ ecpay: '綠界', linepay: 'LINE Pay', jkopay: '街口', taiwanpay: '台灣Pay', platform: 'Uber Eats' }[p.provider]} 撥款`, { dep: p.net, counterparty: p.ref });
  for (const d of docs.filter((x) => x.status === 'posted' && x.pay_account === '1103')) bankLine(d.doc_date, `轉帳 ${d.vendor_name}`, { w: d.amount_total, counterparty: d.vendor_name });
  // 現金營收每週一存入銀行（留 2,000 找零）
  for (const d of eachDay(from, to).filter((x) => weekdayIndex(x) === 0 && x > from)) {
    const cash = orders.filter((o) => o.pay === 'cash' && o.date < d && o.date >= addDays(d, -7)).reduce((t, o) => t + o.total, 0);
    const amt = Math.max(0, Math.floor((cash - 2000) / 100) * 100);
    if (!amt) continue;
    addEntry({ date: d, description: '門市現金存入銀行', source: 'manual', lines: [{ account: '1103', debit: amt, credit: 0, memo: '' }, { account: '1101', debit: 0, credit: amt, memo: '' }] });
    bankLine(d, '現金存入', { dep: amt });
  }
  for (const ym of months) {
    const pay10 = dayOf(ym, 10);
    if (pay10) {
      addEntry({ date: pay10, description: `${Number(ym.slice(5))} 月薪資`, source: 'manual', lines: [{ account: '6101', debit: 64000, credit: 0, memo: '正職 1 名、計時 2 名' }, { account: '1103', debit: 0, credit: 64000, memo: '' }] });
      bankLine(pay10, '薪資轉帳', { w: 64000 });
    }
    const last = monthEnd(ym) <= to ? monthEnd(ym) : null;
    if (last) {
      addEntry({ date: last, description: `${Number(ym.slice(5))} 月勞健保（雇主負擔）`, source: 'manual', lines: [{ account: '6119', debit: 9800, credit: 0, memo: '' }, { account: '1103', debit: 0, credit: 9800, memo: '' }] });
      bankLine(last, '勞健保費', { w: 9800 });
    }
    // 上個月的月結貨款在 5 日付清；員工代墊在 1 日、16 日請款
    const pay5 = dayOf(ym, 5);
    if (pay5) {
      const prev = addMonths(ym, -1);
      const byVendor = new Map();
      for (const d of docs.filter((x) => x.status === 'posted' && x.pay_account === '2111' && x.doc_date.startsWith(prev))) byVendor.set(d.vendor_name, (byVendor.get(d.vendor_name) || 0) + d.amount_total);
      for (const [v, amt] of byVendor) {
        addEntry({ date: pay5, description: `支付 ${v} ${Number(prev.slice(5))} 月貨款`, source: 'manual', lines: [{ account: '2111', debit: amt, credit: 0, memo: v }, { account: '1103', debit: 0, credit: amt, memo: '' }] });
        bankLine(pay5, `轉帳 ${v}`, { w: amt, counterparty: v });
      }
    }
    for (const day of [1, 16]) {
      const pd = dayOf(ym, day);
      if (!pd) continue;
      const fromD = day === 1 ? `${addMonths(ym, -1)}-16` : `${ym}-01`;
      const amt = docs.filter((x) => x.status === 'posted' && x.pay_account === '2134' && x.doc_date >= fromD && x.doc_date < pd).reduce((t, d) => t + d.amount_total, 0);
      if (!amt) continue;
      addEntry({ date: pd, description: '員工代墊款請款', source: 'manual', lines: [{ account: '2134', debit: amt, credit: 0, memo: '' }, { account: '1103', debit: 0, credit: amt, memo: '' }] });
      bankLine(pd, '轉帳 員工代墊款', { w: amt });
    }
  }
  bank.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.deposit - a.deposit));
  let bal = opening;
  bank.forEach((b, i) => {
    bal = round2(bal + b.deposit - b.withdrawal);
    C.bank_lines.push({ id: `bk_${fnv1a(b.date + b.description + i)}_1`, batch_id: 'b_bank', bank_account_id: 'main', date: b.date, description: b.description, withdrawal: b.withdrawal, deposit: b.deposit, balance: bal, note: '', counterparty: b.counterparty, match_key: null });
  });
  C.import_batches.push({ id: 'b_bank', target: 'bank', file_name: '網銀交易明細.csv', row_count: C.bank_lines.length, added: C.bank_lines.length, skipped: 0, date_from: from, date_to: to, imported_at: `${to}T21:30:00+08:00` });

  // ── 財政部電子發票（進項）：有照片的會自動連結；另有幾張沒拍照的待入帳
  for (const d of docs.filter((x) => x.status === 'posted' && x.invoice_no && x.doc_date >= `${months[2]}-01`).slice(0, 10)) {
    C.einvoices.push({ id: 'inv_' + fnv1a(d.invoice_no + '|' + d.doc_date), batch_id: 'b_mof', invoice_no: d.invoice_no, date: d.doc_date, seller_tax_id: d.vendor_tax_id, seller_name: d.vendor_name, buyer_tax_id: SHOP_TAX_ID, total: d.amount_total, tax: d.tax_amount || 0, status: '已確認', voided: false, deductible: !!d.deductible, items: (d.items || []).map((i) => ({ name: i.name, amount: i.amount })), suggested_account: d.account, account: d.account, document_id: d.id, entry_id: d.entry_id, confidence: 0.9 });
    d.einvoice_id = C.einvoices[C.einvoices.length - 1].id;
  }
  for (const [name, item, total, acc, offset] of [
    ['書香文具行', '收據本、原子筆', 260, '6112', 12],
    ['快捷物流', '宅配運費', 150, '6114', 9],
    ['巷口便利商店', '冰塊 3 包', 105, '6133', 6],
  ]) {
    const date = addDays(today, -offset);
    const no = `QZ${pad(20000000 + offset * 7, 8)}`;
    C.einvoices.push({ id: 'inv_' + fnv1a(no), batch_id: 'b_mof', invoice_no: no, date, seller_tax_id: taxId(81000000 + offset * 1000), seller_name: name, buyer_tax_id: SHOP_TAX_ID, total, tax: vatOf(total), status: '已確認', voided: false, deductible: true, items: [{ name: item, amount: total }], suggested_account: acc, confidence: 0.75 });
  }

  // ── 供應商、原物料、進貨與盤點
  for (const [k, v] of Object.entries(VENDORS)) if (v.terms) C.suppliers.push({ id: 'sp_' + k, name: v.short, tax_id: v.tax || '', contact: '業務窗口', phone: '02-0000-' + pad(Object.keys(VENDORS).indexOf(k) + 100, 4), terms: v.terms, note: '' });
  for (const it of INVENTORY) {
    const { supplier, ...rest } = it;
    C.inventory_items.push({ ...rest, sku: it.id.slice(3).toUpperCase(), supplier_id: 'sp_' + supplier, active: true });
    C.inventory_moves.push({ id: 'mv_open_' + it.id, item_id: it.id, date: from, type: 'opening', qty: it.reorder_qty, amount: round2(it.reorder_qty * it.std_cost), note: '期初盤點' });
  }
  const ITEM_OF = { 配方咖啡豆: 'it_bean', '單品咖啡豆（衣索比亞）': 'it_bean_so', 鮮乳936ml: 'it_milk', 燕麥奶1L: 'it_oat', 伯爵紅茶葉: 'it_earl', 抹茶粉: 'it_matcha', 奶油乳酪: 'it_cheese', 冷凍可頌麵團: 'it_croissant', '12oz紙杯': 'it_cup', 杯蓋: 'it_lid' };
  for (const d of docs.filter((x) => x.status === 'posted')) {
    for (const i of d.items || []) {
      const item = ITEM_OF[i.name];
      if (!item) continue;
      const ex = d.deductible ? round2((i.amount * (d.amount_total - (d.tax_amount || 0))) / d.amount_total) : i.amount;
      C.inventory_moves.push({ id: `mv_${fnv1a(d.id + i.name)}`, item_id: item, date: d.doc_date, type: 'purchase', qty: i.qty, amount: ex, supplier_id: 'sp_' + Object.keys(VENDORS).find((k) => VENDORS[k].short === d.vendor_name), order_date: addDays(d.doc_date, -2), yield_score: int(3, 5), invoice_no: d.invoice_no, note: '' });
    }
  }
  for (const ym of months) {
    const last = monthEnd(ym);
    if (last > to) continue;
    for (const it of INVENTORY.slice(0, 4)) C.inventory_moves.push({ id: `mv_adj_${it.id}_${ym}`, item_id: it.id, date: last, type: 'adjust', qty: -kg(R() * it.safety_stock * 0.3), amount: 0, note: '月底盤點差異' });
  }

  C.journal_entries = entries;
  C.documents = docs;
  return { collections: C, images, range: { from, to, today } };
}
