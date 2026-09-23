-- 午月營運帳務系統：Supabase 初始結構（由 tools/gen-schema.mjs 產生，請勿手改表格欄位）
-- 套用：Supabase Dashboard → SQL Editor 貼上執行，或 supabase db push
-- 安全模型：所有資料表啟用 RLS，只有 app_users 白名單中的 Email 登入者可讀寫。

-- ───────── 使用者白名單
create table if not exists public.app_users (
  email text primary key,
  role text not null default 'owner' check (role in ('owner', 'staff', 'accountant')),
  created_at timestamptz not null default now()
);
alter table public.app_users enable row level security;

create or replace function public.is_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.app_users u
    where lower(u.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_member() from public;
grant execute on function public.is_member() to authenticated;

drop policy if exists "members read app_users" on public.app_users;
create policy "members read app_users" on public.app_users for select to authenticated using (public.is_member());

-- 共用：更新時記錄時間與操作者
create or replace function public.touch_row()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' then
    new.inserted_at := old.inserted_at;
  end if;
  new.updated_by := auth.uid();
  return new;
end;
$$;

-- ───────── 系統設定
create table if not exists public."settings" (
  "id" text primary key,
  "value" jsonb,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."settings" enable row level security;
drop policy if exists "members full access" on public."settings";
create policy "members full access" on public."settings" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."settings";
create trigger touch_row before insert or update on public."settings" for each row execute function public.touch_row();

-- ───────── 匯入批次
create table if not exists public."import_batches" (
  "id" text primary key,
  "target" text,
  "file_name" text,
  "file_hash" text,
  "encoding" text,
  "row_count" numeric,
  "added" numeric,
  "skipped" numeric,
  "date_from" date,
  "date_to" date,
  "mapping" jsonb,
  "imported_at" timestamptz,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."import_batches" enable row level security;
drop policy if exists "members full access" on public."import_batches";
create policy "members full access" on public."import_batches" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."import_batches";
create trigger touch_row before insert or update on public."import_batches" for each row execute function public.touch_row();

-- ───────── 欄位對應範本
create table if not exists public."import_profiles" (
  "id" text primary key,
  "target" text,
  "signature" text,
  "header_index" numeric,
  "mapping" jsonb,
  "headers" jsonb,
  "name" text,
  "updated_at" timestamptz,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."import_profiles" enable row level security;
drop policy if exists "members full access" on public."import_profiles";
create policy "members full access" on public."import_profiles" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."import_profiles";
create trigger touch_row before insert or update on public."import_profiles" for each row execute function public.touch_row();

-- ───────── POS 銷售明細
create table if not exists public."sales_lines" (
  "id" text primary key,
  "batch_id" text,
  "date" date,
  "time" text,
  "order_no" text,
  "item_raw" text,
  "option_raw" text,
  "category_raw" text,
  "qty" numeric,
  "unit_price" numeric,
  "gross" numeric,
  "discount" numeric,
  "amount" numeric,
  "revenue" numeric,
  "payment_raw" text,
  "payment" text,
  "status_raw" text,
  "note" text,
  "member" text,
  "staff" text,
  "channel" text,
  "is_adjustment" boolean,
  "void_reason" text,
  "void_keyword" text,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
create index if not exists sales_lines_date_idx on public."sales_lines" ("date");
create index if not exists sales_lines_batch_id_idx on public."sales_lines" ("batch_id");
alter table public."sales_lines" enable row level security;
drop policy if exists "members full access" on public."sales_lines";
create policy "members full access" on public."sales_lines" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."sales_lines";
create trigger touch_row before insert or update on public."sales_lines" for each row execute function public.touch_row();

-- ───────── 品項主檔
create table if not exists public."products" (
  "id" text primary key,
  "name" text,
  "category" text,
  "price" numeric,
  "active" boolean,
  "note" text,
  "updated_at" timestamptz,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."products" enable row level security;
drop policy if exists "members full access" on public."products";
create policy "members full access" on public."products" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."products";
create trigger touch_row before insert or update on public."products" for each row execute function public.touch_row();

-- ───────── 品項別名對應
create table if not exists public."product_aliases" (
  "id" text primary key,
  "raw_name" text,
  "product_id" text,
  "updated_at" timestamptz,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."product_aliases" enable row level security;
drop policy if exists "members full access" on public."product_aliases";
create policy "members full access" on public."product_aliases" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."product_aliases";
create trigger touch_row before insert or update on public."product_aliases" for each row execute function public.touch_row();

-- ───────── 確認非同品項
create table if not exists public."product_not_same" (
  "id" text primary key,
  "a" text,
  "b" text,
  "updated_at" timestamptz,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."product_not_same" enable row level security;
drop policy if exists "members full access" on public."product_not_same";
create policy "members full access" on public."product_not_same" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."product_not_same";
create trigger touch_row before insert or update on public."product_not_same" for each row execute function public.touch_row();

-- ───────── 刷卡／行動支付交易
create table if not exists public."payment_tx" (
  "id" text primary key,
  "batch_id" text,
  "provider" text,
  "date" date,
  "time" text,
  "order_no" text,
  "provider_no" text,
  "amount" numeric,
  "fee" numeric,
  "net" numeric,
  "status" text,
  "ok" boolean,
  "payout_date" date,
  "method" text,
  "card_last4" text,
  "note" text,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
create index if not exists payment_tx_date_idx on public."payment_tx" ("date");
alter table public."payment_tx" enable row level security;
drop policy if exists "members full access" on public."payment_tx";
create policy "members full access" on public."payment_tx" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."payment_tx";
create trigger touch_row before insert or update on public."payment_tx" for each row execute function public.touch_row();

-- ───────── 金流撥款
create table if not exists public."payouts" (
  "id" text primary key,
  "batch_id" text,
  "provider" text,
  "payout_date" date,
  "gross" numeric,
  "fee" numeric,
  "net" numeric,
  "period_from" date,
  "period_to" date,
  "tx_count" numeric,
  "ref" text,
  "note" text,
  "document_id" text,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."payouts" enable row level security;
drop policy if exists "members full access" on public."payouts";
create policy "members full access" on public."payouts" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."payouts";
create trigger touch_row before insert or update on public."payouts" for each row execute function public.touch_row();

-- ───────── 銀行帳戶
create table if not exists public."bank_accounts" (
  "id" text primary key,
  "name" text,
  "bank" text,
  "last4" text,
  "gl_account" text,
  "opening_date" date,
  "opening_balance" numeric,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."bank_accounts" enable row level security;
drop policy if exists "members full access" on public."bank_accounts";
create policy "members full access" on public."bank_accounts" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."bank_accounts";
create trigger touch_row before insert or update on public."bank_accounts" for each row execute function public.touch_row();

-- ───────── 存摺明細
create table if not exists public."bank_lines" (
  "id" text primary key,
  "batch_id" text,
  "bank_account_id" text,
  "date" date,
  "description" text,
  "withdrawal" numeric,
  "deposit" numeric,
  "balance" numeric,
  "note" text,
  "counterparty" text,
  "match_key" text,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
create index if not exists bank_lines_date_idx on public."bank_lines" ("date");
alter table public."bank_lines" enable row level security;
drop policy if exists "members full access" on public."bank_lines";
create policy "members full access" on public."bank_lines" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."bank_lines";
create trigger touch_row before insert or update on public."bank_lines" for each row execute function public.touch_row();

-- ───────── 會計項目
create table if not exists public."accounts" (
  "code" text primary key,
  "name" text,
  "type" text,
  "side" text,
  "grp" text,
  "contra" boolean,
  "behavior" text,
  "tax_line" text,
  "hint" text,
  "active" boolean,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."accounts" enable row level security;
drop policy if exists "members full access" on public."accounts";
create policy "members full access" on public."accounts" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."accounts";
create trigger touch_row before insert or update on public."accounts" for each row execute function public.touch_row();

-- ───────── 日記簿分錄
create table if not exists public."journal_entries" (
  "id" text primary key,
  "date" date,
  "voucher_no" text,
  "description" text,
  "source" text,
  "source_ref" text,
  "status" text,
  "lines" jsonb,
  "attachments" jsonb,
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
create index if not exists journal_entries_date_idx on public."journal_entries" ("date");
create index if not exists journal_entries_source_idx on public."journal_entries" ("source");
alter table public."journal_entries" enable row level security;
drop policy if exists "members full access" on public."journal_entries";
create policy "members full access" on public."journal_entries" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."journal_entries";
create trigger touch_row before insert or update on public."journal_entries" for each row execute function public.touch_row();

-- ───────── 原始憑證
create table if not exists public."documents" (
  "id" text primary key,
  "kind" text,
  "status" text,
  "storage_path" text,
  "original_name" text,
  "archived_name" text,
  "mime" text,
  "file_ext" text,
  "doc_date" date,
  "vendor_name" text,
  "vendor_tax_id" text,
  "buyer_tax_id" text,
  "invoice_type" text,
  "invoice_no" text,
  "amount_total" numeric,
  "tax_amount" numeric,
  "deductible" boolean,
  "summary" text,
  "items" jsonb,
  "account" text,
  "pay_account" text,
  "confidence" numeric,
  "ai" jsonb,
  "entry_id" text,
  "einvoice_id" text,
  "asset_id" text,
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
create index if not exists documents_doc_date_idx on public."documents" ("doc_date");
create index if not exists documents_entry_id_idx on public."documents" ("entry_id");
alter table public."documents" enable row level security;
drop policy if exists "members full access" on public."documents";
create policy "members full access" on public."documents" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."documents";
create trigger touch_row before insert or update on public."documents" for each row execute function public.touch_row();

-- ───────── 電子發票
create table if not exists public."einvoices" (
  "id" text primary key,
  "batch_id" text,
  "invoice_no" text,
  "date" date,
  "seller_tax_id" text,
  "seller_name" text,
  "buyer_tax_id" text,
  "total" numeric,
  "tax" numeric,
  "status" text,
  "voided" boolean,
  "deductible" boolean,
  "items" jsonb,
  "suggested_account" text,
  "account" text,
  "document_id" text,
  "entry_id" text,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."einvoices" enable row level security;
drop policy if exists "members full access" on public."einvoices";
create policy "members full access" on public."einvoices" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."einvoices";
create trigger touch_row before insert or update on public."einvoices" for each row execute function public.touch_row();

-- ───────── 固定資產
create table if not exists public."fixed_assets" (
  "id" text primary key,
  "name" text,
  "category" text,
  "acquired_on" date,
  "cost" numeric,
  "life_years" numeric,
  "residual" numeric,
  "disposed_on" date,
  "supplier" text,
  "invoice_no" text,
  "tax_amount" numeric,
  "pay_account" text,
  "doc_ids" jsonb,
  "purchase_entry_id" text,
  "note" text,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."fixed_assets" enable row level security;
drop policy if exists "members full access" on public."fixed_assets";
create policy "members full access" on public."fixed_assets" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."fixed_assets";
create trigger touch_row before insert or update on public."fixed_assets" for each row execute function public.touch_row();

-- ───────── 原物料品項
create table if not exists public."inventory_items" (
  "id" text primary key,
  "sku" text,
  "name" text,
  "category" text,
  "unit" text,
  "gl_account" text,
  "safety_stock" numeric,
  "reorder_qty" numeric,
  "supplier_id" text,
  "std_cost" numeric,
  "active" boolean,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."inventory_items" enable row level security;
drop policy if exists "members full access" on public."inventory_items";
create policy "members full access" on public."inventory_items" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."inventory_items";
create trigger touch_row before insert or update on public."inventory_items" for each row execute function public.touch_row();

-- ───────── 進銷存異動
create table if not exists public."inventory_moves" (
  "id" text primary key,
  "item_id" text,
  "date" date,
  "type" text,
  "qty" numeric,
  "amount" numeric,
  "supplier_id" text,
  "order_date" date,
  "yield_score" numeric,
  "invoice_no" text,
  "note" text,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
create index if not exists inventory_moves_date_idx on public."inventory_moves" ("date");
alter table public."inventory_moves" enable row level security;
drop policy if exists "members full access" on public."inventory_moves";
create policy "members full access" on public."inventory_moves" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."inventory_moves";
create trigger touch_row before insert or update on public."inventory_moves" for each row execute function public.touch_row();

-- ───────── 配方（BOM）
create table if not exists public."recipes" (
  "id" text primary key,
  "product_id" text,
  "item_id" text,
  "qty" numeric,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."recipes" enable row level security;
drop policy if exists "members full access" on public."recipes";
create policy "members full access" on public."recipes" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."recipes";
create trigger touch_row before insert or update on public."recipes" for each row execute function public.touch_row();

-- ───────── 月底盤點
create table if not exists public."stocktakes" (
  "id" text primary key,
  "month" text,
  "account" text,
  "value" numeric,
  "note" text,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."stocktakes" enable row level security;
drop policy if exists "members full access" on public."stocktakes";
create policy "members full access" on public."stocktakes" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."stocktakes";
create trigger touch_row before insert or update on public."stocktakes" for each row execute function public.touch_row();

-- ───────── 供應商
create table if not exists public."suppliers" (
  "id" text primary key,
  "name" text,
  "tax_id" text,
  "contact" text,
  "phone" text,
  "terms" text,
  "note" text,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."suppliers" enable row level security;
drop policy if exists "members full access" on public."suppliers";
create policy "members full access" on public."suppliers" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."suppliers";
create trigger touch_row before insert or update on public."suppliers" for each row execute function public.touch_row();

-- ───────── 會員
create table if not exists public."customers" (
  "id" text primary key,
  "member_no" text,
  "name" text,
  "tier" text,
  "birthday" text,
  "preferences" text,
  "joined_on" date,
  "note" text,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."customers" enable row level security;
drop policy if exists "members full access" on public."customers";
create policy "members full access" on public."customers" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."customers";
create trigger touch_row before insert or update on public."customers" for each row execute function public.touch_row();

-- ───────── 行銷活動
create table if not exists public."campaigns" (
  "id" text primary key,
  "name" text,
  "type" text,
  "start_date" date,
  "end_date" date,
  "keywords" text,
  "issued_qty" numeric,
  "redeemed_qty" numeric,
  "marketing_cost" numeric,
  "note" text,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."campaigns" enable row level security;
drop policy if exists "members full access" on public."campaigns";
create policy "members full access" on public."campaigns" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."campaigns";
create trigger touch_row before insert or update on public."campaigns" for each row execute function public.touch_row();

-- ───────── 月結檢查
create table if not exists public."checklist" (
  "id" text primary key,
  "month" text,
  "key" text,
  "done" boolean,
  "note" text,
  "done_at" timestamptz,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."checklist" enable row level security;
drop policy if exists "members full access" on public."checklist";
create policy "members full access" on public."checklist" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."checklist";
create trigger touch_row before insert or update on public."checklist" for each row execute function public.touch_row();

-- ───────── 申報事項
create table if not exists public."tax_tasks" (
  "id" text primary key,
  "done" boolean,
  "note" text,
  "done_at" timestamptz,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."tax_tasks" enable row level security;
drop policy if exists "members full access" on public."tax_tasks";
create policy "members full access" on public."tax_tasks" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."tax_tasks";
create trigger touch_row before insert or update on public."tax_tasks" for each row execute function public.touch_row();

-- ───────── 營業稅申報紀錄
create table if not exists public."tax_filings" (
  "id" text primary key,
  "period_from" text,
  "period_to" text,
  "status" text,
  "sales_ex" numeric,
  "output_tax" numeric,
  "input_tax" numeric,
  "input_asset_tax" numeric,
  "prev_cf" numeric,
  "payable" numeric,
  "refund" numeric,
  "cf" numeric,
  "platform_sales_ex" numeric,
  "platform_output_tax" numeric,
  "claimed" jsonb,
  "filed_on" date,
  "paid_on" date,
  "receipt_no" text,
  "entry_id" text,
  "pay_entry_id" text,
  "note" text,
  "updated_at" timestamptz,
  "extra" jsonb not null default '{}'::jsonb,
  "inserted_at" timestamptz not null default now(),
  "updated_by" uuid default auth.uid()
);
alter table public."tax_filings" enable row level security;
drop policy if exists "members full access" on public."tax_filings";
create policy "members full access" on public."tax_filings" for all to authenticated using (public.is_member()) with check (public.is_member());
drop trigger if exists touch_row on public."tax_filings";
create trigger touch_row before insert or update on public."tax_filings" for each row execute function public.touch_row();

-- ───────── 分錄借貸平衡檢查（網頁端已檢查，資料庫再把關一次）
create or replace function public.check_entry_balanced()
returns trigger
language plpgsql
as $$
declare
  dr numeric;
  cr numeric;
begin
  if new.status = 'void' then
    return new;
  end if;
  select coalesce(sum(coalesce((l ->> 'debit')::numeric, 0)), 0),
         coalesce(sum(coalesce((l ->> 'credit')::numeric, 0)), 0)
    into dr, cr
    from jsonb_array_elements(coalesce(new.lines, '[]'::jsonb)) as l;
  if abs(dr - cr) > 0.005 then
    raise exception '分錄 % 借貸不平衡：借 % ／貸 %', coalesce(new.voucher_no, new.id), dr, cr;
  end if;
  return new;
end;
$$;
drop trigger if exists check_entry_balanced on public.journal_entries;
create trigger check_entry_balanced before insert or update on public.journal_entries for each row execute function public.check_entry_balanced();

-- ───────── 查詢用檢視表（在 Supabase 後台可直接用 SQL 分析）
create or replace view public.journal_lines with (security_invoker = true) as
select e.id as entry_id, e.date, e.voucher_no, e.description, e.source,
       (l.ord - 1)::int as line_no,
       l.value ->> 'account' as account,
       a.name as account_name,
       coalesce((l.value ->> 'debit')::numeric, 0) as debit,
       coalesce((l.value ->> 'credit')::numeric, 0) as credit,
       l.value ->> 'memo' as memo
from public.journal_entries e
cross join lateral jsonb_array_elements(e.lines) with ordinality as l(value, ord)
left join public.accounts a on a.code = l.value ->> 'account'
where coalesce(e.status, 'posted') <> 'void';

create or replace view public.daily_sales with (security_invoker = true) as
select date,
       sum(revenue) filter (where void_reason is null) as revenue,
       count(distinct nullif(order_no, '')) as orders,
       sum(qty) filter (where void_reason is null and not coalesce(is_adjustment, false)) as qty,
       sum(amount) filter (where void_reason is not null) as voided_amount
from public.sales_lines
group by date;

-- ───────── 憑證影像：私有 Storage bucket
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do update set public = false;

drop policy if exists "members read documents" on storage.objects;
create policy "members read documents" on storage.objects for select to authenticated using (bucket_id = 'documents' and public.is_member());
drop policy if exists "members upload documents" on storage.objects;
create policy "members upload documents" on storage.objects for insert to authenticated with check (bucket_id = 'documents' and public.is_member());
drop policy if exists "members update documents" on storage.objects;
create policy "members update documents" on storage.objects for update to authenticated using (bucket_id = 'documents' and public.is_member()) with check (bucket_id = 'documents' and public.is_member());
drop policy if exists "members delete documents" on storage.objects;
create policy "members delete documents" on storage.objects for delete to authenticated using (bucket_id = 'documents' and public.is_member());

-- ───────── 最後一步（請改成你自己的 Email 後執行）：
-- insert into public.app_users (email, role) values ('你的Email', 'owner');
