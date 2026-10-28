// 憑證本機自動辨識流程：照片 → QR 碼／文字辨識 → 對照電子發票、已申報媒體檔、廠商資料庫 → 自動覆核規則 → 寫回憑證。
// 沒有疑點的標「已覆核」（可直接「全部入帳」）；有疑點的留在「待覆核」並列出要確認的地方。

import { store } from './store.js';
import { getSettings, getAccounts } from './state.js';
import { recognizeImage, canRecognize, releaseOcr } from './vision.js';
import { assembleInvoices } from './lib/einvoiceqr.js';
import { extractReceiptFields } from './lib/receipttext.js';
import { buildVendorKB, lookupVendor } from './lib/vendorkb.js';
import { autoReview } from './lib/autoreview.js';
import { parseDocName } from './lib/docname.js';
import { today } from './lib/dates.js';
import { lookupCompanyName, canLookupCompany, isBan } from './lib/companyname.js';

let running = null;

export const isRecognizing = () => !!running;
export function stopRecognizing() {
  if (running) running.stop = true;
}

/**
 * @param list 要辨識的憑證
 * @param opts { files: Map(id → File) 剛上傳的檔案（免再下載）, onProgress(i, n, doc, step), onDoc(doc) 每張完成後 }
 * @returns {{ done, clean, needs, skipped, failed: [{doc, reason}] }}
 */
export async function recognizeDocuments(list, { files = new Map(), onProgress, onDoc } = {}) {
  if (running) throw new Error('辨識進行中，請稍候');
  const job = (running = { stop: false });
  const res = { done: 0, clean: 0, needs: 0, skipped: 0, failed: [] };
  try {
    const [settings, accounts, docs, einvoices, filings] = await Promise.all([getSettings(), getAccounts(), store.all('documents'), store.all('einvoices'), store.all('tax_filings')]);
    const kb = buildVendorKB(docs, einvoices);
    // 本店自己開的（銷項）發票混在電子發票裡時不拿來比對
    const purchase = einvoices.filter((i) => !settings.tax_id || i.seller_tax_id !== settings.tax_id);
    const filed = filings.flatMap((f) => f.filed_inputs || []);
    const all = [...docs];
    for (let i = 0; i < list.length; i++) {
      if (job.stop) break;
      let doc = all.find((d) => d.id === list[i].id) || list[i];
      if (doc.status === 'posted' || doc.status === 'ignored' || doc.kind === 'payout_statement') {
        res.skipped++;
        continue;
      }
      const step = (s) => onProgress?.(i, list.length, doc, s);
      step('讀取照片');
      try {
        let codes = [];
        let ocr = null;
        let vision = null;
        if (canRecognize(doc)) {
          const blob = files.get(doc.id) || (await store.readFile(doc));
          if (blob) {
            // 讀到 QR 碼、且店名已知（檔名有寫，或賣方統編在廠商資料庫）時，不必再做較慢的文字辨識
            const fn = parseDocName(doc.original_name || '');
            vision = await recognizeImage(blob, {
              ocr: settings.ocr_enabled === false ? 'never' : 'auto',
              needOcr: (found) => {
                const inv = assembleInvoices(found);
                if (!inv.length) return true;
                if (doc.vendor_name || fn.vendor) return false;
                return !(lookupVendor(kb, { taxId: inv[0].seller_tax_id })?.confidence >= 0.9);
              },
              onStep: step,
            });
            codes = vision.codes;
            if (vision.text) ocr = extractReceiptFields(vision.text, { shopTaxId: settings.tax_id, today: today(), hints: { invoice_no: fn.invoice_no, date: fn.date, amount: fn.amount } });
          }
        }
        const qr = assembleInvoices(codes);
        const r = autoReview(doc, { qr, ocr, einvoices: purchase, filed, kb, accounts, settings, docs: all, today: today() });
        // 廠商名稱：用賣方統編到商工登記查登記全名（一張照片多張發票時以第一張的賣方為準）；手動填過的不動；要連雲端才查得到
        const ban = r.patch.vendor_tax_id || doc.vendor_tax_id;
        if (isBan(ban) && r.sources.vendor_name !== 'user' && canLookupCompany()) {
          step('查商工登記全名');
          try {
            const reg = await lookupCompanyName(ban);
            if (reg?.name && reg.name !== r.patch.vendor_name) {
              r.patch.vendor_name = reg.name;
              r.sources.vendor_name = 'registry';
              r.reasons.push(`商工登記：統編 ${ban} 的登記名稱是「${reg.name}」${reg.status && reg.status !== '核准設立' ? `（${reg.status}）` : ''}`);
              r.issues = r.issues.filter((x) => !/^廠商「.*」由文字辨識取得/.test(x));
              r.clean = !r.issues.length && r.confidence >= 0.5;
            } else if (reg?.name) r.reasons.push(`商工登記：統編 ${ban} 登記名稱相符`);
          } catch (e) {
            if (e?.status !== 404) r.reasons.push(`商工登記查詢失敗：${e.message || e}`);
          }
        }
        const status = doc.status === 'inbox' && r.clean ? 'reviewed' : doc.status;
        const upd = {
          ...doc,
          ...r.patch,
          status,
          reviewed_by: status === 'reviewed' && doc.status === 'inbox' ? 'auto' : doc.reviewed_by || null,
          confidence: r.confidence,
          review_issues: r.issues,
          auto: {
            at: new Date().toISOString(),
            confidence: r.confidence,
            reasons: r.reasons,
            issues: r.issues,
            sources: r.sources,
            qr: qr.map((x) => ({ invoice_no: x.invoice_no, date: x.date, total: x.total, buyer: x.buyer_tax_id, seller: x.seller_tax_id })),
            ocr_confidence: vision?.text ? Math.round(vision.confidence) : null,
            ms: vision?.ms ?? null,
            error: vision?.error || null,
          },
          updated_at: new Date().toISOString(),
        };
        await store.put('documents', upd);
        const k = all.findIndex((d) => d.id === upd.id);
        if (k >= 0) all[k] = upd;
        else all.push(upd);
        res.done++;
        if (status === 'reviewed' && !r.issues.length) res.clean++;
        else res.needs++;
        onDoc?.(upd);
        doc = upd;
      } catch (e) {
        console.error(e);
        res.failed.push({ doc, reason: e.message || String(e) });
      }
    }
  } finally {
    running = null;
    releaseOcr();
  }
  return res;
}
