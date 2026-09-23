// 輕量 .xlsx 讀取器（零相依）：解 ZIP → 讀 workbook / sharedStrings / styles / sheet XML。
// 只讀取「值」，公式取快取結果；日期格式儲存格轉成 YYYY-MM-DD[ HH:MM]。

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 ZIP 目錄）');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const files = new Map();
  const dec = new TextDecoder();
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    files.set(name, { method, csize, local });
    p += 46 + nlen + elen + clen;
  }
  return {
    names: [...files.keys()],
    async read(name) {
      const f = files.get(name);
      if (!f) return null;
      const lnl = dv.getUint16(f.local + 26, true);
      const lel = dv.getUint16(f.local + 28, true);
      const start = f.local + 30 + lnl + lel;
      const data = u8.subarray(start, start + f.csize);
      const raw = f.method === 0 ? data : await inflateRaw(data);
      return dec.decode(raw);
    },
  };
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function xmlText(s) {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENT[e] ?? m;
    })
    .replace(/_x([0-9A-F]{4})_/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripNs(xml) {
  return xml.replace(/<(\/?)[A-Za-z0-9]+:/g, '<$1');
}

function attrs(s) {
  const o = {};
  for (const m of s.matchAll(/([\w:]+)="([^"]*)"/g)) o[m[1]] = m[2];
  return o;
}

function textRuns(xml) {
  // 串接 <t>，略過注音/假名 <rPh>
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  for (const m of clean.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g)) out += m[1] ? xmlText(m[1]) : '';
  return out;
}

const BUILTIN_DATE = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function isDateFormat(code) {
  if (!code) return false;
  const c = code.replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
  return /[ymdhs]|上午|下午|年|月|日/i.test(c) && !/^[#0.,%\s]*$/.test(c);
}

export function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function serialToDate(serial, date1904 = false) {
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const ms = Math.round(serial * 86400000);
  const d = new Date(epoch + ms);
  const ymd = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const frac = serial - Math.floor(serial);
  if (frac < 1e-9) return ymd;
  return `${ymd} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export async function readXlsx(buffer) {
  const zip = await unzip(buffer);
  const wbXml = stripNs((await zip.read('xl/workbook.xml')) || '');
  if (!wbXml) throw new Error('找不到 xl/workbook.xml');
  const date1904 = /date1904="(1|true)"/.test(wbXml);
  const relsXml = stripNs((await zip.read('xl/_rels/workbook.xml.rels')) || '');
  const rels = {};
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    rels[a.Id] = a.Target;
  }
  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const a = attrs(m[1]);
    let target = rels[a['r:id']] || '';
    target = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
    sheets.push({ name: xmlText(a.name || ''), path: target, state: a.state || 'visible' });
  }

  const sst = [];
  const sstXml = await zip.read('xl/sharedStrings.xml');
  if (sstXml) for (const m of stripNs(sstXml).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) sst.push(m[1] ? textRuns(m[1]) : '');

  const dateStyles = new Set();
  const stylesXml = await zip.read('xl/styles.xml');
  if (stylesXml) {
    const sx = stripNs(stylesXml);
    const fmts = {};
    for (const m of sx.matchAll(/<numFmt\b([^>]*)\/?>/g)) {
      const a = attrs(m[1]);
      fmts[a.numFmtId] = xmlText(a.formatCode || '');
    }
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(sx);
    if (xfs) {
      let idx = 0;
      for (const m of xfs[1].matchAll(/<xf\b([^>]*?)(?:\/>|>[\s\S]*?<\/xf>)/g)) {
        const id = Number(attrs(m[1]).numFmtId || 0);
        if (BUILTIN_DATE.has(id) || isDateFormat(fmts[id])) dateStyles.add(idx);
        idx++;
      }
    }
  }

  const out = [];
  for (const sh of sheets) {
    const xml = await zip.read(sh.path);
    if (!xml) continue;
    const sx = stripNs(xml);
    const rows = [];
    for (const rm of sx.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const ra = attrs(rm[1]);
      const rIdx = ra.r ? Number(ra.r) - 1 : rows.length;
      while (rows.length < rIdx) rows.push([]);
      const row = [];
      let next = 0;
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ca = attrs(cm[1]);
        const ci = ca.r ? colIndex(ca.r) : next;
        next = ci + 1;
        const body = cm[2] || '';
        const vm = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(body);
        const v = vm ? xmlText(vm[1]) : '';
        let val = '';
        switch (ca.t) {
          case 's':
            val = sst[Number(v)] ?? '';
            break;
          case 'inlineStr': {
            const im = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(body);
            val = im ? textRuns(im[1]) : '';
            break;
          }
          case 'b':
            val = v === '1' ? 'TRUE' : 'FALSE';
            break;
          case 'str':
          case 'e':
          case 'd':
            val = v;
            break;
          default:
            if (v === '') val = '';
            else if (dateStyles.has(Number(ca.s)) && Number.isFinite(Number(v))) val = serialToDate(Number(v), date1904);
            else val = v;
        }
        while (row.length < ci) row.push('');
        row[ci] = val;
      }
      rows[rIdx] = row;
    }
    const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
    for (const r of rows) while (r.length < width) r.push('');
    while (rows.length && rows[rows.length - 1].every((c) => c === '')) rows.pop();
    out.push({ name: sh.name, hidden: sh.state !== 'visible', rows });
  }
  return out;
}
