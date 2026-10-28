// 統編 → 登記全名：經濟部「商工登記公示資料」（公司、商號）。瀏覽器不能直接連政府的 API（沒有 CORS），
// 由 Supabase 函式 company-name 代查；查過的統編記在設定（company_names），同一家下次不再查。
// 只有連線雲端時查得到；函式沒部署（404）或離線時安靜略過，廠商名稱就沿用辨識結果。

import { store } from '../store.js';
import { getSettings } from '../state.js';

const mem = new Map();
let missing = false; // 函式尚未部署：這次開著就不再試
const DAY = 86400e3;

export const isBan = (s) => /^\d{8}$/.test(String(s || '').trim());
export const canLookupCompany = () => store.mode === 'cloud' && !missing;

async function savedAll() {
  const rows = await store.all('settings');
  return rows.find((r) => r.id === 'company_names')?.value || {};
}

/**
 * @returns {Promise<{name:string|null, kind:string|null, status:string|null, at:string}|null>}
 *   name＝登記名稱（查無則 null）；kind：company 公司、business 商號、branch 分公司；status：核准設立、解散…
 */
export async function lookupCompanyName(ban, { force = false, maxAge = 180 * DAY } = {}) {
  ban = String(ban || '').trim();
  if (!isBan(ban)) return null;
  if (!force && mem.has(ban)) return mem.get(ban);
  const saved = await savedAll();
  const old = saved[ban];
  if (!force && old?.at && Date.now() - Date.parse(old.at) < maxAge && (old.name || old.kind)) {
    mem.set(ban, old);
    return old;
  }
  if (force) missing = false; // 使用者按「測試」或「查全名」：重新試一次（可能剛部署好、或改了函式名稱）
  if (!canLookupCompany()) return old || null;
  const fn = String((await getSettings()).company_function || 'company-name').trim();
  let r;
  try {
    r = await store.backend.invoke(fn, { ban });
  } catch (e) {
    if (e?.status === 404) missing = true;
    throw e;
  }
  const rec = { name: r?.name || null, kind: r?.kind || null, status: r?.status || null, at: new Date().toISOString() };
  mem.set(ban, rec);
  await store.put('settings', { id: 'company_names', value: { ...saved, [ban]: rec } });
  return rec;
}
