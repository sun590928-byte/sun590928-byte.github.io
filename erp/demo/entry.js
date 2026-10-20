// 作品集預覽版的進入點（tools/build-demo.mjs 打包成單一 HTML 檔）。
// 順序很重要：env.js 先放好記憶體後端與示範資料，store.js 載入時才會用它。

import { decorate } from './env.js';
import { store } from '../js/store.js';
import { ensureAccounts } from '../js/state.js';
import { syncAll } from '../js/sync.js';
import { renumberMonth } from '../js/lib/ledger.js';
import { buildCalendar } from '../js/lib/taxcal.js';
import { periodInfo, periodKeyOf, inputItems } from '../js/lib/vat.js';
import { addDays } from '../js/lib/dates.js';
import { profileOf } from '../js/views/tax.js';
import { getSettings } from '../js/state.js';

// POS 營收、撥款、折舊分錄由 ERP 自己產生（和正式版同一套算法），再依日期重排傳票號
await ensureAccounts();
await syncAll();
const entries = await store.all('journal_entries');
for (const ym of new Set(entries.map((e) => e.date.slice(0, 7)))) renumberMonth(entries, ym);
await store.put('journal_entries', entries);

// 已過期限的申報都當作已完成（營業稅期別標「已申報」，數字由 401 工作表依帳上計算）
{
  const { today } = globalThis.__ERP_DEMO__.range;
  const settings = await getSettings();
  const y = Number(today.slice(0, 4));
  const items = [...buildCalendar(y - 1, profileOf(settings)), ...buildCalendar(y, profileOf(settings))].filter((i) => i.filing && i.due < today);
  await store.put('tax_tasks', items.filter((i) => !i.vatPeriod).map((i) => ({ id: i.id, done: true, done_at: `${addDays(i.target, -1)}T17:00:00+08:00` })));
  // 已申報期別要記下申報了哪些進項，否則會被當成逾期入帳、順延到下一期
  const inputs = inputItems(await store.all('documents'), await store.all('einvoices'));
  await store.put(
    'tax_filings',
    items
      .filter((i) => i.vatPeriod)
      .map((i) => ({ id: i.vatPeriod, period_from: periodInfo(i.vatPeriod).from, period_to: periodInfo(i.vatPeriod).to, status: 'filed', filed_on: addDays(i.target, -1), claimed: inputs.filter((it) => periodKeyOf(it.date) === i.vatPeriod).map((it) => it.id), note: '示範資料：已依 401 工作表申報' })),
  );
}

await import('../js/main.js');
decorate();
