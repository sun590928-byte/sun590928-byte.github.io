// 疑似同品項分析：POS 與進銷存系統迭代後，同一商品出現多種名稱。
// 訊號：去除冰熱/容量/甜冰度後的核心名稱、字元相似度、售價、販售期間是否前後接續（改名）、品類。

import { normalizeText, compactKey, dice, levRatio, charOverlap } from './text.js';
import { guessCategory } from './pos.js';

const SYNONYMS = [
  [/cafe\s*latte|caff[eè]\s*latte|咖啡拿鐵|拿鐵咖啡|latte/g, '拿鐵'],
  [/americano|美式咖啡/g, '美式'],
  [/cappuccino|卡布奇諾|卡布其諾|卡布基諾|卡布咖啡/g, '卡布'],
  [/flat\s*white|馥列白|馥芮白|澳白咖啡/g, '澳白'],
  [/mocha|摩卡咖啡/g, '摩卡'],
  [/macchiato|瑪琪朵|瑪其朵/g, '瑪奇朵'],
  [/espresso|義式濃縮|意式濃縮|濃縮咖啡/g, '濃縮'],
  [/cold\s*brew|冰釀|冷釀|冷萃咖啡/g, '冷萃'],
  [/pour\s*over|hand\s*drip|手沖咖啡|手冲/g, '手沖'],
  [/dirty\s*coffee|髒髒咖啡|髒咖啡|dirty/g, 'dirty'],
  [/matcha/g, '抹茶'],
  [/hojicha|烘焙茶/g, '焙茶'],
  [/affogato|阿芙佳朵|阿法奇朵/g, '阿法奇朵'],
  [/einsp[aä]nner|維也納咖啡/g, '維也納'],
  [/basque/g, '巴斯克'],
  [/cheese\s*cake|乳酪蛋糕|芝士蛋糕/g, '起司蛋糕'],
  [/scones?/g, '司康'],
  [/tonic|通寧水|湯尼/g, '通寧'],
  [/sparkling|氣泡水|蘇打水|soda/g, '氣泡'],
  [/oat\s*milk/g, '燕麥奶'],
  [/black\s*tea/g, '紅茶'],
  [/hot\s*chocolate|cocoa/g, '可可'],
];

const TEMP = /(?:^|[\s(/_-])(冰|熱|溫|hot|iced|ice)(?=$|[\s)/_-])|^(冰|熱|溫)(?=[^\s淇塊滴釀萃沙砂])|(冰|熱)的/;
const SIZE = /\((大|中|小|l|m|s)\)|(大杯|中杯|小杯|大份|小份|large|medium|small|tall|grande|venti|\d+\s*oz)/;
const SUGAR = /(無糖|微糖|半糖|少糖|全糖|正常糖|多糖|去冰|微冰|少冰|正常冰|常溫)/g;
const MILK = /(換?燕麥奶|換?豆漿|豆奶|低脂|全脂|脫脂|換?杏仁奶)/g;
const NOISE = /(午月|招牌|經典|本日|新品|限定|推薦|人氣|熱賣|\(新\)|new|★|☆|✿|♥|❤|\$\s*\d+|\d+\s*元)/g;

// 將品名拆成核心名稱 + 屬性（冰熱、容量、甜冰、奶類）
export function analyzeName(raw) {
  let s = normalizeText(raw);
  for (const [re, to] of SYNONYMS) s = s.replace(re, to);
  s = s.replace(/([\p{L}\p{N}]{2,4})\1+/gu, '$1');
  const attrs = {};
  const t = TEMP.exec(s);
  if (t) {
    const v = t[1] || t[2] || t[3];
    attrs.temp = /hot|熱/.test(v) ? '熱' : /溫/.test(v) ? '溫' : '冰';
    s = s.replace(TEMP, (m) => m.replace(v, ' ').replace(/的$/, ''));
  }
  const z = SIZE.exec(s);
  if (z) {
    attrs.size = z[1] || z[2];
    s = s.replace(SIZE, ' ');
  }
  const sugars = s.match(SUGAR);
  if (sugars) {
    attrs.sweet = sugars.join('');
    s = s.replace(SUGAR, ' ');
  }
  const milks = s.match(MILK);
  if (milks) {
    attrs.milk = milks.join('').replace(/^換/, '');
    s = s.replace(MILK, ' ');
  }
  s = s.replace(NOISE, ' ');
  let core = compactKey(s);
  if (core.length > 2 && core.endsWith('咖啡')) core = core.slice(0, -2);
  if (!core) core = compactKey(raw);
  return { core, attrs };
}

export const aliasKey = (raw) => compactKey(raw);

function attrSig(attrs) {
  return ['temp', 'size', 'sweet', 'milk'].map((k) => attrs[k] || '').join('|');
}

/**
 * 依別名鍵彙總品名統計（僅格式差異者自動歸為同一名稱）。
 */
export function collectNames(lines) {
  const map = new Map();
  for (const l of lines) {
    if (l.is_adjustment) continue;
    const key = aliasKey(l.item_raw);
    if (!key) continue;
    let n = map.get(key);
    if (!n) {
      n = { key, spellings: new Map(), count: 0, qty: 0, amount: 0, revenueQty: 0, revenue: 0, first: l.date, last: l.date, rawCats: new Map(), options: new Map(), voidQty: 0 };
      map.set(key, n);
    }
    n.spellings.set(l.item_raw, (n.spellings.get(l.item_raw) || 0) + 1);
    n.count++;
    n.qty += l.qty;
    n.amount += l.amount;
    if (l.void_reason) n.voidQty += l.qty;
    else if (l.qty > 0 && l.amount > 0) {
      n.revenueQty += l.qty;
      n.revenue += l.amount;
    }
    if (l.date < n.first) n.first = l.date;
    if (l.date > n.last) n.last = l.date;
    if (l.category_raw) n.rawCats.set(l.category_raw, (n.rawCats.get(l.category_raw) || 0) + 1);
    if (l.option_raw) n.options.set(l.option_raw, (n.options.get(l.option_raw) || 0) + 1);
  }
  const out = [];
  for (const n of map.values()) {
    const name = [...n.spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const rawCat = n.rawCats.size ? [...n.rawCats.entries()].sort((a, b) => b[1] - a[1])[0][0] : '';
    const { core, attrs } = analyzeName(name);
    out.push({
      key: n.key,
      name,
      spellings: [...n.spellings.keys()],
      count: n.count,
      qty: n.qty,
      amount: n.amount,
      avgPrice: n.revenueQty ? n.revenue / n.revenueQty : null,
      first: n.first,
      last: n.last,
      rawCat,
      guessCat: guessCategory(name, rawCat),
      options: [...n.options.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map((x) => x[0]),
      voidQty: n.voidQty,
      core,
      attrs,
    });
  }
  return out.sort((a, b) => b.amount - a.amount);
}

function longestCommon(a, b) {
  const s = [...a];
  const t = [...b];
  let best = 0;
  let end = 0;
  let prev = new Array(t.length + 1).fill(0);
  for (let i = 1; i <= s.length; i++) {
    const cur = new Array(t.length + 1).fill(0);
    for (let j = 1; j <= t.length; j++) {
      if (s[i - 1] === t[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) {
          best = cur[j];
          end = i;
        }
      }
    }
    prev = cur;
  }
  return s.slice(end - best, end).join('');
}

function dayNum(ymd) {
  return Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86400000;
}

export function scorePair(a, b) {
  const reasons = [];
  let base;
  let type = 'duplicate';
  if (a.core === b.core) {
    base = 0.96;
    if (attrSig(a.attrs) !== attrSig(b.attrs)) {
      type = 'variant';
      reasons.push('核心名稱相同，僅冰熱／容量／甜冰度不同');
    } else reasons.push('去除修飾字後名稱相同');
  } else {
    const A = a.core;
    const B = b.core;
    const d = dice(A, B);
    const l = levRatio(A, B);
    const o = charOverlap(A, B);
    const shorter = A.length <= B.length ? A : B;
    const longer = shorter === A ? B : A;
    const contain = shorter.length >= 2 && longer.includes(shorter) ? 0.6 + 0.3 * (shorter.length / longer.length) : 0;
    // 共同詞段（例：流星巴斯克 / 巴斯克乳酪蛋糕 → 巴斯克），證據較弱，需售價、改名時序加分才會成群
    const common = longestCommon(A, B);
    const lcs = common.length >= 3 ? 0.45 + 0.3 * (common.length / shorter.length) : 0;
    base = Math.max(d, 0.9 * l, contain, 0.85 * o, lcs);
    if (contain && contain >= base) reasons.push(`名稱主體相同「${shorter}」`);
    else if (lcs && lcs >= base) reasons.push(`共同詞「${common}」`);
    else if (base >= 0.5) reasons.push(`名稱相似 ${Math.round(base * 100)}%`);
    if (attrSig(a.attrs) !== attrSig(b.attrs) && (a.attrs.temp || b.attrs.temp || a.attrs.size || b.attrs.size)) type = 'variant';
  }
  if (base < 0.45) return null;
  let score = base;
  if (a.avgPrice && b.avgPrice) {
    const ratio = Math.min(a.avgPrice, b.avgPrice) / Math.max(a.avgPrice, b.avgPrice);
    if (ratio >= 0.95) {
      score += 0.06;
      reasons.push('售價相同');
    } else if (ratio < 0.7) {
      score -= 0.12;
      reasons.push(`售價差異大（$${Math.round(a.avgPrice)} vs $${Math.round(b.avgPrice)}）`);
    }
  }
  const overlap = Math.min(dayNum(a.last), dayNum(b.last)) - Math.max(dayNum(a.first), dayNum(b.first));
  if (overlap < 0 && -overlap <= 21) {
    score += 0.08;
    const [older, newer] = a.last < b.first ? [a, b] : [b, a];
    reasons.push(`前後接續販售：「${older.name}」到 ${older.last.slice(5)} 止，「${newer.name}」從 ${newer.first.slice(5)} 起（疑似改名）`);
  } else if (overlap >= 7 && a.count >= 5 && b.count >= 5) {
    score -= 0.04;
    reasons.push('同期間都有銷售');
  }
  if (a.guessCat !== b.guessCat && a.guessCat !== 'other' && b.guessCat !== 'other') {
    score -= 0.1;
    reasons.push('品類不同');
  } else if (a.rawCat && a.rawCat === b.rawCat) score += 0.02;
  score = Math.max(0, Math.min(1, score));
  if (score < 0.55) return null;
  return { a: a.key, b: b.key, score, type, reasons };
}

export const pairKey = (x, y) => (x < y ? `${x}||${y}` : `${y}||${x}`);

export function confidenceOf(score) {
  return score >= 0.85 ? 'high' : score >= 0.7 ? 'medium' : 'low';
}

/**
 * @param lines 銷售明細
 * @param opts.aliases Map(aliasKey → product_id) 已確認的對應
 * @param opts.notSame Set(pairKey) 使用者標記「不是同一品項」
 * @param opts.threshold 分群門檻
 */
export function analyzeDuplicates(lines, { aliases = new Map(), notSame = new Set(), threshold = 0.7 } = {}) {
  const names = collectNames(lines);
  const byKey = new Map(names.map((n) => [n.key, n]));
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i];
      const b = names[j];
      const pk = pairKey(a.key, b.key);
      if (notSame.has(pk)) continue;
      const pa = aliases.get(a.key);
      const pb = aliases.get(b.key);
      if (pa && pb && pa === pb) continue; // 已合併
      const p = scorePair(a, b);
      if (p) pairs.push(p);
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const pairScore = new Map(pairs.map((p) => [pairKey(p.a, p.b), p.score]));

  // 貪婪平均連結分群：避免 A~B、B~C 串成一大群
  const parent = new Map(names.map((n) => [n.key, n.key]));
  const members = new Map(names.map((n) => [n.key, [n.key]]));
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const p of pairs) {
    if (p.score < threshold) break;
    const ra = find(p.a);
    const rb = find(p.b);
    if (ra === rb) continue;
    const ma = members.get(ra);
    const mb = members.get(rb);
    let total = 0;
    for (const x of ma) for (const y of mb) total += pairScore.get(pairKey(x, y)) || 0;
    const avg = total / (ma.length * mb.length);
    if (avg < threshold - 0.1) continue;
    parent.set(rb, ra);
    members.set(ra, ma.concat(mb));
    members.delete(rb);
  }
  const clusters = [];
  for (const [root, keys] of members) {
    if (keys.length < 2) continue;
    const mem = keys.map((k) => byKey.get(k));
    const inner = pairs.filter((p) => keys.includes(p.a) && keys.includes(p.b));
    const top = inner.reduce((m, p) => Math.max(m, p.score), 0);
    const type = inner.every((p) => p.type === 'variant') ? 'variant' : 'duplicate';
    const byRecent = [...mem].sort((x, y) => (y.last > x.last ? 1 : y.last < x.last ? -1 : y.count - x.count));
    const mapped = keys.map((k) => aliases.get(k)).filter(Boolean);
    clusters.push({
      id: root,
      keys,
      members: mem.sort((x, y) => (x.first < y.first ? -1 : 1)),
      pairs: inner,
      score: top,
      confidence: confidenceOf(top),
      type,
      suggestedName: byRecent[0].name,
      suggestedCat: byRecent[0].guessCat,
      existingProduct: mapped.length ? mapped[0] : null,
    });
  }
  clusters.sort((x, y) => y.score - x.score || y.members.length - x.members.length);
  const autoMerged = names.filter((n) => n.spellings.length > 1);
  return { names, pairs, clusters, autoMerged };
}
