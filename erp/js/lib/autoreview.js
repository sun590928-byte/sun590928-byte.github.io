// 本機自動覆核：把每天人工（或 Claude）覆核憑證的判斷寫成規則。
// 欄位來源依可靠度：老闆手動填的 > 發票 QR 碼 > 財政部電子發票／已申報媒體檔（依發票號碼）> 檔名 > 文字辨識 > 廠商資料庫。
// 會計項目：老闆以前對同一家店的選擇 > 品項關鍵字與「以前相似品項」一致 > 其中之一 > 綜合賣場列雜項。
// 每個欄位記下來源與理由；有疑點的列入 issues，留在「待覆核」等老闆確認，沒有疑點的標「已覆核」可直接入帳。
// 純計算，可單獨測試。

import { classifyExpense } from './classify.js';
import { lookupVendor, predictAccount } from './vendorkb.js';
import { parseDocName } from './docname.js';
import { INVOICE_NO_RE, NON_DEDUCTIBLE_ACCOUNTS, FIXED_ASSET_ACCOUNTS, DED_CODES, TAX_TYPES } from './vat.js';
import { round2 } from './money.js';

export const SOURCE_LABELS = { user: '手動', qr: 'QR 碼', einvoice: '電子發票', filed: '已申報媒體檔', filename: '檔名', ocr: '文字辨識', kb: '廠商資料庫', learned: '以前相似品項', rule: '規則', classify: '品項關鍵字' };
const QUALITY = { user: 1, qr: 1, einvoice: 1, filed: 0.97, filename: 0.9, ocr: 0.7, kb: 0.85, learned: 0.8, rule: 0.8, classify: 0.7 };

const GENERAL_STORES = /全聯|家樂福|好市多|costco|大潤發|愛買|頂好|美廉社|7-?11|7-?eleven|統一超商|全家|萊爾富|ok超商|momo|富邦媒體|pchome|網路家庭|蝦皮|shopee|小北|寶雅|大創|daiso|ikea|宜家|屈臣氏|康是美/i;
// 超商、生活百貨的零星採買（老闆的規則：大創、7-11 等列 6133 雜項費用）；網購平台什麼都賣，不套用
const SUNDRY_STORES = /全聯|美廉社|7-?11|7-?eleven|統一超商|全家|萊爾富|ok超商|小北|寶雅|大創|daiso|屈臣氏|康是美/i;
// 一張照片是好幾張收據的彙總（「收據7份」「多家彙總」）
const BUNDLE = /彙總|多家|收據\s*\d+\s*[份張]|\d+\s*份收據/;
const EQUIPMENT = /咖啡機|磨豆機|製冰機|冰箱|冷凍櫃|冷藏櫃|烤箱|淨水|純水機|電腦|筆電|收銀機|印表機|冷氣|空調|洗碗機|設備|機台/;
// 達資本化門檻時依品項列固定資產科目
const ASSET_BY_KEYWORD = [
  ['1511', /咖啡機|磨豆機|研磨機|義式機/],
  ['1521', /冰箱|冷凍櫃|冷藏櫃|製冰機|烤箱|淨水|純水機|洗碗機|冷氣|空調/],
  ['1531', /電腦|筆電|收銀機|pos機|印表機|平板/i],
  ['1541', /裝潢|木作|隔間|工程款/],
];
// 老闆在備註寫過「不入帳、不認列、暫緩、家用」等決定的憑證，自動覆核不碰
const HOLD_NOTE = /不入帳|不認列|先不|暫緩|家用|私人|待確認|待查/;
// 會計項目信心達此值才算「沒有疑點」
const ACCOUNT_SURE = 0.7;

const vatOf = (total) => round2(total - Math.round(total / 1.05));
const near5 = (total, tax) => Math.abs(tax - vatOf(total)) <= 1;
const has = (v) => v !== null && v !== undefined && v !== '';
const sumOf = (list) => round2(list.reduce((t, i) => t + (Number(i.total) || 0), 0));

function summarize(items = []) {
  const names = items.map((i) => String(i.name || '').replace(/\s+/g, '').replace(/^[\d*#\-.]+/, '')).filter(Boolean);
  if (!names.length) return '';
  const first = names[0].slice(0, names.length > 1 ? 7 : 10);
  return names.length > 1 ? `${first}等${names.length}項` : first;
}

/**
 * @param doc 憑證
 * @param ctx { qr: 發票[]（assembleInvoices）, ocr: extractReceiptFields 結果, einvoices, filed: 媒體檔進項列, kb, accounts, settings, docs, today }
 * @returns {{ patch, confidence, reasons: string[], issues: string[], sources: object, clean: boolean }}
 */
export function autoReview(doc, ctx = {}) {
  const { qr = [], ocr = null, einvoices = [], filed = [], kb = null, accounts = [], settings = {}, docs = [], today = new Date().toISOString().slice(0, 10) } = ctx;
  const shop = settings.tax_id || '';
  const threshold = Number(settings.capitalize_threshold) || 80000;
  const accSet = new Set(accounts.map((a) => a.code));
  const accName = (c) => accounts.find((a) => a.code === c)?.name || '';
  const reasons = [];
  const issues = [];
  const sources = {};
  const out = {};

  // 老闆或 Claude 覆核過的憑證：欄位不覆寫，只做檢查。
  // 其餘（剛上傳、或之前自動辨識過）一律從檔名重新判斷，所以重跑辨識結果一致
  const manual = doc.reviewed_by === 'user' || (doc.status === 'reviewed' && doc.reviewed_by !== 'auto') || !!doc.ai;
  const fn = parseDocName(doc.original_name || '');
  const cur = (docVal, fnVal) => (manual ? (has(docVal) ? [docVal, 'user'] : null) : has(fnVal) ? [fnVal, 'filename'] : has(docVal) && !doc.auto ? [docVal, 'filename'] : null);
  const current = {
    invoice_no: cur(doc.invoice_no, fn.invoice_no),
    doc_date: cur(doc.doc_date, fn.date),
    amount_total: cur(has(doc.amount_total) ? Number(doc.amount_total) : null, fn.amount),
    vendor_name: cur(doc.vendor_name, fn.vendor),
  };
  // 依序取第一個有值的來源：手動 > 精準來源（QR、電子發票、媒體檔）> 檔名 > 文字辨識；手動時回傳與它不同的精準值
  const choose = (field, precise, weak = []) => {
    const c = current[field];
    if (c && c[1] === 'user') {
      out[field] = c[0];
      sources[field] = 'user';
      return precise.find((x) => x && has(x[0]) && String(x[0]) !== String(c[0]));
    }
    const list = [...precise, c, ...weak].filter((x) => x && has(x[0]));
    if (list.length) [out[field], sources[field]] = list[0];
    return null;
  };

  // ── 1. 照片上的發票：一張照片（或一張憑證）可能有好幾張發票
  const invs = qr.filter((i) => i && i.invoice_no);
  const qrByNo = new Map(invs.map((i) => [i.invoice_no, i]));
  const filedOf = (no) => filed.find((r) => r.invoice_no === no) || null;
  const fromQR = (i) => ({ invoice_no: i.invoice_no, date: i.date, total: i.total, tax: i.tax, buyer: i.buyer_tax_id || '', seller: i.seller_tax_id || '', items: i.items || [], src: 'qr' });
  const fromFiled = (r) => ({ invoice_no: r.invoice_no, date: null, total: round2(r.amount + r.tax), tax: r.tax, buyer: r.buyer || '', seller: r.seller || '', items: [], src: 'filed' });
  const fnNos = fn.invoice_nos || [];
  let q = invs.length === 1 ? invs[0] : null;
  let multi = null;
  if (fnNos.length > 1) {
    // 檔名列了好幾張發票號碼：照片 QR 讀到的用 QR，其餘用已申報媒體檔
    const list = fnNos.map((no) => (qrByNo.get(no) ? fromQR(qrByNo.get(no)) : filedOf(no) ? fromFiled(filedOf(no)) : null));
    if (list.every(Boolean)) multi = list;
    else issues.push(`檔名有 ${fnNos.length} 張發票，照片與申報資料只找到 ${list.filter(Boolean).length} 張`);
  } else if (invs.length > 1) {
    const wanted = current.invoice_no?.[0];
    if (current.amount_total && Math.abs(sumOf(invs) - current.amount_total[0]) < 1) multi = invs.map(fromQR);
    else if (wanted && qrByNo.has(wanted)) q = qrByNo.get(wanted);
    else {
      multi = invs.map(fromQR);
      issues.push(`照片有 ${invs.length} 張發票（合計 ${sumOf(invs)}），已全部拆成明細，請確認是否都屬於這張憑證`);
    }
  }
  if (multi) {
    q = null;
    reasons.push(`有 ${multi.length} 張發票（${multi.map((i) => i.invoice_no).join('、')}），合計 ${sumOf(multi)}，已自動拆分明細`);
  }
  const lead = multi ? multi[0] : q ? fromQR(q) : null;
  const leadSrc = multi ? (multi.every((i) => i.src === 'qr') ? 'qr' : 'filed') : 'qr';

  // ── 2. 依發票號碼對照財政部電子發票、已申報媒體檔
  const o = (k, min = 2) => (ocr?.[k] && ocr[k].score >= min ? ocr[k].value : null);
  const invNo = multi ? null : q?.invoice_no || current.invoice_no?.[0] || o('invoice_no');
  const ein = invNo ? einvoices.find((i) => i.invoice_no === invNo && !i.voided) : null;
  const fil = invNo ? filedOf(invNo) : null;
  if (ein) reasons.push(`財政部電子發票有這張（${ein.seller_name || ein.seller_tax_id || ''}）`);
  if (fil) reasons.push(`已申報於 ${Number(fil.ym.slice(0, 4)) - 1911} 年 ${Number(fil.ym.slice(5))} 月（扣抵代號 ${fil.ded_code}）`);
  if (multi) for (const i of multi) if (filedOf(i.invoice_no)) reasons.push(`${i.invoice_no} 已申報（扣抵代號 ${filedOf(i.invoice_no).ded_code}）`);

  // ── 3. 逐欄決定
  const conflict = [];
  const c1 = choose('invoice_no', [lead && [lead.invoice_no, leadSrc], fil && [fil.invoice_no, 'filed']], [[o('invoice_no'), 'ocr']]);
  if (c1 && !multi) conflict.push(`發票號碼：${SOURCE_LABELS[c1[1]]}是 ${c1[0]}，欄位是 ${out.invoice_no}`);
  const leadDate = multi ? multi.find((i) => i.date)?.date : q?.date;
  const c2 = choose('doc_date', [leadDate && [leadDate, 'qr'], ein && [ein.date, 'einvoice']], [[o('date'), 'ocr']]);
  if (c2) conflict.push(`日期：${SOURCE_LABELS[c2[1]]}是 ${c2[0]}，欄位是 ${out.doc_date}`);
  const c3 = choose('amount_total', [multi && [sumOf(multi), leadSrc], q && [q.total, 'qr'], ein && [Number(ein.total), 'einvoice'], fil && [round2(fil.amount + fil.tax), 'filed']], [[o('total'), 'ocr']]);
  if (c3 && Math.abs(c3[0] - out.amount_total) >= 1) conflict.push(`金額：${SOURCE_LABELS[c3[1]]}是 ${c3[0]}，欄位是 ${out.amount_total}`);
  for (const c of conflict) issues.push(`與手動填的不同－${c}`);
  // 檔名與照片不一致（檔名打錯、或照片拍到別張）
  if (current.amount_total?.[1] === 'filename' && sources.amount_total !== 'filename' && Math.abs(out.amount_total - current.amount_total[0]) >= 1) {
    issues.push(`檔名金額 ${current.amount_total[0]} 與${SOURCE_LABELS[sources.amount_total]} ${out.amount_total} 不同`);
  }
  if (current.invoice_no?.[1] === 'filename' && sources.invoice_no !== 'filename' && out.invoice_no !== current.invoice_no[0]) {
    issues.push(`檔名發票號碼 ${current.invoice_no[0]} 與${SOURCE_LABELS[sources.invoice_no]} ${out.invoice_no} 不同`);
  }
  if (current.doc_date?.[1] === 'filename' && ['qr', 'einvoice'].includes(sources.doc_date) && out.doc_date !== current.doc_date[0]) {
    reasons.push(`檔名日期 ${current.doc_date[0]}，發票上是 ${out.doc_date}，以發票為準`);
  }

  // 統編
  const buyer = lead ? lead.buyer : ein ? ein.buyer_tax_id || '' : fil ? fil.buyer || '' : o('buyer_tax_id') || doc.buyer_tax_id || '';
  sources.buyer_tax_id = lead ? leadSrc : ein ? 'einvoice' : fil ? 'filed' : o('buyer_tax_id') ? 'ocr' : doc.buyer_tax_id ? 'user' : null;
  out.buyer_tax_id = buyer;
  const sellerC = [lead && [lead.seller, leadSrc], ein && [ein.seller_tax_id, 'einvoice'], fil && [fil.seller, 'filed'], [o('seller_tax_id', 1), 'ocr']].filter((c) => c && c[0]);
  if (doc.vendor_tax_id && manual) [out.vendor_tax_id, sources.vendor_tax_id] = [doc.vendor_tax_id, 'user'];
  else if (sellerC.length) [out.vendor_tax_id, sources.vendor_tax_id] = sellerC[0];

  // 廠商：統編查資料庫 > 電子發票店名 > 檔名 > 照片文字比對 > 文字辨識
  const hit = lookupVendor(kb, { taxId: out.vendor_tax_id, name: current.vendor_name?.[0] || ein?.seller_name || '', text: ocr?.text || '' });
  if (current.vendor_name?.[1] === 'user') [out.vendor_name, sources.vendor_name] = [current.vendor_name[0], 'user'];
  else if (hit && hit.confidence >= 0.9) [out.vendor_name, sources.vendor_name] = [hit.name, 'kb'];
  else if (ein?.seller_name) [out.vendor_name, sources.vendor_name] = [ein.seller_name, 'einvoice'];
  else if (current.vendor_name) [out.vendor_name, sources.vendor_name] = current.vendor_name;
  else if (hit && hit.confidence >= 0.6) [out.vendor_name, sources.vendor_name] = [hit.name, 'kb'];
  else if (ocr?.vendor_name) [out.vendor_name, sources.vendor_name] = [ocr.vendor_name.value, 'ocr'];
  if (hit) reasons.push(hit.why);
  if (!out.vendor_tax_id && hit?.entry?.taxId && hit.confidence >= 0.85) [out.vendor_tax_id, sources.vendor_tax_id] = [hit.entry.taxId, 'kb'];

  // 憑證種類
  const fmtType = { 21: '三聯式發票', 22: '二聯式收銀機發票', 25: '電子發票' };
  if (doc.invoice_type && manual) out.invoice_type = doc.invoice_type;
  else if (q || (multi && leadSrc === 'qr')) out.invoice_type = '電子發票';
  else if (fil && fmtType[fil.fmt]) out.invoice_type = fmtType[fil.fmt];
  else if (multi && filedOf(multi[0].invoice_no) && fmtType[filedOf(multi[0].invoice_no).fmt]) out.invoice_type = fmtType[filedOf(multi[0].invoice_no).fmt];
  else if (ein) out.invoice_type = '電子發票';
  else if (ocr?.invoice_type) out.invoice_type = ocr.invoice_type.value;
  else out.invoice_type = doc.invoice_type || (out.invoice_no ? '' : '收據');

  // 品項與摘要（檔名的摘要是老闆寫的，優先）
  const items = q?.items?.length ? q.items : multi ? multi.flatMap((i) => i.items) : ein?.items?.length ? ein.items : doc.items || [];
  if (items.length) out.items = items;
  if (manual && doc.summary) [out.summary, sources.summary] = [doc.summary, 'user'];
  else if (fn.summary) [out.summary, sources.summary] = [fn.summary, 'filename'];
  else if (summarize(items)) [out.summary, sources.summary] = [summarize(items), q || multi ? 'qr' : 'einvoice'];
  else if (doc.summary && !doc.auto) [out.summary, sources.summary] = [doc.summary, 'filename'];
  else if (hit?.entry?.summary && hit.confidence >= 0.85) [out.summary, sources.summary] = [hit.entry.summary, 'kb'];

  // ── 4. 會計項目
  const itemText = [out.summary, ...items.map((i) => i.name)].filter(Boolean).join(' ');
  // 摘要就是品項描述（檔名或 QR），當品項判斷
  const cls = classifyExpense({ vendor: out.vendor_name || '', items: items.length ? items : out.summary ? [out.summary] : [] });
  const ruleHit = cls.account !== '6199' && accSet.has(cls.account);
  const nb = predictAccount(kb, itemText);
  const nbOk = nb && accSet.has(nb.account);
  const vend = hit?.entry?.account;
  const general = GENERAL_STORES.test(out.vendor_name || '');
  // 同一家店以前都記同一個科目；但這次品項關鍵字與相似品項都指向別的科目（例如茶行的運費）時不沿用
  const otherwise = ruleHit && cls.confidence >= 0.6 && nbOk && nb.account === cls.account && cls.account !== vend?.value;
  const vendorFixed = vend?.value && accSet.has(vend.value) && hit.confidence >= 0.6 && hit.entry.n >= 2 && vend.share >= 0.8 && !general && !otherwise;
  let account;
  let accConf;
  const pick = (code, conf, src, why) => {
    [account, accConf, sources.account] = [code, conf, src];
    if (why) reasons.push(why);
  };
  if (manual && doc.account) pick(doc.account, 1, 'user');
  else if (vendorFixed && ruleHit && cls.confidence >= 0.6 && cls.account !== vend.value) pick(vend.value, 0.65, 'kb', `這家店以前記 ${vend.value} ${accName(vend.value)}，但品項看起來像 ${cls.account} ${cls.label}`);
  else if (vendorFixed) pick(vend.value, 0.9, 'kb', `會計項目沿用這家店以前的選擇（${hit.entry.n} 次）：${vend.value} ${accName(vend.value)}`);
  else if (ruleHit && cls.confidence >= 0.6 && nbOk && nb.account === cls.account) pick(cls.account, 0.85, 'learned', `品項關鍵字與以前相似品項都判斷為 ${cls.account} ${accName(cls.account)}`);
  else if (ruleHit && cls.confidence >= 0.6 && !(nbOk && nb.p >= 0.9)) pick(cls.account, 0.7, 'classify', `依品項關鍵字判斷為 ${cls.account} ${cls.label}`);
  else if (nbOk && nb.p >= 0.9 && !ruleHit) pick(nb.account, 0.7, 'learned', `依以前相似品項判斷為 ${nb.account} ${accName(nb.account)}`);
  else if (SUNDRY_STORES.test(out.vendor_name || '') && !ruleHit && !(nbOk && nb.p >= 0.9) && accSet.has('6133')) pick('6133', 0.7, 'rule', '超商、生活百貨的零星採買列 6133 雜項費用');
  else if (vend?.value && accSet.has(vend.value) && vend.share >= 0.6 && hit.confidence >= 0.6) pick(vend.value, 0.6, 'kb', `這家店以前多半記 ${vend.value} ${accName(vend.value)}`);
  else if (ruleHit) pick(cls.account, 0.5, 'classify');
  else if (nbOk) pick(nb.account, 0.45, 'learned');
  else if (ocr?.text && classifyExpense({ text: ocr.text }).account !== '6199' && accSet.has(classifyExpense({ text: ocr.text }).account)) {
    const c = classifyExpense({ text: ocr.text });
    pick(c.account, 0.5, 'classify', `照片文字有「${c.label}」相關字詞`);
  }
  else pick(accSet.has('6199') ? '6199' : doc.account || '', 0.2, 'classify');
  // 資本化門檻：未達門檻的設備列 6135 雜項購置；達門檻的設備列固定資產（入帳時自動建立並提列折舊）
  const total = Number(out.amount_total) || 0;
  const eqText = `${itemText}${out.vendor_name || ''}`;
  if (sources.account !== 'user') {
    if (FIXED_ASSET_ACCOUNTS.has(account) && total > 0 && total < threshold && accSet.has('6135')) {
      reasons.push(`${account} ${accName(account)} 未達 ${threshold.toLocaleString()} 元資本化門檻，改列 6135 雜項購置`);
      account = '6135';
    } else if (!FIXED_ASSET_ACCOUNTS.has(account) && total >= threshold) {
      const kw = ASSET_BY_KEYWORD.find(([code, re]) => accSet.has(code) && re.test(eqText));
      if (kw) {
        [account, sources.account] = [kw[0], 'rule'];
        issues.push(`金額 ${total.toLocaleString()} 元達資本化門檻，已列 ${account} ${accName(account)}（入帳時自動建立固定資產並提列折舊），請確認`);
      } else if (EQUIPMENT.test(eqText)) issues.push(`設備金額 ${total.toLocaleString()} 元達資本化門檻，是否列固定資產（15xx）並提列折舊？`);
    }
  }
  out.account = account;
  if (accConf < ACCOUNT_SURE) {
    const alt = [cls.account, nb?.account, vend?.value].filter((c) => c && c !== account && c !== '6199' && accSet.has(c));
    issues.push(`會計項目請確認（推測 ${account} ${accName(account)}${alt.length ? `，也可能是 ${[...new Set(alt)].map((c) => `${c} ${accName(c)}`).join('、')}` : ''}）`);
  }

  // ── 5. 稅額與扣抵
  const isInvoice = !!out.invoice_no && INVOICE_NO_RE.test(out.invoice_no);
  const toShop = !!shop && buyer === shop;
  let tax = null;
  if (manual && has(doc.tax_amount)) [tax, sources.tax_amount] = [Number(doc.tax_amount), 'user'];
  else if (fil) [tax, sources.tax_amount] = [fil.tax, 'filed'];
  else if (toShop && isInvoice && !multi) {
    // QR 的銷售額有些店家填 0（也可能是免稅品）：只在「總計－銷售額」約為 5% 時採用，否則不推算、請老闆確認
    if (q && q.total === total && has(q.tax) && q.tax > 0) [tax, sources.tax_amount] = [q.tax, 'qr'];
    else if (q && q.total === total && !has(q.tax)) issues.push(`QR 碼的銷售額 ${q.sales_ex} 看不出稅額（可能是免稅品），請依發票確認稅額與課稅別`);
    else if (ein && has(ein.tax) && Number(ein.total) === total) [tax, sources.tax_amount] = [Number(ein.tax), 'einvoice'];
    else if (has(o('tax')) && near5(total, o('tax'))) [tax, sources.tax_amount] = [o('tax'), 'ocr'];
    else if (total > 0 && !/收銀機/.test(out.invoice_type || '')) {
      [tax, sources.tax_amount] = [vatOf(total), 'rule'];
      reasons.push(`稅額依含稅 ${total} 推算為 ${tax}（總額－總額÷1.05）`);
    }
  }
  if (tax !== null) out.tax_amount = tax;
  else if (!manual) out.tax_amount = null;

  if (buyer && shop && buyer !== shop) issues.push(`發票上的買方統編 ${buyer} 不是本店（${shop}）`);
  if (fil) {
    out.tax_type = fil.tax_type || '';
    out.ded_code = fil.ded_code || '';
    out.deductible = fil.ded_code === '1' || fil.ded_code === '2';
    if (fil.tax_type && fil.tax_type !== '1') reasons.push(`申報課稅別 ${fil.tax_type}（${TAX_TYPES[fil.tax_type] || ''}）`);
  } else if (manual && has(doc.deductible)) out.deductible = doc.deductible;
  else out.deductible = isInvoice && toShop && !NON_DEDUCTIBLE_ACCOUNTS[account];
  if (NON_DEDUCTIBLE_ACCOUNTS[account] && out.deductible && sources.account !== 'user') {
    out.deductible = false;
    reasons.push(NON_DEDUCTIBLE_ACCOUNTS[account]);
  }
  // 老闆以前對這家店一律不扣抵（例如外送平台）
  const ded = hit?.entry?.ded;
  if (!fil && !manual && out.deductible && ded?.no >= 2 && !ded.yes && hit.confidence >= 0.85) {
    out.deductible = false;
    reasons.push(`這家店以前的發票都沒有扣抵（${ded.no} 張），照舊不扣抵`);
  }
  if (isInvoice && !buyer && !fil && !multi && Number(out.tax_amount) > 0 && sources.tax_amount !== 'user') out.tax_amount = null;
  if (isInvoice && !buyer && (q || ein) && !manual) reasons.push('發票沒有買方統編（個人載具／二聯式），稅額不能扣抵');
  // 有發票號碼卻不知道買方統編：沒讀到 QR、文字，或文字裡有「買方」卻沒讀到統編 → 請老闆看一下，免得漏扣進項稅額
  const buyerUnknown = isInvoice && !buyer && !q && !multi && !ein && !fil && !manual && (!ocr?.text || /買方|買受人/.test(ocr.text));
  if (buyerUnknown) issues.push('沒讀到買方統編：發票上若有本店統編，請勾「可扣抵」並填稅額');

  // 多張發票：自動拆分明細（每張一行；稅額、申報代號照 QR 或媒體檔）
  if (multi && !manual && !doc.lines?.length) {
    out.lines = multi.map((i) => {
      const f = filedOf(i.invoice_no);
      const ok = !!shop && i.buyer === shop;
      const t = f ? f.tax : ok ? (has(i.tax) && i.tax > 0 ? i.tax : vatOf(i.total)) : 0;
      return { invoice_no: i.invoice_no, account, amount: i.total, tax: t, tax_type: f?.tax_type || '', ded_code: f?.ded_code || '', memo: summarize(i.items) };
    });
    out.tax_amount = round2(out.lines.reduce((t, p) => t + p.tax, 0));
    out.deductible = out.lines.some((p) => p.tax > 0 && (!p.ded_code || p.ded_code === '1' || p.ded_code === '2')) && !NON_DEDUCTIBLE_ACCOUNTS[account];
  }
  const dedCodes = out.lines ? out.lines.map((p) => p.ded_code) : [out.ded_code];
  if (dedCodes.some((c) => c === '2' || c === '4') && !FIXED_ASSET_ACCOUNTS.has(account)) issues.push(`申報為扣抵代號 ${dedCodes.find((c) => c === '2' || c === '4')}（${DED_CODES[dedCodes.find((c) => c === '2' || c === '4')]}），會計項目卻不是固定資產`);

  // 付款方式：沒有資料夾指定、還是預設值時，沿用老闆以前對這家店的付款方式（例如月結）
  const pay = hit?.entry?.pay;
  if (!manual && !doc.source_folder && (!doc.pay_account || doc.pay_account === '1101') && pay?.value && pay.value !== '1101' && accSet.has(pay.value) && pay.share >= 0.8 && hit.entry.n >= 2 && hit.confidence >= 0.85) {
    out.pay_account = pay.value;
    reasons.push(`付款方式沿用這家店以前的 ${pay.value} ${accName(pay.value)}`);
  }

  // ── 6. 檢查（每天覆核時會看的地方）
  if (!out.doc_date) issues.push('缺日期');
  else if (out.doc_date > today) issues.push(`日期 ${out.doc_date} 在今天之後`);
  else if (out.doc_date < `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`) issues.push(`日期 ${out.doc_date} 超過一年，請確認`);
  if (!(Number(out.amount_total) > 0)) issues.push('缺金額');
  if (out.invoice_no && !INVOICE_NO_RE.test(out.invoice_no)) issues.push(`發票號碼 ${out.invoice_no} 格式不對`);
  if (Number(out.tax_amount) > 0 && total > 0 && !near5(total, Number(out.tax_amount)) && !out.lines && sources.tax_amount !== 'filed') issues.push(`稅額 ${out.tax_amount} 不是含稅 ${total} 的 5%`);
  for (const k of ['doc_date', 'amount_total']) if (sources[k] === 'ocr') issues.push(`${k === 'doc_date' ? '日期' : '金額'}只由文字辨識取得，請核對照片`);
  if (sources.vendor_name === 'ocr') issues.push(`廠商「${out.vendor_name}」由文字辨識取得，可能有錯字`);
  if (!out.vendor_name) issues.push('缺廠商');
  const others = docs.filter((d) => d.id !== doc.id && d.status !== 'ignored');
  if (out.invoice_no) {
    const nos = new Set(out.lines ? out.lines.map((p) => p.invoice_no) : [out.invoice_no]);
    const dup = others.find((d) => (d.lines?.length ? d.lines.some((p) => nos.has(p.invoice_no)) : nos.has(d.invoice_no)));
    if (dup) issues.push(`發票號碼與「${dup.vendor_name || dup.original_name}」（${dup.doc_date || ''}）重複`);
  } else if (total > 0 && out.doc_date) {
    const dup = others.find((d) => d.doc_date === out.doc_date && Number(d.amount_total) === total && (!out.vendor_name || !d.vendor_name || d.vendor_name === out.vendor_name));
    if (dup) issues.push(`可能重複：「${dup.original_name || dup.vendor_name}」同一天、同金額`);
  }
  // 照片上的日期（文字辨識信心高）與檔名不同
  if (sources.doc_date === 'filename' && ocr?.date?.score >= 3 && ocr.date.value !== out.doc_date) issues.push(`照片上的日期像是 ${ocr.date.value}，檔名是 ${out.doc_date}`);
  if (BUNDLE.test(`${fn.vendor} ${fn.summary} ${out.summary || ''}`) && !doc.lines?.length) issues.push('這張照片是多張收據的彙總，請確認金額與拆分明細');
  // 備註多半是 Claude 覆核時寫的（存在 ai.notes）；「｜原註記」之後是舊的說明，不看
  const noteNow = String(doc.notes || doc.ai?.notes || '').split('｜原註記')[0];
  if (HOLD_NOTE.test(noteNow)) issues.push(`備註：${noteNow.slice(0, 40)}`);
  if (doc.hold) issues.push('標記為暫緩入帳');
  if (!invs.length && !ein && !fil && !ocr) reasons.push('沒有讀到 QR 碼與文字，只用檔名欄位');

  // ── 7. 信心：每個關鍵欄位的來源品質相乘
  const qOf = (k) => QUALITY[sources[k]] ?? 0.5;
  let confidence = qOf('doc_date') * qOf('amount_total') * (out.vendor_name ? qOf('vendor_name') : 0.6) * Math.max(0.2, accConf);
  if (out.invoice_no) confidence *= Math.max(0.85, qOf('invoice_no'));
  confidence = Math.round(Math.max(0, Math.min(1, confidence)) * 100) / 100;

  const patch = {};
  for (const [k, v] of Object.entries(out)) if (v !== undefined && !(manual && sources[k] === 'user')) patch[k] = v;
  const clean = !issues.length && confidence >= 0.5;
  return { patch, confidence, reasons, issues, sources, clean };
}
