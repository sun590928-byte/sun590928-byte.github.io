// 營業稅申報（401）工作表：雙月一期。銷項（POS 開立發票基礎、帳上銷項稅額、電子發票平台數字）、
// 進項憑證清單（可否扣抵與原因）、稅額計算（留抵、退稅）、申報前檢查、結轉分錄與繳稅登錄、匯出 Excel。

import { h, raw, mount, bindActions, fmt, toast, confirmBox, modal, badge, status, download, options, stat, dataTable } from '../ui.js';
import { store } from '../store.js';
import { getSettings, getAccounts, getProductIndex, isLocked } from '../state.js';
import { periodInfo, periodsBetween, periodKeyOf, internalTargets, inputItems, assignPeriods, deductibility, posInvoiceBase, computeTax, settlementEntry, netMovement } from '../lib/vat.js';
import { nextVoucherNo, validateEntry } from '../lib/ledger.js';
import { accountMap } from '../lib/coa.js';
import { addMonths, addDays, today, daysBetween, weekdayIndex, WEEKDAYS } from '../lib/dates.js';
import { round2 } from '../lib/money.js';
import { uid } from '../lib/text.js';
import { makeXlsx } from '../lib/xlsxw.js';
import { VOID_REASONS } from '../lib/pos.js';
import { reportHead } from './_shared.js';

const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8))}（${WEEKDAYS[weekdayIndex(ymd)]}）`;
const FILED = new Set(['filed', 'paid']);

// 科目截至某日的餘額（借 − 貸），可排除特定分錄
function balance(entries, account, to, skip = () => false) {
  let n = 0;
  for (const e of entries) {
    if (e.status === 'void' || e.date > to || skip(e)) continue;
    for (const l of e.lines || []) if (l.account === account) n += (Number(l.debit) || 0) - (Number(l.credit) || 0);
  }
  return round2(n);
}

export async function render(root, ctx) {
  const settings = await getSettings();
  const accounts = await getAccounts();
  const accMap = accountMap(accounts);
  const idx = await getProductIndex();
  let [entries, docs, einvoices, filings, sales] = await Promise.all(['journal_entries', 'documents', 'einvoices', 'tax_filings', 'sales_lines'].map((c) => store.all(c)));
  const t = today();
  const periods = periodsBetween(settings.revenue_start < t ? settings.revenue_start : t, t).reverse();
  const defaultKey = () => {
    const due = periods.filter((p) => p.end < t && !FILED.has(filings.find((f) => f.id === p.key)?.status));
    return (due.length ? due[due.length - 1] : periods[0]).key;
  };
  const f = { p: ctx.params.p && /^\d{4}-\d{2}$/.test(ctx.params.p) ? periodKeyOf(ctx.params.p + '-01') : defaultKey() };

  function compute() {
    const info = periodInfo(f.p);
    const filing = filings.find((x) => x.id === f.p) || { id: f.p, period_from: info.from, period_to: info.to, status: 'draft' };
    const ownSettlement = (e) => e.source === 'vat' && e.source_ref === f.p;
    // 銷項
    const lines = sales.filter((l) => l.date >= info.start && l.date <= info.end && l.date >= settings.revenue_start);
    const pos = posInvoiceBase(lines, { categoryOf: (l) => idx.of(l).category, prepaidVat: settings.prepaid_vat || 'sale' });
    // 帳上本期銷項／進項稅額（不含結轉分錄）；前期未結轉的餘額另外提醒
    const bookOutput = -netMovement(entries, '2131', { from: info.start, to: info.end, exclude: ['vat'] });
    const bookInput = netMovement(entries, '1261', { from: info.start, to: info.end, exclude: ['vat'] });
    const priorOutput = -balance(entries, '2131', addDays(info.start, -1), ownSettlement);
    const priorInput = balance(entries, '1261', addDays(info.start, -1), ownSettlement);
    const platformSales = filing.platform_sales_ex ?? null;
    const platformTax = filing.platform_output_tax ?? null;
    const output = platformTax ?? bookOutput;
    // 進項
    const opts = { taxId: settings.tax_id, vatMode: settings.vat_mode };
    const items = assignPeriods(inputItems(docs, einvoices), filings)
      .filter((it) => it.period === f.p)
      .map((it) => ({ ...it, check: deductibility(it, opts) }));
    const sum = (list, k) => round2(list.reduce((a, x) => a + (x[k] || 0), 0));
    const ok = items.filter((x) => x.check.ok);
    const exp = ok.filter((x) => x.use === 'expense');
    const ast = ok.filter((x) => x.use === 'asset');
    // 上期累積留抵
    const prev = filings.find((x) => x.id === addMonths(f.p, -2));
    const prevDefault = prev && FILED.has(prev.status) ? prev.cf || 0 : Math.max(0, balance(entries, '1262', addDays(info.start, -1)));
    const prevCf = filing.prev_cf ?? prevDefault;
    const tax = computeTax({ output, inputExpense: sum(exp, 'tax'), inputAsset: sum(ast, 'tax'), prevCf });
    const targets = internalTargets(info.due, { prepDay: settings.filing_prep_day ?? 10, targetDay: settings.filing_target_day ?? 12 });
    // 申報前檢查
    const pendingDocs = docs.filter((d) => ['inbox', 'reviewed'].includes(d.status) && (!d.doc_date || d.doc_date <= info.end));
    const pendingInv = einvoices.filter((e) => !e.entry_id && !e.voided && e.date && e.date <= info.end);
    const wrongFlag = items.filter((x) => !x.check.ok && x.deductible !== false && Number(x.tax) > 0);
    const invCount = new Map();
    for (const d of docs) if (d.invoice_no && d.status === 'posted') invCount.set(d.invoice_no, (invCount.get(d.invoice_no) || 0) + 1);
    const dupInv = [...invCount.entries()].filter(([, n]) => n > 1).map(([k]) => k);
    const lockedBoth = [info.from, info.to].every((m) => isLocked(settings, `${m}-01`));
    const lateTax = round2(ok.filter((x) => x.late).reduce((a, x) => a + x.tax, 0));
    const inputDiff = round2(bookInput - (tax.input - lateTax));
    const priorLeft = Math.abs(priorOutput) >= 1 || Math.abs(round2(priorInput - lateTax)) >= 1;
    const outputDiff = round2(bookOutput - pos.tax);
    const prevOpen = periods.some((p) => p.key < f.p && p.end >= settings.revenue_start && !FILED.has(filings.find((x) => x.id === p.key)?.status));
    const checks = [
      { ok: lockedBoth, warn: true, text: lockedBoth ? `${info.from}、${info.to} 皆已結帳鎖定` : '期間內月份尚未全部結帳鎖定（建議先完成「每月結帳檢查」）', link: `#/closing?ym=${info.to}` },
      { ok: !pendingDocs.length && !pendingInv.length, text: pendingDocs.length || pendingInv.length ? `還有 ${pendingDocs.length} 張照片、${pendingInv.length} 張電子發票未入帳` : '憑證與電子發票皆已入帳', link: '#/documents' },
      { ok: !wrongFlag.length, text: wrongFlag.length ? `${wrongFlag.length} 張進項不符扣抵條件，但分錄已列進項稅額（請修改憑證或分錄）` : '進項稅額皆符合扣抵條件' },
      { ok: !dupInv.length, text: dupInv.length ? `發票號碼重複入帳：${dupInv.join('、')}` : '沒有重複入帳的發票號碼' },
      { ok: Math.abs(inputDiff) < 1, text: Math.abs(inputDiff) < 1 ? '帳上進項稅額（1261）與清單一致' : `帳上本期進項稅額 ${fmt(bookInput)} 與清單可扣抵 ${fmt(round2(tax.input - lateTax))} 差 ${fmt(inputDiff)}（可能有分錄列了進項稅額但憑證沒填稅額、或手動分錄未附憑證）` },
      { ok: !priorLeft, warn: true, text: priorLeft ? `前期還有未結轉的銷項稅額 ${fmt(priorOutput)}、進項稅額 ${fmt(round2(priorInput - lateTax))}（請先到前期產生結轉分錄）` : '前期稅額皆已結轉' },
      { ok: platformTax !== null, warn: true, text: platformTax !== null ? '已輸入電子發票平台數字' : '請輸入電子發票平台的本期銷售額與銷項稅額，與 POS 核對' },
      { ok: Math.abs(outputDiff) <= Math.max(10, pos.tax * 0.002), warn: true, text: `帳上銷項稅額 ${fmt(bookOutput)}，POS 開立發票基礎 ${fmt(pos.tax)}${Math.abs(outputDiff) > 0.5 ? `（差 ${fmt(outputDiff)}，多為每日四捨五入）` : ''}` },
      { ok: !prevOpen, warn: true, text: prevOpen ? '前期尚未標記申報（留抵與順延憑證可能不正確）' : '前期已申報' },
    ];
    return { info, filing, pos, lines, bookOutput, bookInput, output, platformSales, platformTax, items, ok, exp, ast, sum, prevCf, prevDefault, tax, targets, checks };
  }

  async function draw() {
    const c = compute();
    const { info, filing, pos, tax, targets } = c;
    const reportTitle = await reportHead('營業稅申報工作表（401）', `${info.label}（${info.start} 至 ${info.end}）`);
    const filed = FILED.has(filing.status);
    const days = daysBetween(t, targets.target);
    const head = filed
      ? status('good', filing.status === 'paid' ? `已申報、已繳稅（${filing.filed_on || ''}）` : `已申報（${filing.filed_on || ''}）`)
      : info.end >= t
        ? status('na', '本期尚未結束')
        : t > info.due
          ? status('bad', '已逾法定期限')
          : t > targets.target
            ? status('warn', '已過目標日')
            : status('info', `距目標日還有 ${days} 天`);
    const settlement = entries.find((e) => e.source === 'vat' && e.source_ref === f.p);
    const nd = c.items.filter((x) => !x.check.ok);
    const voidRows = Object.entries(pos.voidByReason);
    mount(
      root,
      h`<div class="toolbar no-print">
        <label class="field"><span>申報期別</span><select data-act="period">${options(periods.map((p) => [p.key, `${p.label}（${FILED.has(filings.find((x) => x.id === p.key)?.status) ? '已申報' : '未申報'}）`]), f.p)}</select></label>
        <span class="spacer"></span>
        <button class="btn" data-act="xlsx">匯出 Excel</button>
        <button class="btn" data-act="print">列印</button>
      </div>
      <div class="callout ${filed ? 'good' : 'warn'} no-print" style="margin-bottom:14px"><p><b>${info.label}</b>　${head}<br>
        ${md(targets.prep)} 開始準備、<b>${md(targets.target)} 前完成</b>；法定期限 ${md(info.due)}。${settings.vat_mode !== 'general' ? h`<br><b>目前設定不是一般稅額營業人</b>，此工作表僅供參考。` : ''}
        ${info.start < settings.revenue_start && info.end >= settings.revenue_start ? h`<br>營收起算日 ${settings.revenue_start} 之前的銷售與進項不在系統明細內：本期請以電子發票平台數字申報，起算日前的銷項／進項稅額可列入<a href="#/journal">期初開帳</a>（2131、1261），結轉分錄才會一致。` : ''}</p></div>
      <div class="stats">
        ${stat('銷項稅額', '$' + fmt(tax.output), c.platformTax !== null ? '電子發票平台' : '帳上（2131）')}
        ${stat('得扣抵進項稅額', '$' + fmt(tax.input), `進貨費用 ${fmt(tax.inputExpense)}・固定資產 ${fmt(tax.inputAsset)}`)}
        ${stat('上期累積留抵', '$' + fmt(tax.prevCf))}
        ${tax.payable ? stat('本期應繳稅額', '$' + fmt(tax.payable), '', 'hero') : stat('本期累積留抵', '$' + fmt(tax.cf), tax.refund ? `另可退稅 ${fmt(tax.refund)}` : '溢付，留待下期扣抵', 'hero')}
      </div>
      <div class="grid-2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-head"><h2>申報前檢查</h2></div>
          <div class="stack" style="gap:6px">${c.checks.map((k) => h`<div class="row" style="gap:8px;align-items:flex-start">${k.ok ? status('good', '') : status(k.warn ? 'warn' : 'bad', '')}<span style="flex:1">${k.text}${k.link ? h` <a href="${k.link}">前往</a>` : ''}</span></div>`)}</div>
        </div>
        <div class="card">
          <div class="card-head"><h2>申報紀錄</h2>${badge(filed ? '已申報' : '草稿', filed ? 'high' : '')}</div>
          <div class="form-grid" id="vat-form">
            <label class="field"><span>平台本期應稅銷售額（未稅）</span><input type="number" name="platform_sales_ex" value="${c.platformSales ?? ''}" placeholder="POS 估算 ${pos.salesEx}" ${filed ? raw('disabled') : ''}></label>
            <label class="field"><span>平台本期銷項稅額</span><input type="number" name="platform_output_tax" value="${c.platformTax ?? ''}" placeholder="帳上 ${Math.round(c.bookOutput)}" ${filed ? raw('disabled') : ''}></label>
            <label class="field"><span>上期累積留抵稅額</span><input type="number" name="prev_cf" value="${filing.prev_cf ?? ''}" placeholder="預設 ${c.prevDefault}" ${filed ? raw('disabled') : ''}></label>
            <label class="field"><span>申報日期</span><input type="date" name="filed_on" value="${filing.filed_on || ''}" ${filed ? raw('disabled') : ''}></label>
            <label class="field" style="grid-column:1/-1"><span>備註（收執聯號碼等）</span><input type="text" name="note" value="${filing.note || filing.receipt_no || ''}"></label>
          </div>
          <div class="row" style="margin-top:10px">
            ${filed ? h`<button class="btn" data-act="unfile">取消申報標記</button>` : h`<button class="btn" data-act="save">儲存</button><button class="btn primary" data-act="file">標記已申報</button>`}
            <button class="btn" data-act="settle">${settlement ? '重新產生結轉分錄' : '產生結轉分錄'}</button>
            ${tax.payable && filing.status !== 'paid' ? h`<button class="btn" data-act="pay">登錄繳稅</button>` : ''}
          </div>
          <p class="muted" style="font-size:12.5px;margin-top:8px">${settlement ? h`結轉分錄：<a href="#/journal?ym=${info.to}&q=${encodeURIComponent(settlement.voucher_no)}">${settlement.voucher_no}</a>。` : '結轉分錄會把本期銷項、進項稅額與留抵轉入「應付營業稅」或「留抵稅額」。'}${filing.pay_entry_id ? ' 已登錄繳稅分錄。' : ''}</p>
        </div>
      </div>
      <div class="card" style="margin-bottom:16px">
        ${reportTitle}
        <div class="card-head"><h2>稅額計算（對照 401 申報書）</h2><span class="card-note">金額：新台幣元</span></div>
        <table class="fin">
          <tr class="h"><td>一、銷項</td><td class="amt"></td></tr>
          <tr class="i"><td>應稅銷售額（未稅）</td><td class="amt">${fmt(c.platformSales ?? pos.salesEx)}</td></tr>
          <tr class="i"><td>銷項稅額</td><td class="amt">${fmt(tax.output)}</td></tr>
          <tr class="h"><td>二、進項（得扣抵）</td><td class="amt"></td></tr>
          <tr class="i"><td>進貨及費用：金額（未稅）／稅額</td><td class="amt">${fmt(c.sum(c.exp, 'ex'))}／${fmt(tax.inputExpense)}</td></tr>
          <tr class="i"><td>固定資產：金額（未稅）／稅額</td><td class="amt">${fmt(c.sum(c.ast, 'ex'))}／${fmt(tax.inputAsset)}</td></tr>
          <tr class="i"><td>進項總金額（含不得扣抵憑證與收據）：進貨及費用／固定資產</td><td class="amt">${fmt(c.sum(c.items.filter((x) => x.use === 'expense'), 'ex'))}／${fmt(c.sum(c.items.filter((x) => x.use === 'asset'), 'ex'))}</td></tr>
          <tr class="h"><td>三、稅額計算</td><td class="amt"></td></tr>
          <tr class="i"><td>本期銷項稅額合計</td><td class="amt">${fmt(tax.output)}</td></tr>
          <tr class="i"><td>得扣抵進項稅額合計</td><td class="amt">${fmt(tax.input)}</td></tr>
          <tr class="i"><td>上期累積留抵稅額</td><td class="amt">${fmt(tax.prevCf)}</td></tr>
          <tr class="t"><td>本期應實繳稅額</td><td class="amt">${fmt(tax.payable)}</td></tr>
          <tr class="i"><td>本期申報留抵稅額（溢付）</td><td class="amt">${fmt(tax.overpaid)}</td></tr>
          <tr class="i"><td>得退稅限額（固定資產進項稅額）</td><td class="amt">${fmt(tax.inputAsset)}</td></tr>
          <tr class="i"><td>本期應退稅額</td><td class="amt">${fmt(tax.refund)}</td></tr>
          <tr class="gt"><td>本期累積留抵稅額</td><td class="amt">${fmt(tax.cf)}</td></tr>
        </table>
        <p class="muted" style="font-size:12.5px;margin-top:8px">實際以財政部申報系統計算為準。溢付稅額中屬於購買固定資產者可申請退還，其餘留待下期扣抵（營業稅法第 39 條）。</p>
      </div>
      <div class="grid-2" style="margin-bottom:16px">
        <div class="card">
          <div class="card-head"><h2>銷項來源（POS）</h2></div>
          <table class="fin">
            <tr><td>本期 POS 有效營收（含稅）</td><td class="amt">${fmt(round2(pos.receipts + pos.excluded.redeem + pos.excluded.prepaidSale))}</td></tr>
            ${pos.excluded.redeem ? h`<tr class="i"><td>減：寄杯兌換（售出時已開發票）</td><td class="amt">${fmt(-pos.excluded.redeem)}</td></tr>` : ''}
            ${pos.excluded.prepaidSale ? h`<tr class="i"><td>減：寄杯售出（兌換時才開發票）</td><td class="amt">${fmt(-pos.excluded.prepaidSale)}</td></tr>` : ''}
            <tr class="t"><td>應開立發票金額（含稅）</td><td class="amt">${fmt(pos.receipts)}</td></tr>
            <tr class="i"><td>未稅銷售額／稅額（÷1.05）</td><td class="amt">${fmt(pos.salesEx)}／${fmt(pos.tax)}</td></tr>
            <tr><td>帳上銷項稅額（2131，本期分錄）</td><td class="amt">${fmt(c.bookOutput)}</td></tr>
            ${c.platformTax !== null ? h`<tr><td>電子發票平台銷項稅額（輸入）</td><td class="amt">${fmt(c.platformTax)}</td></tr><tr class="i"><td>與 POS 差異</td><td class="amt">${fmt(round2(c.platformTax - pos.tax))}</td></tr>` : ''}
          </table>
          ${voidRows.length ? h`<p class="muted" style="font-size:12.5px;margin-top:10px">不開發票（金額作廢）：${voidRows.map(([k, v]) => `${VOID_REASONS[k]?.label || k} ${fmt(v.qty)} 份／牌價 ${fmt(v.amount)} 元`).join('；')}。</p>` : ''}
          ${pos.voidByReason.boss_treat ? h`<p class="muted" style="font-size:12.5px">提醒：老闆招待（無償提供給他人）依營業稅法第 3 條第 3 項屬「視為銷售」，原則上應開立發票並計入銷項；金額小可自行評估，如已開立請以平台數字申報。</p>` : ''}
        </div>
        <div class="card">
          <div class="card-head"><h2>申報步驟（自行申報）</h2></div>
          <ol class="plain-list" style="padding-left:22px">
            <li>完成 ${Number(info.from.slice(5))}、${Number(info.to.slice(5))} 月的「每月結帳檢查」並鎖定。</li>
            <li>登入財政部電子發票整合服務平台，核對本期銷項發票總額與進項發票，把平台數字填進「申報紀錄」。</li>
            <li>本頁「申報前檢查」全部通過後，到財政部電子申報繳稅服務網申報 401，繳款書或留抵資料存檔（可拍照上傳到憑證）。</li>
            <li>按「標記已申報」，並「產生結轉分錄」；繳稅後「登錄繳稅」。</li>
            <li>目標 ${md(targets.target)} 前完成；法定期限 ${md(info.due)}。有疑問可撥國稅局免付費電話 0800-000-321。</li>
          </ol>
        </div>
      </div>
      <div class="card">
        <div class="card-head"><h2>本期進項憑證</h2><span class="card-note">${c.items.length} 張・可扣抵 ${c.ok.length} 張${nd.length ? `・不可扣抵 ${nd.length} 張` : ''}</span></div>
        <div id="items"></div>
      </div>`,
    );
    dataTable(root.querySelector('#items'), {
      rows: c.items,
      pageSize: 200,
      exportName: `進項憑證_${info.key}.csv`,
      empty: '本期沒有已入帳的進項憑證',
      rowClass: (r) => (r.check.ok ? '' : 'muted-row'),
      columns: [
        { key: 'date', label: '日期', fmt: (v, r) => h`${v}${r.late ? h` ${badge('延後扣抵', 'accent')}` : ''}` },
        { key: 'invoice_no', label: '發票號碼' },
        { key: 'vendor', label: '賣方', fmt: (v, r) => h`${v}${r.vendor_tax_id ? h`<div class="muted" style="font-size:12px">${r.vendor_tax_id}</div>` : ''}` },
        { key: 'account', label: '科目', fmt: (v) => `${v} ${accMap.get(v)?.name || ''}` },
        { key: 'use', label: '類別', fmt: (v) => (v === 'asset' ? '固定資產' : '進貨及費用') },
        { key: 'ex', label: '未稅金額', align: 'num', fmt: (v) => fmt(v) },
        { key: 'tax', label: '稅額', align: 'num', fmt: (v) => fmt(v) },
        { key: 'check', label: '可否扣抵', sort: (r) => (r.check.ok ? 0 : 1), csv: (v) => (v.ok ? '可扣抵' : '不可扣抵：' + v.reason), fmt: (v) => (v.ok ? status('good', '可扣抵') : status('na', v.reason)) },
      ],
    });
  }

  async function saveFiling(patch) {
    const c = compute();
    const form = root.querySelector('#vat-form');
    const num = (n) => {
      const v = form.querySelector(`[name=${n}]`).value;
      return v === '' ? null : Number(v);
    };
    const rec = {
      ...c.filing,
      platform_sales_ex: num('platform_sales_ex'),
      platform_output_tax: num('platform_output_tax'),
      prev_cf: num('prev_cf'),
      filed_on: form.querySelector('[name=filed_on]').value || c.filing.filed_on || null,
      note: form.querySelector('[name=note]').value.trim(),
      updated_at: new Date().toISOString(),
      ...patch,
    };
    await store.put('tax_filings', rec);
    filings = await store.all('tax_filings');
    return rec;
  }

  const unbind = bindActions(root, {
    period: (el) => {
      f.p = el.value;
      ctx.setParams({ p: f.p });
      draw();
    },
    save: async () => {
      await saveFiling({});
      toast('已儲存', 'good');
      draw();
    },
    file: async () => {
      const c = compute();
      const bad = c.checks.filter((k) => !k.ok && !k.warn);
      if (bad.length && !(await confirmBox(`還有 ${bad.length} 項檢查未通過：${bad.map((k) => k.text).join('；')}。仍要標記已申報？`, { ok: '仍要標記' }))) return;
      const filedOn = root.querySelector('#vat-form [name=filed_on]').value || today();
      await saveFiling({
        status: 'filed',
        filed_on: filedOn,
        sales_ex: c.platformSales ?? c.pos.salesEx,
        output_tax: c.tax.output,
        input_tax: c.tax.inputExpense,
        input_asset_tax: c.tax.inputAsset,
        prev_cf: c.tax.prevCf,
        payable: c.tax.payable,
        refund: c.tax.refund,
        cf: c.tax.cf,
        claimed: c.items.map((x) => x.id),
      });
      toast(`${c.info.label} 已標記申報`, 'good');
      draw();
    },
    unfile: async () => {
      if (!(await confirmBox('取消申報標記？進項清單與留抵會重新計算。'))) return;
      await saveFiling({ status: 'draft', claimed: [] });
      draw();
    },
    settle: async () => {
      const c = compute();
      if (isLocked(settings, c.info.end)) return toast(`${c.info.to} 已結帳鎖定，請先解除鎖定再產生結轉分錄`, 'error', 6000);
      const e0 = settlementEntry(f.p, { bookOutput: c.bookOutput, bookInput: c.tax.input, tax: c.tax });
      const errs = validateEntry({ ...e0, id: 'x' }, accMap);
      if (errs.length) return toast(errs[0], 'error');
      const plug = e0.lines.find((l) => l.memo === '營業稅尾差');
      if (plug && Math.max(plug.debit, plug.credit) > 50 && !(await confirmBox(`帳上數字與工作表差 ${fmt(Math.max(plug.debit, plug.credit))} 元，會列為營業稅尾差。建議先處理「申報前檢查」的差異。仍要產生？`, { ok: '仍要產生' }))) return;
      const old = entries.find((e) => e.source === 'vat' && e.source_ref === f.p);
      const e = { ...e0, id: old?.id || uid('je_'), voucher_no: old?.voucher_no || nextVoucherNo(entries, e0.date), status: 'posted', created_at: old?.created_at || new Date().toISOString(), updated_at: new Date().toISOString() };
      await store.put('journal_entries', e);
      entries = await store.all('journal_entries');
      await saveFiling({ entry_id: e.id });
      toast(`已產生結轉分錄 ${e.voucher_no}`, 'good');
      draw();
    },
    pay: async () => {
      const c = compute();
      const r = await modal({
        title: '登錄繳納營業稅',
        body: h`<div class="form-grid">
          <label class="field"><span>繳納日期</span><input type="date" name="d" value="${today()}"></label>
          <label class="field"><span>金額</span><input type="number" name="a" value="${c.tax.payable}"></label>
          <label class="field"><span>付款帳戶</span><select name="acc">${options([['1103', '1103 銀行存款'], ['1101', '1101 庫存現金'], ['2191', '2191 業主往來（老闆代墊）']], settings.bank_gl || '1103')}</select></label>
        </div><p class="muted" style="font-size:12.5px;margin-top:8px">分錄：借 2132 應付營業稅／貸 付款帳戶。請先產生結轉分錄（應付營業稅才會有餘額）。</p>`,
        actions: [
          { label: '取消', value: null },
          { label: '登錄', primary: true, value: (d) => ({ date: d.querySelector('[name=d]').value, amount: Number(d.querySelector('[name=a]').value), acc: d.querySelector('[name=acc]').value }) },
        ],
      });
      if (!r || !r.date || !(r.amount > 0)) return;
      if (isLocked(settings, r.date)) return toast('該月份已結帳鎖定', 'error');
      const old = entries.find((e) => e.source === 'vat_pay' && e.source_ref === f.p);
      const e = { id: old?.id || uid('je_'), date: r.date, description: `繳納營業稅（${c.info.label}）`, source: 'vat_pay', source_ref: f.p, status: 'posted', voucher_no: old?.voucher_no && old.date.slice(0, 7) === r.date.slice(0, 7) ? old.voucher_no : nextVoucherNo(entries.filter((x) => x.id !== old?.id), r.date), lines: [{ account: '2132', debit: r.amount, credit: 0, memo: '應付營業稅' }, { account: r.acc, debit: 0, credit: r.amount, memo: '' }], created_at: old?.created_at || new Date().toISOString(), updated_at: new Date().toISOString() };
      await store.put('journal_entries', e);
      entries = await store.all('journal_entries');
      await saveFiling({ status: FILED.has(c.filing.status) ? 'paid' : c.filing.status, paid_on: r.date, pay_entry_id: e.id });
      toast(`已登錄繳稅 ${e.voucher_no}`, 'good');
      draw();
    },
    xlsx: async () => {
      const c = compute();
      const s = await getSettings();
      const title = [[`${s.business_name}　營業稅申報工作表（401）`], [`${c.info.label}　法定期限 ${c.info.due}　目標完成 ${c.targets.target}`], []];
      const calc = [
        ...title,
        ['項目', '金額'],
        ['應稅銷售額（未稅）', c.platformSales ?? c.pos.salesEx],
        ['銷項稅額', c.tax.output],
        ['進貨及費用：金額（未稅）', c.sum(c.exp, 'ex')],
        ['進貨及費用：得扣抵稅額', c.tax.inputExpense],
        ['固定資產：金額（未稅）', c.sum(c.ast, 'ex')],
        ['固定資產：得扣抵稅額', c.tax.inputAsset],
        ['得扣抵進項稅額合計', c.tax.input],
        ['上期累積留抵稅額', c.tax.prevCf],
        ['本期應實繳稅額', c.tax.payable],
        ['本期申報留抵稅額（溢付）', c.tax.overpaid],
        ['本期應退稅額', c.tax.refund],
        ['本期累積留抵稅額', c.tax.cf],
        [],
        ['POS 應開立發票金額（含稅）', c.pos.receipts],
        ['POS 未稅銷售額', c.pos.salesEx],
        ['POS 稅額', c.pos.tax],
        ['帳上銷項稅額（2131 本期）', c.bookOutput],
        ['電子發票平台銷項稅額', c.platformTax ?? ''],
      ];
      const list = [['日期', '發票號碼', '賣方', '賣方統編', '科目', '類別', '未稅金額', '稅額', '可否扣抵', '說明'], ...c.items.map((x) => [x.date, x.invoice_no, x.vendor, x.vendor_tax_id, `${x.account} ${accMap.get(x.account)?.name || ''}`, x.use === 'asset' ? '固定資產' : '進貨及費用', x.ex, x.tax, x.check.ok ? '可扣抵' : '不可扣抵', x.check.reason + (x.late ? '（延後扣抵）' : '')])];
      const checks = [['檢查項目', '結果'], ...c.checks.map((k) => [k.text, k.ok ? '通過' : '待處理'])];
      download(`營業稅401工作表_${c.info.label.replace(/\s/g, '')}.xlsx`, makeXlsx([
        { name: '稅額計算', rows: calc, widths: [34, 16], header: 0, bold: [0, 3] },
        { name: '進項憑證', rows: list, widths: [12, 14, 22, 11, 24, 12, 12, 10, 10, 36] },
        { name: '申報前檢查', rows: checks, widths: [70, 10] },
      ]));
    },
    print: () => window.print(),
  });
  draw();
  return unbind;
}
