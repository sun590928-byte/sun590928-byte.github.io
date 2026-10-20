// 本機辨識（全部在瀏覽器裡執行，照片不送到任何外部 AI）：
// 1. 讀電子發票 QR 碼（ZXing）：發票號碼、日期、金額、買賣方統編、品項，完全精準
// 2. 文字辨識（Tesseract，繁中＋英數）：沒有 QR 碼的發票、收據，抓發票號碼、日期、金額、統編、店名
// 程式與語言資料都放在本站 vendor/，第一次使用時下載（約 10 MB），之後瀏覽器會快取。

const BASE = new URL('../vendor/', import.meta.url).href;
// 作品集預覽版（單一 HTML 檔）：QR 程式由建置時打包進來，不從 vendor/ 下載；沒有文字辨識
const DEMO = globalThis.__ERP_DEMO__;

let zxingP = null;
function zxing() {
  zxingP ||= (DEMO?.loadZxing ? DEMO.loadZxing() : import(BASE + 'zxing/reader.js')).then(async (m) => {
    if (DEMO?.loadZxing) return m;
    await m.prepareZXingModule({ overrides: { locateFile: (path, prefix) => (path.endsWith('.wasm') ? BASE + 'zxing/' + path : prefix + path) }, fireImmediately: true });
    return m;
  });
  return zxingP.catch((e) => {
    zxingP = null;
    throw e;
  });
}

let ocrP = null;
let ocrIdle = null;
function ocrWorker() {
  if (DEMO) return Promise.reject(new Error('預覽版沒有內建文字辨識（正式版會在瀏覽器裡辨識）'));
  ocrP ||= import(BASE + 'tesseract/tesseract.esm.min.js').then(({ default: T }) =>
    T.createWorker(['chi_tra', 'eng'], 1, {
      workerPath: BASE + 'tesseract/worker.min.js',
      corePath: BASE + 'tesseract/',
      langPath: BASE + 'tessdata',
      gzip: true,
      workerBlobURL: false,
    }),
  );
  clearTimeout(ocrIdle);
  return ocrP.catch((e) => {
    ocrP = null;
    throw e;
  });
}

/** 辨識完一批後釋放文字辨識的記憶體（約 100 MB） */
export function releaseOcr(afterMs = 60000) {
  clearTimeout(ocrIdle);
  ocrIdle = setTimeout(async () => {
    const p = ocrP;
    ocrP = null;
    if (p) (await p.catch(() => null))?.terminate();
  }, afterMs);
}

export const canRecognize = (doc) => /^image\/(jpeg|png|webp|gif|bmp)$/i.test(doc.mime || '') || /\.(jpe?g|png|webp|bmp)$/i.test(doc.original_name || '');

// 照片 → 畫布（套用 EXIF 方向、長邊縮到 maxSide、可旋轉 0/90/180/270 度、可裁切）
async function toCanvas(src, { maxSide = 2400, deg = 0, crop = null, gray = false } = {}) {
  const bmp = src instanceof ImageBitmap ? src : await createImageBitmap(src);
  const sx = crop ? crop.x : 0;
  const sy = crop ? crop.y : 0;
  const sw = crop ? crop.w : bmp.width;
  const sh = crop ? crop.h : bmp.height;
  const s = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * s);
  const h = Math.round(sh * s);
  const rot = deg % 180 !== 0;
  const c = document.createElement('canvas');
  c.width = rot ? h : w;
  c.height = rot ? w : h;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (gray) g.filter = 'grayscale(1) contrast(1.25)';
  g.translate(c.width / 2, c.height / 2);
  g.rotate((deg * Math.PI) / 180);
  g.drawImage(bmp, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  return c;
}

const imageData = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);

const QR_OPTS = { formats: ['QRCode'], tryHarder: true, tryDownscale: true, maxNumberOfSymbols: 12 };

function collect(results, dx = 0, dy = 0, scale = 1) {
  return results
    .filter((r) => r.isValid !== false && r.bytes?.length)
    .map((r) => {
      const p = r.position;
      return {
        bytes: r.bytes,
        x: ((p.topLeft.x + p.bottomRight.x) / 2) * scale + dx,
        y: ((p.topLeft.y + p.bottomRight.y) / 2) * scale + dy,
        // QR 上緣的方向：0 度＝正放；用來決定文字辨識要把照片轉幾度
        angle: (Math.atan2(p.topRight.y - p.topLeft.y, p.topRight.x - p.topLeft.x) * 180) / Math.PI,
      };
    });
}

/** 讀照片上所有 QR 碼（整張讀不到時再分四塊放大讀） */
export async function scanQR(bmp) {
  const z = await zxing();
  const full = await toCanvas(bmp, { maxSide: 2400 });
  let codes = collect(await z.readBarcodes(imageData(full), QR_OPTS));
  if (!codes.length && Math.max(bmp.width, bmp.height) > 1400) {
    const tw = Math.round(bmp.width * 0.6);
    const th = Math.round(bmp.height * 0.6);
    for (const [fx, fy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const crop = { x: Math.round((bmp.width - tw) * fx), y: Math.round((bmp.height - th) * fy), w: tw, h: th };
      const c = await toCanvas(bmp, { maxSide: 2000, crop });
      const scale = tw / c.width;
      codes.push(...collect(await z.readBarcodes(imageData(c), QR_OPTS), crop.x, crop.y, scale));
    }
    const seen = new Set();
    codes = codes.filter((c) => {
      const k = Array.from(c.bytes.subarray(0, 40)).join(',');
      return seen.has(k) ? false : seen.add(k);
    });
  }
  return codes;
}

/** 文字辨識；deg 未知時先試正放，信心不足再試左右轉 */
export async function readText(bmp, { deg = null, onStep } = {}) {
  const w = await ocrWorker();
  const tries = [];
  const order = deg !== null ? [deg] : [0, 90, 270];
  for (const d of order) {
    onStep?.(`文字辨識${d ? `（轉 ${d}°）` : ''}`);
    const c = await toCanvas(bmp, { maxSide: 2000, deg: d, gray: true });
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const { data } = await w.recognize(blob);
    tries.push({ deg: d, text: data.text || '', confidence: data.confidence || 0 });
    if (data.confidence >= 60) break;
  }
  tries.sort((a, b) => b.confidence - a.confidence);
  return tries[0];
}

/**
 * 辨識一張憑證照片。
 * @param blob 照片
 * @param opts { ocr: 'auto'（needOcr(codes) 為真時才做）| 'always' | 'never', needOcr, onStep }
 * @returns {{ codes, text, confidence, deg, ms, error? }}
 */
export async function recognizeImage(blob, { ocr = 'auto', needOcr = (codes) => !codes.length, onStep } = {}) {
  const t0 = performance.now();
  let bmp;
  try {
    bmp = await createImageBitmap(blob);
  } catch {
    return { codes: [], text: '', confidence: 0, deg: 0, ms: 0, error: '瀏覽器無法開啟這個檔案（HEIC 請先轉成 JPEG）' };
  }
  try {
    onStep?.('讀 QR 碼');
    let codes = [];
    try {
      codes = await scanQR(bmp);
    } catch (e) {
      console.warn('QR', e);
    }
    const lefts = codes.filter((c) => c.bytes.length >= 77 && /^[A-Z]{2}\d{8}/.test(String.fromCharCode(...c.bytes.subarray(0, 10))));
    let text = '';
    let confidence = 0;
    let deg = 0;
    const want = ocr === 'always' || (ocr === 'auto' && needOcr(codes));
    if (want) {
      // 有 QR 時用 QR 的方向把照片轉正，省掉試轉
      const a = lefts[0]?.angle;
      const known = a === undefined ? null : ((Math.round(-a / 90) * 90) % 360 + 360) % 360;
      try {
        const r = await readText(bmp, { deg: known, onStep });
        [text, confidence, deg] = [r.text, r.confidence, r.deg];
      } catch (e) {
        console.warn('OCR', e);
      }
    }
    return { codes, text, confidence, deg, ms: Math.round(performance.now() - t0) };
  } finally {
    bmp.close?.();
  }
}
