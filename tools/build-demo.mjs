// 作品集預覽版：把整個 ERP（含 QR 碼辨識）打包成一個 HTML 檔，雙擊就能在任何電腦打開。
// 資料全部虛構、只在記憶體；不連網路（程式擋＋CSP 再擋）；不含任何金鑰或店家真實資料。
//
// 執行：npm i -g esbuild（一次）→ NODE_PATH=$(npm root -g) node tools/build-demo.mjs
// 產出：dist-demo/午月ERP預覽版.html（完整網頁）、dist-demo/artifact.html（沒有 html/head/body 外殼，發佈 Artifact 用）

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'dist-demo');
const p = (...x) => join(ROOT, ...x);

const res = await build({
  entryPoints: [p('erp/demo/entry.js')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  write: false,
  charset: 'utf8',
  legalComments: 'inline',
  loader: { '.wasm': 'binary' },
  logLevel: 'warning',
  logOverride: { 'unsupported-dynamic-import': 'silent' }, // vision.js 正式版從 vendor/ 動態載入 ZXing，預覽版不會走到
});
let js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

const css = (await readFile(p('erp/app.css'), 'utf8')) + '\n' + (await readFile(p('erp/demo/demo.css'), 'utf8'));
const theme = await readFile(p('erp/js/theme.js'), 'utf8');
let html = await readFile(p('erp/index.html'), 'utf8');

// 網路一律不准（只有頁面自己產生的 blob:、data:）
const CSP = "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; connect-src data: blob:; font-src data:; frame-src blob:; worker-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'";
const swap = (from, to) => {
  if (!html.includes(from)) throw new Error('index.html 找不到：' + from.slice(0, 60));
  html = html.replace(from, () => to);
};
html = html.replace(/<meta http-equiv="Content-Security-Policy" content="[^"]*">/, `<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
swap('<title>午月營運帳務</title>', '<title>午月營運帳務｜作品集預覽版</title>');
swap('<link rel="stylesheet" href="app.css">', `<style>\n${css}\n</style>`);
swap('<script src="js/theme.js"></script>', `<script>\n${theme}\n</script>`);
swap('<div class="gate" id="gate" aria-live="polite"></div>', '<div id="demo-loading">正在準備示範資料…</div>\n<div class="gate" id="gate" aria-live="polite"></div>');
swap('<script type="module" src="js/main.js"></script>', `<script type="module">\n${js}\n</script>`);

// Artifact 版：只要 head 裡的 meta／title／style 與 body 內容（外殼由發佈端提供；CSP 也由發佈端負責）
const head = /<head>([\s\S]*?)<\/head>/.exec(html)[1].replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n?/, '').replace(/<meta charset="utf-8">\n?|<meta name="viewport"[^>]*>\n?/g, '');
const body = /<body>([\s\S]*?)<\/body>/.exec(html)[1];
const artifact = `${head.trim()}\n${body.trim()}\n`;

// ── 安全掃描：不能出現正式環境的金鑰、專案代號、店家真實資料
const env = await readFile(p('.env'), 'utf8').catch(() => '');
const forbidden = [
  /sb_secret_[A-Za-z0-9_-]+/,
  /sbp_[A-Za-z0-9]{20,}/,
  /eyJhbGciOi[A-Za-z0-9_-]{20,}/, // JWT（anon／service key）
  /https:\/\/[a-z0-9]{20}\.supabase\.co/,
  /iewzkrwpbzjseupcrema/,
  /61246142/, // 店家真實統編
  /五口晤月/,
  /李鳳雪|陳其佳/,
  ...env
    .split(/\r?\n/)
    .map((l) => l.split('=').slice(1).join('=').trim())
    .filter((v) => v.length >= 8)
    .map((v) => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
];
const hits = forbidden.filter((re) => re.test(html));
if (hits.length) {
  await rm(OUT, { recursive: true, force: true });
  throw new Error('預覽版含有不該出現的內容，已刪除產出：' + hits.map(String).join('、'));
}

await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, '午月ERP預覽版.html'), html);
await writeFile(join(OUT, 'artifact.html'), artifact);
console.log(`完成：dist-demo/午月ERP預覽版.html（${(Buffer.byteLength(html) / 1024 / 1024).toFixed(2)} MB）、artifact.html；安全掃描通過`);
