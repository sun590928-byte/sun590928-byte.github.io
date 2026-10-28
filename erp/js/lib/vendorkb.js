// 廠商資料庫：從老闆已覆核、已入帳的憑證學習「賣方統編／店名 → 慣用名稱、會計項目、付款方式、摘要」。
// 下一張同一家店的發票，就照老闆以前的選擇帶入。純計算，可單獨測試。

import { compactKey, levRatio } from './text.js';

// 公司型態與分店字尾：「範例商行股份有限公司信義分公司」→「範例商行」
const SUFFIX = /(股份有限公司|有限公司|企業社|商行|工作室|公司)(.{0,8}(分公司|門市|分店|店))?$/;

/** 公司（行號）全名：結尾是公司型態，例如「範例電機有限公司」；「範例電機」是簡稱 */
export const isCompanyName = (name) => SUFFIX.test(String(name || '').normalize('NFKC').trim());
/** 去掉公司型態（與分店）的簡稱 */
export const shortVendorName = (name) => String(name || '').normalize('NFKC').trim().replace(SUFFIX, '');

/** 店名的比對鍵（可能有好幾個）：全名、去公司型態、括號內外各一 */
export function vendorAliases(name) {
  const s = String(name || '').normalize('NFKC');
  const out = new Set();
  const add = (x) => {
    const k = compactKey(x);
    if ([...k].length >= 2 && !/^\d+$/.test(k)) out.add(k);
  };
  add(s);
  add(s.replace(SUFFIX, ''));
  const paren = /^(.*?)[(（]([^)）]+)[)）](.*)$/.exec(s);
  if (paren) {
    add(paren[1] + paren[3]);
    add(paren[1].replace(SUFFIX, ''));
    add(paren[2]);
  }
  return [...out];
}

// 連鎖通路的常見寫法（店名字面，不含任何統編）：沒有歷史資料時也能從照片文字認出店家
export const KNOWN_VENDORS = [
  ['全聯', ['全聯福利中心', '全聯實業']],
  ['好市多', ['costco', '好市多']],
  ['家樂福', ['carrefour', '家福股份']],
  ['7-11', ['統一超商', '7-eleven', '7eleven']],
  ['全家', ['全家便利商店', 'familymart']],
  ['萊爾富', ['萊爾富國際', 'hilife']],
  ['OK超商', ['來來超商', 'okmart']],
  ['大創', ['大創百貨', 'daiso']],
  ['特力屋', ['特力屋', '特力股份']],
  ['IKEA', ['ikea', '宜家家居']],
  ['momo', ['富邦媒體', 'momo購物']],
  ['蝦皮', ['蝦皮購物', 'shopee']],
  ['中華電信', ['中華電信']],
  ['台灣電力', ['台灣電力', '台電']],
  ['自來水', ['自來水事業處', '台灣自來水']],
  ['寶雅', ['寶雅國際', 'poya']],
  ['小北百貨', ['小北百貨']],
  ['美廉社', ['三商家購', '美廉社']],
];

const top = (counts) => {
  let best = null;
  let n = 0;
  let all = 0;
  for (const [k, v] of counts) {
    all += v;
    if (v > n) [best, n] = [k, v];
  }
  return { value: best, share: all ? n / all : 0, n };
};
const bump = (m, k, by = 1) => k && m.set(k, (m.get(k) || 0) + by);

/** 本機辨識之後，Claude 又透過連接器覆核過（以 Claude 的為準） */
export const reviewedAfterAuto = (d) => !!d.ai?.at && (!d.auto?.at || d.ai.at > d.auto.at);

/**
 * @param docs 憑證（已入帳，或已覆核且不是本機自動覆核的）
 * @param einvoices 已入帳、已指定科目的電子發票
 */
export function buildVendorKB(docs = [], einvoices = []) {
  const entries = [];
  const byTax = new Map();
  const byAlias = new Map();
  const entryFor = (taxId, name) => {
    let e = taxId ? byTax.get(taxId) : null;
    if (!e) for (const a of vendorAliases(name)) if ((e = byAlias.get(a))) break;
    if (!e) {
      e = { taxId: '', names: new Map(), accounts: new Map(), pays: new Map(), summaries: [], n: 0, last: '', ded: { yes: 0, no: 0 } };
      entries.push(e);
    }
    if (taxId && !e.taxId) {
      e.taxId = taxId;
      byTax.set(taxId, e);
    }
    for (const a of vendorAliases(name)) if (!byAlias.has(a)) byAlias.set(a, e);
    return e;
  };
  // 本機自動覆核的不學（避免自己學自己）；之後老闆或 Claude 看過的才算
  const learned = (d) => d.status === 'posted' || (d.status === 'reviewed' && (d.reviewed_by !== 'auto' || reviewedAfterAuto(d)));
  for (const d of docs) {
    if (!learned(d) || d.kind === 'payout_statement' || (!d.vendor_name && !d.vendor_tax_id)) continue;
    const e = entryFor(d.vendor_tax_id, d.vendor_name);
    e.n++;
    bump(e.names, d.vendor_name);
    if (d.lines?.length) for (const p of d.lines) bump(e.accounts, p.account, 1 / d.lines.length);
    else bump(e.accounts, d.account);
    if (d.pay_account) bump(e.pays, d.pay_account);
    if (d.summary) e.summaries.push(d.summary);
    if ((d.doc_date || '') > e.last) e.last = d.doc_date;
    // 載明買方統編的發票，老闆最後有沒有扣抵（例如外送平台老闆決定不扣抵）
    if (d.invoice_no && d.buyer_tax_id) e.ded[d.deductible === false ? 'no' : 'yes']++;
  }
  for (const i of einvoices) {
    if (!i.entry_id || !(i.account || i.suggested_account) || (!i.seller_name && !i.seller_tax_id)) continue;
    const e = entryFor(i.seller_tax_id, i.seller_name);
    e.n++;
    bump(e.names, i.seller_name);
    bump(e.accounts, i.account || i.suggested_account);
  }
  const done = entries.map((e) => ({
    taxId: e.taxId,
    name: top(e.names).value || '',
    // 以前記過的公司全名（發票的廠商用全名）
    fullName: top([...e.names].filter(([n]) => isCompanyName(n))).value || '',
    account: top(e.accounts),
    pay: top(e.pays),
    summary: e.summaries[e.summaries.length - 1] || '',
    n: e.n,
    last: e.last,
    ded: e.ded,
    aliases: [...new Set([...e.names.keys()].flatMap(vendorAliases))],
  }));
  const items = trainItems(docs.filter((d) => learned(d) && d.kind !== 'payout_statement'));
  return { entries: done, byTax: new Map(done.filter((e) => e.taxId).map((e) => [e.taxId, e])), items };
}

// ── 品項 → 會計項目（從老闆以前的摘要、品項學習；樸素貝氏，特徵是中文兩字詞與英文單字）
function itemFeatures(text) {
  const k = compactKey(text).replace(/\d+/g, ' ');
  const out = k.match(/[a-z]{2,}/g) || [];
  const cjk = [...k.replace(/[a-z ]+/g, ' ')];
  for (let i = 0; i < cjk.length - 1; i++) if (cjk[i] !== ' ' && cjk[i + 1] !== ' ') out.push(cjk[i] + cjk[i + 1]);
  return out;
}
const itemTextOf = (d) => [d.summary, ...(d.items || []).map((i) => i.name)].filter(Boolean).join(' ');

function trainItems(docs) {
  const m = { cls: new Map(), vocab: new Set(), n: 0 };
  const add = (account, text) => {
    const f = itemFeatures(text);
    if (!account || !f.length) return;
    const c = m.cls.get(account) || { docs: 0, tok: new Map(), total: 0 };
    c.docs++;
    m.n++;
    for (const x of f) {
      c.tok.set(x, (c.tok.get(x) || 0) + 1);
      c.total++;
      m.vocab.add(x);
    }
    m.cls.set(account, c);
  };
  for (const d of docs) {
    if (d.lines?.length) for (const p of d.lines) add(p.account, p.memo || '');
    else add(d.account, itemTextOf(d));
  }
  return m;
}

/** 依品項文字預測會計項目：{ account, p（0–1）, hits（認得的詞數）} 或 null */
export function predictAccount(kb, text) {
  const m = kb?.items;
  if (!m?.n) return null;
  const f = itemFeatures(text).filter((x) => m.vocab.has(x));
  if (!f.length) return null;
  const V = m.vocab.size;
  const sc = [];
  for (const [a, c] of m.cls) {
    let s = Math.log(c.docs / m.n);
    for (const x of f) s += Math.log(((c.tok.get(x) || 0) + 1) / (c.total + V));
    sc.push([a, s]);
  }
  sc.sort((x, y) => y[1] - x[1]);
  const z = sc.reduce((t, [, s]) => t + Math.exp(s - sc[0][1]), 0);
  return { account: sc[0][0], p: 1 / z, hits: f.length, second: sc[1]?.[0] || null };
}

/**
 * 找廠商：統編完全相同最可靠；其次店名；最後在照片文字裡找學過或常見的店名（容許少量錯字）。
 * @returns {{ entry?, name, confidence, why }} 或 null
 */
export function lookupVendor(kb, { taxId = '', name = '', text = '' } = {}) {
  if (taxId && kb?.byTax.has(taxId)) {
    const e = kb.byTax.get(taxId);
    return { entry: e, name: e.name, confidence: 0.95, why: `統編 ${taxId} 以前記過 ${e.n} 次（${e.name}）` };
  }
  const entries = kb?.entries || [];
  const keys = vendorAliases(name);
  if (keys.length) {
    for (const e of entries)
      for (const a of e.aliases)
        for (const k of keys)
          if (a === k || ([...a].length >= 2 && k.includes(a)) || ([...k].length >= 3 && a.includes(k))) return { entry: e, name: e.name, confidence: 0.85, why: `店名「${name}」與以前的「${e.name}」相同` };
  }
  const hay = compactKey(text);
  if (!hay) return null;
  let best = null;
  const consider = (alias, hit) => {
    if (!best || hit.confidence > best.confidence || (hit.confidence === best.confidence && [...alias].length > best.len)) best = { ...hit, len: [...alias].length };
  };
  const scan = (alias, make) => {
    const L = [...alias].length;
    if (L < 2) return;
    if (hay.includes(alias)) return consider(alias, make(0.8, '照片文字裡有'));
    if (L < 4) return;
    // 容錯比對：OCR 常認錯一兩個字（「範例媒體科技」→「範例媒休科技」）
    const chars = [...hay];
    let r = 0;
    for (let i = 0; i + L <= chars.length; i++) r = Math.max(r, levRatio(alias, chars.slice(i, i + L).join('')));
    if (r >= 0.75) consider(alias, make(0.55 + 0.2 * (r - 0.75) * 4, '照片文字近似'));
  };
  for (const e of entries) for (const a of e.aliases) scan(a, (c, w) => ({ entry: e, name: e.name, confidence: c, why: `${w}「${e.name}」` }));
  for (const [name2, aliases] of KNOWN_VENDORS) for (const a of [name2, ...aliases].map(compactKey)) scan(a, (c, w) => ({ name: name2, confidence: c - 0.05, why: `${w}「${name2}」` }));
  if (!best) return null;
  const { len, ...hit } = best;
  return hit;
}
