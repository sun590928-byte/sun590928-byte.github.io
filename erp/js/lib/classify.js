// 支出憑證建議科目：依賣方名稱與品項關鍵字（AI 辨識前的規則式判斷，也作為 AI 結果的備援）。

import { normalizeText } from './text.js';

const RULES = [
  { account: '1211', label: '咖啡豆', re: /咖啡豆|熟豆|生豆|烘焙豆|roast|coffee\s*bean|配方豆|單品豆|莊園|衣索比亞|耶加|肯亞|哥倫比亞|瓜地馬拉|巴拿馬|藝伎|geisha/i },
  { account: '1212', label: '乳品', re: /鮮奶|鮮乳|牛奶|牛乳|燕麥奶|豆漿|鮮奶油|動物性|植物奶|乳品|oatly|光泉|林鳳營|瑞穗|福樂|初鹿|四方|味全|milk|cream/i },
  { account: '1213', label: '茶葉粉類糖漿', re: /茶葉|紅茶|綠茶|烏龍|伯爵|抹茶|焙茶|可可粉|巧克力醬|糖漿|果露|蜂蜜|砂糖|黑糖|冰糖|monin|糖包|syrup|tea|氣泡水|碳酸水|果汁|椰子水|蘇打/i },
  { account: '1214', label: '甜點輕食原料', re: /麵粉|奶油|雞蛋|蛋(?!糕模)|起司|乳酪|奶霜|可頌|吉利丁|香草精|水果|草莓|檸檬|藍莓|堅果|杏仁|開心果|抹醬|餅乾|吐司|麵包|上白糖|紅豆|烘焙材料|butter|cheese|flour|egg/i },
  { account: '1215', label: '包材耗材', re: /紙杯|杯蓋|吸管|杯套|杯袋|提袋|紙袋|外帶|包材|封口|濾紙|濾杯紙|餐巾紙|擦手紙|廚房紙巾|防漏紙|杯架|塑膠杯|pet杯|紙盒|餐盒|保鮮膜|鋁箔|cup|lid|straw/i },
  { account: '6118', label: '水電瓦斯', re: /台灣電力|台電|電費|自來水|水費|瓦斯(?!噴槍|爐)|天然氣|欣[一-龥]瓦斯/ },
  { account: '6115', label: '郵電費', re: /中華電信|台灣大哥大|遠傳|亞太電信|台灣之星|網路費|電話費|市話|月租|郵局|郵資|中華郵政/ },
  { account: '6111', label: '租金', re: /租金|房租|店租|管理費/ },
  { account: '6116', label: '修繕', re: /維修|修繕|保養|濾心|濾芯|校正|水電工程|修理|塗料|油漆|防水|擋縫條|防震墊|窗貼/ },
  { account: '6117', label: '廣告', re: /廣告|印刷|名片|dm|傳單|海報|facebook|meta|instagram|google\s*ads|設計費|菜單印製|貼紙印製/i },
  { account: '6114', label: '運費', re: /運費|物流費|宅配|黑貓|宅急便|新竹物流|嘉里|順豐|快遞|lalamove|貨運/i },
  { account: '6133', label: '雜項費用', re: /清潔|洗碗精|洗潔|抹布|垃圾袋|漂白|消毒|酒精|除蟲|病媒|清洗劑|洗手乳|防蚊|蚊香|電池|雜支/ },
  { account: '6134', label: '軟體訂閱', re: /訂閱|subscription|雲端|pos\s*月費|軟體|app\s*store|google\s*workspace|canva|notion|電子發票設定|系統設定|設定費|加值服務|系統服務費/i },
  { account: '6135', label: '雜項購置', re: /器具|工具|刮刀|量匙|湯匙|茶匙|叉|刀具|砧板|鍋|壺|玻璃杯|陶瓷杯|酒杯|馬克杯|茶杯|杯組|盤|碗|碟|托盤|收納|層板|置物|架子|凳|椅|桌|燈|電鑽|起子|掃描器|價目牌|標示牌|噴霧瓶|密封|模具|蛋糕模|粉篩|打蛋|量杯|電子秤|計時器|延長線|插座|風扇|餐墊|蓋巾|毛巾|純水機|淨水器/ },
  { account: '6136', label: '規費', re: /規費|商標|智慧財產局|登記費|工商憑證|執照|印鑑證明/ },
  { account: '6112', label: '文具用品', re: /文具|影印|碳粉|墨水|紙張|原子筆|奇異筆|油性筆|膠帶|釘書|訂書機|收據本|發票紙|感熱紙|板夾|資料夾/ },
  { account: '6126', label: '伙食', re: /便當|員工餐|餐費|午餐|晚餐/ },
  { account: '6132', label: '勞務費', re: /記帳|會計師|代書|律師|顧問費|勞務/ },
  { account: '6131', label: '手續費', re: /手續費|匯費|轉帳費|金流|linepay|line\s*pay|ecpay|綠界/i },
  { account: '6119', label: '保險', re: /勞保|健保|勞退|保險|產險|公共意外/ },
  { account: '6122', label: '稅捐', re: /營業稅|印花稅|牌照稅|房屋稅|地價稅|稅款|國稅局/ },
];

// 綜合型賣場：需看品項，無法判斷時給低信心
const GENERAL_STORES = /全聯|家樂福|好市多|costco|大潤發|愛買|頂好|美廉社|7-?eleven|統一超商|全家|萊爾富|ok超商|momo|pchome|蝦皮|shopee|小北百貨|寶雅|大創|ikea|屈臣氏|康是美/i;

export function classifyExpense({ vendor = '', items = [], text = '' } = {}) {
  const itemText = normalizeText([].concat(items).map((i) => (typeof i === 'string' ? i : i.name)).join(' '));
  const vendorText = normalizeText(vendor);
  const all = `${vendorText} ${itemText} ${normalizeText(text)}`;
  const scores = new Map();
  for (const r of RULES) {
    let s = 0;
    if (r.re.test(itemText)) s += 2;
    if (r.re.test(vendorText)) s += 1.5;
    if (!s && r.re.test(all)) s += 1;
    if (s) scores.set(r.account, (scores.get(r.account) || 0) + s);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { account: '6199', confidence: GENERAL_STORES.test(vendorText) ? 0.2 : 0.3, label: '其他費用', alternatives: [] };
  const [acc, sc] = ranked[0];
  const second = ranked[1]?.[1] || 0;
  let confidence = Math.min(0.9, 0.45 + 0.15 * sc - 0.1 * second);
  if (GENERAL_STORES.test(vendorText) && !itemText) confidence = Math.min(confidence, 0.4);
  return { account: acc, confidence: Math.max(0.2, confidence), label: RULES.find((r) => r.account === acc).label, alternatives: ranked.slice(1, 3).map((x) => x[0]) };
}

// 統一發票號碼：2 碼英文 + 8 碼數字（前後不能緊接英數字；底線、連字號等分隔符號可以）
export const INVOICE_RE = /(?<![A-Za-z0-9])([A-Z]{2})[-\s]?(\d{8})(?!\d)/;

export function isValidTaxId(id) {
  // 營利事業統一編號檢查碼（2023 起除數改為 5，並相容舊制 10）
  if (!/^\d{8}$/.test(id)) return false;
  const w = [1, 2, 1, 2, 1, 2, 4, 1];
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const p = Number(id[i]) * w[i];
    sum += Math.floor(p / 10) + (p % 10);
  }
  return sum % 5 === 0 || (id[6] === '7' && (sum + 1) % 5 === 0);
}
