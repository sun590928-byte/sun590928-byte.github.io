// 文字辨識（OCR）結果 → 發票欄位。OCR 的字常有雜訊，所以每個欄位都用規則交叉驗證：
// 統編要通過檢查碼、未稅＋稅額＝總額且稅額約 5%、日期要合理、發票號碼要符合字軌格式。
// 純計算，可單獨測試。

import { isValidTaxId } from './classify.js';

const CJK = '\\u3400-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef';
const SPACE_NEAR_CJK = new RegExp(`(?<=[${CJK}])[ \\t]+|[ \\t]+(?=[${CJK}])`, 'g');

/** 整理 OCR 文字：全形轉半形、去掉中文字之間的空白 */
export function normalizeOcr(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(SPACE_NEAR_CJK, '').replace(/[ \t]{2,}/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

const NUM = /(?<![\d.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?![\d])/g;
const toNum = (s) => Number(String(s).replace(/,/g, ''));

// 中文大寫金額：壹仟陸佰元 → 1600；收據方格「零拾零萬壹仟陸佰零拾零元」→ 1600（寫了零的格子是 0）
const CN_DIGIT = { 零: 0, 〇: 0, '○': 0, 壹: 1, 一: 1, 貳: 2, 二: 2, 兩: 2, 參: 3, 叁: 3, 三: 3, 肆: 4, 四: 4, 伍: 5, 五: 5, 陸: 6, 六: 6, 柒: 7, 七: 7, 捌: 8, 八: 8, 玖: 9, 九: 9 };
const CN_UNIT = { 拾: 10, 十: 10, 佰: 100, 百: 100, 仟: 1000, 千: 1000 };
export function parseChineseAmount(s) {
  const chars = [...String(s)].filter((ch) => ch in CN_DIGIT || ch in CN_UNIT || ch === '萬' || ch === '万');
  let total = 0;
  let section = 0;
  let digit = 0;
  let hasDigit = false;
  for (const [i, ch] of chars.entries()) {
    if (ch in CN_DIGIT) {
      digit = CN_DIGIT[ch];
      hasDigit = true;
    } else if (ch in CN_UNIT) {
      // 單位前沒有數字：開頭且後面接數字（「拾伍」、OCR 漏掉「壹」的「仟陸佰」）當 1；其餘是收據上沒填的空格，當 0
      const implied = i === 0 && chars[i + 1] in CN_DIGIT ? 1 : 0;
      section += (hasDigit ? digit : implied) * CN_UNIT[ch];
      digit = 0;
      hasDigit = false;
    } else {
      total += (section + digit) * 10000;
      section = 0;
      digit = 0;
      hasDigit = false;
    }
  }
  return chars.length ? total + section + digit : null;
}

// 收據的「合計新台幣（大寫）○萬○仟○佰○拾○元整」：方格之間的空白、直線、底線不算
const CN_AMOUNT_CHARS = '零〇○壹貳參叁肆伍陸柒捌玖拾佰仟萬万';
const CN_RUN = new RegExp(`([${CN_AMOUNT_CHARS}][${CN_AMOUNT_CHARS}\\s|｜_.、:：]*)[元圓]`, 'g');
const CN_LABEL = /合計|總計|共計|總額|新[台臺]幣|大寫/;
function chineseTotals(norm) {
  const out = [];
  for (const m of norm.matchAll(CN_RUN)) {
    const s = m[1].replace(new RegExp(`[^${CN_AMOUNT_CHARS}]`, 'g'), '');
    const v = [...s].length >= 2 ? parseChineseAmount(s) : null;
    if (!(v > 0 && v < 100_000_000)) continue;
    const labeled = CN_LABEL.test(norm.slice(Math.max(0, m.index - 16), m.index));
    out.push({ value: v, score: labeled ? 5 : 3, why: labeled ? '「合計新台幣」大寫金額' : '中文大寫金額' });
  }
  return out;
}

function pick(cands) {
  if (!cands.length) return null;
  const by = new Map();
  for (const c of cands) {
    const k = String(c.value);
    const cur = by.get(k) || { value: c.value, score: 0, hits: 0, why: c.why };
    cur.score += c.score;
    cur.hits++;
    by.set(k, cur);
  }
  return [...by.values()].sort((a, b) => b.score - a.score || b.hits - a.hits)[0];
}

/**
 * @param text OCR 文字
 * @param opts { shopTaxId, today, hints: { invoice_no, date, amount } }
 * @returns {{ invoice_no, date, total, sales_ex, tax, buyer_tax_id, seller_tax_id, invoice_type, vendor_name, notes }}
 *   每個欄位是 { value, score, why } 或 null
 */
export function extractReceiptFields(text, { shopTaxId = '', today = new Date().toISOString().slice(0, 10), hints = {} } = {}) {
  const norm = normalizeOcr(text);
  const lines = norm.split('\n');
  const notes = [];

  // ── 發票號碼
  const invC = [];
  for (const [i, l] of lines.entries()) {
    for (const m of l.toUpperCase().matchAll(/(?<![A-Z])([A-Z]{2})[\s-]?(\d{8})(?!\d)/g)) {
      const v = m[1] + m[2];
      if (/^(NT|TW|TEL|NO)$/.test(m[1])) continue;
      let s = 1;
      if (/發票號碼|發票號|號碼|INVOICE/i.test(l)) s += 3;
      if (/證明聯|發票/.test(lines[i - 1] || '')) s += 1;
      if (hints.invoice_no && v === hints.invoice_no) s += 3;
      invC.push({ value: v, score: s, why: '文字辨識' });
    }
  }
  const invoice_no = pick(invC);

  // ── 日期（排除列印日期、到期日）
  const minDate = `${Number(today.slice(0, 4)) - 2}-01-01`;
  const dateC = [];
  const addDate = (y, m, d, s, why) => {
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (m < 1 || m > 12 || d < 1 || d > 31 || iso > today || iso < minDate) return;
    dateC.push({ value: iso, score: s, why });
  };
  for (const l of lines) {
    if (/列印|印表|到期|截止|有效|期限|繳費期限/.test(l)) continue;
    const near = /日期|開立|交易|時間|中華民國/.test(l) ? 2 : 0;
    // 「115年9-10月」是發票期別不是日期；日期後面緊接時間（14:46:18）通常就是開立時間
    const isPeriod = (m) => /[-~]\s*\d{1,2}$/.test(m[0]) && /^\s*月/.test(l.slice(m.index + m[0].length));
    const timed = (m) => (/^\s*\d{1,2}:\d{2}/.test(l.slice(m.index + m[0].length)) ? 2 : 0);
    for (const m of l.matchAll(/(?<!\d)(20\d{2})\s*[-/.年]\s*(\d{1,2})\s*[-/.月\s]\s*(\d{1,2})(?!\d)/g)) if (!isPeriod(m)) addDate(+m[1], +m[2], +m[3], 1 + near + timed(m), '西元日期');
    for (const m of l.matchAll(/(?<!\d)(1[01]\d)\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})(?!\d)/g)) if (!isPeriod(m)) addDate(+m[1] + 1911, +m[2], +m[3], 1 + near + timed(m), '民國日期');
    for (const m of l.matchAll(/(?<!\d)(1[01]\d)(\d{2})(\d{2})(?!\d)/g)) if (near) addDate(+m[1] + 1911, +m[2], +m[3], 1, '民國日期（連寫）');
  }
  if (hints.date) for (const c of dateC) if (c.value === hints.date) c.score += 2;
  const date = pick(dateC);

  // ── 統一編號（8 碼且檢查碼正確）
  const taxIds = [];
  for (const [i, l] of lines.entries()) {
    // 前面緊接英文字母或連字號的 8 碼是發票號碼的數字部分，不是統編
    for (const m of l.matchAll(/(?<![\dA-Za-z-])(\d{8})(?!\d)/g)) {
      if (!isValidTaxId(m[1])) continue;
      const ctx = `${lines[i - 1] || ''}${l}`;
      taxIds.push({ id: m[1], buyer: /買方|買受人|客戶/.test(l.slice(0, Math.max(0, l.indexOf(m[1])))), seller: /賣方|營業人|統一編號|統編/.test(ctx) && !/買方|買受人/.test(l.slice(Math.max(0, l.indexOf(m[1]) - 6), l.indexOf(m[1]))) });
    }
  }
  let buyer = null;
  let seller = null;
  if (shopTaxId && taxIds.some((t) => t.id === shopTaxId)) buyer = { value: shopTaxId, score: 3, why: '載明本店統編' };
  else {
    const b = taxIds.find((t) => t.buyer);
    if (b) buyer = { value: b.id, score: 2, why: '買方統編' };
  }
  const sc = taxIds.filter((t) => t.id !== buyer?.value);
  const s1 = sc.find((t) => t.seller) || sc[0];
  if (s1) seller = { value: s1.id, score: s1.seller ? 2 : 1, why: '賣方統編' };

  // ── 金額：關鍵字後面的數字
  const kw = {
    total: [/總計|總金額|總額|應付金額|實收|付款金額|總放|總記|金額\(D\)|TOTAL/gi, 2],
    sub: [/合計/g, 1], // 「合計 4」常是品項數，分數低
    ex: [/銷售額|應稅|未稅|小計/g, 2],
    tax: [/稅額|營業稅|稅金|TAX/gi, 2],
  };
  const amt = { total: [], ex: [], tax: [] };
  for (const l of lines) {
    for (const [k, [re, sc]] of Object.entries(kw)) {
      for (const m of l.matchAll(re)) {
        const after = l.slice(m.index + m[0].length, m.index + m[0].length + 16);
        const n = [...after.matchAll(NUM)].map((x) => toNum(x[1])).find((v) => v > 0 && v < 10_000_000);
        if (n !== undefined) amt[k === 'sub' ? 'total' : k].push({ value: n, score: sc, why: `「${m[0]}」後的數字` });
      }
    }
  }
  // 中文大寫總額（OCR 常把「壹」認錯，單位字仍可推回金額）；「合計新台幣」後面的最可靠，有好幾個時取最大的
  const cnList = chineseTotals(norm).sort((a, b) => b.score - a.score || b.value - a.value);
  const nums = [...new Set([...norm.matchAll(NUM)].map((x) => toNum(x[1])).filter((v) => v > 0 && v < 10_000_000))].slice(0, 300);
  const set = new Set(nums);
  // numeric：照片上也有同樣的阿拉伯數字（例如 NT$1,600），可互相印證
  const cn_total = cnList[0] ? { ...cnList[0], numeric: set.has(cnList[0].value) } : null;
  if (cn_total) amt.total.push({ value: cn_total.value, score: cn_total.score, why: cn_total.why });

  // 「未稅＋稅額＝總額、稅額約 5%」：要有關鍵字或檔名金額佐證才採用（避免地址、電話等數字湊巧成立）
  const has = (list, v) => list.some((c) => c.value === v);
  let best = null;
  for (const ex of nums)
    for (const t of nums) {
      if (ex <= t || Math.abs(t - Math.round(ex * 0.05)) > 1 || !set.has(ex + t)) continue;
      const total = ex + t;
      const support = (has(amt.total, total) ? 3 : 0) + (has(amt.ex, ex) ? 2 : 0) + (has(amt.tax, t) ? 2 : 0) + (hints.amount === total ? 2 : 0);
      if (support >= 2 && (!best || support > best.support || (support === best.support && total > best.total))) best = { ex, tax: t, total, support };
    }
  let total = pick(amt.total);
  let sales_ex = null;
  let tax = null;
  if (best) {
    total = { value: best.total, score: 3 + best.support, why: '未稅＋稅額＝總額（5%）' };
    sales_ex = { value: best.ex, score: 3, why: '未稅＋稅額＝總額（5%）' };
    tax = { value: best.tax, score: 3, why: '未稅＋稅額＝總額（5%）' };
  } else if (total) {
    // 總額＋銷售額（或總額＋稅額）互相驗證
    const ex = amt.ex.find((c) => c.value < total.value && Math.abs(total.value - c.value - Math.round(total.value - total.value / 1.05)) <= 1);
    const tx = amt.tax.find((c) => Math.abs(c.value - Math.round(total.value - total.value / 1.05)) <= 1);
    if (ex) {
      sales_ex = { value: ex.value, score: 3, why: '總額－銷售額＝5%' };
      tax = { value: total.value - ex.value, score: 3, why: '總額－銷售額＝5%' };
    } else if (tx) {
      tax = { value: tx.value, score: 3, why: '稅額約為總額的 5%' };
      sales_ex = { value: total.value - tx.value, score: 2, why: '總額－稅額' };
    }
  }
  if (hints.amount && total && total.value !== hints.amount) notes.push(`檔名金額 ${hints.amount} 與辨識 ${total.value} 不同`);

  // ── 憑證種類
  let invoice_type = null;
  if (/證明聯|電子發票/.test(norm)) invoice_type = { value: '電子發票', score: 2, why: '「電子發票證明聯」' };
  else if (/三聯/.test(norm)) invoice_type = { value: '三聯式發票', score: 2, why: '「三聯式」' };
  else if (/收銀機/.test(norm)) invoice_type = { value: '收銀機發票', score: 2, why: '「收銀機」' };
  else if (/免用統一發票|收據|收執/.test(norm)) invoice_type = { value: '收據', score: 2, why: '「收據」' };
  else if (/二聯/.test(norm)) invoice_type = { value: '二聯式發票', score: 2, why: '「二聯式」' };

  // ── 賣方名稱（公司行號）
  // OCR 的店名常夾雜誤認字，只當線索（廠商資料庫會再用統編或字面相似度比對）
  let vendor_name = null;
  for (const l of lines) {
    if (/本店|買方|買受人/.test(l)) continue;
    const s = l.replace(/^.*?(賣方|營業人名稱|營業人|公司名稱)[:：]?/, '');
    const m = /([一-鿿][一-鿿()（）]{1,23}?(股份有限公司|有限公司|企業社|商行|工作室|(?<!分)公司))/.exec(s);
    if (!m) continue;
    const score = (/賣方|營業人/.test(l) ? 1 : 0) + (/有限公司|企業社|商行/.test(m[2]) ? 1 : 0);
    if (!vendor_name || score > vendor_name.score) vendor_name = { value: m[1], score, why: '公司行號名稱' };
  }

  return { invoice_no, date, total, sales_ex, tax, buyer_tax_id: buyer, seller_tax_id: seller, invoice_type, vendor_name, cn_total, notes, text: norm };
}

