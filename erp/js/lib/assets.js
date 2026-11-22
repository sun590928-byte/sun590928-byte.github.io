// 固定資產折舊（平均法）。
// 預設殘值 = 成本 ÷ (耐用年數 + 1)（營所稅查核準則常用算法）；取得當月即開始提列，不滿一月以一月計。

import { ASSET_CATEGORIES } from './coa.js';
import { addMonths, daysBetween } from './dates.js';
import { round2 } from './money.js';
import { docParts, FIXED_ASSET_ACCOUNTS } from './vat.js';

export function defaultResidual(cost, life) {
  return Math.round(Number(cost) / (Number(life) + 1));
}

export function normalizeAsset(a) {
  const cat = ASSET_CATEGORIES[a.category] || ASSET_CATEGORIES.machine;
  const life = Number(a.life_years) || cat.life;
  const cost = Number(a.cost) || 0;
  const residual = a.residual === '' || a.residual === null || a.residual === undefined ? defaultResidual(cost, life) : Number(a.residual);
  return { ...a, life_years: life, cost, residual, asset_account: a.asset_account || cat.asset, accum_account: a.accum_account || cat.accum };
}

/**
 * 逐月折舊表（整數元，最後一期補足尾差）。
 * @returns [{ month, amount, accum, book }]
 */
export function schedule(asset, { until } = {}) {
  const a = normalizeAsset(asset);
  if (!a.acquired_on || a.cost <= 0) return [];
  const depreciable = Math.max(0, a.cost - a.residual);
  const months = a.life_years * 12;
  const monthly = Math.round(depreciable / months);
  const start = a.acquired_on.slice(0, 7);
  const stop = a.disposed_on ? a.disposed_on.slice(0, 7) : null;
  const out = [];
  let accum = 0;
  for (let i = 0; i < months; i++) {
    const month = addMonths(start, i);
    if (until && month > until) break;
    if (stop && month > stop) break;
    let amount = i === months - 1 ? depreciable - accum : Math.min(monthly, depreciable - accum);
    if (amount <= 0) break;
    accum += amount;
    out.push({ month, amount, accum, book: a.cost - accum });
  }
  return out;
}

export function depreciationForMonth(assets, ym) {
  const items = [];
  for (const raw of assets) {
    const a = normalizeAsset(raw);
    const row = schedule(a, { until: ym }).find((r) => r.month === ym);
    if (row) items.push({ id: a.id, name: a.name, amount: row.amount, accum: a.accum_account });
  }
  return items;
}

// ─────────── 11/20 需求 2：固定資產發票入帳時「連結現有資產」或「新增資產」，避免同一台設備變兩筆

const normInv = (x) => String(x || '').toUpperCase().replace(/[\s-]/g, '');
const normName = (s) => String(s || '').replace(/\s+/g, '').replace(/(股份)?有限公司|企業社|商行|行號|公司|工作室/g, '').toLowerCase();

/** 憑證上的發票號碼（拆分明細每一行的也算） */
export function docInvoiceNos(doc) {
  return [...new Set([doc.invoice_no, ...(Array.isArray(doc.lines) ? doc.lines.map((p) => p.invoice_no) : [])].map(normInv).filter(Boolean))];
}

/** 資產登記的發票號碼（多張用 + 串起來） */
export function assetInvoiceNos(a) {
  return String(a.invoice_no || '').split(/[+、,，\s/]+/).map(normInv).filter(Boolean);
}

/** 憑證裡固定資產科目（15xx）的部分：未稅成本、可扣抵稅額、含稅金額、科目（與入帳時自動建立資產同算法） */
export function docAssetParts(doc) {
  const split = Array.isArray(doc.lines) && doc.lines.length > 0;
  const out = { cost: 0, tax: 0, gross: 0, accounts: [] };
  for (const p of docParts(doc)) {
    if (!FIXED_ASSET_ACCOUNTS.has(p.account)) continue;
    const t = (split ? p.deductible : doc.deductible) ? p.tax : 0;
    out.cost = round2(out.cost + p.total - t);
    out.tax = round2(out.tax + t);
    out.gross = round2(out.gross + p.total);
    if (!out.accounts.includes(p.account)) out.accounts.push(p.account);
  }
  return out;
}

export const hasAssetAccount = (doc) => docAssetParts(doc).accounts.length > 0;

/**
 * 可能是同一台設備的現有資產：發票號碼相同、這張憑證已附在資產上，或廠商＋金額相同而且取得日期相差 days 天內（沒有廠商時只看金額＋日期）。
 * @returns [{ asset, reasons: string[], strength }]（strength 大的排前面）
 */
export function assetMatches(doc, assets, { days = 7 } = {}) {
  const nos = new Set(docInvoiceNos(doc));
  const part = docAssetParts(doc);
  const total = round2(Number(doc.amount_total) || 0);
  const docAmts = [part.cost, part.gross, Math.round(part.gross / 1.05), total].filter((x) => x > 0);
  const vendor = normName(doc.vendor_name);
  const out = [];
  for (const a of assets || []) {
    if (a.disposed_on) continue;
    const reasons = [];
    let strength = 0;
    if ((a.doc_ids || []).includes(doc.id)) {
      reasons.push('這張憑證已附在這項資產');
      strength = 3;
    }
    const same = assetInvoiceNos(a).filter((n) => nos.has(n));
    if (same.length) {
      reasons.push(`發票號碼相同（${same.join('、')}）`);
      strength = Math.max(strength, 2);
    }
    const aAmts = [Number(a.cost) || 0, round2((Number(a.cost) || 0) + (Number(a.tax_amount) || 0))].filter((x) => x > 0);
    const amountSame = aAmts.some((x) => docAmts.some((y) => Math.abs(x - y) < 1));
    const gap = a.acquired_on && doc.doc_date ? Math.abs(daysBetween(a.acquired_on, doc.doc_date)) : null;
    if (!same.length && amountSame && gap !== null && gap <= days) {
      const sup = normName(a.supplier);
      const vendorSame = vendor && sup && (vendor.includes(sup) || sup.includes(vendor));
      if (vendorSame || !sup || !vendor) {
        reasons.push(`${vendorSame ? '廠商、' : ''}金額相同，取得日期${gap ? `相差 ${gap} 天` : '同一天'}`);
        strength = Math.max(strength, vendorSame ? 1 : 0.5);
      }
    }
    if (reasons.length) out.push({ asset: a, reasons, strength });
  }
  return out.sort((x, y) => y.strength - x.strength);
}

/**
 * 連結現有資產時這張發票怎麼入帳：
 * 'link' 資產的購置分錄已經記了這張發票（發票號碼相同、已附上）→ 只連結照片，不再入帳；
 * 'ask'  資產已有購置分錄，看不出是不是同一張發票 → 讓使用者選「只連結」或「入帳並加到資產成本」；
 * 'post' 資產還沒有購置分錄 → 入帳，這張分錄當它的購置分錄（資產成本不變）。
 */
export function linkModeOf(asset, doc, entries = []) {
  const e = asset.purchase_entry_id ? (entries || []).find((x) => x.id === asset.purchase_entry_id) : null;
  if (!e) return 'post';
  const nos = docInvoiceNos(doc);
  const mine = new Set(assetInvoiceNos(asset));
  const evident = (asset.doc_ids || []).includes(doc.id) || (e.attachments || []).includes(doc.id) || nos.some((n) => mine.has(n) || String(e.description || '').toUpperCase().includes(n));
  return evident ? 'link' : 'ask';
}

// 截至某月的資產摘要
export function assetSummary(assets, asOfYm) {
  return assets.map((raw) => {
    const a = normalizeAsset(raw);
    const sch = schedule(a, { until: asOfYm });
    const accum = sch.length ? sch[sch.length - 1].accum : 0;
    const full = schedule(a);
    const monthly = full.length ? full[0].amount : 0;
    const remaining = full.filter((r) => r.month > asOfYm).length;
    const thisYear = sch.filter((r) => r.month.slice(0, 4) === asOfYm.slice(0, 4)).reduce((t, r) => t + r.amount, 0);
    return { ...a, accum, book: a.cost - accum, monthly, remaining, thisYear, endMonth: full.length ? full[full.length - 1].month : null };
  });
}
