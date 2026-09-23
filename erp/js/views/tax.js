// 年度／每月 會計申報與重要事項工作表：依店家型態產生期限清單，可勾選完成、匯出行事曆（.ics）。

import { h, raw, mount, bindActions, badge, status, download, options } from '../ui.js';
import { store } from '../store.js';
import { getSettings } from '../state.js';
import { buildCalendar } from '../lib/taxcal.js';
import { today, addDays, daysBetween } from '../lib/dates.js';

const ORG = { sole: '獨資／合夥（行號）', company: '公司' };
const VAT = { general: '一般稅額（開立統一發票，5%）', small: '小規模營業人（查定課徵 1%）', none: '免稅' };

export async function render(root, ctx) {
  const settings = await getSettings();
  let done = await store.all('tax_tasks');
  const f = { year: Number(ctx.params.year) || Number(today().slice(0, 4)), hideDone: ctx.params.hide === '1' };
  const profile = { orgType: settings.org_type, vatMode: settings.vat_mode, hasEmployees: settings.has_employees, ownsProperty: settings.owns_property, hasVehicle: settings.has_vehicle, paysRentToIndividual: settings.pays_rent_to_individual };

  function draw() {
    const items = buildCalendar(f.year, profile);
    const doneMap = new Map(done.map((d) => [d.id, d]));
    const t = today();
    const soon = items.filter((i) => !doneMap.get(i.id)?.done && i.due >= t && i.due <= addDays(t, 30));
    const overdue = items.filter((i) => !doneMap.get(i.id)?.done && i.due < t && i.due >= addDays(t, -60));
    const byMonth = new Map();
    for (const it of items) {
      if (f.hideDone && doneMap.get(it.id)?.done) continue;
      const m = it.due.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, []);
      byMonth.get(m).push(it);
    }
    mount(
      root,
      h`<div class="toolbar">
        <label class="field"><span>年度</span><select data-act="year">${options([f.year - 1, f.year, f.year + 1].map((y) => [y, `民國 ${y - 1911} 年（${y}）`]), f.year)}</select></label>
        <label class="check" style="padding-bottom:6px"><input type="checkbox" data-act="hide" ${f.hideDone ? raw('checked') : ''}> 隱藏已完成</label>
        <span class="spacer"></span>
        <button class="btn" data-act="ics">匯出行事曆（.ics）</button>
      </div>
      <div class="callout" style="margin-bottom:14px"><p>目前設定：<b>${ORG[settings.org_type]}</b>・<b>${VAT[settings.vat_mode]}</b>・${settings.has_employees ? '有聘僱員工' : '無員工'}${settings.pays_rent_to_individual ? '・店租付給個人房東（需扣繳）' : ''}。<a href="#/settings">修改</a><br>
      期限為法定常態日期，遇週末已自動順延至週一；國定假日與當年度特別公告請以財政部、勞保局、健保署為準，並與記帳士確認。</p></div>
      <div class="grid-2" style="margin-bottom:16px">
        <div class="card"><div class="card-head"><h2>30 天內到期</h2></div>${soon.length ? soon.map((i) => h`<div class="row" style="margin-bottom:6px"><b class="num">${i.due.slice(5)}</b><span>${i.title}</span><span class="spacer"></span><span class="muted">${daysBetween(t, i.due)} 天</span></div>`) : h`<p class="muted">近期沒有待辦申報。</p>`}</div>
        <div class="card"><div class="card-head"><h2>逾期未勾選</h2></div>${overdue.length ? overdue.map((i) => h`<div class="row" style="margin-bottom:6px">${status('bad', i.due.slice(5))}<span>${i.title}</span></div>`) : h`<p class="muted">沒有逾期項目。</p>`}</div>
      </div>
      ${[...byMonth.entries()].map(
        ([m, list]) => h`<div class="cal-month"><h3>${Number(m.slice(5))} 月</h3>${list.map((i) => {
          const d = doneMap.get(i.id);
          return h`<div class="cal-item ${d?.done ? 'done' : ''} ${i.due < t ? 'past' : ''}">
            <div><div class="date">${i.start ? `${i.start.slice(5)}～` : ''}${i.due.slice(5)}</div>${i.due !== i.date ? h`<div class="muted" style="font-size:11.5px">原 ${i.date.slice(5)}，順延</div>` : ''}</div>
            <div><div><b>${i.title}</b></div><div class="muted" style="font-size:13px">${i.detail}</div><div class="tags">${i.tags.map((x) => badge(x))}</div></div>
            <label class="check"><input type="checkbox" data-act="done" data-id="${i.id}" ${d?.done ? raw('checked') : ''}> 完成</label>
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
        const d = i.due.replace(/-/g, '');
        const next = addDays(i.due, 1).replace(/-/g, '');
        return ['BEGIN:VEVENT', `UID:${i.id.replace(/[^\w-]/g, '')}-${d}@wuyue-erp`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${next}`, `SUMMARY:${esc('【午月】' + i.title)}`, `DESCRIPTION:${esc(i.detail)}`, 'BEGIN:VALARM', 'TRIGGER:-P3D', 'ACTION:DISPLAY', `DESCRIPTION:${esc(i.title)}`, 'END:VALARM', 'END:VEVENT'].join('\r\n');
      });
      download(`午月申報行事曆_${f.year}.ics`, ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//wuyue-erp//TW', 'CALSCALE:GREGORIAN', ...ev, 'END:VCALENDAR'].join('\r\n'), 'text/calendar;charset=utf-8');
    },
  });
  draw();
  return unbind;
}
