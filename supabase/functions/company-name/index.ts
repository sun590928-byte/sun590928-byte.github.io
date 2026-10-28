// Supabase Edge Function：統編 → 商工登記的登記名稱（經濟部商業發展署「商工登記公示資料」開放 API，data.gcis.nat.gov.tw）。
// 瀏覽器不能直接連政府的 API（沒有 CORS 標頭），由這個函式代查；只回傳名稱、現況、種類，不存任何資料。
// 部署：supabase functions deploy company-name（或後台 Edge Functions → Deploy a new function → Via Editor 貼上）
// 沒有部署時 ERP 會安靜略過（廠商名稱沿用辨識結果）。

import { createClient } from "npm:@supabase/supabase-js@2.116.0";

// 允許呼叫的網站來源（逗號分隔）；未設定時不限制來源（仍須登入且在白名單）
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allow = !ALLOWED.length ? "*" : ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

const GCIS = "https://data.gcis.nat.gov.tw/od/data/api/";
// 公司登記基本資料-應用一（依公司統一編號）
const COMPANY = "5F64D864-61CB-4D0D-8AD9-492047CC1EA6";
// 商業登記基本資料-應用三（依商業統一編號：獨資、合夥的商號）
const BUSINESS = "426D5542-5F05-43EB-83F9-F1300F14E1F1";
// 統編查是否為公司、分公司及商業
const KIND = "673F0FC0-B3A7-429F-9041-E9866836B66D";

type Row = Record<string, unknown>;

async function gcis(dataset: string, filter: string): Promise<Row[]> {
  const url = `${GCIS}${dataset}?$format=json&$filter=${encodeURIComponent(filter)}&$skip=0&$top=5`;
  const r = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(12000) });
  const text = (await r.text()).trim();
  if (!r.ok) throw new Error(`商工登記 API 回 ${r.status}`);
  if (!text.startsWith("[")) return []; // 查無資料時回空白（不是 []）
  return JSON.parse(text) as Row[];
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

// 查過的統編在這個函式實例活著的期間記住（同一天重複查同一家不再打政府 API）
const cache = new Map<string, { body: Row; at: number }>();
const TTL = 6 * 3600 * 1000;

async function lookup(ban: string): Promise<Row> {
  const hit = cache.get(ban);
  if (hit && Date.now() - hit.at < TTL) return hit.body;
  let out: Row = { ban, name: null, status: null, kind: null, source: "gcis", fetched_at: new Date().toISOString() };
  const co = (await gcis(COMPANY, `Business_Accounting_NO eq ${ban}`))[0];
  if (co && str(co.Company_Name)) out = { ...out, name: str(co.Company_Name), status: str(co.Company_Status_Desc) || null, kind: "company" };
  else {
    const bz = (await gcis(BUSINESS, `President_No eq ${ban}`))[0];
    if (bz && str(bz.Business_Name)) out = { ...out, name: str(bz.Business_Name), status: str(bz.Business_Current_Status_Desc) || null, kind: "business" };
    else {
      // 分公司的統編查不到全名（公示資料只能從總公司統編往下查）：只回種類
      const kinds = await gcis(KIND, `NO eq ${ban}`).catch(() => [] as Row[]);
      const k = kinds.find((x) => str(x.exist) === "Y");
      out = { ...out, kind: k ? ({ 公司: "company", 分公司: "branch", 商業: "business" } as Record<string, string>)[str(k.TYPE)] ?? null : null };
    }
  }
  cache.set(ban, { body: out, at: Date.now() });
  return out;
}

Deno.serve(async (req) => {
  const CORS = corsHeaders(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);
  if (ALLOWED.length && !ALLOWED.includes(req.headers.get("Origin") ?? "")) return json({ error: "來源網站不在允許清單" }, 403);
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: member, error: memberErr } = await supabase.rpc("is_member");
    if (memberErr || member !== true) return json({ error: "沒有使用權限（帳號不在 app_users 白名單）" }, 403);

    const body = await req.json().catch(() => ({}));
    const ban = String(body?.ban ?? "").replace(/\D/g, "");
    if (!/^\d{8}$/.test(ban)) return json({ error: "統一編號要 8 碼數字" }, 400);
    return json(await lookup(ban));
  } catch (e) {
    return json({ error: (e as Error).message ?? String(e) }, 502);
  }
});
