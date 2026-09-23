// 自動分錄同步：依目前資料重新產生 POS 營收、撥款入帳、折舊分錄（已鎖定月份不動）。

import { store } from './store.js';
import { getSettings, getProductIndex, revenueLines } from './state.js';
import { salesJournal, payoutJournal, depreciationJournal, mergeGenerated } from './lib/autojournal.js';
import { DEBIT_ACCOUNT_BY_PAYMENT } from './lib/coa.js';
import { depreciationForMonth } from './lib/assets.js';
import { nextVoucherNo } from './lib/ledger.js';
import { eachMonth, today } from './lib/dates.js';
import { uid } from './lib/text.js';

async function apply(source, generated, scopeRefs = null) {
  const s = await getSettings();
  const entries = await store.all('journal_entries');
  const res = mergeGenerated(entries, generated, { source, lockedMonths: new Set(s.locked_months || []), makeId: () => uid('je_'), nextNo: nextVoucherNo, scopeRefs });
  if (res.upserts.length) await store.put('journal_entries', res.upserts);
  if (res.removes.length) await store.remove('journal_entries', res.removes);
  return { source, updated: res.upserts.length, removed: res.removes.length, locked: res.skippedLocked };
}

export async function syncSales() {
  const s = await getSettings();
  const idx = await getProductIndex();
  const lines = await revenueLines();
  const gen = salesJournal(lines, {
    categoryOf: (l) => idx.of(l).category,
    vatMode: s.vat_mode,
    paymentAccounts: { ...DEBIT_ACCOUNT_BY_PAYMENT, unknown: s.unknown_payment_account || '1101' },
  });
  return apply('pos', gen);
}

export async function syncPayouts() {
  const s = await getSettings();
  const payouts = (await store.all('payouts')).filter((p) => p.payout_date >= s.revenue_start);
  return apply('payout', payouts.map((p) => payoutJournal(p, { bankAccount: s.bank_gl || '1103' })));
}

export async function syncDepreciation() {
  const s = await getSettings();
  const assets = await store.all('fixed_assets');
  const months = eachMonth(s.revenue_start.slice(0, 7), today().slice(0, 7));
  const gen = months.map((ym) => depreciationJournal(ym, depreciationForMonth(assets, ym))).filter(Boolean);
  return apply('depreciation', gen, new Set(months));
}

export async function syncAll() {
  const out = [];
  out.push(await syncSales());
  out.push(await syncPayouts());
  out.push(await syncDepreciation());
  return out;
}

export function describeSync(results) {
  const label = { pos: 'POS 營收', payout: '撥款入帳', depreciation: '折舊' };
  const parts = results.filter((r) => r.updated || r.removed || r.locked).map((r) => `${label[r.source]} 更新 ${r.updated}${r.removed ? `、移除 ${r.removed}` : ''}${r.locked ? `（鎖定月份略過 ${r.locked}）` : ''}`);
  return parts.length ? '自動分錄：' + parts.join('；') : '自動分錄已是最新';
}
