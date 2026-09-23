// 通用匯入器：定義每種資料的「欄位 + 同義詞」，自動找表頭列並對應欄位。
// 使用者調整過的對應會以「表頭簽章」存成範本，同格式檔案下次自動套用（一勞永逸）。

import { compactKey, normalizeText, fnv1a } from './text.js';

const f = (key, label, syn, extra = {}) => ({ key, label, syn, ...extra });

export const TARGETS = {
  sales: {
    label: 'POS 銷售明細',
    hint: '每列一個品項（含數量、金額），可含訂單編號、付款方式、備註',
    fields: [
      f('datetime', '日期時間', ['日期時間', '交易時間', '結帳時間', '訂單時間', '建立時間', '銷售時間', '下單時間', '開單時間', '消費時間', '成立時間', 'datetime', 'createdat', 'orderedat']),
      f('date', '日期', ['日期', '營業日', '營業日期', '交易日期', '銷售日期', '結帳日期', '訂單日期', '消費日期', 'date', 'businessdate']),
      f('time', '時間', ['時間', '交易時刻', 'time']),
      f('order_no', '訂單/單號', ['訂單編號', '單號', '訂單號碼', '訂單號', '交易序號', '交易編號', '帳單編號', '結帳單號', '流水號', '序號', '發票號碼', 'orderno', 'orderid', 'order', 'receipt', 'billno']),
      f('item', '品項名稱', ['品項名稱', '品項', '商品名稱', '品名', '商品', '產品名稱', '產品', '餐點名稱', '餐點', '菜單名稱', '項目名稱', '項目', 'itemname', 'item', 'product', 'productname', 'name'], { required: true }),
      f('option', '規格/選項', ['規格', '選項', '口味', '加料', '客製化', '客製', '調整', '品項選項', '商品規格', '附加選項', 'option', 'options', 'modifier', 'modifiers', 'variant']),
      f('category', '分類', ['分類', '類別', '品類', '商品分類', '商品類別', '品項分類', '品項類別', '菜單分類', 'category']),
      f('qty', '數量', ['數量', '份數', '銷售數量', '杯數', 'qty', 'quantity', 'count']),
      f('unit_price', '單價', ['單價', '售價', '價格', '原價', '品項單價', '商品單價', 'price', 'unitprice']),
      f('amount', '金額(小計)', ['小計', '金額', '銷售金額', '銷售額', '品項金額', '品項小計', '實收', '實收金額', '應收', '應收金額', '總計', '合計', '總金額', 'amount', 'subtotal', 'total', 'sales']),
      f('discount', '折扣', ['折扣', '折扣金額', '折讓', '優惠', '優惠金額', '折價', 'discount']),
      f('payment', '付款方式', ['付款方式', '支付方式', '結帳方式', '付款', '支付', '付款類型', '收款方式', 'payment', 'paymethod', 'paymenttype', 'tender']),
      f('status', '狀態', ['狀態', '訂單狀態', '交易狀態', '品項狀態', 'status', 'state']),
      f('note', '備註', ['備註', '註記', '說明', '品項備註', '訂單備註', '原因', '折扣原因', 'note', 'notes', 'memo', 'remark', 'comment']),
      f('member', '會員', ['會員', '會員編號', '會員電話', '會員手機', '會員名稱', '顧客', '顧客電話', '客戶', '手機', '電話', 'member', 'memberid', 'customer', 'phone']),
      f('staff', '人員', ['人員', '服務人員', '收銀員', '員工', '結帳人員', '點餐人員', '操作人員', 'staff', 'cashier', 'employee']),
      f('channel', '用餐方式/通路', ['訂單類型', '用餐方式', '通路', '來源', '內用外帶', '取餐方式', '訂單來源', 'type', 'channel', 'source']),
    ],
    validate: (m) => (m.item === undefined ? '請指定「品項名稱」欄' : m.amount === undefined && m.unit_price === undefined ? '請指定「金額」或「單價」欄' : m.datetime === undefined && m.date === undefined ? '請指定「日期時間」或「日期」欄' : null),
  },
  ecpay_tx: {
    label: '綠界刷卡明細',
    hint: '每列一筆信用卡交易',
    fields: [
      f('datetime', '交易時間', ['交易時間', '付款時間', '授權時間', '交易日期', '授權日期', '付款日期', '訂單成立時間', '訂單建立時間', 'paymentdate', 'tradedate', 'date']),
      f('order_no', '訂單編號', ['廠商訂單編號', '特店訂單編號', '特店交易編號', '商店訂單編號', '訂單編號', 'merchanttradeno', 'orderno']),
      f('provider_no', '綠界交易編號', ['綠界交易編號', '綠界訂單編號', '交易編號', '綠界交易序號', 'tradeno']),
      f('amount', '交易金額', ['交易金額', '訂單金額', '授權金額', '金額', '請款金額', 'tradeamt', 'amount'], { required: true }),
      f('fee', '手續費', ['手續費', '交易手續費', '金流手續費', '服務費', '處理費', 'fee', 'handlingcharge']),
      f('net', '實收/撥款金額', ['撥款金額', '實撥金額', '實收金額', '入帳金額', '淨額', 'net']),
      f('status', '狀態', ['交易狀態', '付款狀態', '訂單狀態', '狀態', '請款狀態', 'status']),
      f('payout_date', '撥款日期', ['撥款日期', '預計撥款日', '預計撥款日期', '撥款日', '入帳日期', 'payoutdate']),
      f('method', '付款方式', ['付款方式', '支付方式', '交易方式', '卡別', 'paymenttype']),
      f('card_last4', '卡號末四碼', ['卡號末四碼', '末四碼', '卡號後四碼', '信用卡末四碼', '卡號', 'card4no', 'cardno']),
      f('auth_code', '授權碼', ['授權碼', '授權碼碼', 'authcode']),
      f('note', '備註', ['備註', '商品名稱', '交易描述', 'itemname', 'remark']),
    ],
    validate: (m) => (m.amount === undefined ? '請指定「交易金額」欄' : m.datetime === undefined ? '請指定「交易時間」欄' : null),
  },
  payouts: {
    label: '撥款明細（綠界 / LINE Pay / 行動支付）',
    hint: '每列一筆撥款（入帳）',
    fields: [
      f('payout_date', '撥款日期', ['撥款日期', '撥款日', '入帳日期', '匯款日期', '實際撥款日', '撥付日期', '日期', 'payoutdate', 'date'], { required: true }),
      f('provider', '金流', ['金流', '支付工具', '付款方式', '平台', '服務', 'provider']),
      f('gross', '交易總額', ['交易金額', '交易總額', '訂單總額', '銷售總額', '應撥金額', '請款金額', '總金額', 'gross', 'amount']),
      f('fee', '手續費', ['手續費', '手續費合計', '交易手續費', '服務費', '處理費', 'fee']),
      f('net', '撥款金額', ['撥款金額', '實撥金額', '實際撥款金額', '入帳金額', '撥付金額', '淨額', 'net', 'payout']),
      f('period_from', '交易期間起', ['交易期間起', '交易起日', '請款起日', '起日', 'from']),
      f('period_to', '交易期間迄', ['交易期間迄', '交易迄日', '請款迄日', '迄日', 'to']),
      f('tx_count', '筆數', ['筆數', '交易筆數', '件數', 'count']),
      f('ref', '撥款編號', ['撥款編號', '撥款單號', '批次編號', '序號', 'ref', 'batchno']),
      f('note', '備註', ['備註', '說明', 'note', 'remark']),
    ],
    validate: (m) => (m.payout_date === undefined ? '請指定「撥款日期」欄' : m.net === undefined && m.gross === undefined ? '請指定「撥款金額」或「交易總額」欄' : null),
  },
  bank: {
    label: '銀行存摺明細',
    hint: '網銀匯出的交易明細（日期、摘要、支出、存入、餘額）',
    fields: [
      f('date', '交易日期', ['交易日期', '日期', '帳務日期', '記帳日', '入帳日', '交易日', 'date'], { required: true }),
      f('description', '摘要', ['摘要', '說明', '交易摘要', '交易說明', '交易類別', '交易種類', 'description']),
      f('withdrawal', '支出', ['支出', '支出金額', '提款', '提出', '提款金額', '支領', '轉出', '扣款', 'withdrawal', 'debit']),
      f('deposit', '存入', ['存入', '存入金額', '存款', '存款金額', '收入', '轉入', '入帳', 'deposit', 'credit']),
      f('amount', '金額（正負）', ['金額', '交易金額', '發生額', 'amount']),
      f('balance', '餘額', ['餘額', '結餘', '帳戶餘額', '可用餘額', 'balance']),
      f('note', '備註', ['備註', '附言', '備註欄', '交易資訊', '註記', 'note', 'memo']),
      f('counterparty', '對方帳號/戶名', ['對方帳號', '對方戶名', '轉出入帳號', '轉入帳號', '對方', '交易對象', 'counterparty']),
    ],
    validate: (m) => (m.date === undefined ? '請指定「交易日期」欄' : m.withdrawal === undefined && m.deposit === undefined && m.amount === undefined ? '請指定「支出／存入」或「金額」欄' : null),
  },
  journal: {
    label: '會計分錄（舊帳匯入）',
    hint: '每列一行分錄：日期、傳票號、科目、借方、貸方、摘要',
    fields: [
      f('date', '日期', ['日期', '傳票日期', '交易日期', '記帳日期', 'date'], { required: true }),
      f('voucher_no', '傳票號碼', ['傳票號碼', '傳票編號', '傳票號', '憑證號碼', '單據號碼', '分錄號', 'voucher', 'voucherno']),
      f('account_code', '科目代號', ['科目代號', '科目代碼', '會計科目代號', '會計項目代號', '科目編號', '代號', 'code', 'accountcode']),
      f('account_name', '科目名稱', ['科目名稱', '會計科目', '會計項目', '科目', '項目', 'account', 'accountname']),
      f('debit', '借方', ['借方', '借方金額', '借', 'debit', 'dr']),
      f('credit', '貸方', ['貸方', '貸方金額', '貸', 'credit', 'cr']),
      f('amount', '金額（單欄）', ['金額', 'amount']),
      f('side', '借貸別', ['借貸', '借貸別', '借/貸', 'side', 'drcr']),
      f('memo', '摘要', ['摘要', '說明', '備註', '內容', 'memo', 'description']),
      f('partner', '對象', ['對象', '廠商', '客戶', '往來對象', '供應商', 'partner', 'vendor']),
    ],
    validate: (m) => (m.date === undefined ? '請指定「日期」欄' : m.account_code === undefined && m.account_name === undefined ? '請指定「科目代號」或「科目名稱」' : m.debit === undefined && m.credit === undefined && m.amount === undefined ? '請指定「借方／貸方」或「金額」欄' : null),
  },
  purchases: {
    label: '進貨／採購紀錄',
    hint: '每列一筆進貨：日期、供應商、品項、數量、單價',
    fields: [
      f('date', '進貨/到貨日', ['到貨日', '到貨日期', '進貨日期', '交貨日期', '收貨日期', '日期', 'date'], { required: true }),
      f('order_date', '訂購日', ['訂購日', '訂購日期', '下單日期', '叫貨日期', 'orderdate']),
      f('supplier', '供應商', ['供應商', '廠商', '廠商名稱', '供應商名稱', '進貨廠商', 'supplier', 'vendor']),
      f('item', '品項', ['品項', '品名', '原物料', '材料', '商品', '項目', 'item', 'material']),
      f('qty', '數量', ['數量', '進貨量', '進貨數量', 'qty', 'quantity']),
      f('unit', '單位', ['單位', 'unit']),
      f('unit_price', '單價', ['單價', '採購單價', '進價', 'price', 'unitprice']),
      f('amount', '金額', ['金額', '小計', '總價', '總金額', '進貨金額', 'amount', 'total']),
      f('yield_score', '良率評分(%)', ['良率', '良率評分', '品質評分', '評分', 'yield', 'quality']),
      f('invoice_no', '發票號碼', ['發票號碼', '發票', '單據號碼', 'invoice']),
      f('note', '備註', ['備註', '說明', 'note']),
    ],
    validate: (m) => (m.item === undefined ? '請指定「品項」欄' : m.amount === undefined && m.unit_price === undefined ? '請指定「金額」或「單價」欄' : null),
  },
  assets: {
    label: '固定資產清單',
    hint: '資產名稱、取得日期、成本、耐用年限',
    fields: [
      f('name', '資產名稱', ['資產名稱', '名稱', '品名', '設備名稱', '財產名稱', 'name'], { required: true }),
      f('category', '類別', ['類別', '資產類別', '分類', 'category']),
      f('acquired_on', '取得日期', ['取得日期', '購入日期', '購置日期', '啟用日期', '日期', 'date'], { required: true }),
      f('cost', '取得成本', ['取得成本', '成本', '金額', '購入金額', '原始成本', 'cost', 'amount'], { required: true }),
      f('life_years', '耐用年限', ['耐用年限', '耐用年數', '年限', '使用年限', 'life']),
      f('residual', '殘值', ['殘值', '預估殘值', 'residual', 'salvage']),
      f('note', '備註', ['備註', '廠商', '說明', 'note']),
    ],
  },
  customers: {
    label: '會員名單',
    hint: '會員編號/電話、姓名、等級、偏好',
    fields: [
      f('member_no', '會員編號/電話', ['會員編號', '會員電話', '手機', '電話', '會員', 'member', 'phone'], { required: true }),
      f('name', '姓名', ['姓名', '名稱', '會員名稱', '稱呼', 'name']),
      f('tier', '等級', ['等級', '會員等級', '級別', 'tier', 'level']),
      f('birthday', '生日', ['生日', '出生日期', 'birthday']),
      f('preferences', '偏好', ['偏好', '喜好', '常點', '口味偏好', 'preference']),
      f('joined_on', '加入日期', ['加入日期', '註冊日期', '入會日期', 'joined']),
      f('note', '備註', ['備註', 'note']),
    ],
  },
  einvoice: {
    label: '電子發票（進項）',
    hint: '財政部電子發票平台下載之進項發票明細',
    fields: [
      f('invoice_no', '發票號碼', ['發票號碼', '發票字軌號碼', '字軌號碼', '發票號', 'invoiceno'], { required: true }),
      f('date', '發票日期', ['發票日期', '開立日期', '日期', 'date'], { required: true }),
      f('seller_tax_id', '賣方統編', ['賣方統編', '賣方統一編號', '銷售人統一編號', '商店統編', '統一編號', '統編', 'sellerid']),
      f('seller_name', '賣方名稱', ['賣方名稱', '銷售人名稱', '商店店名', '店名', '營業人名稱', '賣方', 'sellername']),
      f('buyer_tax_id', '買方統編', ['買方統編', '買方統一編號', '買受人統一編號', 'buyerid']),
      f('amount', '銷售額(未稅)', ['銷售額', '未稅金額', '銷售額合計', 'salesamount']),
      f('tax', '稅額', ['稅額', '營業稅額', '營業稅', 'tax']),
      f('total', '總計', ['總計', '總金額', '發票金額', '含稅金額', '金額', 'total']),
      f('status', '狀態', ['發票狀態', '狀態', 'status']),
      f('items', '品項', ['品項名稱', '品名', '品項', '明細', 'item', 'items']),
    ],
  },
};

// 「金額(元)」「單價（含稅）」→ 去掉尾端括號註記再比對
export function headerKey(h) {
  const stripped = normalizeText(h).replace(/\([^)]*\)\s*$/, '');
  return compactKey(stripped) || compactKey(h);
}

function scoreHeader(h, syn) {
  const k = headerKey(h);
  if (!k) return 0;
  let best = 0;
  for (let i = 0; i < syn.length; i++) {
    const sk = compactKey(syn[i]);
    if (!sk) continue;
    if (k === sk) return 100 - i * 0.1; // 同義詞越前面越優先（例：小計 優於 金額）
    if (k.length >= 2 && sk.length >= 2) {
      if (k.startsWith(sk) || k.endsWith(sk)) best = Math.max(best, 60 + Math.min(sk.length, 10));
      else if (k.includes(sk)) best = Math.max(best, 40 + Math.min(sk.length, 10));
    }
  }
  return best;
}

// 在前 25 列中，找出最像表頭的一列
export function detectHeaderRow(rows, targetKey) {
  const t = TARGETS[targetKey];
  let bestIdx = 0;
  let bestScore = -1;
  const limit = Math.min(rows.length, 25);
  for (let i = 0; i < limit; i++) {
    const row = rows[i] || [];
    const nonEmpty = row.filter((c) => String(c).trim()).length;
    if (nonEmpty < 2) continue;
    let score = 0;
    for (const field of t.fields) {
      let fb = 0;
      for (const cell of row) fb = Math.max(fb, scoreHeader(cell, field.syn));
      if (fb >= 60) score += fb;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return { index: bestIdx, score: bestScore };
}

// 以分數由高到低指派，每欄只對應一個欄位
export function autoMap(headers, targetKey) {
  const t = TARGETS[targetKey];
  const cands = [];
  t.fields.forEach((field, fi) => {
    headers.forEach((h, ci) => {
      const s = scoreHeader(h, field.syn);
      if (s >= 50) cands.push({ field: field.key, ci, s, fi });
    });
  });
  cands.sort((a, b) => b.s - a.s || a.fi - b.fi || a.ci - b.ci);
  const mapping = {};
  const usedCols = new Set();
  for (const c of cands) {
    if (mapping[c.field] !== undefined || usedCols.has(c.ci)) continue;
    mapping[c.field] = c.ci;
    usedCols.add(c.ci);
  }
  return mapping;
}

export function headerSignature(headers) {
  return fnv1a(headers.map(headerKey).filter(Boolean).join('|'));
}

// 猜測檔案屬於哪一種資料
export function guessTarget(rows, fileName = '') {
  const name = fileName.normalize('NFKC');
  if (/撥款/.test(name)) return 'payouts';
  if (/綠界|ecpay|刷卡/i.test(name)) return 'ecpay_tx';
  if (/存摺|銀行|對帳單|交易明細.*帳戶/.test(name)) return 'bank';
  if (/發票/.test(name)) return 'einvoice';
  if (/銷售|pos|品項|訂單/i.test(name)) return 'sales';
  let best = 'sales';
  let bestScore = -1;
  for (const key of Object.keys(TARGETS)) {
    const { score } = detectHeaderRow(rows, key);
    const norm = score / Math.sqrt(TARGETS[key].fields.length);
    if (norm > bestScore) {
      bestScore = norm;
      best = key;
    }
  }
  return best;
}

// 依對應取出物件（值皆為原始字串，後續由各模組正規化）
export function extract(rows, headerIndex, mapping) {
  const out = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => String(c ?? '').trim() === '')) continue;
    const o = { _row: i + 1 };
    for (const [k, ci] of Object.entries(mapping)) {
      if (ci === null || ci === undefined || ci < 0) continue;
      o[k] = String(r[ci] ?? '').trim();
    }
    out.push(o);
  }
  return out;
}
