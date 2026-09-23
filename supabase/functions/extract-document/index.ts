// Supabase Edge Function：讀取 Storage 中的憑證影像（發票、收據、撥款明細截圖），交由 Claude 辨識並回傳結構化 JSON。
// 部署：supabase functions deploy extract-document
// 金鑰：supabase secrets set ANTHROPIC_API_KEY=sk-ant-...（金鑰只存在伺服器端，網頁端拿不到）

import Anthropic from "npm:@anthropic-ai/sdk@0.127.0";
import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const MODEL = Deno.env.get("CLAUDE_MODEL") ?? "claude-opus-5";
const MAX_BYTES = 12 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

const nullable = (type: string) => ({ anyOf: [{ type }, { type: "null" }] });

// 結構化輸出：物件一律 additionalProperties:false 並列出 required
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "doc_date", "vendor_name", "vendor_tax_id", "invoice_no", "amount_total", "tax_amount", "items", "summary", "suggested_account", "confidence", "notes", "payouts"],
  properties: {
    kind: { type: "string", enum: ["invoice", "receipt", "payout_statement", "other"] },
    doc_date: { ...nullable("string"), description: "西元日期 YYYY-MM-DD（民國年請 +1911 換算）" },
    vendor_name: nullable("string"),
    vendor_tax_id: { ...nullable("string"), description: "賣方統一編號 8 碼" },
    invoice_no: { ...nullable("string"), description: "統一發票號碼：2 碼英文 + 8 碼數字，不含連字號" },
    amount_total: { ...nullable("number"), description: "含稅總金額（新台幣元）" },
    tax_amount: { ...nullable("number"), description: "營業稅額；二聯式或收據未載明則為 null" },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "qty", "amount"],
        properties: { name: { type: "string" }, qty: nullable("number"), amount: nullable("number") },
      },
    },
    summary: { type: "string", description: "10 字內的品項摘要，用於檔名，例如「鮮乳4瓶」「咖啡豆2kg」" },
    suggested_account: { ...nullable("string"), description: "從提供的會計項目代號中選一個最適合的" },
    confidence: { type: "number", description: "0 到 1，整體辨識把握度" },
    notes: { type: "string", description: "看不清楚或需人工確認之處；沒有則空字串" },
    payouts: {
      type: "array",
      description: "僅 kind=payout_statement 時填寫（LINE Pay、綠界、街口等撥款明細），否則空陣列",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["provider", "payout_date", "gross", "fee", "net", "period_from", "period_to", "ref"],
        properties: {
          provider: { type: "string", enum: ["linepay", "ecpay", "jkopay", "mobile", "platform"] },
          payout_date: nullable("string"),
          gross: nullable("number"),
          fee: nullable("number"),
          net: nullable("number"),
          period_from: nullable("string"),
          period_to: nullable("string"),
          ref: nullable("string"),
        },
      },
    },
  },
};

const SYSTEM = `你是台灣咖啡廳的記帳助理，負責讀取支出憑證影像並擷取資料。
憑證類型：
- 統一發票（電子發票證明聯、三聯式、收銀機發票）：發票號碼為 2 碼英文字軌 + 8 碼數字；日期常為民國年（例 115-09-01 = 2026-09-01）；三聯式或載明買方統編者通常分列銷售額與稅額。
- 收據（免用統一發票收據、手寫收據、網購明細）：可能沒有發票號碼與稅額。
- 撥款明細（LINE Pay、綠界、街口等金流的撥款/入帳截圖）：kind 設為 payout_statement，逐筆填入 payouts（撥款日、交易總額、手續費、實撥金額、交易期間）。
規則：
- 看不清楚的欄位填 null，不要猜；把疑點寫在 notes。
- 金額一律為新台幣元的數字（去掉逗號與 $）。
- suggested_account 只能從使用者提供的會計項目代號中選擇；咖啡豆、乳品、茶粉糖漿、甜點原料、包材屬於存貨科目，水電、電信、修繕、清潔、文具、運費等屬於費用科目。`;

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "只接受 POST" }, 405);
  try {
    const auth = req.headers.get("Authorization") ?? "";
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, { global: { headers: { Authorization: auth } } });
    const { data: member, error: memberErr } = await supabase.rpc("is_member");
    if (memberErr || member !== true) return json({ error: "沒有使用權限（帳號不在 app_users 白名單）" }, 403);

    const body = await req.json();
    const path = String(body?.path ?? "");
    if (!path || path.includes("..")) return json({ error: "缺少檔案路徑" }, 400);
    const accounts: { code: string; name: string }[] = Array.isArray(body?.accounts) ? body.accounts.slice(0, 200) : [];

    const { data: blob, error: dlErr } = await supabase.storage.from("documents").download(path);
    if (dlErr || !blob) return json({ error: "讀取檔案失敗：" + (dlErr?.message ?? "not found") }, 404);
    if (blob.size > MAX_BYTES) return json({ error: "檔案超過 12MB，請先壓縮或裁切" }, 413);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mime = (blob.type || String(body?.mime ?? "")).toLowerCase();
    const data = toBase64(bytes);

    let media: Anthropic.Beta.Messages.BetaContentBlockParam;
    if (mime === "application/pdf" || path.toLowerCase().endsWith(".pdf")) {
      media = { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
    } else if (IMAGE_TYPES.has(mime)) {
      media = { type: "image", source: { type: "base64", media_type: mime as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data } };
    } else {
      return json({ error: `不支援的檔案格式 ${mime || '(未知)'}，請改用 JPG、PNG 或 PDF（iPhone 的 HEIC 請先轉成 JPG）` }, 415);
    }

    const accountList = accounts.map((a) => `${a.code} ${a.name}`).join("\n");
    const client = new Anthropic(); // 讀取 ANTHROPIC_API_KEY
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { format: { type: "json_schema", schema: SCHEMA } },
      messages: [
        {
          role: "user",
          content: [
            media,
            { type: "text", text: `原始檔名：${String(body?.file_name ?? "")}\n\n可用的會計項目：\n${accountList || "（未提供）"}\n\n請擷取這張憑證的資料。` },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") return json({ error: "模型拒絕處理此影像", category: response.stop_details?.category ?? null }, 422);
    if (response.stop_reason === "max_tokens") return json({ error: "輸出被截斷，請重試" }, 502);
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    const result = JSON.parse(text);
    if (result.suggested_account && accounts.length && !accounts.some((a) => a.code === result.suggested_account)) result.suggested_account = null;
    return json({ ...result, model: response.model });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: "AI 服務忙碌中，請稍後再試" }, 429);
    if (err instanceof Anthropic.AuthenticationError) return json({ error: "ANTHROPIC_API_KEY 未設定或無效" }, 500);
    if (err instanceof Anthropic.BadRequestError) return json({ error: "AI 請求格式錯誤：" + err.message }, 400);
    if (err instanceof Anthropic.APIError) return json({ error: `AI 服務錯誤 ${err.status}` }, 502);
    return json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});
