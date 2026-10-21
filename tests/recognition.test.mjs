// 本機辨識：電子發票 QR 碼、文字辨識結果解析、廠商資料庫、自動覆核規則（全為合成資料）
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLeftQR, assembleInvoices } from '../erp/js/lib/einvoiceqr.js';
import { extractReceiptFields, normalizeOcr, parseChineseAmount } from '../erp/js/lib/receipttext.js';
import { buildVendorKB, lookupVendor, vendorAliases } from '../erp/js/lib/vendorkb.js';
import { autoReview } from '../erp/js/lib/autoreview.js';
import { DEFAULT_ACCOUNTS } from '../erp/js/lib/coa.js';

// 合成統編（通過檢查碼，與本店無關）
const SHOP = '10007919';
const SELLER = '10047514';
const SELLER2 = '10324679';
const OTHER = '10332598';
const accounts = DEFAULT_ACCOUNTS.map((a) => ({ ...a, active: true }));
const settings = { tax_id: SHOP, vat_mode: 'general', capitalize_threshold: 80000 };
const TODAY = '2026-10-12';

const hex = (n) => n.toString(16).toUpperCase().padStart(8, '0');
function leftQR({ no = 'AB12345678', roc = '1150915', ex = 1000, total = 1050, buyer = SHOP, seller = SELLER, items = [['咖啡豆', 1, 500], ['鮮乳', 2, 275]] } = {}) {
  const head = `${no}${roc}1234${hex(ex)}${hex(total)}${buyer || '00000000'}${seller}${'A'.repeat(24)}`;
  const body = `:**********:${items.length}:${items.length}:1:${items.map((i) => i.join(':')).join(':')}`;
  return new TextEncoder().encode(head + body);
}

test('QR：解析左邊 QR（日期、金額、統編、品項）', () => {
  const q = parseLeftQR(leftQR());
  assert.equal(q.invoice_no, 'AB12345678');
  assert.equal(q.date, '2026-09-15');
  assert.equal(q.total, 1050);
  assert.equal(q.sales_ex, 1000);
  assert.equal(q.tax, 50);
  assert.equal(q.buyer_tax_id, SHOP);
  assert.equal(q.seller_tax_id, SELLER);
  assert.deepEqual(q.items.map((i) => i.name), ['咖啡豆', '鮮乳']);
  assert.equal(q.items[1].amount, 550);
});

test('QR：銷售額填 0 或不像 5% 時稅額視為不明；沒有買方統編稅額為 0', () => {
  assert.equal(parseLeftQR(leftQR({ ex: 0, total: 1050 })).tax, null);
  assert.equal(parseLeftQR(leftQR({ ex: 1050, total: 1050 })).tax, null);
  assert.equal(parseLeftQR(leftQR({ buyer: '', ex: 1050, total: 1050 })).tax, 0);
  assert.equal(parseLeftQR(new TextEncoder().encode('not a qr')), null);
});

test('QR：一張照片兩張發票，右邊 QR 併到左邊那張', () => {
  const right = new TextEncoder().encode('**濾紙:3:100');
  const inv = assembleInvoices([
    { bytes: leftQR({ no: 'AB12345678' }), x: 100, y: 100 },
    { bytes: right, x: 300, y: 100 },
    { bytes: leftQR({ no: 'AB12345679', total: 2100, ex: 2000 }), x: 100, y: 600 },
    { bytes: leftQR({ no: 'AB12345678' }), x: 102, y: 101 },
  ]);
  assert.equal(inv.length, 2);
  assert.deepEqual(inv[0].items.map((i) => i.name), ['咖啡豆', '鮮乳', '濾紙']);
});

test('文字辨識：整理空白、中文大寫金額', () => {
  assert.equal(normalizeOcr('電 子 發 票 證 明 聯\n\n 總 計 : 1,050 '), '電子發票證明聯\n總計: 1,050');
  assert.equal(parseChineseAmount('壹仟陸佰'), 1600);
  assert.equal(parseChineseAmount('貳萬參仟零伍拾'), 23050);
  assert.equal(parseChineseAmount('仟陸佰'), 1600, 'OCR 認錯「壹」時單位字仍可推回');
});

test('文字辨識：抓發票號碼、日期、統編、金額（含雜訊、期別、列印日期）', () => {
  const text = `人 二 三 還
電 子 發 票 證 明 聯
115 年 9-10 月
AB-12345678
2026-09 14 14:46:18 格式:25
賣方:${SELLER} 買方:${SHOP}
台北市某某區 112 號 電話 0222345678
銷售額(應稅): 1,000
稅 額 : 50
總 計 : 1,050
列印日期: 2026.10.01`;
  const r = extractReceiptFields(text, { shopTaxId: SHOP, today: TODAY });
  assert.equal(r.invoice_no.value, 'AB12345678');
  assert.equal(r.date.value, '2026-09-14', '「115年9-10月」是期別、列印日期要排除');
  assert.equal(r.seller_tax_id.value, SELLER);
  assert.equal(r.buyer_tax_id.value, SHOP);
  assert.equal(r.total.value, 1050);
  assert.equal(r.sales_ex.value, 1000);
  assert.equal(r.tax.value, 50);
  assert.equal(r.invoice_type.value, '電子發票');
});

test('文字辨識：地址、電話湊出的「未稅＋稅額＝總額」不採用；中文大寫金額優先', () => {
  const r = extractReceiptFields(`收 據\n地址 112 號 5 樓 117 室\n新台幣 壹仟陸佰 元整\n`, { today: TODAY });
  assert.equal(r.total.value, 1600);
  assert.equal(r.tax, null);
  const r2 = extractReceiptFields(`雜訊 112 5 117`, { today: TODAY });
  assert.equal(r2.total, null);
  assert.equal(r2.tax, null);
  // 發票號碼數字部分不是統編
  const r3 = extractReceiptFields(`發票號碼 CD${SELLER2}`, { today: TODAY });
  assert.equal(r3.seller_tax_id, null);
});

const posted = (o) => ({ id: 'd' + Math.random(), status: 'posted', kind: 'receipt', ...o });

test('廠商資料庫：依統編、店名、照片文字（容錯）找到以前的選擇', () => {
  assert.ok(vendorAliases('範例咖啡股份有限公司信義分公司').includes('範例咖啡'));
  assert.ok(vendorAliases('範例媒體(shop)').includes('shop'));
  const kb = buildVendorKB([
    posted({ vendor_name: '範例烘豆', vendor_tax_id: SELLER, account: '1211', pay_account: '2111', summary: '咖啡豆2kg' }),
    posted({ vendor_name: '範例烘豆', vendor_tax_id: SELLER, account: '1211', pay_account: '2111' }),
    posted({ vendor_name: '測試五金行', account: '6135' }),
    { id: 'x', status: 'reviewed', reviewed_by: 'auto', vendor_name: '自動的不學', account: '6199' },
  ]);
  const a = lookupVendor(kb, { taxId: SELLER });
  assert.equal(a.name, '範例烘豆');
  assert.equal(a.entry.account.value, '1211');
  assert.equal(a.entry.pay.value, '2111');
  assert.ok(a.confidence >= 0.9);
  assert.equal(lookupVendor(kb, { name: '測試五金行' }).entry.account.value, '6135');
  assert.equal(lookupVendor(kb, { name: '自動的不學' }), null);
  const fuzzy = lookupVendor(kb, { text: '人 二 測試五金汀 地址' });
  assert.equal(fuzzy?.name, '測試五金行', 'OCR 錯一個字也找得到');
  assert.equal(lookupVendor(kb, { text: '全聯福利中心 收銀機' }).name, '全聯');
});

const baseDoc = (o = {}) => ({ id: 'doc_1', status: 'inbox', kind: 'receipt', original_name: 'IMG_0001.jpg', doc_date: null, vendor_name: '', invoice_no: null, amount_total: null, tax_amount: null, summary: '', account: '6199', pay_account: '1101', ...o });
const kbOf = () => buildVendorKB([posted({ vendor_name: '範例烘豆', vendor_tax_id: SELLER, account: '1211' }), posted({ vendor_name: '範例烘豆', vendor_tax_id: SELLER, account: '1211' })]);

test('自動覆核：QR 碼＋廠商資料庫 → 沒有疑點、可直接入帳', () => {
  const qr = assembleInvoices([{ bytes: leftQR() }]);
  const r = autoReview(baseDoc(), { qr, kb: kbOf(), accounts, settings, today: TODAY });
  assert.deepEqual(r.issues, []);
  assert.ok(r.clean);
  assert.equal(r.patch.invoice_no, 'AB12345678');
  assert.equal(r.patch.doc_date, '2026-09-15');
  assert.equal(r.patch.amount_total, 1050);
  assert.equal(r.patch.tax_amount, 50);
  assert.equal(r.patch.deductible, true);
  assert.equal(r.patch.vendor_name, '範例烘豆');
  assert.equal(r.patch.vendor_tax_id, SELLER);
  assert.equal(r.patch.account, '1211');
  assert.equal(r.patch.summary, '咖啡豆等2項');
  assert.equal(r.sources.amount_total, 'qr');
  assert.equal(r.sources.account, 'kb');
});

test('自動覆核：檔名金額與 QR 不同、買方不是本店、重複發票 → 需確認', () => {
  const qr = assembleInvoices([{ bytes: leftQR({ buyer: OTHER }) }]);
  const doc = baseDoc({ original_name: '20260915_範例烘豆_999.jpg', doc_date: '2026-09-15', vendor_name: '範例烘豆', amount_total: 999 });
  const dup = { id: 'doc_2', status: 'posted', invoice_no: 'AB12345678', vendor_name: '範例烘豆', doc_date: '2026-09-15' };
  const r = autoReview(doc, { qr, kb: kbOf(), accounts, settings, docs: [dup], today: TODAY });
  assert.equal(r.clean, false);
  assert.ok(r.issues.some((x) => x.includes('檔名金額 999')));
  assert.ok(r.issues.some((x) => x.includes('不是本店')));
  assert.ok(r.issues.some((x) => x.includes('重複')));
  assert.equal(r.patch.deductible, false);
});

test('自動覆核：沒有買方統編（個人載具）→ 稅額不填、不能扣抵', () => {
  const qr = assembleInvoices([{ bytes: leftQR({ buyer: '', ex: 1050, total: 1050 }) }]);
  const r = autoReview(baseDoc(), { qr, kb: kbOf(), accounts, settings, today: TODAY });
  assert.equal(r.patch.deductible, false);
  assert.equal(r.patch.tax_amount, null);
});

test('自動覆核：一張照片兩張發票、合計等於檔名金額 → 自動拆分明細', () => {
  const qr = assembleInvoices([
    { bytes: leftQR({ no: 'AB12345678', ex: 1000, total: 1050 }), x: 0, y: 0 },
    { bytes: leftQR({ no: 'AB12345679', ex: 2000, total: 2100 }), x: 0, y: 500 },
  ]);
  const doc = baseDoc({ original_name: '20260915_範例烘豆_3150.jpg', doc_date: '2026-09-15', vendor_name: '範例烘豆', amount_total: 3150 });
  const r = autoReview(doc, { qr, kb: kbOf(), accounts, settings, today: TODAY });
  assert.equal(r.patch.lines.length, 2);
  assert.deepEqual(r.patch.lines.map((p) => [p.invoice_no, p.amount, p.tax]), [['AB12345678', 1050, 50], ['AB12345679', 2100, 100]]);
  assert.equal(r.patch.tax_amount, 150);
  assert.deepEqual(r.issues, []);
});

test('自動覆核：設備未達資本化門檻改列 6135；達門檻提醒列固定資產', () => {
  const kb = buildVendorKB([posted({ vendor_name: '器材行', vendor_tax_id: SELLER2, account: '1511' })]);
  const small = assembleInvoices([{ bytes: leftQR({ seller: SELLER2, ex: 20000, total: 21000, items: [['磨豆機', 1, 21000]] }) }]);
  const r = autoReview(baseDoc(), { qr: small, kb, accounts, settings, today: TODAY });
  assert.equal(r.patch.account, '6135');
  const kb2 = buildVendorKB([posted({ vendor_name: '器材行', vendor_tax_id: SELLER2, account: '6116' })]);
  const big = assembleInvoices([{ bytes: leftQR({ seller: SELLER2, ex: 100000, total: 105000, items: [['咖啡機', 1, 105000]] }) }]);
  const r2 = autoReview(baseDoc(), { qr: big, kb: kb2, accounts, settings, today: TODAY });
  assert.ok(r2.issues.some((x) => x.includes('資本化門檻')));
});

test('自動覆核：已申報媒體檔有這張 → 課稅別、扣抵代號、稅額照申報', () => {
  const filed = [{ fmt: '25', ym: '2026-07', buyer: SHOP, seller: SELLER, invoice_no: 'AB12345678', amount: 1000, tax_type: '1', tax: 50, ded_code: '1' }];
  const doc = baseDoc({ original_name: '20260715_範例烘豆_AB12345678_1050.jpg', doc_date: '2026-07-15', vendor_name: '範例烘豆', invoice_no: 'AB12345678', amount_total: 1050 });
  const r = autoReview(doc, { filed, kb: kbOf(), accounts, settings, today: TODAY });
  assert.equal(r.patch.tax_amount, 50);
  assert.equal(r.patch.ded_code, '1');
  assert.equal(r.patch.deductible, true);
  assert.equal(r.patch.vendor_tax_id, SELLER);
  assert.ok(r.reasons.some((x) => x.includes('已申報')));
  assert.ok(r.clean);
});

test('自動覆核：只有文字辨識的金額、店名 → 需確認；綜合賣場無品項列雜項', () => {
  const ocr = extractReceiptFields('全聯福利中心\n2026/09/20 10:11\n合計 356\n總計 356', { today: TODAY });
  const r = autoReview(baseDoc(), { ocr, kb: buildVendorKB([]), accounts, settings, today: TODAY });
  assert.equal(r.patch.amount_total, 356);
  assert.equal(r.patch.doc_date, '2026-09-20');
  assert.equal(r.patch.vendor_name, '全聯');
  assert.equal(r.patch.account, '6133');
  assert.ok(r.issues.some((x) => x.includes('金額只由文字辨識')));
  assert.equal(r.clean, false);
});

test('自動覆核：老闆覆核過的欄位不覆寫；備註寫「不入帳」的列入需確認', () => {
  const qr = assembleInvoices([{ bytes: leftQR({ total: 2100, ex: 2000 }) }]);
  const doc = baseDoc({ status: 'reviewed', reviewed_by: 'user', doc_date: '2026-09-15', vendor_name: '老闆填的', amount_total: 1050, account: '6133', invoice_no: 'AB12345678', ai: { notes: '家用水費，不入帳｜原註記：舊說明' } });
  const r = autoReview(doc, { qr, kb: kbOf(), accounts, settings, today: TODAY });
  assert.equal(r.patch.amount_total, undefined, '手動欄位不放進 patch');
  assert.equal(r.patch.vendor_name, undefined);
  assert.equal(r.patch.account, undefined);
  assert.ok(r.issues.some((x) => x.includes('金額：QR 碼是 2100')));
  assert.ok(r.issues.some((x) => x.includes('不入帳')));
});

test('文字辨識：收據方格的大寫金額（寫零的格子是 0、沒填的格子不算）', () => {
  assert.equal(parseChineseAmount('零拾零萬壹仟陸佰零拾零'), 1600);
  assert.equal(parseChineseAmount('萬壹仟陸佰零拾零'), 1600, '萬的格子沒填');
  assert.equal(parseChineseAmount('拾萬萬壹仟陸佰零拾零'), 1600, '拾萬、萬的格子都沒填');
  assert.equal(parseChineseAmount('壹拾貳萬參仟'), 123000);
  assert.equal(parseChineseAmount('拾伍'), 15);
});

const RECEIPT = `免用統一發票收據
測試五金行
電話 0222345678 地址 12 號
膠帶 2 35 70
抹布 10 25 250
合計新台幣 零 萬 零 仟 參 佰 貳 拾 零 元整
2026/09/18`;

test('文字辨識：收據金額取「合計新台幣」大寫處', () => {
  const r = extractReceiptFields(RECEIPT, { today: TODAY });
  assert.equal(r.total.value, 320);
  assert.equal(r.cn_total.value, 320);
  assert.equal(r.cn_total.score, 5);
  assert.equal(r.cn_total.numeric, false);
  const r2 = extractReceiptFields(`收 據\n咖啡杯 2 800\n總計 NT$1,600\n合 計 新 臺 幣 壹 仟 陸 佰 元 整`, { today: TODAY });
  assert.equal(r2.cn_total.value, 1600);
  assert.equal(r2.cn_total.numeric, true, '照片上的 1,600 可對照');
});

test('自動覆核：收據金額用大寫金額；與檔名不同、或沒有數字可對照時列入需確認', () => {
  const kb = buildVendorKB([]);
  const r = autoReview(baseDoc({ original_name: '20260918_測試五金行_300.jpg' }), { ocr: extractReceiptFields(RECEIPT, { today: TODAY, hints: { amount: 300 } }), kb, accounts, settings, today: TODAY });
  assert.equal(r.patch.amount_total, 320);
  assert.equal(r.sources.amount_total, 'cnamt');
  assert.ok(r.issues.some((x) => x.includes('檔名金額 300 與收據大寫金額 320 不同')), r.issues.join('；'));
  const r2 = autoReview(baseDoc(), { ocr: extractReceiptFields(RECEIPT, { today: TODAY }), kb, accounts, settings, today: TODAY });
  assert.equal(r2.patch.amount_total, 320);
  assert.ok(r2.issues.some((x) => x.includes('由收據大寫金額辨識')));
  const r3 = autoReview(baseDoc({ original_name: '20260918_測試五金行_320.jpg' }), { ocr: extractReceiptFields(RECEIPT, { today: TODAY, hints: { amount: 320 } }), kb, accounts, settings, today: TODAY });
  assert.equal(r3.patch.amount_total, 320);
  assert.ok(!r3.issues.some((x) => x.includes('金額')), r3.issues.join('；'));
});

test('自動覆核：發票的廠商用公司全名（照片、以前記過的、電子發票）；收據不改', () => {
  const kb0 = buildVendorKB([]);
  const qr = assembleInvoices([{ bytes: leftQR({ seller: SELLER2 }) }]);
  const named = baseDoc({ original_name: '20260915_範例電機_1050.jpg' });
  // 照片上的公司全名與檔名簡稱相符
  const ocr = extractReceiptFields(`電子發票證明聯\n賣方 範例電機有限公司\n總計 1,050`, { today: TODAY });
  const r = autoReview(named, { qr, ocr, kb: kb0, accounts, settings, today: TODAY });
  assert.equal(r.patch.vendor_name, '範例電機有限公司');
  assert.equal(r.sources.vendor_name, 'fullname');
  assert.ok(!r.issues.some((x) => x.includes('廠商')), r.issues.join('；'));
  // 照片錯一個字：依簡稱校正
  const typo = extractReceiptFields(`電子發票證明聯\n賣方 範例電杋有限公司`, { today: TODAY });
  assert.equal(autoReview(named, { qr, ocr: typo, kb: kb0, accounts, settings, today: TODAY }).patch.vendor_name, '範例電機有限公司');
  // 照片上的公司名稱與店名對不上（例如本店的名稱）就不用
  const other = extractReceiptFields(`電子發票證明聯\n範例咖啡有限公司`, { today: TODAY });
  assert.equal(autoReview(named, { qr, ocr: other, kb: kb0, accounts, settings, today: TODAY }).patch.vendor_name, '範例電機');
  // 以前記過全名：統編相同就用全名（簡稱記得比較多次也一樣）
  const short = (o = {}) => posted({ vendor_name: '範例電機', vendor_tax_id: SELLER2, account: '6116', ...o });
  const kb = buildVendorKB([short(), short(), short({ vendor_name: '範例電機有限公司' })]);
  const r2 = autoReview(baseDoc(), { qr, kb, accounts, settings, today: TODAY });
  assert.equal(r2.patch.vendor_name, '範例電機有限公司');
  assert.equal(r2.sources.vendor_name, 'kb');
  // 財政部電子發票的賣方名稱優先於以前記的簡稱
  const ein = [{ invoice_no: 'AB12345678', date: '2026-09-15', total: 1050, tax: 50, seller_tax_id: SELLER2, seller_name: '範例電機股份有限公司', buyer_tax_id: SHOP }];
  const r3 = autoReview(baseDoc({ original_name: '20260915_範例電機_AB12345678_1050.jpg' }), { einvoices: ein, kb: buildVendorKB([short(), short()]), accounts, settings, today: TODAY });
  assert.equal(r3.patch.vendor_name, '範例電機股份有限公司');
  assert.equal(r3.sources.vendor_name, 'einvoice');
  // 收據照舊用簡稱
  const rc = extractReceiptFields(`收據\n範例電機有限公司\n合計新台幣壹仟元整`, { today: TODAY });
  assert.equal(autoReview(baseDoc({ original_name: '20260915_範例電機_1000.jpg' }), { ocr: rc, kb: kb0, accounts, settings, today: TODAY }).patch.vendor_name, '範例電機');
});
