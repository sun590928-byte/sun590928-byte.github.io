// erp-mcp 的測試：用假資料層驗證金鑰、JSON-RPC 流程與四個工具。
// 執行：ERP_MCP_NO_SERVE=1 deno test -A supabase/functions/erp-mcp/test.ts
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

Deno.env.set("ERP_MCP_NO_SERVE", "1");
const { createHandler, buildPatch } = await import("./index.ts");
import type { DataLayer, Doc, Account } from "./index.ts";

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
const ACCOUNTS: Account[] = [
  { code: "1101", name: "庫存現金（收銀機）", type: "asset", active: true },
  { code: "1212", name: "存貨－乳品", type: "asset", hint: "鮮奶、燕麥奶", active: true },
  { code: "1521", name: "營業設備", type: "asset", active: true },
  { code: "4101", name: "銷貨收入－咖啡飲品", type: "revenue", active: true },
  { code: "6111", name: "租金支出", type: "expense", active: true },
  { code: "6120", name: "交際費", type: "expense", active: true },
  { code: "6199", name: "其他費用", type: "expense", active: false },
];

function fakeDb(opts: { token?: string | null } = {}): DataLayer & { docs: Doc[] } {
  const docs: Doc[] = [
    { id: "doc_1", status: "inbox", kind: "receipt", original_name: "20260902_全聯_鮮乳2瓶_356.jpg", mime: "image/png", storage_path: "inbox/doc_1.png", doc_date: "2026-09-02", vendor_name: "全聯", amount_total: 356, account: "1212", created_at: "2026-09-02T01:00:00Z" },
    { id: "doc_2", status: "reviewed", kind: "receipt", original_name: "scan.pdf", mime: "application/pdf", storage_path: "inbox/doc_2.pdf", created_at: "2026-09-03T01:00:00Z" },
    { id: "doc_3", status: "posted", kind: "receipt", original_name: "old.jpg", mime: "image/jpeg", storage_path: "archive/2026/08/doc_3.jpg", entry_id: "je_1", created_at: "2026-08-20T01:00:00Z" },
    { id: "doc_4", status: "inbox", kind: "payout_statement", original_name: "linepay.jpg", mime: "image/jpeg", storage_path: "inbox/doc_4.jpg", created_at: "2026-09-04T01:00:00Z" },
  ];
  const settings: Record<string, unknown> = { business_name: "午月咖啡廳", tax_id: "12345675", vat_mode: "general" };
  if (opts.token !== null) settings.mcp_token = opts.token ?? "test-token-abc";
  return {
    docs,
    settings: () => Promise.resolve(settings),
    accounts: () => Promise.resolve(ACCOUNTS),
    pending: () => Promise.resolve(docs.filter((d) => ["inbox", "reviewed"].includes(d.status))),
    doc: (id) => Promise.resolve(docs.find((d) => d.id === id) ?? null),
    update: (id, patch) => {
      const d = docs.find((x) => x.id === id && ["inbox", "reviewed"].includes(x.status));
      if (!d) return Promise.resolve(null);
      Object.assign(d, patch);
      return Promise.resolve(d);
    },
    file: (path) => Promise.resolve(path === "inbox/doc_1.png" ? { bytes: PNG, mime: "image/png" } : path === "inbox/doc_2.pdf" ? { bytes: PNG, mime: "application/pdf" } : null),
  };
}

const BASE = "https://x.supabase.co/functions/v1/erp-mcp";
const rpc = (h: (r: Request) => Promise<Response>, body: unknown, init: { url?: string; headers?: Record<string, string> } = {}) =>
  h(new Request(init.url ?? BASE, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer test-token-abc", ...(init.headers ?? {}) }, body: JSON.stringify(body) }));
const call = async (h: (r: Request) => Promise<Response>, name: string, args: Record<string, unknown> = {}) => {
  const res = await rpc(h, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } });
  assertEquals(res.status, 200);
  return (await res.json()).result as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
};

Deno.test("金鑰：header、路徑、query 都可以；錯誤或未設定會擋下", async () => {
  const h = createHandler(fakeDb());
  const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
  assertEquals((await rpc(h, ping)).status, 200);
  assertEquals((await h(new Request(BASE + "/test-token-abc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ping) }))).status, 200);
  assertEquals((await h(new Request(BASE + "?token=test-token-abc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ping) }))).status, 200);
  assertEquals((await rpc(h, ping, { headers: { authorization: "Bearer wrong" } })).status, 401);
  assertEquals((await h(new Request(BASE, { method: "POST", body: JSON.stringify(ping) }))).status, 401);
  const noToken = createHandler(fakeDb({ token: null }));
  assertEquals((await rpc(noToken, ping)).status, 503);
  // health
  const hr = await h(new Request(BASE + "/test-token-abc/health"));
  assertEquals(hr.status, 200);
  const hj = await hr.json();
  assertEquals(hj.ok, true);
  assertEquals(hj.pending, 2, "撥款截圖與已入帳者不算待覆核");
  assertEquals(hj.inbox, 1);
  // 沒有 SSE：GET 回 405；DELETE 結束工作階段
  assertEquals((await h(new Request(BASE, { headers: { authorization: "Bearer test-token-abc" } }))).status, 405);
  assertEquals((await h(new Request(BASE, { method: "DELETE", headers: { authorization: "Bearer test-token-abc" } }))).status, 204);
});

Deno.test("JSON-RPC：initialize、tools/list、通知、批次、未知方法", async () => {
  const h = createHandler(fakeDb());
  const init = await (await rpc(h, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "0" } } })).json();
  assertEquals(init.result.protocolVersion, "2025-03-26");
  assertEquals(init.result.serverInfo.name, "wuyue-erp");
  assert(init.result.instructions.includes("全部入帳"));
  const unknownVer = await (await rpc(h, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json();
  assertEquals(unknownVer.result.protocolVersion, "2025-06-18");
  assertEquals((await rpc(h, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  const tools = await (await rpc(h, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json();
  assertEquals(tools.result.tools.map((t: { name: string }) => t.name), ["get_context", "list_pending_documents", "get_document_image", "update_document"]);
  const batch = await (await rpc(h, [{ jsonrpc: "2.0", id: 4, method: "ping" }, { jsonrpc: "2.0", id: 5, method: "nope" }])).json();
  assertEquals(batch.length, 2);
  assertEquals(batch[1].error.code, -32601);
  const bad = await rpc(h, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope", arguments: {} } });
  assertEquals((await bad.json()).error.code, -32602);
  const parse = await h(new Request(BASE, { method: "POST", headers: { authorization: "Bearer test-token-abc" }, body: "{not json" }));
  assertEquals(parse.status, 400);
});

Deno.test("get_context 與 list_pending_documents", async () => {
  const h = createHandler(fakeDb());
  const ctx = await call(h, "get_context");
  const t = ctx.content[0].text!;
  assert(t.includes("12345675") && t.includes("6111 租金支出") && t.includes("1212 存貨－乳品｜鮮奶、燕麥奶"));
  assert(!t.includes("4101"), "收入科目不列");
  assert(!t.includes("6199"), "停用科目不列");
  assert(t.includes("待覆核憑證：2 張"));
  const list = JSON.parse((await call(h, "list_pending_documents")).content[0].text!);
  assertEquals(list.total, 2);
  assertEquals(list.items[0].id, "doc_1");
  assertEquals(list.items[0].has_image, true);
  assertEquals(list.items[0].account_name, "存貨－乳品");
  assertEquals(list.items[1].has_image, false, "PDF 不算可讀圖片");
  const inbox = JSON.parse((await call(h, "list_pending_documents", { status: "inbox" })).content[0].text!);
  assertEquals(inbox.total, 1);
  const paged = JSON.parse((await call(h, "list_pending_documents", { offset: 1, limit: 1 })).content[0].text!);
  assertEquals(paged.items.map((x: { id: string }) => x.id), ["doc_2"]);
});

Deno.test("get_document_image：圖片回傳 base64；PDF、已入帳、不存在都拒絕", async () => {
  const h = createHandler(fakeDb());
  const img = await call(h, "get_document_image", { id: "doc_1" });
  assert(!img.isError);
  assertEquals(img.content[0].type, "image");
  assertEquals(img.content[0].mimeType, "image/png");
  assertEquals(img.content[0].data, btoa(String.fromCharCode(...PNG)));
  assert(img.content[1].text!.includes("全聯"));
  assert((await call(h, "get_document_image", { id: "doc_2" })).isError, "PDF");
  assert((await call(h, "get_document_image", { id: "doc_3" })).isError, "已入帳");
  assert((await call(h, "get_document_image", { id: "doc_4" })).isError, "撥款截圖");
  assert((await call(h, "get_document_image", { id: "nope" })).isError);
});

Deno.test("update_document：驗證、扣抵規則、只改待覆核", async () => {
  const db = fakeDb();
  const h = createHandler(db);
  const bad = await call(h, "update_document", { id: "doc_1", invoice_no: "ABC123", account: "4101", doc_date: "2026/13/01" });
  assert(bad.isError);
  assertMatch(bad.content[0].text!, /invoice_no/);
  assertMatch(bad.content[0].text!, /account 4101/);
  assertMatch(bad.content[0].text!, /doc_date/);
  assertEquals(db.docs[0].status, "inbox", "驗證失敗不更新");

  const ok = await call(h, "update_document", { id: "doc_1", doc_date: "115/09/02", vendor_name: "全聯福利中心", vendor_tax_id: "12345675", buyer_tax_id: "12345675", invoice_type: "電子發票", invoice_no: "ab-12345678", amount_total: 356, tax_amount: 17, summary: "鮮乳2瓶", account: "1212", pay_account: "1103", confidence: 0.9, notes: "" });
  assert(!ok.isError, ok.content[0].text);
  const d = db.docs[0];
  assertEquals(d.status, "reviewed");
  assertEquals(d.doc_date, "2026-09-02");
  assertEquals(d.invoice_no, "AB12345678");
  assertEquals(d.deductible, true);
  assertEquals((d.ai as { source: string }).source, "claude-connector");

  // 買方統編不是本店 → 不可扣抵並提醒
  const other = await call(h, "update_document", { id: "doc_1", buyer_tax_id: "87654321", tax_amount: 17 });
  assertMatch(other.content[0].text!, /不是本店/);
  assertEquals(db.docs[0].deductible, false);
  // 交際費 → 不可扣抵
  await call(h, "update_document", { id: "doc_1", buyer_tax_id: "12345675", account: "6120", deductible: true });
  assertEquals(db.docs[0].deductible, false);
  // 收據：沒有發票號碼、稅額 0
  const receipt = await call(h, "update_document", { id: "doc_2", invoice_type: "收據", invoice_no: "", amount_total: 120, tax_amount: 0, account: "6111", status: "reviewed" });
  assert(!receipt.isError, receipt.content[0].text);
  assertEquals(db.docs[1].invoice_no, null);
  assertEquals(db.docs[1].deductible, false);
  // ignored
  await call(h, "update_document", { id: "doc_2", status: "ignored", notes: "重複的照片" });
  assertEquals(db.docs[1].status, "ignored");
  // 已入帳不能改
  assert((await call(h, "update_document", { id: "doc_3", vendor_name: "x" })).isError);
  assertEquals(db.docs[2].vendor_name, undefined);
});

Deno.test("buildPatch：稅額與總額不合理會提醒", () => {
  const r = buildPatch({ amount_total: 1000, tax_amount: 300, invoice_no: "AB12345678", buyer_tax_id: "12345675" }, ACCOUNTS, { tax_id: "12345675" }, { id: "x", status: "inbox" });
  assertEquals(r.errors, []);
  assert(r.warnings.some((w) => w.includes("差距較大")));
  const r2 = buildPatch({ amount_total: 100, tax_amount: 200 }, ACCOUNTS, {}, { id: "x", status: "inbox" });
  assert(r2.errors.some((e) => e.includes("不能大於")));
});
