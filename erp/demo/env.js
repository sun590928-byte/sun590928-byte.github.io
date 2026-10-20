// 預覽版環境：一定要在任何 ERP 模組之前載入（entry.js 第一個 import）。
// ・資料放記憶體（MemoryBackend）並載入示範資料；憑證照片第一次顯示時才用 canvas 畫
// ・localStorage／sessionStorage 換成記憶體版，不留下任何東西
// ・所有網路請求一律擋下（blob:、data: 除外）；HTML 另有 CSP 再擋一次
// ・雲端、連接器、密碼、備份等正式版功能按下去只顯示說明

import { MemoryBackend } from './memory.js';
import { buildSeed } from './seed.js';
import { drawInvoice, drawReceipt, toBlob } from './images.js';
import { toast } from '../js/ui.js';
import zxingWasm from '../vendor/zxing/zxing_reader.wasm';

// ── 記憶體版 Web Storage
class MemoryStorage {
  #m = new Map();
  get length() {
    return this.#m.size;
  }
  key(i) {
    return [...this.#m.keys()][i] ?? null;
  }
  getItem(k) {
    return this.#m.has(String(k)) ? this.#m.get(String(k)) : null;
  }
  setItem(k, v) {
    this.#m.set(String(k), String(v));
  }
  removeItem(k) {
    this.#m.delete(String(k));
  }
  clear() {
    this.#m.clear();
  }
}
for (const name of ['localStorage', 'sessionStorage']) {
  try {
    Object.defineProperty(window, name, { value: new MemoryStorage(), configurable: true });
  } catch (e) {
    console.warn('無法替換', name, e);
  }
}
localStorage.setItem('wuyue-erp:autolock', '240'); // 預覽版不自動上鎖（最長選項，且上鎖也只會還原示範）

// ── 分頁互斥用的 BroadcastChannel：預覽版每個分頁各自獨立
window.BroadcastChannel = class {
  postMessage() {}
  addEventListener() {}
  removeEventListener() {}
  close() {}
};

// ── 網路：全部擋下
const allowed = (url) => /^(blob:|data:)/.test(String(url?.url ?? url));
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => (allowed(input) ? realFetch(input, init) : Promise.reject(new TypeError('預覽版不連網路：' + String(input?.url ?? input).slice(0, 80))));
if (navigator.sendBeacon) navigator.sendBeacon = () => false;

// ── 示範資料
const backend = new MemoryBackend();
const seed = buildSeed();
for (const [coll, rows] of Object.entries(seed.collections)) backend.seed(coll, rows);

async function renderSpec(spec) {
  let canvas;
  if (spec.kind === 'invoice') canvas = drawInvoice(spec, { tilt: spec.tilt ?? 1.2 });
  else if (spec.kind === 'pair') {
    // 一張照片兩張發票：左右並排
    const a = drawInvoice(spec.invoices[0], { tilt: -1 });
    const b = drawInvoice(spec.invoices[1], { tilt: 1.5 });
    canvas = document.createElement('canvas');
    canvas.width = a.width + b.width - 60;
    canvas.height = Math.max(a.height, b.height);
    const g = canvas.getContext('2d');
    g.fillStyle = '#b9b2a6';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(a, 0, 0);
    g.drawImage(b, a.width - 60, canvas.height - b.height);
  } else canvas = drawReceipt(spec, { tilt: spec.tilt ?? -1.6 });
  return { name: 'photo.jpg', type: 'image/jpeg', blob: await toBlob(canvas, 'image/jpeg', 0.92) };
}
for (const [id, spec] of seed.images) backend.makers.set(id, () => renderSpec(spec));

// QR 讀取程式（ZXing）：wasm 已打包在這個檔案裡，不需下載
async function loadZxing() {
  const m = await import('../vendor/zxing/reader.js');
  await m.prepareZXingModule({ overrides: { wasmBinary: zxingWasm.buffer.slice(zxingWasm.byteOffset, zxingWasm.byteOffset + zxingWasm.byteLength), locateFile: (p) => p }, fireImmediately: true });
  return m;
}

globalThis.__ERP_DEMO__ = { createBackend: () => backend, loadZxing, range: seed.range };

// ── 正式版才有的功能：按下去只說明
const NOT_IN_DEMO = {
  cloudOn: '雲端同步（Supabase）',
  push: '上傳到雲端',
  signOut: '雲端登出',
  cloudOff: '雲端模式',
  mcpGen: 'Claude 連接器',
  mcpTest: 'Claude 連接器',
  mcpCopy: 'Claude 連接器',
  mcpRotate: 'Claude 連接器',
  changePass: '開啟密碼',
  newRecovery: '復原碼',
  lockNow: '上鎖',
  backup: '加密備份',
  restore: '還原備份',
  wipe: '清除資料',
  aiAll: '雲端 AI 辨識',
  ai: '雲端 AI 辨識',
  claude: 'Claude 覆核',
};
document.addEventListener(
  'click',
  (e) => {
    const el = e.target.closest?.('[data-act], #lock-btn');
    if (!el) return;
    const name = el.id === 'lock-btn' ? 'lockNow' : el.dataset.act;
    if (!NOT_IN_DEMO[name]) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    toast(`預覽版沒有「${NOT_IN_DEMO[name]}」：正式版才會使用。預覽版的資料只在這個分頁，重新整理就回到示範資料。`, 'info', 6000);
  },
  true,
);

// ── 畫面：預覽版標示、資料位置說明、導覽卡
const TOUR = [
  ['dashboard', '營運儀表板', '營收、毛利、待辦一眼看完'],
  ['documents', '憑證歸檔', '按「本機辨識」：在瀏覽器讀發票 QR 碼、自動覆核，有疑點的標「需確認」'],
  ['vat', '營業稅 401', '進銷項自動彙總、可扣抵判斷、申報代號'],
  ['payments', '金流對帳', 'POS 刷卡 ↔ 綠界交易 ↔ 撥款 ↔ 存摺'],
  ['income', '綜合損益表', '複式簿記自動產生的正式報表'],
  ['inventory', '原物料進銷存', '依配方從銷售推算耗用與安全庫存'],
];

function tourCard() {
  const box = document.createElement('aside');
  box.className = 'demo-tour no-print';
  box.setAttribute('aria-label', '預覽版說明');
  box.innerHTML = `<div class="demo-tour-head"><b>作品集預覽版</b><button type="button" class="icon-btn" data-demo-close aria-label="收起說明">✕</button></div>
    <p>午月咖啡廳的營運與帳務系統。資料全部虛構（日期跟著今天走），不連網路、不存檔，<b>重新整理就還原</b>，可以放心操作。</p>
    <ol>${TOUR.map(([p, t, d]) => `<li><a href="#/${p}">${t}</a><span>${d}</span></li>`).join('')}</ol>`;
  box.querySelector('[data-demo-close]').addEventListener('click', () => {
    box.hidden = true;
    chip.hidden = false;
  });
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'demo-chip no-print';
  chip.textContent = '預覽版說明';
  chip.hidden = true;
  chip.addEventListener('click', () => {
    box.hidden = false;
    chip.hidden = true;
  });
  document.body.append(box, chip);
}

export function decorate() {
  const sub = document.querySelector('.brand-sub');
  if (sub) sub.innerHTML = '營運・帳務系統 <span class="demo-badge">預覽版</span>';
  // 左下角的資料位置：改成預覽版的說明
  const pill = document.querySelector('#mode-pill');
  const fix = () => {
    if (pill && !pill.textContent.includes('預覽版')) pill.innerHTML = '資料位置：<b>預覽版（記憶體）</b><br>虛構資料・不連網路<br>重新整理即還原';
  };
  if (pill) new MutationObserver(fix).observe(pill, { childList: true });
  fix();
  tourCard();
  document.querySelector('#demo-loading')?.remove();
}
