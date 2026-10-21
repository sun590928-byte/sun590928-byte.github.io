// 存摺照片辨識結果 → 存摺明細（日期、摘要、支出、存入、結存）。
// 文字辨識讀數字常出錯（小數點、千分位、前面的 * 號、手寫註記），但存摺每一列都有「結存金額」：
// 上一列結存 ± 本列金額 ＝ 本列結存。每個數字先列出幾種可能的讀法，再用這條帳鏈挑出前後一致的那一種；
// 對不上的列標「需確認」，讓使用者勾選、修正後再匯入。純計算，可單獨測試。

import { fnv1a } from './text.js';

// 數字裡常被認錯的字（只用在金額、日期片段裡）
const DIGIT_LIKE = { O: '0', o: '0', Q: '0', D: '0', d: '0', p: '0', U: '0', l: '1', I: '1', '|': '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2' };
const asDigits = (s) => String(s).replace(/[OoQDdpUlI|iSsBZz]/g, (c) => DIGIT_LIKE[c]);
const near = (a, b) => Math.abs(a - b) < 0.5;

// 帳號（1200034-11-0955840；辨識時分隔號常被讀成 }、空白）不是金額
const ACCOUNT_NO = /\d{5,8}\s*[-－}\])|]?\s*\d{1,3}\s*[-－]\s*\d{5,8}/;
// 金額片段：可有 * x % ¥ 等前綴；數字、千分位、小數點（常被讀成 00、Do、p0、.000）
const MONEY = /[*xX%¥£«+#]?\s?\d(?:[\d,]|\.(?=\d))*(?:\s?[.,]\s?[0-9OoQDdpU]{1,3}|\s00(?!\d))?/g;
// 民國日期（1150907、或漏掉開頭 1 的 150907）沒有千分位：不當金額
const ROC_DATE_TOKEN = /^(?:1?1)?5(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{0,4}$/;

/**
 * 一個金額片段可能的數值，交給帳鏈挑。
 * 存摺金額一律印成「*N,NNN.00」，所以結尾的 2～3 位常是角分（或被讀錯的 .00）。
 */
export function moneyCandidates(token) {
  const t = asDigits(String(token).replace(/^[^\d]+/, '')).replace(/\s/g, '').replace(/[.,]+$/, '');
  const digits = t.replace(/\D/g, '');
  if (!digits) return [];
  const out = new Set();
  const add = (s) => s && out.add(Number(s));
  const sep = /[.,](\d{1,3})$/.exec(t); // 最後一個分隔符號後面的 1～3 位
  const cents = /[.,]00\d{0,3}$/.exec(t); // 「371,991.0075」：.00 後面接了雜訊
  if (cents && !sep) add(t.slice(0, cents.index).replace(/\D/g, ''));
  if (sep && sep[1].length <= 2) add(t.slice(0, sep.index).replace(/\D/g, '')); // 「5,000.00」「310,667.60」：小數點前就是金額
  else if (sep) {
    add(digits); // 「16,596」：千分位，沒讀到小數
    add(t.slice(0, sep.index).replace(/\D/g, '')); // 「114,365.008」：.00 後面多一個雜訊
  } else {
    if (digits.endsWith('00') && digits.length > 2) add(digits.slice(0, -2)); // 「262000」＝2,620.00
    add(digits);
  }
  return [...out].filter((v) => v > 0 && v < 1e8).sort((a, b) => a - b);
}

function moneyTokens(line) {
  const toks = [];
  // 「12 500.00」→「12,500.00」（千分位被讀成空白）；前面要是獨立的 1～3 位數，避免把相鄰兩個金額黏在一起
  const s = line.replace(ACCOUNT_NO, ' ').replace(/(?<![\d,.])(\d{1,3})\s(\d{3})(?=[.,]\s?[0-9OoQDdpU]{1,3})/g, '$1,$2');
  for (const m of s.matchAll(MONEY)) {
    const text = m[0].trim();
    const bare = text.replace(/^[^\d]+/, '');
    const plain = !/[,.]/.test(bare) && !/^[*xX%¥£«+#]/.test(text);
    if (plain && (ROC_DATE_TOKEN.test(bare) || (/^\d{0,2}5[01]\d/.test(bare) && bare.length >= 5))) continue; // 日期（行首 1150907、摘要裡的 1150831）
    if (plain && /[(（《]\s*$/.test(s.slice(Math.max(0, m.index - 2), m.index))) continue; // 括號裡的「0827銷」、轉帳帳號
    if (bare.replace(/\D/g, '').length < 2) continue;
    const cands = moneyCandidates(text);
    if (cands.length) toks.push({ text, cands, index: m.index, end: m.index + m[0].length });
  }
  return toks;
}

// 行首的交易日期：民國 1150907（前面的 1 常被漏掉或認錯）
function lineDate(line, year) {
  const head = asDigits(line.slice(0, 20)).replace(/\s/g, '');
  const m = /(?:1?1)?5(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])/.exec(head);
  return m ? `${year}-${m[1]}-${m[2]}` : null;
}

const KIND = [
  ['網銀', /網銀|綱銀|網鋇|網報/],
  ['電匯', /電匯|匯/],
  ['現金', /現金|現全|晨金|趨金|耽金|理金/],
  ['轉帳', /轉帳|轉入|轉出/],
  ['利息', /利息/],
  ['手續費', /手續費|匯費/],
  ['提款', /提款|ATM/i],
];

/** 摘要：交易別＋括號內的說明（例如「電匯（綠界科技股）」「現金（0827銷）」），去掉辨識雜訊 */
function summaryOf(text) {
  const kind = KIND.find(([, re]) => re.test(text))?.[0] || '';
  const paren = /[(（《]([^)）》]{1,16})[)）》]?/.exec(text);
  let memo = paren ? paren[1] : '';
  memo = memo.replace(/[^\p{Script=Han}A-Za-z0-9\-－]/gu, '');
  const sale = /^O?((?:0\d|1[0-2])[0-3]\d)(銷|[\dBHE#]{1,2})?$/.exec(asDigits(memo));
  if (sale) memo = `${sale[1]}銷`; // 「0827銷」常被讀成 08278、0827H
  return { kind, memo, text: [kind, memo && `（${memo}）`].filter(Boolean).join('') };
}

/**
 * 解析一張存摺照片的文字（需用「整頁單一區塊」的辨識模式，讓同一列的日期、金額、結存在同一行）。
 * @param text OCR 文字
 * @param opts { year: 西元年, from, to: 檔名上的日期區間（用來檢查日期） }
 * @returns {{ opening: number[]|null, rows: [{ date, dateGuessed, summary, kind, memo, tokens: number[][], raw }] }}
 */
export function parsePassbookText(text, { year = new Date().getFullYear(), from = null, to = null } = {}) {
  const lines = String(text || '').normalize('NFKC').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  let opening = null;
  let lastDate = null;
  const big = (t) => Math.max(...t.cands);
  const printed = (t) => /^[*xX%¥£«+#]/.test(t.text) || /[.,]/.test(t.text); // 存摺印的金額都有 * 號與 .00
  for (const raw of lines) {
    const toks = moneyTokens(raw);
    // 結存後面的手寫註記（46、375、9/7）：不是印的金額又很小，去掉
    while (toks.length > 1 && big(toks[toks.length - 1]) < 100 && !printed(toks[toks.length - 1])) toks.pop();
    // 表頭「帳號：1200034-11-0955840 … *398,259.00 本數：0」＝承前頁結存（取最大的那個數字）
    if (ACCOUNT_NO.test(raw) || /帳號|本數/.test(raw)) {
      const cands = toks.filter(printed);
      if (!rows.length && cands.length) opening = cands.reduce((a, t) => (big(t) > big(a) ? t : a)).cands;
      continue;
    }
    if (!toks.length) continue;
    // 結存至少 4 位數；只有一個「印的」小金額（*435.00）的行：結存沒讀到的交易列，留著讓帳鏈推算
    if (!toks.some((t) => t.cands.some((v) => v >= 1000)) && !(toks.length === 1 && printed(toks[0]))) continue;
    let date = lineDate(raw, year);
    if (date && ((from && date < from) || (to && date > to) || (lastDate && date < lastDate))) date = null;
    // 只有一個數字又沒日期：除非是印的金額（結存或金額有一個沒讀到），否則多半是雜訊
    if (!date && toks.length < 2 && !/現金|匯|銀|轉/.test(raw) && !printed(toks[0])) continue;
    const firstMoney = toks.length >= 2 ? toks[toks.length - 2] : toks[0];
    const s = summaryOf(raw.slice(0, firstMoney.index) + ' ' + raw.slice(firstMoney.end, toks[toks.length - 1].index));
    rows.push({ date: date || lastDate || from, dateGuessed: !date, summary: s.text, kind: s.kind, memo: s.memo, tokens: toks.map((t) => t.cands), raw });
    if (date) lastDate = date;
  }
  return { opening, rows };
}

const DEPOSIT_HINT = /現金|電匯|存入|利息|轉入|綠界|LINE|撥款|銷/;

// 一列的可能讀法：結存取最後一個或倒數第二個數字的候選值；金額是其他數字的候選值
function readStates(row) {
  const n = row.tokens.length;
  const out = [];
  for (const bi of [n - 1, n - 2]) {
    if (bi < 0) continue;
    const amounts = row.tokens.filter((_, i) => i !== bi).flat();
    for (const b of row.tokens[bi]) if (b >= 1) out.push({ b, amounts, src: 'read', pref: bi === n - 1 ? 0.1 : 0 });
  }
  return out;
}

/**
 * 帳鏈驗證：在每一列的各種讀法裡，找出「前後結存相差＝該列金額」最多的一條路（Viterbi）。
 * 結存沒讀到的列，可用「上一列結存 ± 本列金額」補上。
 * @param pages [{ opening, rows }]（照片依時間順序）
 * @returns rows：{ page, date, summary, withdrawal, deposit, balance, status, note }
 *   status：ok＝金額與結存都對得上；inferred＝結存前後對得上、金額由結存推算；corrected＝結存沒讀清楚、由上一列推算；
 *           check＝對不上（請人工確認）；duplicate＝和前一張照片重複的列
 */
export function verifyChain(pages) {
  // 存摺補登時會重印上一頁最後幾列：下一頁開頭和上一頁結尾日期、結存相同的列標重複
  const items = []; // { kind: 'open'|'row', ... }
  const lastRows = [];
  for (const [pi, p] of pages.entries()) {
    if (p.opening?.length) items.push({ kind: 'open', page: pi, cands: p.opening });
    const tail = lastRows.slice(-6);
    for (const r of p.rows) {
      const lastTok = r.tokens[r.tokens.length - 1] || [];
      const dup = tail.find((x) => x.date === r.date && lastTok.some((v) => v >= 1000 && (x.tokens[x.tokens.length - 1] || []).includes(v)));
      items.push({ kind: 'row', page: pi, row: r, dupOf: dup || null });
    }
    lastRows.push(...p.rows);
  }
  const seq = items.filter((x) => !x.dupOf);
  // Viterbi
  const layers = [];
  for (const [i, it] of seq.entries()) {
    const prevLayer = layers[i - 1] || [];
    let states;
    if (it.kind === 'open') states = it.cands.map((b) => ({ b, src: 'open', amounts: [], pref: 0 }));
    else {
      states = readStates(it.row);
      // 結存沒讀清楚：由上一列的每個可能結存 ± 本列任一數字推出
      const ts = [...new Set(it.row.tokens.flat())];
      for (const [pk, ps] of prevLayer.entries()) for (const t of ts) for (const b of [ps.b + t, ps.b - t]) if (b > 0) states.push({ b, src: 'derived', parent: pk, t, amounts: [t], pref: -0.4 });
      // 只有一個數字的行可能是雜訊（手寫、底紋）：允許略過，結存沿用上一列
      if (it.row.tokens.length <= 1) for (const [pk, ps] of prevLayer.entries()) states.push({ b: ps.b, src: 'skip', parent: pk, amounts: [], pref: -0.5 });
    }
    for (const s of states) {
      s.score = -Infinity;
      s.from = null;
      if (!prevLayer.length) {
        s.score = s.pref;
        continue;
      }
      for (const [pk, ps] of prevLayer.entries()) {
        let gain = 0;
        if (s.src === 'open') gain = near(s.b, ps.b) ? 2 : 0;
        else if (s.src === 'derived' || s.src === 'skip') gain = s.parent === pk ? 0 : -Infinity; // 推算的結存本身不算證據，要靠下一列對上才划算
        else gain = s.amounts.some((t) => t > 0 && near(Math.abs(s.b - ps.b), t)) ? 2 : 0;
        const v = ps.score + gain + s.pref;
        if (v > s.score) {
          s.score = v;
          s.from = pk;
        }
      }
    }
    // 同一個結存只留分數最高的（避免狀態爆炸）
    const best = new Map();
    for (const s of states) if (s.score > -Infinity && (!best.has(s.b) || s.score > best.get(s.b).score)) best.set(s.b, s);
    if (it.kind === 'row' && it.row.tokens.length <= 1) for (const s of states) if (s.src === 'skip' && s.score > -Infinity && best.get(s.b) !== s && s.score >= (best.get(s.b)?.score ?? -Infinity)) best.set(s.b, s);
    layers.push([...best.values()].sort((a, b) => b.score - a.score).slice(0, 40));
  }
  // 回溯
  const path = new Array(seq.length);
  let k = layers.length ? 0 : -1;
  for (let i = layers.length - 1; i >= 0; i--) {
    const s = layers[i][k];
    path[i] = s;
    if (i > 0) k = s.from;
  }
  const out = [];
  let reliable = false; // 上一列結存可信（照片表頭、或已對上的列）
  for (const [i, it] of seq.entries()) {
    if (it.kind === 'open') {
      reliable = true;
      continue;
    }
    const s = path[i];
    if (s.src === 'skip') continue; // 判定為雜訊的行
    const p = i > 0 ? path[i - 1] : null;
    const r = it.row;
    const nx = path[i + 1] && seq[i + 1]?.kind === 'row' ? path[i + 1] : null;
    const matchedPrev = p && (s.src === 'derived' ? true : s.amounts.some((t) => t > 0 && near(Math.abs(s.b - p.b), t)));
    const matchedNext = nx && (nx.src === 'derived' || nx.amounts.some((t) => t > 0 && near(Math.abs(nx.b - s.b), t)));
    let status;
    let amount;
    let note = '';
    if (s.src === 'derived') {
      status = 'corrected';
      amount = s.t;
      note = '結存沒讀清楚，依上一列結存與本列金額推算';
    } else if (matchedPrev) {
      status = 'ok';
      amount = Math.abs(s.b - p.b);
    } else if (p && matchedNext && reliable) {
      status = 'inferred';
      amount = Math.abs(s.b - p.b);
      note = `金額沒讀清楚（照片讀成 ${s.amounts.slice(0, 3).join('／') || '—'}），依前後結存推算`;
    } else if (!p) {
      // 第一列：存摺開戶（金額＝結存）或沒有承前頁結存
      const own = s.amounts.find((t) => near(t, s.b));
      status = own ? 'ok' : 'check';
      amount = own ?? s.amounts[s.amounts.length - 1] ?? 0;
      note = own ? '' : '第一列沒有上一列結存可核對';
    } else {
      status = 'check';
      amount = s.amounts.length ? s.amounts[s.amounts.length - 1] : Math.abs(s.b - p.b);
      note = '金額或結存對不上，請對照照片修正';
    }
    const dep = p && !near(s.b, p.b) && status !== 'check' ? s.b > p.b : !p && status === 'ok' ? true : DEPOSIT_HINT.test(r.summary);
    amount = Math.round(amount * 100) / 100;
    reliable = status !== 'check';
    out.push({ page: it.page, date: r.date, dateGuessed: r.dateGuessed, summary: r.summary, kind: r.kind, memo: r.memo, withdrawal: dep ? 0 : amount, deposit: dep ? amount : 0, balance: s.b, status, note: [note, r.dateGuessed ? '日期沒讀到，沿用上一列' : ''].filter(Boolean).join('；'), raw: r.raw });
  }
  // 重複的列放回它所在照片的開頭，方便對照
  for (const it of items.filter((x) => x.dupOf)) {
    const twin = out.find((o) => o.raw === it.dupOf.raw);
    const at = out.findIndex((o) => o.page === it.page);
    out.splice(at < 0 ? out.length : at, 0, { ...(twin || {}), page: it.page, status: 'duplicate', note: '和前一張照片的同一列重複（存摺補登時重印）', raw: it.row.raw });
  }
  return out;
}

/** 存摺明細列（和匯入中心的格式相同；id 由帳戶、日期、金額、結存決定，重複匯入會被認出） */
export function toBankLine(r, { bankAccountId = 'main', batchId = '' } = {}) {
  const base = [bankAccountId, r.date, r.withdrawal, r.deposit, r.balance].join('|');
  return {
    id: 'bk_' + fnv1a(base) + '_p',
    batch_id: batchId,
    bank_account_id: bankAccountId,
    date: r.date,
    description: r.summary || (r.deposit ? '存入' : '支出'),
    withdrawal: r.withdrawal,
    deposit: r.deposit,
    balance: r.balance,
    note: r.memo || '',
    counterparty: '',
    match_key: null,
    source: 'passbook_photo',
  };
}

/** 已經在系統裡的存摺明細（同日期、同金額、同結存） */
export function alreadyImported(r, existing) {
  return existing.some((b) => b.date === r.date && near(b.withdrawal || 0, r.withdrawal) && near(b.deposit || 0, r.deposit) && (b.balance === null || b.balance === undefined || near(b.balance, r.balance)));
}

// ── 補登分錄的建議科目（存摺沒對到帳上分錄時）
const RULES = [
  [/綠界|ecpay/i, '1111', '綠界撥款（應收帳款－信用卡未撥款項）'],
  [/LINE|連加/i, '1112', 'LINE Pay 撥款'],
  [/街口/, '1113', '街口撥款'],
  [/台灣\s*pay/i, '1114', '台灣Pay 撥款'],
  [/uber|優食|foodpanda|外送/i, '1115', '外送平台撥款'],
  [/利息/, '7101', '利息收入'],
  [/手續費|匯費/, '6131', '手續費'],
  [/薪資|薪水/, '6101', '薪資'],
  [/房租|租金/, '6111', '房租'],
  [/勞保|健保|勞退/, '6119', '勞健保'],
  [/電費|台電|水費|瓦斯/, '6118', '水電瓦斯'],
  [/電信|網路費|電話/, '6115', '電信'],
  [/代墊/, '2134', '員工代墊款'],
  [/營業稅|國稅|稅款/, '2132', '應付稅捐'],
  [/會計.{0,2}零用金/, '1102', '零用金-會計行政'],
  [/零用金/, '1101', '零用金-門市收銀'],
  [/訂金|尾款|貨款|企業|公司|有限/, '2111', '支付供應商（訂金、尾款、貨款）'],
];

/** 以前的存摺補登分錄：說明（去掉數字）→ 對方科目 */
export function bankHistory(entries, gl) {
  const out = [];
  for (const e of entries) {
    if (e.source !== 'bank') continue;
    const other = (e.lines || []).find((l) => l.account !== gl);
    const key = String(e.description || '').replace(/[\d\s]+/g, '');
    if (other && key) out.push({ key, account: other.account });
  }
  return out.reverse(); // 新的優先
}

/**
 * @param line 存摺明細列
 * @param history bankHistory() 的結果（同一說明照舊）
 * @returns {{ account, why }}
 */
export function suggestBankAccount(line, history = []) {
  const text = `${line.description || ''} ${line.note || ''}`;
  const key = String(line.description || '').replace(/[\d\s]+/g, '');
  const past = key && history.find((h) => h.key === key);
  if (past) return { account: past.account, why: `以前「${key}」記這個科目` };
  if (line.deposit > 0 && /\d{4}銷/.test(text)) return { account: '1101', why: '門市現金營收存入（零用金-門市收銀）' };
  for (const [re, account, why] of RULES) if (re.test(text)) return { account, why };
  if (line.deposit > 0 && /現金/.test(text)) return { account: '1101', why: '現金存入' };
  return line.deposit > 0 ? { account: '2161', why: '來源不明，先記暫收款' } : { account: '1291', why: '用途不明，先記暫付款' };
}
