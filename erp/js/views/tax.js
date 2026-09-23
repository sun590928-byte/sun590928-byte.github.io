// 年度／每月 會計申報與重要事項工作表：依店家型態產生期限清單（含自行申報的目標完成日），可勾選完成、匯出行事曆（.ics）。

import { h, raw, mount, bindActions, badge, status, download, options } from '../ui.js';
import { store } from '../store.js';
import { getSettings } from '../state.js';
import { buildCalendar } from '../lib/taxcal.js';
import { today, addDays, daysBetween, weekdayIndex, WEEKDAYS } from '../lib/dates.js';
import { fnv1a } from '../lib/text.js';

const ORG = { sole: '獨資／合夥（商號）', company: '公司' };
const VAT = { general: '一般稅額（開立統一發票，5%）', small: '小規模營業人（查定課徵 1%）', none: '免稅' };

export function profileOf(settings) {
  return {
    orgType: settings.org_type,
    vatMode: settings.vat_mode,
    hasEmployees: settings.has_employees,
    ownsProperty: settings.owns_property,
    hasVehicle: settings.has_vehicle,
    paysRentToIndividual: settings.pays_rent_to_individual,
    prepDay: settings.filing_prep_day ?? 10,
    targetDay: settings.filing_target_day ?? 12,
  };
}

// 申報完成狀態：勾選紀錄，或營業稅工作表已標記申報
export function isDone(item, doneMap, filings) {
  if (doneMap.get(item.id)?.done) return true;
  if (item.vatPeriod) {
    const f = filings.find((x) => x.id === item.vatPeriod);
    return !!f && (f.status === 'filed' || f.status === 'paid');
  }
  return false;
}

const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8))}（${WEEKDAYS[weekdayIndex(ymd)]}）`;

// 首頁提醒：未完成、且在 days 天內進入準備期或已逾期的申報
export async function upcomingFilings(settings, days = 21) {
  const [done, filings] = await Promise.all([store.all('tax_tasks'), store.all('tax_filings')]);
  const doneMap = new Map(done.map((d) => [d.id, d]));
  const t = today();
  const y = Number(t.slice(0, 4));
  const profile = profileOf(settings);
  const items = [...buildCalendar(y - 1, profile), ...buildCalendar(y, profile), ...buildCalendar(y + 1, profile)];
  return items
    .filter((i) => i.filing && !isDone(i, doneMap, filings) && i.due >= settings.revenue_start && ((i.prep || i.target) <= addDays(t, days) || i.due < t) && i.due >= addDays(t, -45))
    .sort((a, b) => (a.target < b.target ? -1 : 1))
    .slice(0, 4);
}

export function filingReminder(items, settings) {
  if (!items.length) return '';
  const t = today();
  return h`<div class="callout ${items.some((i) => i.due < t) ? 'bad' : items.some((i) => i.target < t) ? 'warn' : ''}" style="margin-bottom:14px"><p><b>申報提醒</b>（每期 ${settings.filing_prep_day ?? 10} 日開始準備、${settings.filing_target_day ?? 12} 日前完成）</p>
    ${items.map((i) => h`<div class="row" style="gap:8px">${i.due < t ? status('bad', '已逾期') : i.target < t ? status('warn', '已過目標日') : i.prep && i.prep <= t ? status('info', '準備中') : status('na', '即將到來')}<span><b>${i.title}</b>：目標 ${md(i.target)}，法定期限 ${md(i.due)}</span>${i.vatPeriod ? h`<a href="#/vat?p=${i.vatPeriod}">開啟 401 工作表</a>` : h`<a href="#/tax">行事曆</a>`}</div>`)}
  </div>`;
}

export async function render(root, ctx) {
  const settings = await getSettings();
  let done = await store.all('tax_tasks');
  const filings = await store.all('tax_filings');
  const f = { year: Number(ctx.params.year) || Number(today().slice(0, 4)), hideDone: ctx.params.hide === '1' };
  const profile = profileOf(settings);

  function draw() {
    const items = buildCalendar(f.year, profile);
    const doneMap = new Map(done.map((d) => [d.id, d]));
    const t = today();
    const open = (i) => !isDone(i, doneMap, filings);
    const before = (i) => i.due < settings.revenue_start; // 系統啟用（營收起算日）前的事項不列為逾期
    const soon = items.filter((i) => open(i) && i.due >= t && (i.prep || i.target) <= addDays(t, 30));
    const overdue = items.filter((i) => open(i) && !before(i) && i.due < t && i.due >= addDays(t, -60));
    const byMonth = new Map();
    for (const it of items) {
      if (f.hideDone && !open(it)) continue;
      const m = it.target.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(it);
    }
    const stateOf = (i) => {
      if (!open(i)) return status('good', '已完成');
      if (before(i)) return status('na', '系統啟用前');
      if (i.due < t) return status('bad', '已逾法定期限');
      if (i.target < t) return status('warn', '已過目標日');
      if (i.prep && i.prep <= t) return status('info', '準備中');
      return '';
    };
    mount(
      root,
      h`<div class="toolbar">
        <label class="field"><span>年度</span><select data-act="year">${options([f.year - 1, f.year, f.year + 1].map((y) => [y, `民國 ${y - 1911} 年（${y}）`]), f.year)}</select></label>
        <label class="check" style="padding-bottom:6px"><input type="checkbox" data-act="hide" ${f.hideDone ? raw('checked') : ''}> 隱藏已完成</label>
        <span class="spacer"></span>
        <a class="btn" href="#/vat">營業稅申報工作表</a>
        <button class="btn" data-act="ics">匯出行事曆（.ics）</button>
      </div>
      <div class="callout" style="margin-bottom:14px"><p>目前設定：<b>${ORG[settings.org_type]}</b>・<b>${VAT[settings.vat_mode]}</b>・${settings.filing_self ? '自行申報' : '委託申報'}・${settings.has_employees ? '有聘僱員工' : '無員工'}${settings.pays_rent_to_individual ? '・店租付給個人房東（需扣繳）' : ''}。<a href="#/settings">修改</a><br>
      每項申報都有<b>開始準備日</b>（每月 ${profile.prepDay} 日）與<b>目標完成日</b>（${profile.targetDay} 日前，遇週末提前到週五）；法定期限在 10 日的扣繳稅款、以及勞健保等繳款單，目標訂在期限前 3 天。法定期限遇週末已順延；國定假日與特別公告請以財政部、勞保局、健保署為準，有疑問可撥國稅局免付費電話 0800-000-321。</p></div>
      <div class="grid-2" style="margin-bottom:16px">
        <div class="card"><div class="card-head"><h2>30 天內要處理</h2></div>${soon.length ? soon.map((i) => h`<div class="row" style="margin-bottom:6px"><b class="num">${md(i.target)}</b><span>${i.title}</span><span class="spacer"></span><span class="muted" title="法定期限 ${i.due}">${daysBetween(t, i.target) >= 0 ? `還有 ${daysBetween(t, i.target)} 天` : '已過目標日'}</span></div>`) : h`<p class="muted">近期沒有待辦申報。</p>`}</div>
        <div class="card"><div class="card-head"><h2>逾期未完成</h2></div>${overdue.length ? overdue.map((i) => h`<div class="row" style="margin-bottom:6px">${status('bad', md(i.due))}<span>${i.title}</span></div>`) : h`<p class="muted">沒有逾期項目。</p>`}</div>
      </div>
      ${[...byMonth.entries()].map(
        ([m, list]) => h`<div class="cal-month"><h3>${Number(m.slice(5))} 月</h3>${list.map((i) => {
          const d = doneMap.get(i.id);
          const fin = !open(i);
          return h`<div class="cal-item ${fin || before(i) ? 'done' : ''} ${i.due < t ? 'past' : ''}">
            <div>
              <div class="date">${i.filing ? '目標 ' : ''}${md(i.target)}</div>
              ${i.prep ? h`<div class="muted" style="font-size:11.5px">${md(i.prep)} 開始準備</div>` : ''}
              ${i.filing ? h`<div class="muted" style="font-size:11.5px">法定期限 ${i.start ? `${i.start.slice(5)}～` : ''}${md(i.due)}${i.due !== i.date ? '（順延）' : ''}</div>` : ''}
            </div>
            <div><div><b>${i.title}</b> ${stateOf(i)}</div><div class="muted" style="font-size:13px">${i.detail}</div><div class="tags">${i.tags.map((x) => badge(x))}${i.vatPeriod ? h` <a class="btn sm ghost" href="#/vat?p=${i.vatPeriod}">開啟工作表</a>` : ''}</div></div>
            <label class="check"><input type="checkbox" data-act="done" data-id="${i.id}" ${fin ? raw('checked') : ''} ${i.vatPeriod && !d?.done && fin ? raw('disabled title="已在營業稅工作表標記申報"') : ''}> 完成</label>
          </div>`;
        })}</div>`,
      )}`,
    );
  }

  const unbind = bindActions(root, {
    year: (el) => {
      f.year = Number(el.value);
      ctx.setParams({ year: f.year });
      draw();
    },
    hide: (el) => {
      f.hideDone = el.checked;
      ctx.setParams({ hide: el.checked ? '1' : '' });
      draw();
    },
    done: async (el) => {
      await store.put('tax_tasks', { id: el.dataset.id, done: el.checked, note: '', done_at: el.checked ? new Date().toISOString() : null });
      done = await store.all('tax_tasks');
      draw();
    },
    ics: () => {
      const items = buildCalendar(f.year, profile);
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
      const esc = (s) => String(s).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
      const ev = items.map((i) => {
        const d = i.target.replace(/-/g, '');
        const next = addDays(i.target, 1).replace(/-/g, '');
        const lead = i.prep ? Math.max(1, daysBetween(i.prep, i.target)) : 3;
        const early = lead > 1 ? `-P${lead - 1}DT15H` : '-PT15H'; // 準備日早上 9 點
        const desc = `${i.detail}${i.filing ? `\n法定期限：${i.due}` : ''}`;
        return ['BEGIN:VEVENT', `UID:${fnv1a(i.id)}-${d}@wuyue-erp`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`, `SUMMARY:${esc('【午月】' + (i.filing ? '完成：' : '') + i.title)}`, `DESCRIPTION:${esc(desc)}`, 'BEGIN:VALARM', `TRIGGER:${early}`, 'ACTION:DISPLAY', `DESCRIPTION:${esc('開始準備：' + i.title)}`, 'END:VALARM', 'BEGIN:VALARM', 'TRIGGER:PT9H', 'ACTION:DISPLAY', `DESCRIPTION:${esc('今天完成：' + i.title)}`, 'END:VALARM', 'END:VEVENT'].join('\r\n');
      });
      download(`午月申報行事曆_${f.year}.ics`, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//wuyue-erp//TW', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:午月申報行事曆', ...ev, 'END:VCALENDAR'].join('\r\n'), 'text/calendar;charset=utf-8');
    },
  });
  draw();
  return unbind;
}
