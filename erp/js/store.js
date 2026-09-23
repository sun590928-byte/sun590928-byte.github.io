// 資料層：
// ・本機模式：資料以「開啟密碼」保護的金鑰加密（AES-GCM）後存在這台裝置的瀏覽器（IndexedDB），
//   關閉或上鎖後，沒有密碼（或復原碼）無法讀取。
// ・雲端模式：資料存在你自己的 Supabase（須登入且在白名單），登入狀態同樣加密保存在本機保管箱。
// 兩種模式 API 相同：all / put / remove / clear / exportAll / importAll，憑證檔案另有 saveFile / readFile。

import { SCHEMA, COLLECTIONS, pkOf } from './schema.js';
import * as V from './lib/vault.js';

const DB_NAME = 'wuyue-erp';
const DB_VERSION = 2;
const CLOUD_KEY = 'wuyue-erp:cloud';
const META = '_meta'; // 保管箱（包裝後的金鑰）、加密的登入狀態
const ENC = '_enc'; // 每個資料表一筆加密內容
const FILES = '_files'; // 憑證影像，每個檔案一筆加密內容
const LEGACY_FILES = 'files'; // 舊版（未加密）影像

function reqP(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

// ─────────── 本機：加密的 IndexedDB

class LocalBackend {
  constructor() {
    this.kind = 'local';
    this.db = null;
    this.key = null;
    this.vault = null;
    this.mem = new Map(); // 資料表 → Map(主鍵 → 該列 JSON)
    this.loading = new Map();
    this.revs = new Map();
    this.writes = new Map();
    this.auth = null;
    this.onFatal = null;
  }

  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of [META, ENC, FILES]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        this.db = req.result;
        this.db.onversionchange = () => {
          this.db.close();
          this.onFatal?.('系統已在其他分頁更新，請重新整理');
        };
        resolve(this.db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('資料庫被其他分頁占用，請關閉其他 ERP 分頁後重新整理'));
    });
  }

  async getRec(storeName, id) {
    const db = await this.open();
    return reqP(db.transaction(storeName).objectStore(storeName).get(id));
  }

  async putRec(storeName, rec) {
    const db = await this.open();
    const t = db.transaction(storeName, 'readwrite');
    t.objectStore(storeName).put(rec);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('寫入中止'));
    });
  }

  async delRec(storeName, id) {
    const db = await this.open();
    const t = db.transaction(storeName, 'readwrite');
    t.objectStore(storeName).delete(id);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
    });
  }

  // ── 保管箱
  async loadVault() {
    await this.open();
    const rec = await this.getRec(META, 'vault');
    if (rec) {
      const { id, ...vault } = rec;
      this.vault = vault;
    } else this.vault = null;
    return this.vault;
  }

  get unlocked() {
    return !!this.key;
  }

  async setup(passcode) {
    if (await this.loadVault()) throw new Error('這台裝置已經設定過開啟密碼');
    const { record, key, recoveryCode } = await V.createVault(passcode);
    // 先保存保管箱再搬移舊資料：中途中斷時金鑰仍在，下次解鎖會繼續搬移
    await this.putRec(META, { id: 'vault', ...record });
    this.vault = record;
    this.key = key;
    await this.resumeMigration();
    return recoveryCode;
  }

  async unlock(passcode) {
    if (!this.vault) await this.loadVault();
    this.key = await V.unlockVault(this.vault, passcode);
    await this.resumeMigration();
  }

  async recover(code, newPasscode) {
    if (!this.vault) await this.loadVault();
    const r = await V.recoverVault(this.vault, code, newPasscode);
    await this.putRec(META, { id: 'vault', ...r.record });
    this.vault = r.record;
    this.key = r.key;
    await this.resumeMigration();
    return r.recoveryCode;
  }

  async resumeMigration() {
    try {
      await this.migrateLegacy();
      this.migrationError = null;
    } catch (e) {
      console.warn(e);
      this.migrationError = e.message || String(e);
    }
  }

  async changePasscode(oldPasscode, newPasscode) {
    const r = await V.changePasscode(this.vault, oldPasscode, newPasscode);
    await this.putRec(META, { id: 'vault', ...r.record });
    this.vault = r.record;
  }

  async newRecoveryCode(passcode) {
    const r = await V.newRecoveryCode(this.vault, passcode);
    await this.putRec(META, { id: 'vault', ...r.record });
    this.vault = r.record;
    return r.recoveryCode;
  }

  // 等候進行中的寫入完成
  async flush() {
    for (const st of this.writes.values()) await (st.queued || st.running || Promise.resolve()).catch(() => {});
  }

  async lock() {
    await this.flush();
    this.key = null;
    this.mem.clear();
    this.loading.clear();
    this.auth = null;
  }

  // 舊版未加密資料 → 全部加密寫入後，才清空舊表（可重複執行：同主鍵覆寫）
  async migrateLegacy() {
    const db = await this.open();
    const names = [...COLLECTIONS, LEGACY_FILES].filter((c) => db.objectStoreNames.contains(c));
    const counts = await Promise.all(names.map((c) => reqP(db.transaction(c).objectStore(c).count())));
    const pending = names.filter((_, i) => counts[i] > 0);
    if (!pending.length) return;
    for (const c of pending) {
      const rows = await reqP(db.transaction(c).objectStore(c).getAll());
      if (c === LEGACY_FILES) {
        for (const f of rows) if (f?.blob) await this.putFile({ id: f.id, name: f.name, type: f.type || f.blob.type, blob: f.blob });
      } else await this.putMany(c, rows);
    }
    for (const c of pending) await reqP(db.transaction(c, 'readwrite').objectStore(c).clear());
  }

  // ── 資料表
  requireKey() {
    if (!this.key) throw new Error('系統已上鎖');
  }

  async load(coll) {
    this.requireKey();
    if (this.mem.has(coll)) return this.mem.get(coll);
    if (!this.loading.has(coll)) {
      this.loading.set(
        coll,
        (async () => {
          const rec = await this.getRec(ENC, coll);
          const map = new Map();
          const pk = pkOf(coll);
          if (rec) {
            const text = await V.decryptText(this.key, rec, 'wuyue:c:' + coll);
            for (const line of text.split('\n')) {
              if (!line) continue;
              map.set(JSON.parse(line)[pk], line);
            }
          }
          this.revs.set(coll, rec?.rev || 0);
          this.mem.set(coll, map);
          this.loading.delete(coll);
          return map;
        })().catch((e) => {
          this.loading.delete(coll);
          throw e;
        }),
      );
    }
    return this.loading.get(coll);
  }

  async all(coll) {
    const map = await this.load(coll);
    return [...map.values()].map((line) => JSON.parse(line));
  }

  async putMany(coll, rows) {
    const map = await this.load(coll);
    const pk = pkOf(coll);
    for (const r of rows) map.set(r[pk], JSON.stringify(r));
    return this.persist(coll);
  }

  async removeMany(coll, ids) {
    const map = await this.load(coll);
    for (const id of ids) map.delete(id);
    return this.persist(coll);
  }

  async clear(coll) {
    const map = await this.load(coll);
    map.clear();
    return this.persist(coll);
  }

  // 整批取代（還原備份用）：一次寫入，不會留下清空到一半的狀態
  async replaceAll(coll, rows) {
    const map = await this.load(coll);
    const pk = pkOf(coll);
    map.clear();
    for (const r of rows) map.set(r[pk], JSON.stringify(r));
    return this.persist(coll);
  }

  // 同一資料表的寫入依序進行；排隊中的寫入會帶上最新內容（連續多次修改只加密一次）
  persist(coll) {
    let st = this.writes.get(coll);
    if (!st) this.writes.set(coll, (st = { running: null, queued: null }));
    if (st.queued) return st.queued;
    const start = () => {
      st.queued = null;
      st.running = this.write(coll).finally(() => {
        st.running = null;
      });
      return st.running;
    };
    if (!st.running) return start();
    st.queued = st.running.catch(() => {}).then(start);
    return st.queued;
  }

  async write(coll) {
    this.requireKey();
    const map = this.mem.get(coll);
    const { iv, data } = await V.encryptText(this.key, [...map.values()].join('\n'), 'wuyue:c:' + coll);
    const expected = this.revs.get(coll) || 0;
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const t = db.transaction(ENC, 'readwrite');
      const st = t.objectStore(ENC);
      let conflict = false;
      st.get(coll).onsuccess = (ev) => {
        if ((ev.target.result?.rev || 0) !== expected) {
          conflict = true;
          t.abort();
          return;
        }
        st.put({ id: coll, rev: expected + 1, n: map.size, iv, data, at: Date.now() });
      };
      t.oncomplete = () => resolve();
      t.onabort = () => reject(conflict ? new Error('資料已在其他分頁或裝置更新，為避免覆蓋，請重新整理後再操作') : t.error || new Error('寫入中止'));
      t.onerror = () => reject(t.error);
    }).catch((e) => {
      this.onFatal?.(e.message);
      throw e;
    });
    this.revs.set(coll, expected + 1);
  }

  // ── 憑證影像
  async putFile({ id, name, type, blob }) {
    this.requireKey();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const { iv, data } = await V.encryptFile(this.key, { name, type: type || blob.type || '', size: bytes.length }, bytes, 'wuyue:f:' + id);
    await this.putRec(FILES, { id, iv, data });
  }

  async getFile(id) {
    this.requireKey();
    const rec = await this.getRec(FILES, id);
    if (!rec) return null;
    const { meta, bytes } = await V.decryptFile(this.key, rec, 'wuyue:f:' + id);
    return { id, ...meta, blob: new Blob([bytes], { type: meta.type }) };
  }

  removeFile(id) {
    return this.delRec(FILES, id);
  }

  async fileIds() {
    const db = await this.open();
    return reqP(db.transaction(FILES).objectStore(FILES).getAllKeys());
  }

  async clearFiles() {
    const db = await this.open();
    const t = db.transaction(FILES, 'readwrite');
    t.objectStore(FILES).clear();
    return new Promise((resolve) => (t.oncomplete = resolve));
  }

  // ── 雲端登入狀態（supabase-js 自訂 storage）：只以加密形式存在本機
  async authMap() {
    this.requireKey();
    if (!this.auth) {
      const rec = await this.getRec(META, 'auth');
      this.auth = rec ? JSON.parse(await V.decryptText(this.key, rec, 'wuyue:auth')) : {};
    }
    return this.auth;
  }

  async saveAuth() {
    const { iv, data } = await V.encryptText(this.key, JSON.stringify(this.auth || {}), 'wuyue:auth');
    await this.putRec(META, { id: 'auth', iv, data });
  }

  authStorage() {
    return {
      getItem: async (k) => (await this.authMap())[k] ?? null,
      setItem: async (k, v) => {
        (await this.authMap())[k] = v;
        await this.saveAuth();
      },
      removeItem: async (k) => {
        delete (await this.authMap())[k];
        await this.saveAuth();
      },
    };
  }

  // 清除整台裝置的資料（忘記密碼又沒有復原碼時的最後手段）
  async destroy() {
    this.lock();
    if (this.db) this.db.close();
    this.db = null;
    await new Promise((resolve, reject) => {
      const r = indexedDB.deleteDatabase(DB_NAME);
      r.onsuccess = resolve;
      r.onerror = () => reject(r.error);
      r.onblocked = resolve;
    });
  }
}

// ─────────── Supabase 雲端

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('無法載入 ' + src));
    document.head.appendChild(s);
  });
}

function toRow(coll, obj) {
  const cols = SCHEMA[coll].cols;
  const row = {};
  const extra = {};
  for (const [k, type] of Object.entries(cols)) {
    let v = obj[k];
    if (v === undefined || v === '') v = null;
    if (v !== null) {
      if (type === 'numeric') v = Number.isFinite(Number(v)) ? Number(v) : null;
      else if (type === 'boolean') v = !!v;
      else if (type === 'date') v = /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? String(v).slice(0, 10) : null;
      else if (type === 'text' && typeof v !== 'string') v = String(v);
    }
    row[k] = v;
  }
  for (const [k, v] of Object.entries(obj)) if (!(k in cols) && v !== undefined) extra[k] = v;
  row.extra = extra;
  return row;
}

function fromRow(row) {
  const { extra, owner_id, updated_by, inserted_at, ...rest } = row;
  const out = { ...(extra || {}) };
  for (const [k, v] of Object.entries(rest)) if (v !== null) out[k] = v;
  return out;
}

class CloudBackend {
  constructor(cfg, authStorage) {
    this.kind = 'cloud';
    this.cfg = cfg;
    this.authStorage = authStorage;
    this.client = null;
    this.session = null;
  }
  async open() {
    if (this.client) return this.client;
    await loadScript('vendor/supabase-2.116.0.umd.js');
    this.client = window.supabase.createClient(this.cfg.url, this.cfg.anonKey, {
      auth: { storage: this.authStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce' },
    });
    const { data } = await this.client.auth.getSession();
    this.session = data.session;
    this.client.auth.onAuthStateChange((_e, s) => (this.session = s));
    return this.client;
  }
  // 只接受 Email＋密碼（帳號由管理者在 Supabase 後台建立，不開放自行註冊）
  async signIn(email, password) {
    await this.open();
    if (!password) throw new Error('請輸入密碼');
    const r = await this.client.auth.signInWithPassword({ email, password });
    if (r.error) throw new Error(r.error.message === 'Invalid login credentials' ? 'Email 或密碼錯誤' : r.error.message);
    this.session = r.data.session || null;
    const { data: member } = await this.client.rpc('is_member');
    if (member !== true) {
      await this.client.auth.signOut();
      this.session = null;
      throw new Error('此帳號不在白名單（app_users），請管理者先加入');
    }
    return r.data;
  }
  async signOut() {
    await this.open();
    await this.client.auth.signOut();
    this.session = null;
  }
  async all(coll) {
    await this.open();
    const out = [];
    const size = 1000;
    for (let from = 0; ; from += size) {
      const { data, error } = await this.client.from(coll).select('*').order(pkOf(coll)).range(from, from + size - 1);
      if (error) throw new Error(`${SCHEMA[coll].label}讀取失敗：${error.message}`);
      out.push(...data.map(fromRow));
      if (data.length < size) break;
    }
    return out;
  }
  async putMany(coll, rows) {
    await this.open();
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500).map((r) => toRow(coll, r));
      const { error } = await this.client.from(coll).upsert(chunk, { onConflict: pkOf(coll) });
      if (error) throw new Error(`${SCHEMA[coll].label}寫入失敗：${error.message}`);
    }
  }
  async removeMany(coll, ids) {
    await this.open();
    for (let i = 0; i < ids.length; i += 200) {
      const { error } = await this.client.from(coll).delete().in(pkOf(coll), ids.slice(i, i + 200));
      if (error) throw new Error(`${SCHEMA[coll].label}刪除失敗：${error.message}`);
    }
  }
  async clear(coll) {
    await this.open();
    const { error } = await this.client.from(coll).delete().not(pkOf(coll), 'is', null);
    if (error) throw new Error(`${SCHEMA[coll].label}清除失敗：${error.message}`);
  }
  // 先寫入新資料，再刪除多出來的舊資料（中途中斷也不會是空的）
  async replaceAll(coll, rows) {
    const pk = pkOf(coll);
    await this.putMany(coll, rows);
    const keep = new Set(rows.map((r) => r[pk]));
    const extra = (await this.all(coll)).map((r) => r[pk]).filter((id) => !keep.has(id));
    if (extra.length) await this.removeMany(coll, extra);
  }
  async upload(path, file) {
    await this.open();
    const { error } = await this.client.storage.from('documents').upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw new Error('上傳失敗：' + error.message);
    return path;
  }
  // 簽章網址 10 分鐘後失效
  async fileUrl(path) {
    await this.open();
    const { data, error } = await this.client.storage.from('documents').createSignedUrl(path, 600);
    if (error) throw error;
    return data.signedUrl;
  }
  async download(path) {
    await this.open();
    const { data, error } = await this.client.storage.from('documents').download(path);
    if (error) throw new Error('下載失敗：' + error.message);
    return data;
  }
  async removeFile(path) {
    await this.open();
    const { error } = await this.client.storage.from('documents').remove([path]);
    if (error) throw new Error('刪除檔案失敗：' + error.message);
  }
  async moveFile(from, to) {
    await this.open();
    if (from === to) return;
    const { error } = await this.client.storage.from('documents').move(from, to);
    if (error) throw new Error('歸檔搬移失敗：' + error.message);
  }
  async invoke(fn, body) {
    await this.open();
    const { data, error } = await this.client.functions.invoke(fn, { body });
    if (error) {
      let msg = error.message;
      try {
        const j = await error.context?.json?.();
        if (j?.error) msg = j.error;
      } catch {}
      throw new Error(msg);
    }
    return data;
  }
}

// ─────────── 對外 API（含記憶體快取與變更通知）

const listeners = new Set();
const cache = new Map();
const local = new LocalBackend();
let backend = local;

export function cloudConfig() {
  try {
    return JSON.parse(localStorage.getItem(CLOUD_KEY) || 'null');
  } catch {
    return null;
  }
}

export function saveCloudConfig(cfg) {
  try {
    if (cfg) localStorage.setItem(CLOUD_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(CLOUD_KEY);
  } catch {}
}

function fileExt(name, type) {
  const m = /\.[a-z0-9]+$/i.exec(name || '');
  if (m) return m[0].toLowerCase();
  if (/pdf/.test(type || '')) return '.pdf';
  if (/png/.test(type || '')) return '.png';
  return '.jpg';
}

export const store = {
  get mode() {
    return backend.kind;
  },
  get backend() {
    return backend;
  },
  get local() {
    return local;
  },
  // 開門狀態：setup（尚未設定開啟密碼）、locked（已上鎖）、login（雲端尚未登入）、ready
  get gate() {
    if (!local.vault) return 'setup';
    if (!local.unlocked) return 'locked';
    if (backend.kind === 'cloud' && !backend.session) return 'login';
    return 'ready';
  },
  async open() {
    await local.open();
    await local.loadVault();
  },
  async setup(passcode) {
    return local.setup(passcode);
  },
  async unlock(passcode) {
    await local.unlock(passcode);
  },
  async recover(code, newPasscode) {
    return local.recover(code, newPasscode);
  },
  async lock() {
    await local.lock();
    cache.clear();
    backend = local;
  },
  // 解鎖後連線：雲端模式建立 Supabase 連線（登入狀態由本機保管箱提供）
  async connect() {
    const cfg = cloudConfig();
    // 舊版把 Supabase 登入狀態明文存在 localStorage：搬進加密保管箱後刪除
    try {
      const auth = local.authStorage();
      for (const k of Object.keys(localStorage)) {
        if (!/^sb-.+-(auth-token|code-verifier)/.test(k)) continue;
        if ((await auth.getItem(k)) === null) await auth.setItem(k, localStorage.getItem(k));
        localStorage.removeItem(k);
      }
    } catch (e) {
      console.warn(e);
    }
    if (cfg?.enabled && cfg.url && cfg.anonKey) {
      const be = new CloudBackend(cfg, local.authStorage());
      await be.open();
      backend = be;
    } else backend = local;
  },
  needsLogin() {
    return backend.kind === 'cloud' && !backend.session;
  },
  async all(coll) {
    if (!cache.has(coll)) cache.set(coll, backend.all(coll));
    try {
      return await cache.get(coll);
    } catch (e) {
      cache.delete(coll);
      throw e;
    }
  },
  async get(coll, id) {
    const pk = pkOf(coll);
    return (await this.all(coll)).find((r) => r[pk] === id) || null;
  },
  async put(coll, rowOrRows) {
    const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    if (!rows.length) return;
    await backend.putMany(coll, rows);
    const pk = pkOf(coll);
    const list = await this.all(coll);
    const idx = new Map(list.map((r, i) => [r[pk], i]));
    for (const r of rows) {
      if (idx.has(r[pk])) list[idx.get(r[pk])] = r;
      else {
        idx.set(r[pk], list.length);
        list.push(r);
      }
    }
    emit(coll);
  },
  async remove(coll, idOrIds) {
    const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
    if (!ids.length) return;
    await backend.removeMany(coll, ids);
    const pk = pkOf(coll);
    const del = new Set(ids);
    const list = await this.all(coll);
    cache.set(coll, Promise.resolve(list.filter((r) => !del.has(r[pk]))));
    emit(coll);
  },
  async clear(coll) {
    await backend.clear(coll);
    cache.set(coll, Promise.resolve([]));
    emit(coll);
  },
  reload(coll) {
    if (coll) cache.delete(coll);
    else cache.clear();
    emit(coll || '*');
  },
  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  // ── 憑證檔案：本機模式加密存在瀏覽器；雲端模式存 Supabase 私有空間
  // 回傳要寫回憑證紀錄的欄位（storage_path、file_ext）
  async saveFile(id, file, { folder = 'inbox' } = {}) {
    const ext = fileExt(file.name, file.type);
    if (backend.kind === 'cloud') return { storage_path: await backend.upload(`${folder}/${id}${ext}`, file), file_ext: ext };
    await local.putFile({ id, name: file.name, type: file.type, blob: file });
    return { storage_path: null, file_ext: ext };
  },
  async readFile(doc) {
    if (doc.storage_path && backend.kind === 'cloud') return backend.download(doc.storage_path);
    if (!local.unlocked) return null;
    return (await local.getFile(doc.id))?.blob || null;
  },
  // 預覽網址：雲端為 10 分鐘簽章網址；本機為 blob:（呼叫端用完請 revoke）
  async fileUrl(doc) {
    if (doc.storage_path && backend.kind === 'cloud') return backend.fileUrl(doc.storage_path);
    const blob = await this.readFile(doc);
    return blob ? URL.createObjectURL(blob) : '';
  },
  async deleteFile(doc) {
    if (doc.storage_path && backend.kind === 'cloud') {
      try {
        await backend.removeFile(doc.storage_path);
      } catch (e) {
        console.warn(e);
      }
    }
    if (local.unlocked) await local.removeFile(doc.id);
  },

  async exportAll() {
    const data = {};
    for (const c of COLLECTIONS) data[c] = await this.all(c);
    return { app: 'wuyue-erp', version: 2, exported_at: new Date().toISOString(), mode: backend.kind, data };
  },
  async importAll(json, { replace = false } = {}) {
    if (json?.app !== 'wuyue-erp' || !json.data) throw new Error('不是午月 ERP 的備份檔');
    for (const c of COLLECTIONS) {
      const rows = json.data[c];
      if (!Array.isArray(rows)) continue;
      if (replace) {
        await backend.replaceAll(c, rows);
        cache.set(c, Promise.resolve([...rows]));
        emit(c);
      } else await this.put(c, rows);
    }
  },
  // 本機資料（含加密的憑證照片）一次上傳到雲端
  async pushLocalToCloud(onProgress) {
    if (backend.kind !== 'cloud') throw new Error('尚未連線雲端');
    for (const c of COLLECTIONS) {
      let rows = await local.all(c);
      if (c === 'documents') {
        rows = await Promise.all(
          rows.map(async (d) => {
            if (d.storage_path) return d;
            const f = await local.getFile(d.id);
            if (!f) return d;
            const folder = d.status === 'posted' && d.doc_date ? `archive/${d.doc_date.slice(0, 4)}/${d.doc_date.slice(5, 7)}` : 'inbox';
            const ext = d.file_ext || fileExt(f.name, f.type);
            return { ...d, storage_path: await backend.upload(`${folder}/${d.id}${ext}`, new File([f.blob], f.name || d.id + ext, { type: f.type })), file_ext: ext };
          }),
        );
      }
      if (rows.length) await backend.putMany(c, rows);
      onProgress?.(c, rows.length);
    }
    this.reload();
  },
};

function emit(coll) {
  for (const fn of listeners) {
    try {
      fn(coll);
    } catch (e) {
      console.error(e);
    }
  }
}

export { local as localBackend, toRow, fromRow };
