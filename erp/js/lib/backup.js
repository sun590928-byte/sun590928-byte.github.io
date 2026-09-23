// 備份檔內容：ZIP（backup.json ＋ files/<憑證ID>）→ 以備份密碼加密成 .wyb。
// 舊版未加密的 JSON 備份仍可還原。

import { makeZip } from './zip.js';
import { unzip } from './xlsx.js';
import { encryptBackup, decryptBackup, isEncryptedBackup } from './vault.js';

const te = new TextEncoder();

/**
 * @param json  store.exportAll() 的結果
 * @param files [{ id, name, type, bytes: Uint8Array }]
 */
export async function packBackup(json, files = [], password, opts) {
  const manifest = files.map((f) => ({ id: f.id, name: f.name || '', type: f.type || '', size: f.bytes.length }));
  const zip = makeZip([
    { name: 'backup.json', data: te.encode(JSON.stringify(json)) },
    { name: 'files.json', data: te.encode(JSON.stringify(manifest)) },
    ...files.map((f) => ({ name: `files/${f.id}`, data: f.bytes })),
  ]);
  const bytes = new Uint8Array(await zip.arrayBuffer());
  return encryptBackup(password, bytes, opts);
}

export { isEncryptedBackup };

// 回傳 { json, files: [{ id, name, type, bytes }] }
export async function unpackBackup(bytes, password) {
  if (!isEncryptedBackup(bytes)) {
    const json = JSON.parse(new TextDecoder().decode(bytes));
    return { json, files: [] };
  }
  const plain = await decryptBackup(password, bytes);
  const z = await unzip(plain);
  const json = JSON.parse(await z.read('backup.json'));
  const manifest = JSON.parse((await z.read('files.json')) || '[]');
  const files = [];
  for (const m of manifest) {
    const data = await z.readBytes(`files/${m.id}`);
    if (data) files.push({ ...m, bytes: new Uint8Array(data) });
  }
  return { json, files };
}
