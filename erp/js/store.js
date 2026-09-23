// 資料層：預設存在本機瀏覽器（IndexedDB）；設定 Supabase 後改為雲端資料庫（多裝置共用、需登入）。
// 兩種模式 API 相同：all / put / remove / clear / exportAll / importAll。

import { SCHEMA, COLLECTIONS, pkOf } from './schema.js';

const DB_NAME = 'wuyue-erp';
const DB_VERSION = 1;
const CLOUD_KEY = 'wuyue-erp:cloud';

// ─────────── 本機 IndexedDB

class LocalBackend {
  constructor() {
    this.kind = 'local';
    this.db = null;
  }
  open() {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const c of COLLECTIONS) if (!db.objectStoreNames.contains(c)) db.createObjectStore(c, { keyPath: pkOf(c) });
      };
      req.onsuccess = () => {
        this.db = req.result;
        resolve(this.db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('資料庫被其他分頁占用，請關閉其他 ERP 分頁後重新整理'));
    });
  }
  async tx(coll, mode, fn) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(coll, mode);
      const st = t.objectStore(coll);
      let result;
      Promise.resolve(fn(st)).then((r) => (result = r));
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error('交易中止'));
    });
  }
  async all(coll) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = db.transaction(coll).objectStore(coll).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  putMany(coll, rows) {
    return this.tx(coll, 'readwrite', (st) => {
      for (const r of rows) st.put(r);
    });
  }
  removeMany(coll, ids) {
    return this.tx(coll, 'readwrite', (st) => {
      for (const id of ids) st.delete(id);
    });
  }
  clear(coll) {
    return this.tx(coll, 'readwrite', (st) => st.clear());
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
  constructor(cfg) {
    this.kind = 'cloud';
    this.cfg = cfg;
    this.client = null;
    this.session = null;
  }
  async open() {
    if (this.client) return this.client;
    await loadScript('vendor/supabase-2.116.0.umd.js');
    this.client = window.supabase.createClient(this.cfg.url, this.cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    const { data } = await this.client.auth.getSession();
    this.session = data.session;
    this.client.auth.onAuthStateChange((_e, s) => (this.session = s));
    return this.client;
  }
  async signIn(email, password) {
    await this.open();
    const r = password ? await this.client.auth.signInWithPassword({ email, password }) : await this.client.auth.signInWithOtp({ email, options: { emailRedirectTo: location.href.split('#')[0] } });
    if (r.error) throw r.error;
    this.session = r.data.session || null;
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
  async upload(path, file) {
    await this.open();
    const { error } = await this.client.storage.from('documents').upload(path, file, { upsert: true, contentType: file.type });
    if (error) throw new Error('上傳失敗：' + error.message);
    return path;
  }
  async fileUrl(path) {
    await this.open();
    const { data, error } = await this.client.storage.from('documents').createSignedUrl(path, 3600);
    if (error) throw error;
    return data.signedUrl;
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

export const store = {
  get mode() {
    return backend.kind;
  },
  get backend() {
    return backend;
  },
  async init() {
    const cfg = cloudConfig();
    if (cfg?.enabled && cfg.url && cfg.anonKey) {
      backend = new CloudBackend(cfg);
      try {
        await backend.open();
      } catch (e) {
        backend = local;
        throw e;
      }
    }
    await local.open();
  },
  needsLogin() {
    return backend.kind === 'cloud' && !backend.session;
  },
  async all(coll) {
    if (!cache.has(coll)) cache.set(coll, backend.kind === 'cloud' && SCHEMA[coll].localOnly ? local.all(coll) : backend.all(coll));
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
    const be = SCHEMA[coll].localOnly ? local : backend;
    await be.putMany(coll, rows);
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
    const be = SCHEMA[coll].localOnly ? local : backend;
    await be.removeMany(coll, ids);
    const pk = pkOf(coll);
    const del = new Set(ids);
    const list = await this.all(coll);
    cache.set(coll, Promise.resolve(list.filter((r) => !del.has(r[pk]))));
    emit(coll);
  },
  async clear(coll) {
    const be = SCHEMA[coll].localOnly ? local : backend;
    await be.clear(coll);
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
  async exportAll() {
    const data = {};
    for (const c of COLLECTIONS) {
      if (c === 'files') continue;
      data[c] = await this.all(c);
    }
    return { app: 'wuyue-erp', version: 1, exported_at: new Date().toISOString(), mode: backend.kind, data };
  },
  async importAll(json, { replace = false } = {}) {
    if (json?.app !== 'wuyue-erp' || !json.data) throw new Error('不是午月 ERP 的備份檔');
    for (const [c, rows] of Object.entries(json.data)) {
      if (!SCHEMA[c] || c === 'files') continue;
      if (replace) await this.clear(c);
      await this.put(c, rows);
    }
  },
  // 本機資料一次上傳到雲端
  async pushLocalToCloud(onProgress) {
    if (backend.kind !== 'cloud') throw new Error('尚未連線雲端');
    for (const c of COLLECTIONS) {
      if (SCHEMA[c].localOnly) continue;
      const rows = await local.all(c);
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
