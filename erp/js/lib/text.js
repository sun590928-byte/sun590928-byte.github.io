// 文字正規化與相似度（品項比對、欄位名稱比對共用）。

export function nfkc(s) {
  return String(s ?? '').normalize('NFKC');
}

// 全形轉半形、統一括號與空白、轉小寫
export function normalizeText(s) {
  return nfkc(s)
    .toLowerCase()
    .replace(/[【\[「『〔〈《]/g, '(')
    .replace(/[】\]」』〕〉》]/g, ')')
    .replace(/[\s　]+/g, ' ')
    .trim();
}

// 只留中英數（比對欄位名稱、品項主鍵用）
export function compactKey(s) {
  return normalizeText(s).replace(/[^\p{L}\p{N}]+/gu, '');
}

export function bigrams(s) {
  const chars = [...s];
  const out = new Map();
  if (chars.length === 1) out.set(chars[0], 1);
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i] + chars[i + 1];
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

// Sørensen–Dice（多重集合）
export function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) {
    total += n;
    if (B.has(g)) inter += Math.min(n, B.get(g));
  }
  for (const n of B.values()) total += n;
  return total ? (2 * inter) / total : 0;
}

export function levenshtein(a, b) {
  const s = [...a];
  const t = [...b];
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  let prev = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
}

export function levRatio(a, b) {
  const L = Math.max([...a].length, [...b].length);
  return L ? 1 - levenshtein(a, b) / L : 1;
}

// 共同字元比例（對短中文名稱比 bigram 更寬容）
export function charOverlap(a, b) {
  const A = [...a];
  const B = [...b];
  if (!A.length || !B.length) return 0;
  const pool = new Map();
  for (const c of B) pool.set(c, (pool.get(c) || 0) + 1);
  let hit = 0;
  for (const c of A) {
    if (pool.get(c) > 0) {
      hit++;
      pool.set(c, pool.get(c) - 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
}

export function slug(s) {
  return nfkc(s).replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

export function uid(prefix = '') {
  const r = crypto.getRandomValues(new Uint8Array(10));
  return prefix + [...r].map((b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

export async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// 同步雜湊（FNV-1a 32bit），用於欄位簽章等不需加密強度的場合
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
