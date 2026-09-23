// 裝置保管箱：資料一律以隨機產生的「資料金鑰」（AES-GCM 256）加密後才寫入瀏覽器。
// 資料金鑰再用「開啟密碼」與「復原碼」各包一份（PBKDF2-SHA256 衍生），密碼本身不儲存；
// 改密碼只需重新包裝金鑰，不必重新加密資料。忘記密碼又沒有復原碼時，資料無法解開。
// 同一套工具也用於加密備份檔（.wyb）。瀏覽器與 Node 20+ 皆可執行（globalThis.crypto）。

const subtle = () => globalThis.crypto.subtle;
const te = new TextEncoder();
const td = new TextDecoder();

export const KDF_ITERATIONS = 600000; // OWASP 2023 對 PBKDF2-HMAC-SHA256 的建議值
export const MIN_PASSCODE = 8;

export class WrongPasscodeError extends Error {
  constructor(msg = '密碼錯誤') {
    super(msg);
    this.name = 'WrongPasscodeError';
  }
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export function toB64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 密碼強度：長度、字元種類、常見弱密碼
export function passcodeProblems(p) {
  const s = String(p || '');
  const out = [];
  if ([...s].length < MIN_PASSCODE) out.push(`至少 ${MIN_PASSCODE} 個字`);
  if (/^(\d)\1+$/.test(s) || /^(0123456789|123456789|12345678|87654321|password|qwertyui|abcdefgh)/i.test(s)) out.push('太容易被猜到');
  return out;
}

async function deriveKek(secret, salt, iterations) {
  const base = await subtle().importKey('raw', te.encode(String(secret).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

function importDek(raw) {
  return subtle().importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function wrapRaw(raw, secret, type, iterations) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const kek = await deriveKek(secret, salt, iterations);
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode('wuyue:wrap:' + type) }, kek, raw));
  return { type, iterations, salt: toB64(salt), iv: toB64(iv), data: toB64(data) };
}

async function unwrapRaw(record, secret, type) {
  const w = (record?.wraps || []).find((x) => x.type === type);
  if (!w) throw new Error('保管箱資料不完整');
  const kek = await deriveKek(secret, fromB64(w.salt), w.iterations || record.iterations || KDF_ITERATIONS);
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: fromB64(w.iv), additionalData: te.encode('wuyue:wrap:' + type) }, kek, fromB64(w.data)));
  } catch {
    throw new WrongPasscodeError(type === 'recovery' ? '復原碼不正確' : '密碼錯誤');
  }
}

// 復原碼：25 碼（Crockford Base32，去除易混淆字元），約 125 位元
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function makeRecoveryCode() {
  const b = randomBytes(25);
  const chars = [...b].map((x) => B32[x & 31]).join('');
  return chars.match(/.{5}/g).join('-');
}

export function normalizeRecovery(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

/**
 * 建立保管箱。
 * @returns {{ record: object, key: CryptoKey, recoveryCode: string }} record 可存入資料庫；key 只留在記憶體
 */
export async function createVault(passcode, { iterations = KDF_ITERATIONS } = {}) {
  const raw = randomBytes(32);
  const recoveryCode = makeRecoveryCode();
  const record = {
    v: 1,
    iterations,
    wraps: [await wrapRaw(raw, passcode, 'passcode', iterations), await wrapRaw(raw, normalizeRecovery(recoveryCode), 'recovery', iterations)],
    created_at: new Date().toISOString(),
  };
  const key = await importDek(raw);
  raw.fill(0);
  return { record, key, recoveryCode };
}

export async function unlockVault(record, passcode) {
  const raw = await unwrapRaw(record, passcode, 'passcode');
  const key = await importDek(raw);
  raw.fill(0);
  return key;
}

// 用復原碼解開並設定新密碼，順便換一組新的復原碼
export async function recoverVault(record, recoveryCode, newPasscode) {
  const raw = await unwrapRaw(record, normalizeRecovery(recoveryCode), 'recovery');
  return rewrap(record, raw, newPasscode, makeRecoveryCode());
}

export async function changePasscode(record, oldPasscode, newPasscode) {
  const raw = await unwrapRaw(record, oldPasscode, 'passcode');
  return rewrap(record, raw, newPasscode, null);
}

export async function newRecoveryCode(record, passcode) {
  const raw = await unwrapRaw(record, passcode, 'passcode');
  return rewrap(record, raw, passcode, makeRecoveryCode());
}

async function rewrap(record, raw, passcode, recoveryCode) {
  const iterations = record.iterations || KDF_ITERATIONS;
  const wraps = [await wrapRaw(raw, passcode, 'passcode', iterations)];
  if (recoveryCode) wraps.push(await wrapRaw(raw, normalizeRecovery(recoveryCode), 'recovery', iterations));
  else wraps.push(record.wraps.find((w) => w.type === 'recovery'));
  const key = await importDek(raw);
  raw.fill(0);
  return { record: { ...record, wraps, updated_at: new Date().toISOString() }, key, recoveryCode };
}

// ─────────── 資料加解密（aad 綁定用途，避免密文被搬到別的位置使用）

export async function encryptBytes(key, bytes, aad) {
  const iv = randomBytes(12);
  const data = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, bytes);
  return { iv, data: new Uint8Array(data) };
}

export async function decryptBytes(key, iv, data, aad) {
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: te.encode(aad) }, key, data));
  } catch {
    throw new Error('資料解密失敗（資料可能已損壞或被竄改）');
  }
}

export async function encryptText(key, text, aad) {
  return encryptBytes(key, te.encode(text), aad);
}

export async function decryptText(key, rec, aad) {
  return td.decode(await decryptBytes(key, rec.iv, rec.data, aad));
}

// 檔案：[4 bytes 中繼資料長度][中繼資料 JSON][檔案內容] 整包加密
export async function encryptFile(key, meta, bytes, aad) {
  const m = te.encode(JSON.stringify(meta));
  const buf = new Uint8Array(4 + m.length + bytes.length);
  new DataView(buf.buffer).setUint32(0, m.length);
  buf.set(m, 4);
  buf.set(bytes, 4 + m.length);
  const out = await encryptBytes(key, buf, aad);
  buf.fill(0);
  return out;
}

export async function decryptFile(key, rec, aad) {
  const buf = await decryptBytes(key, rec.iv, rec.data, aad);
  const n = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
  return { meta: JSON.parse(td.decode(buf.subarray(4, 4 + n))), bytes: buf.subarray(4 + n) };
}

// ─────────── 加密備份檔（.wyb）
// 格式：'WUYUEBK1'(8) | flags(1, bit0=gzip) | iterations(4, BE) | salt(16) | iv(12) | AES-GCM 密文

const MAGIC = 'WUYUEBK1';

async function gzip(bytes, mode) {
  const stream = new Blob([bytes]).stream().pipeThrough(mode === 'c' ? new CompressionStream('gzip') : new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function isEncryptedBackup(bytes) {
  return bytes.length > 41 && td.decode(bytes.subarray(0, 8)) === MAGIC;
}

export async function encryptBackup(password, bytes, { iterations = KDF_ITERATIONS } = {}) {
  const canZip = typeof CompressionStream !== 'undefined';
  const body = canZip ? await gzip(bytes, 'c') : bytes;
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKek(password, salt, iterations);
  const header = new Uint8Array(41);
  header.set(te.encode(MAGIC), 0);
  header[8] = canZip ? 1 : 0;
  new DataView(header.buffer).setUint32(9, iterations);
  header.set(salt, 13);
  header.set(iv, 29);
  const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv, additionalData: header }, key, body));
  const out = new Uint8Array(41 + data.length);
  out.set(header, 0);
  out.set(data, 41);
  return out;
}

export async function decryptBackup(password, bytes) {
  if (!isEncryptedBackup(bytes)) throw new Error('不是午月 ERP 的加密備份檔');
  const header = bytes.slice(0, 41);
  const iterations = new DataView(header.buffer).getUint32(9);
  const key = await deriveKek(password, header.subarray(13, 29), iterations);
  let body;
  try {
    body = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: header.subarray(29, 41), additionalData: header }, key, bytes.subarray(41)));
  } catch {
    throw new WrongPasscodeError('備份密碼錯誤，或檔案已損壞');
  }
  return header[8] & 1 ? gzip(body, 'd') : body;
}
