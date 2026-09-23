// 咖啡飲品業專用會計項目表。
// 費用科目對齊「營利事業所得稅結算申報書」費用欄位（taxLine），年度申報可直接彙總。
// type: asset / liability / equity / revenue / cogs / expense / nonop_income / nonop_expense / tax
// side: 正常餘額方向（contra 科目為相反方向）；behavior: fixed / variable（營運損益固定/變動成本）

const A = (code, name, type, extra = {}) => ({ code, name, type, side: ['asset', 'cogs', 'expense', 'nonop_expense', 'tax'].includes(type) ? 'debit' : 'credit', ...extra });

export const DEFAULT_ACCOUNTS = [
  // ── 流動資產
  A('1101', '庫存現金（收銀機）', 'asset', { grp: 'current', hint: '每日收銀現金營收' }),
  A('1102', '零用金', 'asset', { grp: 'current', hint: '小額採買週轉' }),
  A('1103', '銀行存款', 'asset', { grp: 'current', hint: '主要營業帳戶；多帳戶可新增 1104、1105' }),
  A('1111', '在途款項－綠界信用卡', 'asset', { grp: 'current', hint: '刷卡營收，待綠界撥款' }),
  A('1112', '在途款項－LINE Pay', 'asset', { grp: 'current', hint: 'LINE Pay 營收，待撥款' }),
  A('1113', '在途款項－其他行動支付', 'asset', { grp: 'current', hint: '街口、台灣Pay、悠遊卡等' }),
  A('1114', '在途款項－外送平台', 'asset', { grp: 'current', hint: 'Uber Eats、foodpanda 待撥款' }),
  A('1141', '應收帳款', 'asset', { grp: 'current' }),
  A('1151', '其他應收款', 'asset', { grp: 'current' }),
  A('1211', '存貨－咖啡豆', 'asset', { grp: 'current', hint: '熟豆、生豆、配方豆' }),
  A('1212', '存貨－乳品', 'asset', { grp: 'current', hint: '鮮奶、燕麥奶、鮮奶油' }),
  A('1213', '存貨－茶葉粉類糖漿', 'asset', { grp: 'current', hint: '茶葉、抹茶粉、可可粉、糖漿' }),
  A('1214', '存貨－甜點輕食原料', 'asset', { grp: 'current', hint: '麵粉、奶油、起司、雞蛋、水果' }),
  A('1215', '存貨－包材耗材', 'asset', { grp: 'current', hint: '杯、蓋、吸管、提袋、濾紙' }),
  A('1216', '存貨－零售商品', 'asset', { grp: 'current', hint: '販售用豆、濾掛、周邊' }),
  A('1251', '預付費用', 'asset', { grp: 'current' }),
  A('1252', '預付租金', 'asset', { grp: 'current' }),
  A('1261', '進項稅額', 'asset', { grp: 'current', hint: '可扣抵之進項營業稅' }),
  A('1262', '留抵稅額', 'asset', { grp: 'current' }),
  A('1291', '暫付款', 'asset', { grp: 'current' }),
  // ── 非流動資產
  A('1511', '生財器具－咖啡機磨豆機', 'asset', { grp: 'noncurrent', hint: '義式咖啡機、磨豆機、手沖器材（達資本化門檻）' }),
  A('1512', '累計折舊－生財器具', 'asset', { grp: 'noncurrent', contra: true, side: 'credit' }),
  A('1521', '營業設備－冷藏製冰烘焙', 'asset', { grp: 'noncurrent', hint: '冰箱、製冰機、烤箱、淨水設備' }),
  A('1522', '累計折舊－營業設備', 'asset', { grp: 'noncurrent', contra: true, side: 'credit' }),
  A('1531', '辦公資訊設備', 'asset', { grp: 'noncurrent', hint: 'POS、電腦、收銀機' }),
  A('1532', '累計折舊－辦公資訊設備', 'asset', { grp: 'noncurrent', contra: true, side: 'credit' }),
  A('1541', '租賃改良（裝潢）', 'asset', { grp: 'noncurrent', hint: '店面裝潢工程' }),
  A('1542', '累計折舊－租賃改良', 'asset', { grp: 'noncurrent', contra: true, side: 'credit' }),
  A('1811', '存出保證金', 'asset', { grp: 'noncurrent', hint: '押租金、押金' }),
  A('1891', '其他非流動資產', 'asset', { grp: 'noncurrent' }),
  // ── 負債
  A('2101', '短期借款', 'liability', { grp: 'current' }),
  A('2111', '應付帳款', 'liability', { grp: 'current', hint: '供應商月結貨款' }),
  A('2121', '應付薪資', 'liability', { grp: 'current' }),
  A('2122', '應付費用', 'liability', { grp: 'current', hint: '應付水電、租金、記帳費' }),
  A('2131', '銷項稅額', 'liability', { grp: 'current' }),
  A('2132', '應付營業稅', 'liability', { grp: 'current' }),
  A('2141', '代收款－勞健保扣繳', 'liability', { grp: 'current', hint: '員工自付勞健保、代扣所得稅' }),
  A('2151', '預收款項－寄杯', 'liability', { grp: 'current', hint: '寄杯售出時入此科目，兌換時轉收入' }),
  A('2152', '預收款項－儲值禮券', 'liability', { grp: 'current' }),
  A('2161', '暫收款', 'liability', { grp: 'current', hint: '來源未明入帳，待查' }),
  A('2191', '業主（股東）往來', 'liability', { grp: 'current', hint: '老闆個人代墊的店務支出' }),
  A('2501', '長期借款', 'liability', { grp: 'noncurrent' }),
  // ── 權益
  A('3101', '資本（業主投資）', 'equity'),
  A('3102', '業主提取', 'equity', { contra: true, side: 'debit' }),
  A('3201', '累積盈虧', 'equity', { hint: '以前年度損益' }),
  A('3301', '本期損益', 'equity', { hint: '年底結帳轉入' }),
  // ── 營業收入
  A('4101', '銷貨收入－咖啡飲品', 'revenue', { hint: '美式、拿鐵、手沖、冰釀等' }),
  A('4102', '銷貨收入－非咖啡飲品', 'revenue', { hint: '茶飲、可可、氣泡飲' }),
  A('4103', '銷貨收入－甜點輕食', 'revenue'),
  A('4104', '銷貨收入－咖啡豆與零售', 'revenue', { hint: '豆子、濾掛、周邊' }),
  A('4105', '銷貨收入－其他', 'revenue'),
  A('4106', '寄杯兌換收入', 'revenue', { hint: '寄杯兌換時由預收款轉入' }),
  A('4191', '銷貨退回及折讓', 'revenue', { contra: true, side: 'debit' }),
  A('4192', '銷貨折扣－促銷活動', 'revenue', { contra: true, side: 'debit', hint: '時段折扣、買一送一' }),
  // ── 營業成本
  A('5101', '銷貨成本－飲品原料', 'cogs', { behavior: 'variable', hint: '豆、奶、茶、糖漿' }),
  A('5102', '銷貨成本－甜點輕食', 'cogs', { behavior: 'variable' }),
  A('5103', '銷貨成本－零售商品', 'cogs', { behavior: 'variable' }),
  A('5104', '包材耗材成本', 'cogs', { behavior: 'variable', hint: '杯、蓋、吸管、提袋' }),
  A('5105', '存貨報廢損失', 'cogs', { behavior: 'variable', hint: 'POS 標記「報廢」之成本' }),
  A('5106', '存貨盤盈虧', 'cogs', { behavior: 'variable', hint: '盤點差異' }),
  // ── 營業費用（依營所稅申報書順序）
  A('6101', '薪資支出－正職', 'expense', { behavior: 'fixed', tax_line: '薪資支出' }),
  A('6102', '薪資支出－計時人員', 'expense', { behavior: 'variable', tax_line: '薪資支出' }),
  A('6111', '租金支出', 'expense', { behavior: 'fixed', tax_line: '租金支出' }),
  A('6112', '文具用品', 'expense', { behavior: 'fixed', tax_line: '文具用品' }),
  A('6113', '旅費', 'expense', { behavior: 'fixed', tax_line: '旅費' }),
  A('6114', '運費', 'expense', { behavior: 'variable', tax_line: '運費', hint: '叫貨運費、宅配' }),
  A('6115', '郵電費', 'expense', { behavior: 'fixed', tax_line: '郵電費', hint: '電話、網路' }),
  A('6116', '修繕費', 'expense', { behavior: 'fixed', tax_line: '修繕費', hint: '咖啡機保養維修、濾水器換芯' }),
  A('6117', '廣告費', 'expense', { behavior: 'fixed', tax_line: '廣告費', hint: '社群廣告、印刷、菜單設計' }),
  A('6118', '水電瓦斯費', 'expense', { behavior: 'variable', tax_line: '水電瓦斯費' }),
  A('6119', '保險費', 'expense', { behavior: 'fixed', tax_line: '保險費', hint: '勞健保雇主負擔、公共意外險' }),
  A('6120', '交際費', 'expense', { behavior: 'variable', tax_line: '交際費', hint: 'POS 標記「老闆招待」之成本' }),
  A('6121', '捐贈', 'expense', { tax_line: '捐贈' }),
  A('6122', '稅捐', 'expense', { behavior: 'fixed', tax_line: '稅捐', hint: '小規模營業稅、印花稅' }),
  A('6123', '呆帳損失', 'expense', { tax_line: '呆帳損失' }),
  A('6124', '折舊', 'expense', { behavior: 'fixed', tax_line: '折舊' }),
  A('6125', '各項攤提', 'expense', { behavior: 'fixed', tax_line: '各項耗竭及攤提' }),
  A('6126', '伙食費', 'expense', { behavior: 'variable', tax_line: '伙食費', hint: '員工餐' }),
  A('6127', '職工福利', 'expense', { tax_line: '職工福利' }),
  A('6128', '研究發展費', 'expense', { behavior: 'variable', tax_line: '研究發展費', hint: 'POS 標記「老闆測試」之成本、新品試作' }),
  A('6129', '佣金支出', 'expense', { behavior: 'variable', tax_line: '佣金支出', hint: '外送平台抽成' }),
  A('6130', '訓練費', 'expense', { tax_line: '訓練費' }),
  A('6131', '手續費', 'expense', { behavior: 'variable', tax_line: '其他費用', hint: '綠界、LINE Pay 金流手續費、匯費' }),
  A('6132', '勞務費', 'expense', { behavior: 'fixed', tax_line: '勞務費', hint: '記帳士、設計' }),
  A('6133', '清潔衛生費', 'expense', { behavior: 'fixed', tax_line: '其他費用' }),
  A('6134', '軟體訂閱費', 'expense', { behavior: 'fixed', tax_line: '其他費用', hint: 'POS、雲端服務' }),
  A('6135', '雜項購置', 'expense', { behavior: 'fixed', tax_line: '其他費用', hint: '小器具（未達資本化門檻）' }),
  A('6199', '其他費用', 'expense', { behavior: 'fixed', tax_line: '其他費用' }),
  // ── 營業外
  A('7101', '利息收入', 'nonop_income'),
  A('7102', '其他收入', 'nonop_income', { hint: '補助款、獎勵金' }),
  A('7103', '處分資產利益', 'nonop_income'),
  A('7501', '利息費用', 'nonop_expense'),
  A('7502', '處分資產損失', 'nonop_expense'),
  A('7503', '其他損失', 'nonop_expense'),
  A('8101', '所得稅費用', 'tax'),
];

export const TYPE_LABELS = {
  asset: '資產',
  liability: '負債',
  equity: '權益',
  revenue: '營業收入',
  cogs: '營業成本',
  expense: '營業費用',
  nonop_income: '營業外收入',
  nonop_expense: '營業外支出',
  tax: '所得稅',
};

// 損益類科目（年底結帳歸零）
export const PL_TYPES = new Set(['revenue', 'cogs', 'expense', 'nonop_income', 'nonop_expense', 'tax']);

// 銷售品類 → 收入科目
export const REVENUE_ACCOUNT_BY_CATEGORY = {
  coffee: '4101',
  non_coffee: '4102',
  food: '4103',
  retail: '4104',
  other: '4105',
  prepaid: '2151',
};

// 付款方式 → 借方科目
export const DEBIT_ACCOUNT_BY_PAYMENT = {
  cash: '1101',
  card: '1111',
  linepay: '1112',
  jkopay: '1113',
  mobile: '1113',
  ecard: '1113',
  platform: '1114',
  transfer: '1103',
  prepaid: '2151',
  voucher: '2152',
  unknown: '1101',
};

// 固定資產類別 → 資產／累計折舊科目、建議耐用年限（僅供參考，實際依財政部耐用年數表）
export const ASSET_CATEGORIES = {
  machine: { label: '生財器具（咖啡機、磨豆機）', asset: '1511', accum: '1512', life: 5 },
  equipment: { label: '營業設備（冷藏、製冰、烘焙）', asset: '1521', accum: '1522', life: 5 },
  it: { label: '辦公資訊設備（POS、電腦）', asset: '1531', accum: '1532', life: 3 },
  leasehold: { label: '租賃改良（裝潢）', asset: '1541', accum: '1542', life: 5 },
};

export function accountMap(accounts) {
  return new Map(accounts.map((a) => [a.code, a]));
}

export function accountLabel(a) {
  return a ? `${a.code} ${a.name}` : '';
}

// 以名稱模糊對應既有科目（匯入舊帳用）
export function findAccountByName(accounts, name) {
  const n = String(name || '').replace(/\s/g, '');
  if (!n) return null;
  const exact = accounts.find((a) => a.name.replace(/\s/g, '') === n);
  if (exact) return exact;
  const stripped = n.replace(/[－\-–—].*$/, '');
  return accounts.find((a) => a.name.replace(/[－\-–—].*$/, '') === stripped && stripped.length >= 2) || accounts.find((a) => a.name.includes(n) || n.includes(a.name.replace(/（.*）/, ''))) || null;
}
