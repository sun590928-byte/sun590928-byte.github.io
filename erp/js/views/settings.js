// 設定與備份：店家資料、營業稅類型、營收起算日、作廢規則、會員等級、雲端資料庫、備份還原。

import { h, raw, mount, bindActions, toast, confirmBox, download, pickFiles, options, setBusy, status } from '../ui.js';
import { store, cloudConfig, saveCloudConfig } from '../store.js';
import { getSettings, saveSettings } from '../state.js';
import { VOID_REASONS, DEFAULT_VOID_RULES, reapplyVoids } from '../lib/pos.js';
import { isValidTaxId } from '../lib/classify.js';
import { COLLECTIONS, SCHEMA } from '../schema.js';
import { syncAll, describeSync } from '../sync.js';

export async function render(root) {
  let s = await getSettings();

  async function draw() {
    const cfg = cloudConfig() || {};
    const rules = Object.fromEntries((s.void_rules || DEFAULT_VOID_RULES).map((r) => [r.reason, r]));
    const counts = {};
    for (const c of ['sales_lines', 'journal_entries', 'documents', 'payment_tx', 'payouts', 'bank_lines']) counts[c] = (await store.all(c)).length;
    mount(
      root,
      h`<div class="stack">
      <form class="card" id="biz">
        <div class="card-head"><h2>店家與帳務設定</h2></div>
        <div class="form-grid">
          <label class="field"><span>店名（報表抬頭）</span><input type="text" name="business_name" value="${s.business_name}"></label>
          <label class="field"><span>統一編號</span><input type="text" name="tax_id" value="${s.tax_id}" maxlength="8" inputmode="numeric"></label>
          <label class="field"><span>組織型態</span><select name="org_type">${options([['sole', '獨資／合夥（行號）'], ['company', '公司']], s.org_type)}</select></label>
          <label class="field"><span>營業稅類型</span><select name="vat_mode">${options([['general', '一般稅額：開立統一發票（5% 內含）'], ['small', '小規模營業人：查定課徵 1%'], ['none', '免稅／不適用']], s.vat_mode)}</select></label>
          <label class="field"><span>營收起算日</span><input type="date" name="revenue_start" value="${s.revenue_start}"></label>
          <label class="field"><span>營業日切換時間（凌晨幾點前算前一天）</span><input type="number" name="cutoff_hour" min="0" max="6" value="${s.cutoff_hour}"></label>
          <label class="field"><span>主要銀行存款科目</span><input type="text" name="bank_gl" value="${s.bank_gl}"></label>
          <label class="field"><span>付款方式不明時暫列科目</span><input type="text" name="unknown_payment_account" value="${s.unknown_payment_account}"></label>
          <label class="field"><span>估計毛利率（行銷 ROI 用）</span><input type="number" name="gross_margin_est" step="0.05" min="0" max="1" value="${s.gross_margin_est}"></label>
        </div>
        <div class="row" style="margin-top:12px;gap:18px">
          <label class="check"><input type="checkbox" name="vat_confirmed" ${s.vat_confirmed ? raw('checked') : ''}> 已與記帳士確認營業稅類型</label>
          <label class="check"><input type="checkbox" name="has_employees" ${s.has_employees ? raw('checked') : ''}> 有聘僱員工</label>
          <label class="check"><input type="checkbox" name="pays_rent_to_individual" ${s.pays_rent_to_individual ? raw('checked') : ''}> 店租付給個人房東</label>
          <label class="check"><input type="checkbox" name="owns_property" ${s.owns_property ? raw('checked') : ''}> 有自有房地</label>
          <label class="check"><input type="checkbox" name="has_vehicle" ${s.has_vehicle ? raw('checked') : ''}> 有營業用車</label>
        </div>
        <p class="muted" style="font-size:12.5px;margin-top:8px">營業稅類型影響營收入帳方式：一般稅額時，POS 含稅金額 ÷ 1.05 為收入、其餘列銷項稅額；小規模營業人收入以含稅金額入帳，季繳營業稅列「稅捐」。</p>
        <div class="row" style="margin-top:12px"><button class="btn primary" type="button" data-act="saveBiz">儲存設定</button></div>
      </form>

      <div class="card">
        <div class="card-head"><h2>作廢規則</h2><span class="card-note">品名、選項、備註、付款方式、分類中含有這些字，金額即作廢（營收計 0，數量仍計入原物料耗用）</span></div>
        <div class="form-grid">${['boss_test', 'boss_treat', 'scrap', 'pos_void'].map(
          (k) => h`<label class="field"><span>${VOID_REASONS[k].label}${k === 'pos_void' ? '（只比對狀態欄）' : ''}</span><input type="text" data-rule="${k}" value="${(rules[k]?.keywords || []).join('、')}"></label>`,
        )}</div>
        <p class="muted" style="font-size:12.5px;margin-top:8px">多個關鍵字用「、」或逗號分隔。目前依指示：老闆測試、老闆招待、報廢一律視為金額作廢；上週仍不確定的品項也先作廢，確認後可改關鍵字重新套用。</p>
        <div class="row" style="margin-top:10px"><button class="btn primary" data-act="saveRules">儲存並重新套用到全部銷售明細</button></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>會員等級門檻</h2><span class="card-note">依累積消費金額</span></div>
        <div class="form-grid">${(s.tiers || []).map((t, i) => h`<label class="field"><span>等級 ${i + 1}</span><input type="text" data-tier-name="${i}" value="${t.name}"></label><label class="field"><span>門檻（元）</span><input type="number" data-tier-min="${i}" value="${t.min}"></label>`)}</div>
        <div class="row" style="margin-top:10px"><button class="btn" data-act="saveTiers">儲存等級</button></div>
      </div>

      <div class="card">
        <div class="card-head"><h2>雲端資料庫（Supabase）</h2>${store.mode === 'cloud' ? status('good', '使用中') : status('na', '未啟用：資料只存在這台電腦的瀏覽器')}</div>
        <p class="muted" style="font-size:13.5px">連線後資料存到你自己的 Supabase 專案，手機、店裡電腦都能登入同一份帳；憑證照片存到私有儲存空間，並可用 AI 自動辨識。建立專案與部署步驟請見專案說明文件（README 的「雲端設定」章節）。</p>
        <div class="form-grid">
          <label class="field"><span>Project URL</span><input type="url" name="sb_url" value="${cfg.url || ''}" placeholder="https://xxxx.supabase.co"></label>
          <label class="field" style="grid-column:span 2"><span>anon public key</span><input type="text" name="sb_key" value="${cfg.anonKey || ''}"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn primary" data-act="cloudOn">${store.mode === 'cloud' ? '更新連線' : '啟用雲端'}</button>
          ${store.mode === 'cloud' ? h`<button class="btn" data-act="push">把本機資料上傳到雲端</button><button class="btn" data-act="signOut">登出</button><button class="btn danger" data-act="cloudOff">改回本機模式</button>` : ''}
        </div>
        <p class="muted" style="font-size:12.5px;margin-top:8px">anon key 可公開放在網頁端；資料安全由資料庫的列級權限（RLS）保護，只有你加入白名單的帳號能讀寫。</p>
      </div>

      <div class="card">
        <div class="card-head"><h2>備份與還原</h2></div>
        <p class="muted" style="font-size:13.5px">目前資料：銷售明細 ${counts.sales_lines} 筆、分錄 ${counts.journal_entries} 張、憑證 ${counts.documents} 張、刷卡交易 ${counts.payment_tx} 筆、撥款 ${counts.payouts} 筆、存摺 ${counts.bank_lines} 筆。${store.mode === 'local' ? '本機模式下，清除瀏覽器資料會一併刪除帳務，請定期下載備份。' : ''}</p>
        <div class="row">
          <button class="btn primary" data-act="backup">下載完整備份（JSON）</button>
          <button class="btn" data-act="restore">從備份還原…</button>
          <button class="btn" data-act="resync">重新產生全部自動分錄</button>
          <span class="spacer"></span>
          <button class="btn danger" data-act="wipe">清除全部資料…</button>
        </div>
        ${(s.locked_months || []).length ? h`<p style="margin-top:12px">已鎖定月份：${s.locked_months.join('、')}</p>` : ''}
      </div>
      </div>`,
    );
  }

  const unbind = bindActions(root, {
    saveBiz: async () => {
      const form = root.querySelector('#biz');
      const g = (n) => form.querySelector(`[name=${n}]`);
      const taxId = g('tax_id').value.trim();
      if (taxId && !isValidTaxId(taxId)) {
        if (!(await confirmBox(`統一編號 ${taxId} 檢查碼不正確，仍要儲存？`))) return;
      }
      const patch = {
        business_name: g('business_name').value.trim() || '午月咖啡廳',
        tax_id: taxId,
        org_type: g('org_type').value,
        vat_mode: g('vat_mode').value,
        revenue_start: g('revenue_start').value || '2026-08-21',
        cutoff_hour: Number(g('cutoff_hour').value) || 0,
        bank_gl: g('bank_gl').value.trim() || '1103',
        unknown_payment_account: g('unknown_payment_account').value.trim() || '1101',
        gross_margin_est: Number(g('gross_margin_est').value) || 0.7,
        vat_confirmed: g('vat_confirmed').checked,
        has_employees: g('has_employees').checked,
        pays_rent_to_individual: g('pays_rent_to_individual').checked,
        owns_property: g('owns_property').checked,
        has_vehicle: g('has_vehicle').checked,
      };
      const needSync = patch.vat_mode !== s.vat_mode || patch.revenue_start !== s.revenue_start || patch.bank_gl !== s.bank_gl || patch.unknown_payment_account !== s.unknown_payment_account;
      s = await saveSettings(patch);
      if (needSync) {
        setBusy(true, '重新產生自動分錄…');
        try {
          toast(describeSync(await syncAll()), 'good', 6000);
        } finally {
          setBusy(false);
        }
      } else toast('已儲存', 'good');
      draw();
    },
    saveRules: async () => {
      const rules = ['boss_test', 'boss_treat', 'scrap', 'pos_void'].map((k) => ({
        reason: k,
        keywords: root.querySelector(`[data-rule="${k}"]`).value.split(/[、,，\s]+/).map((x) => x.trim()).filter(Boolean),
        statusOnly: k === 'pos_void',
      }));
      s = await saveSettings({ void_rules: rules });
      setBusy(true, '重新套用作廢規則…');
      try {
        const all = await store.all('sales_lines');
        const copy = all.map((l) => ({ ...l }));
        const changed = reapplyVoids(copy, rules);
        const diff = copy.filter((l, i) => l.void_reason !== all[i].void_reason);
        if (diff.length) await store.put('sales_lines', diff);
        await syncAll();
        toast(`已套用，${changed} 筆狀態改變`, 'good');
      } finally {
        setBusy(false);
      }
    },
    saveTiers: async () => {
      const tiers = (s.tiers || []).map((t, i) => ({ name: root.querySelector(`[data-tier-name="${i}"]`).value.trim() || t.name, min: Number(root.querySelector(`[data-tier-min="${i}"]`).value) || 0 })).sort((a, b) => a.min - b.min);
      s = await saveSettings({ tiers });
      toast('已儲存', 'good');
    },
    cloudOn: async () => {
      const url = root.querySelector('[name=sb_url]').value.trim().replace(/\/$/, '');
      const anonKey = root.querySelector('[name=sb_key]').value.trim();
      if (!/^https:\/\/.+/.test(url) || anonKey.length < 20) return toast('請填入正確的 Project URL 與 anon key', 'error');
      saveCloudConfig({ url, anonKey, enabled: true });
      toast('已儲存，重新載入後請登入', 'good');
      setTimeout(() => location.reload(), 800);
    },
    cloudOff: async () => {
      if (!(await confirmBox('改回本機模式？雲端資料不會被刪除，之後可再啟用。'))) return;
      saveCloudConfig({ ...cloudConfig(), enabled: false });
      location.reload();
    },
    signOut: async () => {
      await store.backend.signOut();
      location.reload();
    },
    push: async () => {
      if (!(await confirmBox('把這台電腦瀏覽器裡的本機資料全部上傳到雲端（同 ID 會覆蓋）？'))) return;
      setBusy(true, '上傳中…');
      try {
        await store.pushLocalToCloud((c, n) => setBusy(true, `上傳 ${SCHEMA[c].label}（${n} 筆）…`));
        toast('上傳完成', 'good');
      } finally {
        setBusy(false);
      }
      draw();
    },
    backup: async () => {
      const data = await store.exportAll();
      download(`午月ERP備份_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`, JSON.stringify(data), 'application/json');
    },
    restore: async () => {
      const [file] = await pickFiles({ accept: '.json,application/json', multiple: false });
      if (!file) return;
      const json = JSON.parse(await file.text());
      const replace = await confirmBox('還原方式：按「覆蓋」會先清空目前資料再還原；按「取消」則不動作。', { ok: '覆蓋還原', danger: true });
      if (!replace) return;
      setBusy(true, '還原中…');
      try {
        await store.importAll(json, { replace: true });
        toast('已還原', 'good');
        setTimeout(() => location.reload(), 600);
      } finally {
        setBusy(false);
      }
    },
    resync: async () => {
      setBusy(true, '重新產生自動分錄…');
      try {
        toast(describeSync(await syncAll()), 'good', 6000);
      } finally {
        setBusy(false);
      }
    },
    wipe: async () => {
      if (!(await confirmBox(`清除${store.mode === 'cloud' ? '雲端' : '本機'}全部資料（銷售、分錄、憑證、設定…）？此動作無法復原，請先下載備份。`, { ok: '全部清除', danger: true }))) return;
      if (!(await confirmBox('再次確認：真的要清除全部資料？', { ok: '確定清除', danger: true }))) return;
      setBusy(true, '清除中…');
      try {
        for (const c of COLLECTIONS) await store.clear(c);
      } finally {
        setBusy(false);
      }
      location.reload();
    },
  });
  await draw();
  return unbind;
}
