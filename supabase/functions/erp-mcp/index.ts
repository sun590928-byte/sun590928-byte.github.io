// 午月 ERP 的 Claude 連接器（MCP，Streamable HTTP）
// 讓 claude.ai 的「自訂連接器」或 Claude Code 直接讀取待覆核的憑證照片、填好欄位、標記已覆核；
// 入帳仍在 ERP 按「全部入帳」執行，營業稅扣抵、重複發票、月份鎖定的規則只在 ERP 一處。
//
// 部署（一次）：Supabase 後台 → Edge Functions → Deploy a new function → Via editor
//   名稱建議 erp-mcp（用其他名稱也可以，在 ERP 設定填同樣的名稱），貼上本檔 → Deploy；
//   再到該函式的設定把「Verify JWT」關掉（claude.ai 無法附帶 Supabase 的 JWT）。
// 金鑰：在 ERP「設定與備份 → Claude 連接器」產生，存於 settings.value.mcp_token；也可用 Secrets 的 ERP_MCP_TOKEN 覆寫。
// 呼叫：Authorization: Bearer <金鑰>（Claude Code），或網址 …/erp-mcp/<金鑰>（claude.ai 自訂連接器）。
// 本函式以 service role 讀寫，但只碰 documents（待覆核者）、accounts、settings 與 documents 儲存空間。

import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const VERSION = "1.3.0";
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const PENDING = ["inbox", "reviewed"];
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const INVOICE_TYPES = ["電子發票", "三聯式發票", "收銀機發票", "二聯式發票", "收據", "其他"];
// 統一發票號碼：2 碼英文＋8 碼數字；公用事業（水電瓦斯電信）的載具發票為 BB＋8 碼英數
const INVOICE_NO_RE = /^(?:[A-Z]{2}\d{8}|BB[0-9A-Z]{8})$/;
const TAX_TYPES: Record<string, string> = { "1": "應稅", "2": "零稅率", "3": "免稅" };
const DED_CODES: Record<string, string> = { "1": "可扣抵之進貨及費用", "2": "可扣抵之固定資產", "3": "不可扣抵之進貨及費用", "4": "不可扣抵之固定資產" };
const NON_DEDUCTIBLE: Record<string, string> = { "6120": "交際費", "6127": "職工福利" };

// ─────────── 資料層（測試時換成假資料）

export type Account = { code: string; name: string; type: string; hint?: string | null; active?: boolean | null };
export type Doc = Record<string, unknown> & { id: string; status: string };
export interface DataLayer {
  settings(): Promise<Record<string, unknown>>;
  accounts(): Promise<Account[]>;
  pending(): Promise<Doc[]>;
  doc(id: string): Promise<Doc | null>;
  /** 只更新仍在待覆核狀態的憑證；已入帳者回傳 null */
  update(id: string, patch: Record<string, unknown>): Promise<Doc | null>;
  file(path: string): Promise<{ bytes: Uint8Array; mime: string } | null>;
}

function liveDb(): DataLayer {
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
  const check = (what: string, error: { message: string } | null) => {
    if (error) throw new Error(`${what}：${error.message}`);
  };
  return {
    async settings() {
      const { data, error } = await sb.from("settings").select("value").eq("id", "main").maybeSingle();
      check("讀取設定失敗", error);
      return (data?.value as Record<string, unknown>) ?? {};
    },
    async accounts() {
      const { data, error } = await sb.from("accounts").select("code,name,type,hint,active");
      check("讀取會計項目失敗", error);
      return (data ?? []) as Account[];
    },
    async pending() {
      const { data, error } = await sb.from("documents").select("*").in("status", PENDING).order("created_at", { ascending: true }).limit(500);
      check("讀取憑證失敗", error);
      return (data ?? []) as Doc[];
    },
    async doc(id) {
      const { data, error } = await sb.from("documents").select("*").eq("id", id).maybeSingle();
      check("讀取憑證失敗", error);
      return (data as Doc | null) ?? null;
    },
    async update(id, patch) {
      const { data, error } = await sb.from("documents").update(patch).eq("id", id).in("status", PENDING).select("*").maybeSingle();
      check("更新憑證失敗", error);
      return (data as Doc | null) ?? null;
    },
    async file(path) {
      const { data, error } = await sb.storage.from("documents").download(path);
      if (error || !data) return null;
      return { bytes: new Uint8Array(await data.arrayBuffer()), mime: data.type };
    },
  };
}

// ─────────── 工具

const INSTRUCTIONS = `你是「午月咖啡廳」的記帳助理，透過這個連接器幫老闆覆核支出憑證（發票、收據照片）。
流程：
1. 先呼叫 get_context 取得店家資料、可用的會計項目與規則。
2. list_pending_documents 列出待覆核憑證；逐張用 get_document_image 讀取照片。ERP 已在本機辨識過的憑證會附 local_review：sources 是各欄位來源（QR 碼最可靠），need_check 是規則找到要確認的地方，請優先核對這些。
3. 用 update_document 填入日期、廠商、統編、發票號碼、金額、稅額、摘要、會計項目、付款方式、可否扣抵；預設會標記為「已覆核」。
4. 看不清楚的欄位留空並寫在 notes，或直接問老闆；不要猜數字。
5. 全部處理完，提醒老闆回到 ERP「憑證歸檔」按「全部入帳」。
規則：
- 日期用西元 YYYY-MM-DD；民國年請 +1911（115/09/01 → 2026-09-01）。
- 統一發票號碼＝2 碼英文字軌 + 8 碼數字；收據沒有發票號碼。
- vendor_name：發票填賣方的公司全名（例如「範例電機有限公司」，看賣方名稱或統一發票專用章），不要只填簡稱；收據填收據上的店名。
- amount_total 是含稅總額；收據的金額以「合計新台幣」大寫金額為準（與阿拉伯數字不同時寫在 notes）。三聯式或載明買方統編的發票才有可扣抵的 tax_amount；二聯式、收據的稅額不填。
- 只有載明本店統編（get_context 會給）的統一發票，deductible 才是 true；交際費（6120）、職工福利（6127）用途一律不可扣抵。
- summary 是 10 字內的品項摘要，會用在歸檔檔名，例如「鮮乳4瓶」「咖啡豆2kg」。
- account 只能從 get_context 的清單選：咖啡豆、乳品、茶粉糖漿、甜點原料、包材屬於原料／存貨（12xx）；水電、電信、修繕、文具、運費屬於費用（61xx）；單價 8 萬元以上的設備屬於固定資產（15xx），未達 8 萬的器具列「雜項購置」。
- pay_account（付款方式）只能從 get_context 的「付款方式」清單選；檔案上傳時所在的資料夾（source_folder）就是付款來源：員工代墊支出→2134 員工代墊、負責人代墊支出→2133（名稱可能已改為負責人借款）、銀行名稱的資料夾→該銀行存款（依科目名稱比對）。綠界、LINE Pay 的手續費發票由撥款中扣除，付款方式選對應的「應收帳款－…未撥款項」（信用卡 1111、LINE Pay 1112）。
- 收銀機發票載明本店統編但沒有分開印稅額：tax_amount＝總額 ÷ 1.05 × 5%（四捨五入），可扣抵（課稅別 1、扣抵代號 1）。
- 申報代號：tax_type 課稅別（1 應稅、2 零稅率、3 免稅）、ded_code 扣抵代號（1 可扣抵進貨及費用、2 可扣抵固定資產、3 不可扣抵進貨及費用、4 不可扣抵固定資產）。老闆指定的代號優先；不確定就不要填，ERP 會依發票與科目自動判斷。
- 一張照片含多張發票（例如訂金＋尾款），或一筆款項分屬多個科目（例如多張代墊收據）時，用 lines 拆分：每行一張發票或一個科目，含稅金額合計要等於 amount_total。
- 老闆說「先不認列」「之後再說」的憑證，用 hold=true 標記暫緩，ERP「全部入帳」會略過。
- 這個連接器不能入帳、不能刪除、不能碰已入帳的憑證；這些都由 ERP 處理。`;

const TOOLS = [
  {
    name: "get_context",
    title: "取得店家資料與會計項目",
    description: "回傳店名、統一編號、營業稅類型、可用的會計項目（代號＋名稱＋用途）、付款方式，以及待覆核憑證張數。開始工作前先呼叫一次。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_pending_documents",
    title: "列出待覆核憑證",
    description: "列出還沒入帳的憑證（狀態為待覆核或已覆核）及目前已填的欄位。回傳 JSON：{ total, offset, items[] }。",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["all", "inbox", "reviewed"], description: "all＝全部待入帳（預設）；inbox＝尚未覆核；reviewed＝已覆核但未入帳" },
        offset: { type: "integer", minimum: 0, default: 0 },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_document_image",
    title: "讀取憑證照片",
    description: "取得一張憑證的照片（圖片）與目前欄位，供辨識。PDF 與 HEIC 無法透過連接器讀取，請改用 ERP 內的「AI 辨識」。",
    inputSchema: { type: "object", properties: { id: { type: "string", description: "憑證 id（list_pending_documents 的 items[].id）" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "update_document",
    title: "填寫憑證欄位",
    description: "更新一張待覆核憑證的欄位並標記為已覆核（可用 status 改為 inbox 或 ignored）。只給有把握的欄位；未提供的欄位維持原值。已入帳的憑證不能修改。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        kind: { type: "string", enum: ["invoice", "receipt", "other"], description: "invoice＝統一發票、receipt＝收據、other＝其他" },
        invoice_type: { type: "string", enum: INVOICE_TYPES },
        doc_date: { type: "string", description: "西元 YYYY-MM-DD（民國年 +1911）" },
        vendor_name: { type: "string", description: "賣方名稱：發票填公司全名（例如範例電機有限公司），收據填店名" },
        vendor_tax_id: { type: "string", description: "賣方統一編號 8 碼；沒有則空字串" },
        buyer_tax_id: { type: "string", description: "發票上載明的買方統一編號 8 碼；沒有則空字串" },
        invoice_no: { type: "string", description: "統一發票號碼，2 碼英文 + 8 碼數字；收據則空字串" },
        amount_total: { type: "number", description: "含稅總金額（新台幣元）" },
        tax_amount: { type: "number", description: "發票載明的營業稅額；未載明則 0" },
        summary: { type: "string", description: "10 字內品項摘要，用於檔名" },
        items: { type: "array", maxItems: 50, items: { type: "object", properties: { name: { type: "string" }, qty: { type: ["number", "null"] }, amount: { type: ["number", "null"] } }, required: ["name"] } },
        account: { type: "string", description: "會計項目代號（見 get_context）" },
        pay_account: { type: "string", description: "付款方式（付款來源）科目代號，見 get_context 的「付款方式」清單" },
        tax_type: { type: "string", enum: ["", "1", "2", "3"], description: "課稅別：1 應稅、2 零稅率、3 免稅；空字串＝ERP 自動判斷" },
        ded_code: { type: "string", enum: ["", "1", "2", "3", "4"], description: "扣抵代號：1 可扣抵進貨及費用、2 可扣抵固定資產、3 不可扣抵進貨及費用、4 不可扣抵固定資產；空字串＝ERP 自動判斷" },
        lines: {
          type: "array",
          maxItems: 30,
          description: "拆分明細（一張照片多張發票、或分屬多個科目時才用）；空陣列＝取消拆分",
          items: {
            type: "object",
            properties: {
              invoice_no: { type: "string" },
              account: { type: "string" },
              amount: { type: "number", description: "含稅金額" },
              tax: { type: "number", description: "這張發票的營業稅額；收據為 0" },
              tax_type: { type: "string", enum: ["", "1", "2", "3"] },
              ded_code: { type: "string", enum: ["", "1", "2", "3", "4"] },
              memo: { type: "string" },
            },
            required: ["account", "amount"],
          },
        },
        hold: { type: "boolean", description: "true＝暫緩入帳（老闆說先不認列時用）" },
        deductible: { type: "boolean", description: "進項稅額可否扣抵（載明本店統編的統一發票才可）" },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "整體把握度 0–1" },
        notes: { type: "string", description: "看不清楚或需老闆確認之處" },
        status: { type: "string", enum: ["reviewed", "inbox", "ignored"], description: "預設 reviewed；ignored＝不是支出憑證（例如重複、模糊）" },
      },
      required: ["id"],
      additionalProperties: false,
    },
  },
];

type Ctx = { db: DataLayer; settings?: Record<string, unknown>; accounts?: Account[] };
type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const fail = (t: string): ToolResult => ({ content: [{ type: "text", text: t }], isError: true });

async function getSettings(ctx: Ctx) {
  return (ctx.settings ??= await ctx.db.settings());
}
async function getAccounts(ctx: Ctx) {
  return (ctx.accounts ??= await ctx.db.accounts());
}
// 全部啟用中的會計項目都可選（1 資產 … 8 所得稅），和 ERP 的下拉選單一致
function docAccounts(accounts: Account[]) {
  return accounts.filter((a) => a.active !== false).sort((a, b) => (a.code < b.code ? -1 : 1));
}
// 付款來源：現金、零用金、銀行存款（110x）、金流未撥款項（111x）、應付帳款、代墊（其他應付款）、業主往來
function isPayAccount(a: Account) {
  if (a.active === false) return false;
  if (a.type === "asset") return /^11[01]\d$/.test(a.code);
  // 依代號判斷（老闆會改名，例如 2133 改成「負責人借款」）：2111、2133～2139 其他應付款、2191；名稱有代墊、往來的也算
  if (a.type === "liability") return ["2111", "2191"].includes(a.code) || /^213[3-9]$/.test(a.code) || /代墊|往來/.test(a.name ?? "");
  return false;
}
function payAccounts(accounts: Account[]) {
  return accounts.filter(isPayAccount).sort((a, b) => (a.code < b.code ? -1 : 1));
}
function extraOf(d: Doc) {
  return ((d.extra ?? {}) as Record<string, unknown>) || {};
}
function isPendingDoc(d: Doc) {
  return PENDING.includes(d.status) && d.kind !== "payout_statement";
}

function docSummary(d: Doc, accounts: Account[]) {
  const acc = accounts.find((a) => a.code === d.account);
  const mime = String(d.mime ?? "");
  return {
    id: d.id,
    file: d.original_name ?? "",
    status: d.status,
    has_image: !!d.storage_path && IMAGE_TYPES.has(mime),
    mime,
    kind: d.kind ?? "receipt",
    invoice_type: d.invoice_type ?? "",
    doc_date: d.doc_date ?? null,
    vendor_name: d.vendor_name ?? "",
    vendor_tax_id: d.vendor_tax_id ?? "",
    buyer_tax_id: d.buyer_tax_id ?? "",
    invoice_no: d.invoice_no ?? null,
    amount_total: d.amount_total ?? null,
    tax_amount: d.tax_amount ?? null,
    summary: d.summary ?? "",
    account: d.account ?? "",
    account_name: acc?.name ?? "",
    pay_account: d.pay_account ?? "1101",
    deductible: d.deductible ?? null,
    confidence: d.confidence ?? null,
    reviewed_by_ai: !!d.ai,
    asset_id: d.asset_id ?? null,
    source_folder: d.source_folder ?? extraOf(d).source_folder ?? "",
    tax_type: d.tax_type ?? extraOf(d).tax_type ?? "",
    ded_code: d.ded_code ?? extraOf(d).ded_code ?? "",
    hold: !!(d.hold ?? extraOf(d).hold),
    lines: (d.lines ?? extraOf(d).lines ?? null) as unknown,
    notes: (d.ai as { notes?: string } | null)?.notes ?? "",
    // ERP 本機辨識（QR 碼／文字辨識／自動覆核規則）的結果：need_check 是規則找到要人工確認的地方，覆核時優先看
    local_review: (() => {
      const auto = (d.auto ?? extraOf(d).auto) as { confidence?: number; reasons?: string[]; sources?: Record<string, string> } | undefined;
      if (!auto) return null;
      return { by: d.reviewed_by ?? extraOf(d).reviewed_by ?? null, confidence: auto.confidence ?? null, need_check: (d.review_issues ?? extraOf(d).review_issues ?? []) as unknown, reasons: auto.reasons ?? [], sources: auto.sources ?? {} };
    })(),
  };
}

// 統一編號檢查碼（2023 起除數改為 5，並相容舊制）
function isValidTaxId(id: string) {
  if (!/^\d{8}$/.test(id)) return false;
  const w = [1, 2, 1, 2, 1, 2, 4, 1];
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    const p = Number(id[i]) * w[i];
    sum += Math.floor(p / 10) + (p % 10);
  }
  return sum % 5 === 0 || (id[6] === "7" && (sum + 1) % 5 === 0);
}

function normalizeDate(v: unknown): string | null {
  const s = String(v ?? "").trim().normalize("NFKC");
  const m = /^(\d{2,4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(s);
  if (!m) return null;
  let y = Number(m[1]);
  if (y < 1000) y += 1911;
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** 檢查並整理 update_document 的參數 */
export function buildPatch(args: Record<string, unknown>, accounts: Account[], settings: Record<string, unknown>, current: Doc) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const patch: Record<string, unknown> = {};
  const has = (k: string) => args[k] !== undefined && args[k] !== null;

  if (has("kind")) patch.kind = String(args.kind);
  if (has("invoice_type")) {
    if (!INVOICE_TYPES.includes(String(args.invoice_type))) errors.push(`invoice_type 必須是：${INVOICE_TYPES.join("、")}`);
    else patch.invoice_type = String(args.invoice_type);
  }
  if (has("doc_date")) {
    const d = normalizeDate(args.doc_date);
    if (!d) errors.push("doc_date 格式須為 YYYY-MM-DD");
    else patch.doc_date = d;
  }
  if (has("vendor_name")) patch.vendor_name = String(args.vendor_name).trim().slice(0, 60);
  for (const k of ["vendor_tax_id", "buyer_tax_id"]) {
    if (!has(k)) continue;
    const v = String(args[k]).replace(/\D/g, "");
    if (v && v.length !== 8) errors.push(`${k} 必須是 8 碼數字`);
    else {
      if (v && !isValidTaxId(v)) warnings.push(`${k} ${v} 檢查碼不符，請再看一次`);
      patch[k] = v;
    }
  }
  if (has("invoice_no")) {
    const v = String(args.invoice_no).normalize("NFKC").toUpperCase().replace(/[\s-]/g, "");
    if (v && !INVOICE_NO_RE.test(v)) errors.push("invoice_no 須為 2 碼英文 + 8 碼數字（公用事業載具發票為 BB＋8 碼；收據請留空）");
    else patch.invoice_no = v || null;
  }
  if (has("amount_total")) {
    const n = Number(args.amount_total);
    if (!Number.isFinite(n) || n < 0) errors.push("amount_total 必須是 0 以上的數字");
    else patch.amount_total = round2(n);
  }
  if (has("tax_amount")) {
    const n = Number(args.tax_amount);
    if (!Number.isFinite(n) || n < 0) errors.push("tax_amount 必須是 0 以上的數字");
    else patch.tax_amount = round2(n);
  }
  const total = (patch.amount_total ?? current.amount_total) as number | null;
  const tax = (patch.tax_amount ?? current.tax_amount) as number | null;
  if (total != null && tax != null && tax > total) errors.push("tax_amount 不能大於 amount_total");
  if (total != null && tax != null && tax > 0 && Math.abs(tax - Math.round(total - total / 1.05)) > Math.max(2, total * 0.01)) warnings.push(`稅額 ${tax} 與含稅總額 ${total} 的 5% 內含（約 ${Math.round(total - total / 1.05)}）差距較大，請確認`);
  if (has("summary")) patch.summary = String(args.summary).trim().slice(0, 20);
  if (has("items")) {
    const list = Array.isArray(args.items) ? args.items.slice(0, 50) : null;
    if (!list) errors.push("items 必須是陣列");
    else patch.items = list.map((x) => ({ name: String((x as { name?: unknown })?.name ?? "").slice(0, 60), qty: numOrNull((x as { qty?: unknown })?.qty), amount: numOrNull((x as { amount?: unknown })?.amount) }));
  }
  if (has("account")) {
    const code = String(args.account).trim();
    const acc = docAccounts(accounts).find((a) => a.code === code);
    if (!acc) errors.push(`account ${code} 不在可用的會計項目清單（請用 get_context 查）`);
    else patch.account = code;
  }
  if (has("pay_account")) {
    const code = String(args.pay_account).trim();
    const pays = payAccounts(accounts);
    if (!pays.some((a) => a.code === code)) errors.push(`pay_account 必須是：${pays.map((a) => `${a.code} ${a.name}`).join("、")}`);
    else patch.pay_account = code;
  }
  if (has("deductible")) patch.deductible = !!args.deductible;
  // 以下欄位存在 extra（jsonb），不需要改資料表
  const extra: Record<string, unknown> = {};
  for (const [k, list] of [["tax_type", TAX_TYPES], ["ded_code", DED_CODES]] as const) {
    if (!has(k)) continue;
    const v = String(args[k]).trim();
    if (v && !list[v]) errors.push(`${k} 必須是：${Object.keys(list).join("、")} 或空字串`);
    else extra[k] = v;
  }
  if (has("hold")) extra.hold = !!args.hold;
  if (has("lines")) {
    const list = Array.isArray(args.lines) ? args.lines.slice(0, 30) : null;
    if (!list) errors.push("lines 必須是陣列");
    else if (!list.length) extra.lines = null;
    else {
      const codes = new Set(docAccounts(accounts).map((a) => a.code));
      const rows = list.map((x, i) => {
        const r = x as Record<string, unknown>;
        const no = String(r.invoice_no ?? "").normalize("NFKC").toUpperCase().replace(/[\s-]/g, "");
        const row = { invoice_no: no, account: String(r.account ?? "").trim(), amount: round2(Number(r.amount)), tax: round2(Number(r.tax ?? 0)), tax_type: String(r.tax_type ?? ""), ded_code: String(r.ded_code ?? ""), memo: String(r.memo ?? "").slice(0, 40) };
        if (!codes.has(row.account)) errors.push(`lines 第 ${i + 1} 行：科目 ${row.account} 不在清單`);
        if (!(row.amount > 0)) errors.push(`lines 第 ${i + 1} 行：含稅金額要大於 0`);
        if (!(row.tax >= 0) || row.tax > row.amount) errors.push(`lines 第 ${i + 1} 行：稅額不合理`);
        if (no && !INVOICE_NO_RE.test(no)) errors.push(`lines 第 ${i + 1} 行：發票號碼 ${no} 格式不對`);
        if (row.tax_type && !TAX_TYPES[row.tax_type]) errors.push(`lines 第 ${i + 1} 行：tax_type 不對`);
        if (row.ded_code && !DED_CODES[row.ded_code]) errors.push(`lines 第 ${i + 1} 行：ded_code 不對`);
        return row;
      });
      const sum = round2(rows.reduce((t, r) => t + (r.amount || 0), 0));
      const target = (patch.amount_total ?? current.amount_total) as number | null;
      if (target != null && Math.abs(sum - target) >= 1) errors.push(`lines 含稅金額合計 ${sum} 不等於 amount_total ${target}（要改總額請一併給 amount_total）`);
      extra.lines = rows;
      if (!has("tax_amount")) patch.tax_amount = round2(rows.reduce((t, r) => t + (r.tax || 0), 0));
      if (!has("invoice_no")) patch.invoice_no = rows.find((r) => r.invoice_no)?.invoice_no ?? current.invoice_no ?? null;
    }
  }
  if (has("confidence")) {
    const n = Number(args.confidence);
    patch.confidence = Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5;
  }
  if (has("status")) {
    const s = String(args.status);
    if (!["reviewed", "inbox", "ignored"].includes(s)) errors.push("status 必須是 reviewed、inbox 或 ignored");
    else patch.status = s;
  } else patch.status = "reviewed";

  // 扣抵規則：買方統編不是本店、二聯式／收據、交際費／職工福利 → 不可扣抵；老闆指定的扣抵代號優先
  const shopTaxId = String(settings.tax_id ?? "").trim();
  const buyer = (patch.buyer_tax_id ?? current.buyer_tax_id ?? "") as string;
  const invoiceType = (patch.invoice_type ?? current.invoice_type ?? "") as string;
  const account = (patch.account ?? current.account ?? "") as string;
  const invoiceNo = (patch.invoice_no ?? current.invoice_no ?? null) as string | null;
  const dedCode = String(extra.ded_code ?? extraOf(current).ded_code ?? "");
  // 收銀機發票載明本店統編、沒有分開印稅額：稅額＝總額 ÷ 1.05 × 5%
  if (!has("tax_amount") && !extra.lines && /收銀機/.test(invoiceType) && invoiceNo && shopTaxId && buyer === shopTaxId && !(Number(tax) > 0) && Number(total) > 0) {
    patch.tax_amount = Math.round(Number(total) - Number(total) / 1.05);
    warnings.push(`收銀機發票未印稅額，依總額推算稅額 ${patch.tax_amount}`);
  }
  const taxNow = (patch.tax_amount ?? tax) as number | null;
  if (dedCode === "3" || dedCode === "4") {
    if (patch.deductible === true) warnings.push(`扣抵代號 ${dedCode} 為不可扣抵，deductible 改為 false`);
    patch.deductible = false;
  } else if ((dedCode === "1" || dedCode === "2") && invoiceNo && Number(taxNow) > 0) {
    patch.deductible = true;
  } else if (patch.deductible === true || (patch.deductible === undefined && taxNow != null && taxNow > 0)) {
    let why = "";
    if (!invoiceNo) why = "沒有統一發票號碼";
    else if (/二聯|收據/.test(invoiceType)) why = `${invoiceType}不能扣抵`;
    else if (NON_DEDUCTIBLE[account]) why = `${NON_DEDUCTIBLE[account]}用途不得扣抵`;
    else if (shopTaxId && buyer && buyer !== shopTaxId) why = `買方統編 ${buyer} 不是本店（${shopTaxId}）`;
    else if (shopTaxId && !buyer) why = "未載明買方統編";
    if (why) {
      patch.deductible = false;
      warnings.push(`進項稅額改為不扣抵：${why}`);
    } else if (patch.deductible === undefined) patch.deductible = true;
  }
  if (patch.deductible === undefined && taxNow === 0) patch.deductible = false;
  // Claude 覆核過：清掉 ERP 本機辨識標的「需確認」，ERP 的廠商資料庫也會學這張
  extra.reviewed_by = "claude";
  if (patch.status === "reviewed") extra.review_issues = [];
  if (Object.keys(extra).length) patch.extra = { ...extraOf(current), ...extra };

  patch.ai = { source: "claude-connector", notes: has("notes") ? String(args.notes).slice(0, 800) : ((current.ai as { notes?: string } | null)?.notes ?? ""), at: new Date().toISOString() };
  patch.updated_at = new Date().toISOString();
  return { patch, errors, warnings };
}

function numOrNull(v: unknown) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function callTool(name: string, args: Record<string, unknown>, ctx: Ctx): Promise<ToolResult> {
  switch (name) {
    case "get_context": {
      const s = await getSettings(ctx);
      const accounts = docAccounts(await getAccounts(ctx));
      const pending = (await ctx.db.pending()).filter(isPendingDoc);
      const vat = { general: "一般稅額（開立統一發票，5% 內含）", small: "小規模營業人（查定課徵，進項不扣抵）", none: "免稅／不適用" }[String(s.vat_mode ?? "general")] ?? String(s.vat_mode);
      const lines = [
        `店名：${s.business_name ?? "午月咖啡廳"}`,
        `本店統一編號：${s.tax_id || "（未設定，無法判斷買方統編是否為本店）"}`,
        `營業稅類型：${vat}`,
        `待覆核憑證：${pending.length} 張（其中 ${pending.filter((d) => d.status === "inbox").length} 張尚未覆核）`,
        "",
        "可用的會計項目（代號 名稱｜用途）：",
        ...accounts.map((a) => `- ${a.code} ${a.name}${a.hint ? `｜${a.hint}` : ""}`),
        "",
        "付款方式（pay_account，依科目表）：",
        ...payAccounts(await getAccounts(ctx)).map((a) => `- ${a.code} ${a.name}`),
        "",
        "扣抵規則：只有載明本店統編的統一發票（電子發票證明聯、三聯式、收銀機發票）進項稅額可扣抵；二聯式、收據、交際費（6120）、職工福利（6127）不可扣抵。",
        "申報代號：課稅別 tax_type（1 應稅、2 零稅率、3 免稅）；扣抵代號 ded_code（1 可扣抵進貨及費用、2 可扣抵固定資產、3 不可扣抵進貨及費用、4 不可扣抵固定資產）。",
      ];
      return text(lines.join("\n"));
    }
    case "list_pending_documents": {
      const accounts = await getAccounts(ctx);
      const status = String(args.status ?? "all");
      const offset = Math.max(0, Number(args.offset) || 0);
      const limit = Math.min(200, Math.max(1, Number(args.limit) || 50));
      const all = (await ctx.db.pending()).filter(isPendingDoc).filter((d) => status === "all" || d.status === status);
      const items = all.slice(offset, offset + limit).map((d) => docSummary(d, accounts));
      return text(JSON.stringify({ total: all.length, offset, count: items.length, items }, null, 1));
    }
    case "get_document_image": {
      const id = String(args.id ?? "");
      const d = id ? await ctx.db.doc(id) : null;
      if (!d) return fail(`找不到憑證 ${id}`);
      if (!isPendingDoc(d)) return fail(`憑證 ${id} 已入帳或不是支出憑證，連接器不提供`);
      const path = String(d.storage_path ?? "");
      if (!path) return fail("這張憑證的照片只存在使用者的裝置（本機模式上傳），雲端沒有檔案；請在 ERP「設定與備份」按「把本機資料上傳到雲端」");
      const f = await ctx.db.file(path);
      if (!f) return fail("讀取照片失敗（檔案不存在）");
      const mime = f.mime || String(d.mime ?? "");
      if (!IMAGE_TYPES.has(mime)) return fail(`檔案格式 ${mime || "未知"} 無法透過連接器讀取（PDF、HEIC 請在 ERP 用「AI 辨識」）`);
      if (f.bytes.length > MAX_IMAGE_BYTES) return fail(`照片 ${(f.bytes.length / 1048576).toFixed(1)} MB 太大，請在 ERP 重新上傳（會自動縮圖）`);
      const accounts = await getAccounts(ctx);
      const s = await getSettings(ctx);
      const cur = docSummary(d, accounts);
      const hint = [
        `憑證 ${d.id}（檔名：${cur.file}）目前欄位：`,
        JSON.stringify(cur, null, 1),
        `本店統編：${s.tax_id || "（未設定）"}。請辨識照片後用 update_document 填入正確欄位；看不清楚的不要猜。`,
      ].join("\n");
      return { content: [{ type: "image", data: toBase64(f.bytes), mimeType: mime }, { type: "text", text: hint }] };
    }
    case "update_document": {
      const id = String(args.id ?? "");
      const current = id ? await ctx.db.doc(id) : null;
      if (!current) return fail(`找不到憑證 ${id}`);
      if (!isPendingDoc(current)) return fail(`憑證 ${id} 已入帳（或不是支出憑證），連接器不能修改；請老闆在 ERP 處理`);
      const { patch, errors, warnings } = buildPatch(args, await getAccounts(ctx), await getSettings(ctx), current);
      if (errors.length) return fail("欄位有誤，未更新：\n- " + errors.join("\n- "));
      const updated = await ctx.db.update(id, patch);
      if (!updated) return fail(`憑證 ${id} 剛剛已被入帳，未更新`);
      const cur = docSummary(updated, await getAccounts(ctx));
      const out = [`已更新憑證 ${id}（狀態：${cur.status}）`, JSON.stringify(cur, null, 1)];
      if (warnings.length) out.push("提醒：\n- " + warnings.join("\n- "));
      if (cur.asset_id) out.push("這張是固定資產的購置發票，入帳會連結到資產的購置分錄。");
      return text(out.join("\n"));
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

// ─────────── JSON-RPC（Streamable HTTP：POST 一問一答，不開 SSE 串流）

type Rpc = { jsonrpc?: string; id?: unknown; method?: unknown; params?: Record<string, unknown> };

async function handleRpc(msg: Rpc, ctx: Ctx): Promise<Record<string, unknown> | null> {
  const id = msg.id ?? null;
  const reply = (result: unknown) => ({ jsonrpc: "2.0", id, result });
  const error = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const method = msg.method;
  if (typeof method !== "string") return error(-32600, "Invalid Request");
  if (method.startsWith("notifications/")) return null;
  const params = msg.params ?? {};
  switch (method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return reply({
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "wuyue-erp", title: "午月營運帳務系統", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      try {
        return reply(await callTool(name, args, ctx));
      } catch (e) {
        const err = e as { code?: number; message?: string };
        if (err.code === -32602) return error(-32602, err.message ?? "Invalid params");
        return reply(fail("執行失敗：" + (err.message ?? String(e))));
      }
    }
    case "resources/list":
      return reply({ resources: [] });
    case "resources/templates/list":
      return reply({ resourceTemplates: [] });
    case "prompts/list":
      return reply({ prompts: [] });
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

// ─────────── HTTP

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, mcp-session-id", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, ...headers, "Content-Type": "application/json; charset=utf-8" } });

function timingSafeEqual(a: string, b: string) {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.length !== y.length || !x.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export function createHandler(db: DataLayer) {
  const inner = handlerCore(db);
  // 任何未預期的錯誤都回 JSON（帶 CORS 標頭），瀏覽器才看得到原因，不會變成「連不到函式」
  return async (req: Request): Promise<Response> => {
    try {
      return await inner(req);
    } catch (e) {
      console.error(e);
      return json({ error: "函式執行錯誤：" + ((e as Error)?.message ?? String(e)) }, 500);
    }
  };
}

function handlerCore(db: DataLayer) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    // 路徑形狀不固定：Supabase 交給函式時可能是 /functions/v1/<名稱>/…、/<名稱>/…，甚至只剩 /…
    // 所以不靠位置：最後一段是 health／version 就是該路由；金鑰則看路徑裡有沒有任一段等於金鑰。
    let segs = url.pathname.split("/").filter(Boolean);
    if (segs[0] === "functions" && segs[1] === "v1") segs = segs.slice(2);
    const last = segs[segs.length - 1] ?? "";
    if (last === "version") return json({ name: "wuyue-erp", version: VERSION }); // 公開：只回版本，供 ERP 與部署檢查用
    const health = last === "health";

    let expected: string;
    try {
      expected = Deno.env.get("ERP_MCP_TOKEN") || String((await db.settings()).mcp_token ?? "");
    } catch (e) {
      return json({ error: "無法讀取設定：" + (e as Error).message }, 500);
    }
    if (!expected) return json({ error: "尚未設定連接器金鑰：請到 ERP「設定與備份 → Claude 連接器」產生" }, 503);
    // 金鑰：Authorization: Bearer、?token=，或網址路徑中的一段（claude.ai 自訂連接器用）
    const auth = req.headers.get("authorization") ?? "";
    const presented = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, "").trim() : url.searchParams.get("token") || "";
    const authorized = presented ? timingSafeEqual(presented, expected) : segs.some((s) => timingSafeEqual(s, expected));
    if (!authorized) return json({ error: "連接器金鑰不正確" }, 401);

    if (health) {
      const s = await db.settings();
      const pending = (await db.pending()).filter(isPendingDoc);
      return json({ ok: true, business: s.business_name ?? "", pending: pending.length, inbox: pending.filter((d) => d.status === "inbox").length, version: VERSION });
    }
    if (req.method === "GET") return new Response("此連接器不提供 SSE 串流，請用 POST", { status: 405, headers: { ...CORS, Allow: "POST, DELETE, OPTIONS" } });
    if (req.method === "DELETE") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { ...CORS, Allow: "POST, DELETE, OPTIONS" } });

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const msgs = (Array.isArray(body) ? body : [body]) as Rpc[];
    const ctx: Ctx = { db };
    const out: Record<string, unknown>[] = [];
    for (const m of msgs) {
      const r = await handleRpc(m ?? {}, ctx);
      if (r) out.push(r);
    }
    if (!out.length) return new Response(null, { status: 202, headers: CORS });
    return json(Array.isArray(body) ? out : out[0]);
  };
}

if (Deno.env.get("ERP_MCP_NO_SERVE") !== "1") Deno.serve(createHandler(liveDb()));
