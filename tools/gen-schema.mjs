// 由 erp/js/schema.js 產生 Supabase 資料庫遷移檔：node tools/gen-schema.mjs
// 資料表欄位與網頁端共用同一份定義；安全性（RLS、白名單、Storage 權限）寫在下方固定段落。

import { writeFileSync } from 'node:fs';
import { SCHEMA } from '../erp/js/schema.js';

const OUT = new URL('../supabase/migrations/20260923000000_wuyue_erp_init.sql', import.meta.url);
const q = (id) => `"${id}"`;

const head = `-- 午月營運帳務系統：Supabase 資料庫結構（由 tools/gen-schema.mjs 產生，請勿手改表格欄位）
-- 套用：Supabase Dashboard → SQL Editor 貼上執行，或 supabase db push
-- 可重複執行：系統更新後再執行一次同一份檔案，會補上新增的資料表與欄位，既有資料不受影響。
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
`;

let body = '';
for (const [name, def] of Object.entries(SCHEMA)) {
  if (def.localOnly) continue;
  const pk = def.pk || 'id';
  const cols = Object.entries(def.cols).map(([c, t]) => `  ${q(c)} ${t}${c === pk ? ' primary key' : ''}`);
  cols.push(`  "extra" jsonb not null default '{}'::jsonb`, `  "inserted_at" timestamptz not null default now()`, `  "updated_by" uuid default auth.uid()`);
  body += `\n-- ───────── ${def.label}\ncreate table if not exists public.${q(name)} (\n${cols.join(',\n')}\n);\n`;
  // 舊版已建立的資料表：補上新欄位
  for (const [c, t] of Object.entries(def.cols)) if (c !== pk) body += `alter table public.${q(name)} add column if not exists ${q(c)} ${t};\n`;
  for (const c of def.index || []) body += `create index if not exists ${name}_${c}_idx on public.${q(name)} (${q(c)});\n`;
  body += `alter table public.${q(name)} enable row level security;\n`;
  body += `drop policy if exists "members full access" on public.${q(name)};\n`;
  body += `create policy "members full access" on public.${q(name)} for all to authenticated using (public.is_member()) with check (public.is_member());\n`;
  body += `drop trigger if exists touch_row on public.${q(name)};\n`;
  body += `create trigger touch_row before insert or update on public.${q(name)} for each row execute function public.touch_row();\n`;
}

const tail = `
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

-- 通知 API 重新讀取資料表結構
notify pgrst, 'reload schema';

-- ───────── 最後一步（請改成你自己的 Email 後執行）：
-- insert into public.app_users (email, role) values ('你的Email', 'owner');
`;

writeFileSync(OUT, head + body + tail);
console.log('wrote', OUT.pathname);
