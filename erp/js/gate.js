// 開啟畫面：第一次設定開啟密碼（本機加密／雲端同步）、解鎖、復原碼重設、雲端登入。
// 解鎖前不讀取任何帳務資料；閒置自動上鎖、同時只允許一個分頁使用。

import { h, raw, mount, toast, download, confirmBox } from './ui.js';
import { store, cloudConfig, saveCloudConfig } from './store.js';
import { passcodeProblems, WrongPasscodeError, MIN_PASSCODE } from './lib/vault.js';
import { today } from './lib/dates.js';

const LOCK_MSG = 'wuyue-erp:lockmsg';
const AUTOLOCK_KEY = 'wuyue-erp:autolock';
export const AUTOLOCK_CHOICES = [5, 15, 30, 60, 120, 240];

export function autoLockMinutes() {
  try {
    const n = Number(localStorage.getItem(AUTOLOCK_KEY));
    return AUTOLOCK_CHOICES.includes(n) ? n : 30;
  } catch {
    return 30;
  }
}

export function setAutoLockMinutes(n) {
  try {
    localStorage.setItem(AUTOLOCK_KEY, String(n));
  } catch {}
}

function takeLockMessage() {
  try {
    const m = sessionStorage.getItem(LOCK_MSG);
    sessionStorage.removeItem(LOCK_MSG);
    return m || '';
  } catch {
    return '';
  }
}

// 上鎖：等候寫入完成、清除記憶體中的金鑰與資料，重新載入回到開啟畫面
export async function lockNow(reason = '') {
  try {
    if (reason) sessionStorage.setItem(LOCK_MSG, reason);
  } catch {}
  try {
    await store.lock();
  } finally {
    location.reload();
  }
}

// ─────────── 閒置上鎖與分頁互斥

const TAB = Math.random().toString(36).slice(2);
let channel = null;
let watching = false;

export function startGuards() {
  if (watching) return;
  watching = true;
  let last = Date.now();
  const bump = () => (last = Date.now());
  for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) addEventListener(ev, bump, { passive: true, capture: true });
  const check = () => {
    const mins = autoLockMinutes();
    if (Date.now() - last > mins * 60000) lockNow(`閒置超過 ${mins} 分鐘，已自動上鎖。`);
  };
  setInterval(check, 15000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && check());
  if ('BroadcastChannel' in window) {
    channel = new BroadcastChannel('wuyue-erp');
    channel.onmessage = (e) => {
      if (e.data?.type === 'active' && e.data.tab !== TAB && store.gate === 'ready') lockNow('系統已在另一個分頁開啟，這個分頁已自動上鎖（避免兩邊同時修改資料）。');
    };
    channel.postMessage({ type: 'active', tab: TAB });
  }
  store.local.onFatal = (msg) => {
    toast(msg, 'error', 8000);
    setTimeout(() => lockNow(msg), 1200);
  };
}

// ─────────── 畫面

const brand = h`<div class="gate-brand"><svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="14" fill="var(--brand-ink)"/><circle cx="32" cy="38" r="14" fill="var(--terra)"/><rect x="10" y="38" width="44" height="16" fill="var(--brand-ink)"/><path d="M12 40h40" stroke="#F4ECDD" stroke-width="2"/></svg><div><div class="gate-name">午月</div><div class="gate-sub">營運・帳務系統</div></div></div>`;

function shell(root, body) {
  document.body.classList.add('gated');
  mount(root, h`<div class="gate-card">${brand}${body}</div>`);
  [...root.querySelectorAll('input:not([type=radio]):not([type=checkbox])')].find((i) => i.offsetParent !== null)?.focus();
}

// 復原碼分組顯示（換行只發生在分組之間）
export const codeHtml = (code) => raw(String(code).split('-').map((g) => String(h`<span>${g}</span>`)).join('-<wbr>'));

function busy(btn, on, text) {
  if (!btn) return;
  if (on) {
    btn.dataset.label = btn.textContent;
    btn.textContent = text;
  } else if (btn.dataset.label) btn.textContent = btn.dataset.label;
  btn.disabled = on;
}

function locationLabel() {
  const cfg = cloudConfig();
  return cfg?.enabled ? '雲端資料庫（Supabase），登入狀態加密保存在這台裝置' : '這台裝置的瀏覽器（已加密）';
}

/**
 * 顯示開啟畫面，直到可以進入系統。
 * @param root  畫面容器
 * @param onReady 進入系統（解鎖且雲端已登入）
 */
export async function showGate(root, onReady) {
  const next = async () => {
    if (!store.local.unlocked) return;
    try {
      await store.connect();
    } catch (e) {
      return renderError(e);
    }
    if (store.needsLogin()) return renderLogin();
    document.body.classList.remove('gated');
    onReady();
  };

  function renderSetup(msg = '') {
    const cfg = cloudConfig() || {};
    const cloud = !!cfg.enabled;
    shell(
      root,
      h`<h1>設定開啟密碼</h1>
      <p class="muted">帳務資料會用這組密碼加密後才存進這台裝置，別人拿到電腦或手機也打不開。密碼不會上傳、也不會被儲存；忘記時可以用接下來顯示的<b>復原碼</b>重設。</p>
      ${msg ? h`<div class="callout warn"><p>${msg}</p></div>` : ''}
      <form id="g-setup" class="stack" autocomplete="off">
        <fieldset class="gate-choice"><legend>資料存放位置</legend>
          <label class="check"><input type="radio" name="where" value="local" ${cloud ? '' : raw('checked')}> <span><b>這台裝置</b>：加密存在瀏覽器，不上傳任何地方</span></label>
          <label class="check"><input type="radio" name="where" value="cloud" ${cloud ? raw('checked') : ''}> <span><b>雲端同步（Supabase）</b>：店裡電腦、手機都能用同一份帳，發票可用 AI 辨識</span></label>
        </fieldset>
        <div id="g-cloud" class="stack" ${cloud ? '' : raw('hidden')}>
          <label class="field"><span>Supabase Project URL</span><input type="url" name="url" value="${cfg.url || ''}" placeholder="https://xxxx.supabase.co"></label>
          <label class="field"><span>anon public key</span><input type="text" name="key" value="${cfg.anonKey || ''}" spellcheck="false"></label>
          <p class="muted" style="font-size:12.5px;margin:0">建立專案的步驟見說明文件「雲端與 AI」。之後也可以在「設定與備份」再連線。</p>
        </div>
        <label class="field"><span>開啟密碼（至少 ${MIN_PASSCODE} 個字，可用中文）</span><input type="password" name="p1" autocomplete="off" required></label>
        <label class="field"><span>再輸入一次</span><input type="password" name="p2" autocomplete="off" required></label>
        <div class="gate-hint muted" id="g-hint" aria-live="polite"></div>
        <button class="btn primary" type="submit">建立並進入</button>
      </form>`,
    );
    const form = root.querySelector('#g-setup');
    form.addEventListener('change', (e) => {
      if (e.target.name === 'where') form.querySelector('#g-cloud').hidden = e.target.value !== 'cloud';
    });
    form.addEventListener('input', () => {
      const p = passcodeProblems(form.p1.value);
      form.querySelector('#g-hint').textContent = form.p1.value ? (p.length ? '密碼：' + p.join('、') : '密碼強度可以 ✓') : '';
    });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const where = form.where.value;
      const probs = passcodeProblems(form.p1.value);
      if (probs.length) return toast('開啟密碼' + probs.join('、'), 'error');
      if (form.p1.value !== form.p2.value) return toast('兩次輸入的密碼不一樣', 'error');
      let cloudCfg = null;
      if (where === 'cloud') {
        const url = form.url.value.trim().replace(/\/$/, '');
        const anonKey = form.key.value.trim();
        if (!/^https:\/\/[\w.-]+$/.test(url) || anonKey.length < 20) return toast('請填入正確的 Supabase Project URL 與 anon key', 'error');
        cloudCfg = { url, anonKey, enabled: true };
      }
      const btn = form.querySelector('[type=submit]');
      busy(btn, true, '建立中…');
      try {
        const code = await store.setup(form.p1.value);
        saveCloudConfig(cloudCfg || (cloudConfig() ? { ...cloudConfig(), enabled: false } : null));
        renderRecovery(code, '這是這台裝置的復原碼');
      } catch (err) {
        busy(btn, false);
        toast(err.message, 'error', 6000);
      }
    });
  }

  function renderRecovery(code, title) {
    shell(
      root,
      h`<h1>請保存復原碼</h1>
      <p class="muted">${title}。忘記開啟密碼時，只能用它重設；請下載保存或抄在紙上，放在安全的地方（不要和電腦放在一起，也不要拍照上傳）。</p>
      <div class="recovery-code" id="g-code">${codeHtml(code)}</div>
      <div class="row"><button class="btn" type="button" id="g-dl">下載復原碼</button><button class="btn ghost" type="button" id="g-copy">複製</button></div>
      <label class="check"><input type="checkbox" id="g-ok"> 我已妥善保存復原碼</label>
      <button class="btn primary" type="button" id="g-next" disabled>進入系統</button>`,
    );
    root.querySelector('#g-dl').addEventListener('click', () => {
      const d = today();
      download(`午月ERP復原碼_${d}.txt`, `午月營運帳務系統 復原碼\r\n\r\n${code}\r\n\r\n建立日期：${d}\r\n用途：忘記這台裝置的開啟密碼時，在開啟畫面按「忘記密碼？」輸入此碼重設。\r\n請妥善保管，勿與電腦放在一起。\r\n`);
    });
    root.querySelector('#g-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code);
        toast('已複製', 'good');
      } catch {
        toast('無法複製，請手動抄寫', 'error');
      }
    });
    root.querySelector('#g-ok').addEventListener('change', (e) => (root.querySelector('#g-next').disabled = !e.target.checked));
    root.querySelector('#g-next').addEventListener('click', next);
  }

  function renderUnlock(msg = '') {
    shell(
      root,
      h`<h1>請輸入開啟密碼</h1>
      ${msg ? h`<div class="callout"><p>${msg}</p></div>` : ''}
      <form id="g-unlock" class="stack" autocomplete="off">
        <label class="field"><span>開啟密碼</span><input type="password" name="p" autocomplete="off" required></label>
        <button class="btn primary" type="submit">解鎖</button>
      </form>
      <div class="row gate-foot"><span class="muted">資料位置：${locationLabel()}</span><span class="spacer"></span><a href="#" id="g-forgot">忘記密碼？</a></div>`,
    );
    const form = root.querySelector('#g-unlock');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      busy(btn, true, '解鎖中…');
      try {
        await store.unlock(form.p.value);
        await next();
      } catch (err) {
        busy(btn, false);
        form.p.value = '';
        form.p.focus();
        toast(err instanceof WrongPasscodeError ? '密碼錯誤，請再試一次' : err.message, 'error');
      }
    });
    root.querySelector('#g-forgot').addEventListener('click', (e) => {
      e.preventDefault();
      renderRecover();
    });
  }

  function renderRecover() {
    shell(
      root,
      h`<h1>用復原碼重設密碼</h1>
      <p class="muted">輸入設定時保存的 25 碼復原碼，再設定新的開啟密碼。完成後會產生一組新的復原碼。</p>
      <form id="g-rec" class="stack" autocomplete="off">
        <label class="field"><span>復原碼</span><input type="text" name="code" placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX" spellcheck="false" autocapitalize="characters" required></label>
        <label class="field"><span>新的開啟密碼（至少 ${MIN_PASSCODE} 個字）</span><input type="password" name="p1" autocomplete="off" required></label>
        <label class="field"><span>再輸入一次</span><input type="password" name="p2" autocomplete="off" required></label>
        <button class="btn primary" type="submit">重設並解鎖</button>
      </form>
      <div class="row gate-foot"><a href="#" id="g-back">← 回到輸入密碼</a><span class="spacer"></span><a href="#" id="g-wipe" class="danger-link">復原碼也遺失了…</a></div>`,
    );
    const form = root.querySelector('#g-rec');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const probs = passcodeProblems(form.p1.value);
      if (probs.length) return toast('新密碼' + probs.join('、'), 'error');
      if (form.p1.value !== form.p2.value) return toast('兩次輸入的密碼不一樣', 'error');
      const btn = form.querySelector('[type=submit]');
      busy(btn, true, '驗證中…');
      try {
        const code = await store.recover(form.code.value, form.p1.value);
        renderRecovery(code, '密碼已重設，舊的復原碼已失效，這是新的復原碼');
      } catch (err) {
        busy(btn, false);
        toast(err.message, 'error');
      }
    });
    root.querySelector('#g-back').addEventListener('click', (e) => {
      e.preventDefault();
      renderUnlock();
    });
    root.querySelector('#g-wipe').addEventListener('click', async (e) => {
      e.preventDefault();
      const cloud = cloudConfig()?.enabled;
      const msg = cloud
        ? '清除這台裝置的保管箱與登入狀態？雲端資料庫裡的帳務資料不受影響，清除後重新設定開啟密碼並登入即可。'
        : '沒有密碼也沒有復原碼時，加密的資料無法解開。清除後，這台裝置上的帳務資料會全部刪除，只能從「加密備份檔」還原。確定要清除？';
      if (!(await confirmBox(msg, { ok: '清除這台裝置的資料', danger: true }))) return;
      if (!cloud && !(await confirmBox('再次確認：刪除這台裝置上全部的帳務資料？', { ok: '確定刪除', danger: true }))) return;
      await store.local.destroy();
      location.reload();
    });
  }

  function renderLogin(msg = '') {
    const cfg = cloudConfig() || {};
    shell(
      root,
      h`<h1>登入雲端資料庫</h1>
      <p class="muted">以管理者在 Supabase 建立、並加入白名單的帳號登入。登入後這台裝置會保持登入（加密保存），之後只要輸入開啟密碼。</p>
      ${msg ? h`<div class="callout warn"><p>${msg}</p></div>` : ''}
      <form id="g-login" class="stack">
        <label class="field"><span>Email</span><input type="email" name="email" autocomplete="username" required></label>
        <label class="field"><span>雲端帳號密碼</span><input type="password" name="password" autocomplete="current-password" required></label>
        <button class="btn primary" type="submit">登入</button>
      </form>
      <div class="row gate-foot"><span class="muted">${cfg.url || ''}</span><span class="spacer"></span><a href="#" id="g-local">改用本機資料</a></div>`,
    );
    const form = root.querySelector('#g-login');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('[type=submit]');
      busy(btn, true, '登入中…');
      try {
        await store.backend.signIn(form.email.value.trim(), form.password.value);
        store.reload();
        await next();
      } catch (err) {
        busy(btn, false);
        toast('登入失敗：' + err.message, 'error', 6000);
      }
    });
    root.querySelector('#g-local').addEventListener('click', async (e) => {
      e.preventDefault();
      saveCloudConfig({ ...cloudConfig(), enabled: false });
      await next();
    });
  }

  function renderError(err) {
    shell(
      root,
      h`<h1>無法連線雲端資料庫</h1>
      <div class="callout bad"><p>${err?.message || err}</p></div>
      <p class="muted">請確認網路與 Supabase 設定。帳務資料在雲端，不會因為這次連線失敗而遺失。</p>
      <div class="row"><button class="btn primary" type="button" id="g-retry">重試</button><button class="btn" type="button" id="g-local">改用本機資料</button></div>`,
    );
    root.querySelector('#g-retry').addEventListener('click', next);
    root.querySelector('#g-local').addEventListener('click', async () => {
      saveCloudConfig({ ...cloudConfig(), enabled: false });
      await next();
    });
  }

  const gate = store.gate;
  if (gate === 'setup') renderSetup();
  else if (gate === 'locked') renderUnlock(takeLockMessage());
  else await next();
}
