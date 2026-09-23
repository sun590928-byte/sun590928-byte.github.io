// 帳冊 Excel：把日記簿、分類帳、試算表、損益表、資產負債表、固定資產、憑證清單整理成工作表列資料，
// 供各報表頁「匯出 Excel」與月結「下載本月帳冊」共用（純計算，可單獨測試）。

import { trialBalance, incomeStatement, balanceSheet, generalLedger, voucherKind } from './ledger.js';
import { accountMap, TYPE_LABELS, ASSET_CATEGORIES } from './coa.js';
import { assetSummary } from './assets.js';
import { archiveFolder } from './docname.js';

const SOURCE = { manual: '手動', pos: 'POS 營收', payout: '撥款入帳', depreciation: '折舊', cogs: '存貨成本', document: '憑證', asset: '資產購置', import: '舊帳匯入', opening: '期初開帳', closing: '年底結帳', bank: '存摺補登', vat: '營業稅結轉', vat_pay: '營業稅繳納' };

// 標題列（店名、報表名稱、期間）＋欄名
function titled(name, { business = '', title, period }, head, body, extra = {}) {
  const top = [[business], [title], [period ? `${period}　單位：新台幣元` : '單位：新台幣元'], []];
  return { name, rows: [...top, head, ...body], header: top.length + 1, ...extra };
}

export function journalSheet(entries, accounts, { from, to }, meta) {
  const accMap = accountMap(accounts);
  const list = entries.filter((e) => e.status !== 'void' && e.date >= from && e.date <= to).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.voucher_no || '') < (b.voucher_no || '') ? -1 : 1));
  const body = [];
  let dr = 0;
  let cr = 0;
  for (const e of list)
    for (const l of e.lines || []) {
      dr += Number(l.debit) || 0;
      cr += Number(l.credit) || 0;
      body.push([e.date, e.voucher_no || '', voucherKind(e), SOURCE[e.source] || e.source || '', e.description || '', l.account, accMap.get(l.account)?.name || '', Number(l.debit) || null, Number(l.credit) || null, l.memo || '', (e.attachments || []).length || null]);
    }
  body.push(['', '', '', '', '合計', '', '', Math.round(dr * 100) / 100, Math.round(cr * 100) / 100]);
  return titled('日記簿', { ...meta, title: '日記簿' }, ['日期', '傳票號碼', '傳票種類', '來源', '摘要', '科目代號', '會計項目', '借方', '貸方', '說明', '附件'], body, { widths: [11, 12, 12, 10, 34, 9, 22, 12, 12, 24, 6], bold: [4 + 1 + body.length - 1] });
}

export function ledgerSheet(entries, accounts, { from, to }, meta) {
  const gl = generalLedger(entries, accounts, { from, to });
  const body = [];
  const bold = [];
  for (const g of gl.values()) {
    bold.push(5 + body.length);
    body.push([`${g.account.code} ${g.account.name}`, '', '期初餘額', null, null, g.opening]);
    for (const r of g.rows) body.push([r.date, r.voucher_no || '', r.memo || '', r.debit || null, r.credit || null, r.balance]);
    body.push(['', '', '本期合計／期末餘額', g.debit, g.credit, g.closing], []);
  }
  return titled('分類帳', { ...meta, title: '分類帳' }, ['日期', '傳票號碼', '摘要', '借方', '貸方', '餘額'], body, { widths: [22, 12, 40, 12, 12, 14], bold });
}

export function trialSheet(entries, accounts, { from, to }, meta, name = '試算表') {
  const tb = trialBalance(entries, accounts, { from, to });
  const body = [];
  let last = null;
  for (const r of tb.rows) {
    if (r.type !== last) body.push([TYPE_LABELS[r.type] || r.type]);
    last = r.type;
    body.push([r.code, r.name, r.openDr || null, r.openCr || null, r.periodDr || null, r.periodCr || null, r.closeDr || null, r.closeCr || null]);
  }
  body.push(['', '合計', tb.totals.openDr, tb.totals.openCr, tb.totals.periodDr, tb.totals.periodCr, tb.totals.closeDr, tb.totals.closeCr], [], [tb.balanced ? '借貸平衡' : '借貸不平衡，請檢查分錄']);
  return titled(name, { ...meta, title: '試算表' }, ['代號', '會計項目', '期初借方', '期初貸方', '本期借方', '本期貸方', '期末借方', '期末貸方'], body, { widths: [8, 26, 13, 13, 13, 13, 13, 13] });
}

export function incomeSheet(entries, accounts, { from, to }, meta, name = '綜合損益表') {
  const is = incomeStatement(entries, accounts, { from, to });
  const base = is.netRevenue || 0;
  const pc = (v) => (base ? Math.round((v / base) * 1000) / 10 : null);
  const body = [];
  const bold = [];
  const row = (label, v, strong = false) => {
    if (strong) bold.push(5 + body.length);
    body.push([label, v, pc(v)]);
  };
  const head = (label) => {
    bold.push(5 + body.length);
    body.push([label]);
  };
  head('營業收入');
  is.revenue.forEach((r) => row(`　${r.code} ${r.name}`, r.amount));
  is.contra.forEach((r) => row(`　減：${r.name}`, -r.amount));
  row('營業收入淨額', is.netRevenue, true);
  head('營業成本');
  is.cogs.forEach((r) => row(`　${r.code} ${r.name}`, r.amount));
  row('營業成本合計', is.cogsTotal, true);
  row('營業毛利', is.grossProfit, true);
  head('營業費用');
  is.opex.forEach((r) => row(`　${r.code} ${r.name}`, r.amount));
  row('營業費用合計', is.opexTotal, true);
  row('營業淨利（淨損）', is.operatingIncome, true);
  if (is.nonopIncome.length || is.nonopExpense.length) {
    head('營業外收入及支出');
    is.nonopIncome.forEach((r) => row(`　${r.code} ${r.name}`, r.amount));
    is.nonopExpense.forEach((r) => row(`　減：${r.name}`, -r.amount));
  }
  row('稅前淨利（淨損）', is.pretax, true);
  is.tax.forEach((r) => row(`　減：${r.name}`, -r.amount));
  row('本期淨利（淨損）', is.netIncome, true);
  row('其他綜合損益', is.oci);
  row('本期綜合損益總額', is.comprehensiveIncome, true);
  return titled(name, { ...meta, title: '綜合損益表' }, ['項目', '金額', '占營收 %'], body, { widths: [34, 15, 10], bold });
}

export function balanceSheetRows(entries, accounts, { asOf }, meta) {
  const bs = balanceSheet(entries, accounts, { asOf });
  const body = [];
  const bold = [];
  const head = (label) => {
    bold.push(5 + body.length);
    body.push([label]);
  };
  const items = (list) => list.forEach((r) => body.push([`　${r.code.replace('*', '')} ${r.name}`, r.amount]));
  const total = (label, v) => {
    bold.push(5 + body.length);
    body.push([label, v]);
  };
  head('流動資產');
  items(bs.assetsCurrent);
  total('流動資產合計', bs.totalAssetsCurrent);
  head('非流動資產');
  items(bs.assetsNon);
  total('非流動資產合計', bs.totalAssetsNon);
  total('資產總計', bs.totalAssets);
  head('流動負債');
  items(bs.liabCurrent);
  total('流動負債合計', bs.totalLiabCurrent);
  if (bs.liabNon.length) {
    head('非流動負債');
    items(bs.liabNon);
    total('非流動負債合計', bs.totalLiabNon);
  }
  total('負債總計', bs.totalLiab);
  head('權益');
  items(bs.equity);
  total('權益總計', bs.totalEquity);
  total('負債及權益總計', bs.totalLiab + bs.totalEquity);
  body.push([], [bs.balanced ? '資產＝負債＋權益' : `不平衡，差額 ${bs.diff}`]);
  return titled('資產負債表', { ...meta, title: '資產負債表' }, ['項目', '金額'], body, { widths: [34, 16], bold });
}

export function assetsSheet(assets, ym, meta) {
  const sum = assetSummary(assets, ym);
  const body = sum.map((a) => [a.name, ASSET_CATEGORIES[a.category]?.label.replace(/（.*）/, '') || a.category, a.acquired_on, a.cost, a.life_years, a.residual, a.monthly, a.thisYear, a.accum, a.book, a.endMonth || '', a.invoice_no || '', (a.doc_ids || []).length || null]);
  const t = (k) => sum.reduce((x, a) => x + (a[k] || 0), 0);
  body.push(['合計', '', '', t('cost'), null, null, null, t('thisYear'), t('accum'), t('book')]);
  return titled('固定資產', { ...meta, title: '固定資產及折舊明細表' }, ['資產名稱', '類別', '取得日期', '取得成本', '年限', '殘值', '月折舊', '本年折舊', '累計折舊', '帳面價值', '提列至', '發票號碼', '附件'], body, { widths: [26, 16, 11, 12, 6, 10, 10, 11, 12, 12, 9, 12, 6], bold: [5 + body.length - 1] });
}

export function documentsSheet(docs, { from, to }, meta) {
  const STATUS = { inbox: '待覆核', reviewed: '已覆核', posted: '已入帳', ignored: '不入帳' };
  const list = docs.filter((d) => d.doc_date && d.doc_date >= from && d.doc_date <= to).sort((a, b) => (a.doc_date < b.doc_date ? -1 : 1));
  const body = list.map((d) => [d.doc_date, d.vendor_name || '', d.vendor_tax_id || '', d.invoice_no || '', d.summary || '', Number(d.amount_total) || null, Number(d.tax_amount) || null, d.account || '', STATUS[d.status] || d.status || '', d.archived_name ? `${archiveFolder(d.doc_date)}/${d.archived_name}` : d.original_name || '']);
  return titled('憑證清單', { ...meta, title: '原始憑證清單' }, ['日期', '廠商', '統編', '發票號碼', '摘要', '金額（含稅）', '稅額', '科目', '狀態', '歸檔名稱'], body, { widths: [11, 18, 10, 12, 20, 12, 9, 8, 8, 52] });
}
