// 預覽版的資料層：全部放在記憶體，不碰 IndexedDB／localStorage、不連雲端；重新整理就回到示範資料。
// 介面與 store.js 的 LocalBackend 相同（store 只用到這些方法）。

import { pkOf } from '../js/schema.js';

const NOT_IN_DEMO = '預覽版沒有這個功能（正式版才有開啟密碼、復原碼與加密備份）';

export class MemoryBackend {
  constructor() {
    this.kind = 'local';
    this.vault = { demo: true }; // 讓開門畫面直接放行
    this.unlocked = true;
    this.migrationError = null;
    this.onFatal = null;
    this.mem = new Map(); // 資料表 → Map(主鍵 → JSON)
    this.files = new Map(); // 憑證 id → { id, name, type, blob }
    this.makers = new Map(); // 憑證 id → () => Promise<{ name, type, blob }>（第一次讀取時才畫照片）
  }

  open() {
    return Promise.resolve();
  }
  async loadVault() {}
  async setup() {
    throw new Error(NOT_IN_DEMO);
  }
  async unlock() {}
  async recover() {
    throw new Error(NOT_IN_DEMO);
  }
  async changePasscode() {
    throw new Error(NOT_IN_DEMO);
  }
  async newRecoveryCode() {
    throw new Error(NOT_IN_DEMO);
  }
  async destroy() {
    throw new Error(NOT_IN_DEMO);
  }
  async lock() {}
  async flush() {}

  table(coll) {
    if (!this.mem.has(coll)) this.mem.set(coll, new Map());
    return this.mem.get(coll);
  }
  /** 載入示範資料（不經 store 快取） */
  seed(coll, rows) {
    const map = this.table(coll);
    const pk = pkOf(coll);
    for (const r of rows) map.set(r[pk], JSON.stringify(r));
  }
  async all(coll) {
    return [...this.table(coll).values()].map((s) => JSON.parse(s));
  }
  async readPersisted(coll) {
    return this.all(coll);
  }
  async putMany(coll, rows) {
    const map = this.table(coll);
    const pk = pkOf(coll);
    for (const r of rows) map.set(r[pk], JSON.stringify(r));
  }
  async removeMany(coll, ids) {
    const map = this.table(coll);
    for (const id of ids) map.delete(id);
  }
  async clear(coll) {
    this.table(coll).clear();
  }
  async replaceAll(coll, rows) {
    this.table(coll).clear();
    await this.putMany(coll, rows);
  }

  // ── 憑證影像
  async putFile({ id, name, type, blob }) {
    this.files.set(id, { id, name, type: type || blob.type || '', blob });
  }
  async getFile(id) {
    if (!this.files.has(id) && this.makers.has(id)) {
      const f = await this.makers.get(id)();
      this.files.set(id, { id, ...f });
    }
    return this.files.get(id) || null;
  }
  async removeFile(id) {
    this.files.delete(id);
    this.makers.delete(id);
  }
  async fileIds() {
    return [...new Set([...this.files.keys(), ...this.makers.keys()])];
  }
  async clearFiles() {
    this.files.clear();
    this.makers.clear();
  }

  // 雲端登入狀態：預覽版不連雲端
  authStorage() {
    return { getItem: async () => null, setItem: async () => {}, removeItem: async () => {} };
  }
}
