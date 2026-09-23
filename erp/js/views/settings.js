// 設定與備份：店家資料、營業稅與申報、作廢規則、會員等級、安全性（開啟密碼、自動上鎖）、雲端資料庫、加密備份還原。

import { h, raw, mount, bindActions, toast, confirmBox, download, pickFiles, options, setBusy, status, modal } from '../ui.js';
import { store, cloudConfig, saveCloudConfig } from '../store.js';
import { getSettings, saveSettings } from '../state.js';
import { VOID_REASONS, DEFAULT_VOID_RULES, reapplyVoids } from '../lib/pos.js';
import { isValidTaxId } from '../lib/classify.js';
import { COLLECTIONS, SCHEMA } from '../schema.js';
import { syncAll, describeSync } from '../sync.js';
import { passcodeProblems, MIN_PASSCODE, KDF_ITERATIONS } from '../lib/vault.js';
import { packBackup, unpackBackup, isEncryptedBackup } from '../lib/backup.js';
import { AUTOLOCK_CHOICES, autoLockMinutes, setAutoLockMinutes, lockNow, codeHtml } from '../gate.js';
import { today, nowStamp } from '../lib/dates.js';

// 兩次輸入的密碼對話框；回傳密碼或 null
async function askNewPassword(title, intro, { current = false } = {}) {
  return modal({
    title,
    body: h`<p class="muted">${intro}</p><div class="stack" style="gap:10px">
      ${current ? h`<label class="field"><span>目前的開啟密碼</span><input type="password" name="cur" autocomplete="off"></label>` : ''}
      <label class="field"><span>${current ? '新的' : ''}密碼（至少 ${MIN_PASSCODE} 個字）</span><input type="password" name="p1" autocomplete="off"></label>
      <label class="field"><span>再輸入一次</span><input type="password" name="p2" autocomplete="off"></label></div>`,
    actions: [
      { label: '取消', value: null },
      {
        label: '確定',
        primary: true,
        value: (d) => {
          const p1 = d.querySelector('[name=p1]').value;
          const probs = passcodeProblems(p1);
          if (probs.length) {
            toast('密碼' + probs.join('、'), 'error');
            return false;
          }
          if (p1 !== d.querySelector('[name=p2]').value) {
            toast('兩次輸入的密碼不一樣', 'error');
            return false;
          }
          return { current: d.querySelector('[name=cur]')?.value || '', password: p1 };
        },
      },
    ],
    onMount: (d) => d.querySelector('input')?.focus(),
  });
}

async function askPassword(title, intro) {
  return modal({
    title,
    body: h`<p class="muted">${intro}</p><label class="field"><span>密碼</span><input type="password" name="p" autocomplete="off"></label>`,
    actions: [
      { label: '取消', value: null },
      { label: '確定', primary: true, value: (d) => d.querySelector('[name=p]').value || false },
    ],
    onMount: (d) => d.querySelector('input')?.focus(),
  });
}

function showRecoveryCode(code) {
  return modal({
    title: '新的復原碼',
    body: h`<p class="muted">舊的復原碼已失效。請下載保存或抄在紙上，放在安全的地方。</p><div class="recovery-code">${codeHtml(code)}</div>`,
    actions: [
      { label: '下載復原碼', value: () => (download(`午月ERP復原碼_${today()}.txt`, `午月營運帳務系統 復原碼\r\n\r\n${code}\r\n`), false) },
      { label: '我已保存', primary: true, value: true },
    ],
  });
}

export async function render(root) {
  let s = await getSettings();

  async function draw() {
    const cfg = cloudConfig() || {};
    const rules = Object.fromEntries((s.void_rules || DEFAULT_VOID_RULES).map((r) => [r.reason, r]));
    const counts = {};
    for (const c of ['sales_lines', 'journal_entries', 'documents', 'payment_tx', 'payouts', 'bank_lines']) counts[c] = (await store.all(c)).length;
    const lockMins = autoLockMinutes();
    mount(
      root,
      h`<div class="stack">
      <form class="card" id="biz">
        <div class="card-head"><h2>店家、營業稅與申報</h2></div>
        <div class="form-grid">
          <label class="field"><span>店名（報表抬頭）</span><input type="text" name="business_name" value="${s.business_name}"></label>
          <label class="field"><span>統一編號（判斷進項發票可否扣抵）</span><input type="text" name="tax_id" value="${s.tax_id}" maxlength="8" inputmode="numeric"></label>
          <label class="field"><span>組織型態</span><select name="org_type">${options([['sole', '獨資／合夥（商號、行號）'], ['company', '公司']], s.org_type)}</select></label>
          <label class="field"><span>營業稅類型</span><select name="vat_mode">${options([['general', '一般稅額：開立統一發票（5% 內含）'], ['small', '小規模營業人：查定課徵 1%'], ['none', '免稅／不適用']], s.vat_mode)}</select></label>
          <label class="field"><span>寄杯／預購的發票</span><select name="prepaid_vat">${options([['sale', '收款時開立（依法規，預收即開發票）'], ['redeem', '兌換時才開立']], s.prepaid_vat || 'sale')}</select></label>
          <label class="field"><span>營收起算日</span><input type="date" name="revenue_start" value="${s.revenue_start}"></label>
          <label class="field"><span>申報：每期幾日開始準備</span><input type="number" name="filing_prep_day" min="1" max="14" value="${s.filing_prep_day ?? 10}"></label>
          <label class="field"><span>申報：目標幾日前完成</span><input type="number" name="filing_target_day" min="1" max="14" value="${s.filing_target_day ?? 12}"></label>
          <label class="field"><span>營業日切換時間（凌晨幾點前算前一天）</span><input type="number" name="cutoff_hour" min="0" max="6" value="${s.cutoff_hour}"></label>
          <label class="field"><span>主要銀行存款科目</span><input type="text" name="bank_gl" value="${s.bank_gl}"></label>
          <label class="field"><span>付款方式不明時暫列科目</span><input type="text" name="unknown_payment_account" value="${s.unknown_payment_account}"></label>
          <label class="field"><span>估計毛利率（行銷 ROI 用）</span><input type="number" name="gross_margin_est" step="0.05" min="0" max="1" value="${s.gross_margin_est}"></label>
        </div>
        <div class="row" style="margin-top:12px;gap:18px">
          <label class="check"><input type="checkbox" name="vat_confirmed" ${s.vat_confirmed ? raw('checked') : ''}> 已確認營業稅類型</label>
          <label class="check"><input type="checkbox" name="filing_self" ${s.filing_self ? raw('checked') : ''}> 自行申報</label>
          <label class="check"><input type="checkbox" name="has_employees" ${s.has_employees ? raw('checked') : ''}> 有聘僱員工</label>
          <label class="check"><input type="checkbox" name="pays_rent_to_individual" ${s.pays_rent_to_individual ? raw('checked') : ''}> 店租付給個人房東</label>
          <label class="check"><input type="checkbox" name="owns_property" ${s.owns_property ? raw('checked') : ''}> 有自有房地</label>
          <label class="check"><input type="checkbox" name="has_vehicle" ${s.has_vehicle ? raw('checked') : ''}> 有營業用車</label>
        </div>
        <p class="muted" style="font-size:12.5px;margin-top:8px">一般稅額：POS 含稅金額 ÷ 1.05 為收入、其餘列銷項稅額；寄杯收款時即開發票者，銷項稅額在售出當天認列，兌換時不再計稅（變更寄杯設定只會重算未結帳鎖定的月份）。申報行事曆會依「開始準備／目標完成日」提醒（法定期限前完成）。</p>
        <div class="row" style="margin-top:12px"><button class="btn primary" type="button" data-act="saveBiz">儲存設定</button></div>
      </form>

      <div class="card">
        <div class="card-head"><h2>安全性</h2>${status('good', store.mode === 'cloud' ? '雲端登入＋本機加密' : '本機資料已加密')}</div>
        <ul class="plain-list">
          <li>開啟系統需要<b>開啟密碼</b>；${store.mode === 'cloud' ? '雲端登入狀態' : '這台裝置上的帳務資料與憑證照片'}以 AES-256-GCM 加密，金鑰由開啟密碼經 PBKDF2（${KDF_ITERATIONS.toLocaleString()} 次）衍生，密碼本身不儲存。</li>
          <li>閒置超過設定時間自動上鎖；同時只能有一個分頁在使用（另開分頁時舊分頁會自動上鎖）。</li>
          <li>雲端模式：資料在你自己的 Supabase，只有白名單帳號能讀寫（資料列級權限 RLS），憑證照片存在私有空間，預覽連結 10 分鐘失效。</li>
          <li>網站程式碼公開、但不含任何營業資料或金鑰；資料不會出現在 GitHub。</li>
        </ul>
        <div class="form-grid" style="margin-top:10px">
          <label class="field"><span>閒置自動上鎖</span><select data-act="autolock">${options(AUTOLOCK_CHOICES.map((n) => [n, n >= 60 ? `${n / 60} 小時` : `${n} 分鐘`]), lockMins)}</select></label>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn" data-act="changePass">變更開啟密碼</button>
          <button class="btn" data-act="newRecovery">產生新的復原碼</button>
          <button class="btn" data-act="lockNow">立即上鎖</button>
        </div>
      </div>

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
        <div class="card-head"><h2>雲端資料庫（Supabase）</h2>${store.mode === 'cloud' ? status('good', '使用中') : status('na', '未啟用：資料只存在這台裝置')}</div>
        <p class="muted" style="font-size:13.5px">連線後資料存到你自己的 Supabase 專案，手機、店裡電腦都能登入同一份帳；憑證照片存到私有儲存空間，並可用 AI 自動辨識。建立專案與部署步驟請見說明文件的「雲端與 AI」。</p>
        <div class="form-grid">
          <label class="field"><span>Project URL</span><input type="url" name="sb_url" value="${cfg.url || ''}" placeholder="https://xxxx.supabase.co"></label>
          <label class="field" style="grid-column:span 2"><span>anon public key</span><input type="text" name="sb_key" value="${cfg.anonKey || ''}"></label>
        </div>
        <div class="row" style="margin-top:10px">
          <button class="btn primary" data-act="cloudOn">${store.mode === 'cloud' ? '更新連線' : '啟用雲端'}</button>
          ${store.mode === 'cloud' ? h`<button class="btn" data-act="push">把這台裝置的本機資料上傳到雲端</button><button class="btn" data-act="signOut">登出雲端帳號</button><button class="btn danger" data-act="cloudOff">改回本機模式</button>` : ''}
        </div>
        <p class="muted" style="font-size:12.5px;margin-top:8px">anon key 設計上可以放在網頁端；資料安全由資料庫的列級權限（RLS）保護，只有你加入白名單的帳號能讀寫。</p>
      </div>

      <div class="card">
        <div class="card-head"><h2>備份與還原</h2></div>
        <p class="muted" style="font-size:13.5px">目前資料：銷售明細 ${counts.sales_lines} 筆、分錄 ${counts.journal_entries} 張、憑證 ${counts.documents} 張、刷卡交易 ${counts.payment_tx} 筆、撥款 ${counts.payouts} 筆、存摺 ${counts.bank_lines} 筆。備份檔以<b>備份密碼</b>加密（.wyb），可以放在 OneDrive、隨身碟，別人拿到也打不開；${store.mode === 'local' ? '本機模式清除瀏覽器資料會一併刪除帳務，請定期下載備份。' : ''}</p>
        <div class="row">
          <label class="check"><input type="checkbox" id="bk-files" ${store.mode === 'local' ? raw('checked') : ''}> 包含憑證照片（檔案較大）</label>
        </div>
        <div class="row" style="margin-top:8px">
          <button class="btn primary" data-act="backup">下載加密備份</button>
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
      const day = (n, dflt) => Math.min(14, Math.max(1, Math.round(Number(g(n).value)) || dflt));
      const patch = {
        business_name: g('business_name').value.trim() || '午月咖啡廳',
        tax_id: taxId,
        org_type: g('org_type').value,
        vat_mode: g('vat_mode').value,
        prepaid_vat: g('prepaid_vat').value,
        revenue_start: g('revenue_start').value || '2026-08-21',
        filing_prep_day: day('filing_prep_day', 10),
        filing_target_day: day('filing_target_day', 12),
        cutoff_hour: Number(g('cutoff_hour').value) || 0,
        bank_gl: g('bank_gl').value.trim() || '1103',
        unknown_payment_account: g('unknown_payment_account').value.trim() || '1101',
        gross_margin_est: Number(g('gross_margin_est').value) || 0.7,
        vat_confirmed: g('vat_confirmed').checked,
        filing_self: g('filing_self').checked,
        has_employees: g('has_employees').checked,
        pays_rent_to_individual: g('pays_rent_to_individual').checked,
        owns_property: g('owns_property').checked,
        has_vehicle: g('has_vehicle').checked,
      };
      if (patch.filing_prep_day > patch.filing_target_day) patch.filing_prep_day = patch.filing_target_day;
      const needSync = patch.vat_mode !== s.vat_mode || patch.prepaid_vat !== (s.prepaid_vat || 'sale') || patch.revenue_start !== s.revenue_start || patch.bank_gl !== s.bank_gl || patch.unknown_payment_account !== s.unknown_payment_account;
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
    autolock: (el) => {
      setAutoLockMinutes(Number(el.value));
      toast(`閒置 ${el.selectedOptions[0].textContent}後自動上鎖`, 'good');
    },
    lockNow: () => lockNow('已上鎖。'),
    changePass: async () => {
      const r = await askNewPassword('變更開啟密碼', '只影響這台裝置。變更後，復原碼仍然有效。', { current: true });
      if (!r) return;
      setBusy(true, '更新中…');
      try {
        await store.local.changePasscode(r.current, r.password);
        toast('開啟密碼已變更', 'good');
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        setBusy(false);
      }
    },
    newRecovery: async () => {
      const p = await askPassword('產生新的復原碼', '請輸入目前的開啟密碼。產生後舊的復原碼立即失效。');
      if (!p) return;
      setBusy(true, '產生中…');
      try {
        const code = await store.local.newRecoveryCode(p);
        setBusy(false);
        await showRecoveryCode(code);
      } catch (e) {
        toast(e.message, 'error');
      } finally {
        setBusy(false);
      }
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
      if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url) || anonKey.length < 20) return toast('請填入 Supabase 的 Project URL（https://xxxx.supabase.co）與 anon key', 'error');
      saveCloudConfig({ url, anonKey, enabled: true });
      toast('已儲存，重新開啟後請登入雲端帳號', 'good');
      setTimeout(() => lockNow('已切換為雲端資料庫，請輸入開啟密碼後登入雲端帳號。'), 800);
    },
    cloudOff: async () => {
      if (!(await confirmBox('改回本機模式？雲端資料不會被刪除，之後可再啟用。'))) return;
      saveCloudConfig({ ...cloudConfig(), enabled: false });
      lockNow('已改回本機模式。');
    },
    signOut: async () => {
      await store.backend.signOut();
      lockNow('已登出雲端帳號。');
    },
    push: async () => {
      if (!(await confirmBox('把這台裝置的本機資料（含憑證照片）全部上傳到雲端（同 ID 會覆蓋）？'))) return;
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
      const withFiles = root.querySelector('#bk-files').checked;
      const r = await askNewPassword('設定備份密碼', '還原時需要這組密碼。可以和開啟密碼相同，方便記憶；忘記備份密碼就無法還原這個檔案。');
      if (!r) return;
      setBusy(true, '準備備份…');
      try {
        const json = await store.exportAll();
        const files = [];
        if (withFiles) {
          const docs = json.data.documents || [];
          for (let i = 0; i < docs.length; i++) {
            setBusy(true, `讀取憑證照片（${i + 1}/${docs.length}）…`);
            try {
              const blob = await store.readFile(docs[i]);
              if (blob) files.push({ id: docs[i].id, name: docs[i].original_name || '', type: blob.type, bytes: new Uint8Array(await blob.arrayBuffer()) });
            } catch (e) {
              console.warn(e);
            }
          }
        }
        setBusy(true, '加密中…');
        const bytes = await packBackup(json, files, r.password);
        const stamp = nowStamp();
        download(`午月ERP備份_${stamp}.wyb`, new Blob([bytes], { type: 'application/octet-stream' }));
        toast(`已下載加密備份${files.length ? `（含 ${files.length} 張憑證照片）` : ''}`, 'good');
      } finally {
        setBusy(false);
      }
    },
    restore: async () => {
      const [file] = await pickFiles({ accept: '.wyb,.json,application/json,application/octet-stream', multiple: false });
      if (!file) return;
      const bytes = new Uint8Array(await file.arrayBuffer());
      let password = '';
      if (isEncryptedBackup(bytes)) {
        password = await askPassword('輸入備份密碼', `還原「${file.name}」需要建立備份時設定的密碼。`);
        if (!password) return;
      }
      setBusy(true, '解密中…');
      let pack;
      try {
        pack = await unpackBackup(bytes, password);
      } catch (e) {
        setBusy(false);
        return toast(e.message, 'error', 6000);
      }
      setBusy(false);
      const exported = pack.json.exported_at ? new Date(pack.json.exported_at).toLocaleString('zh-TW') : '未知時間';
      if (!(await confirmBox(`還原 ${exported} 的備份？目前${store.mode === 'cloud' ? '雲端' : '這台裝置'}的資料會先清空再還原${pack.files.length ? `（含 ${pack.files.length} 張憑證照片）` : ''}。`, { ok: '覆蓋還原', danger: true }))) return;
      setBusy(true, '還原中…');
      try {
        if (store.mode === 'local' && pack.files.length) await store.local.clearFiles();
        await store.importAll(pack.json, { replace: true });
        const docs = new Map((pack.json.data.documents || []).map((d) => [d.id, d]));
        for (const f of pack.files) {
          const doc = docs.get(f.id);
          if (!doc) continue;
          const saved = await store.saveFile(f.id, new File([f.bytes], f.name || f.id, { type: f.type }), { folder: doc.status === 'posted' && doc.doc_date ? `archive/${doc.doc_date.slice(0, 4)}/${doc.doc_date.slice(5, 7)}` : 'inbox' });
          if (saved.storage_path !== (doc.storage_path || null)) await store.put('documents', { ...doc, ...saved });
        }
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
      if (!(await confirmBox(`清除${store.mode === 'cloud' ? '雲端' : '這台裝置'}全部資料（銷售、分錄、憑證、設定…）？此動作無法復原，請先下載備份。`, { ok: '全部清除', danger: true }))) return;
      if (!(await confirmBox('再次確認：真的要清除全部資料？', { ok: '確定清除', danger: true }))) return;
      setBusy(true, '清除中…');
      try {
        if (store.mode === 'cloud') for (const d of await store.all('documents')) await store.deleteFile(d);
        for (const c of COLLECTIONS) await store.clear(c);
        if (store.mode === 'local') await store.local.clearFiles();
      } finally {
        setBusy(false);
      }
      location.reload();
    },
  });
  await draw();
  return unbind;
}
