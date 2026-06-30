create table if not exists public.ocr_usage_months (
  month text primary key check (month ~ '^\d{4}-\d{2}$'),
  total_requests_attempted integer not null default 0 check (total_requests_attempted >= 0),
  total_requests_successful integer not null default 0 check (total_requests_successful >= 0),
  total_requests_failed integer not null default 0 check (total_requests_failed >= 0),
  last_request_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists ocr_usage_months_updated_at_idx
  on public.ocr_usage_months (updated_at desc);

create table if not exists public.ocr_usage_settings (
  key text primary key,
  value text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ocr_usage_months enable row level security;
alter table public.ocr_usage_settings enable row level security;

drop policy if exists "Allow OCR usage reads" on public.ocr_usage_months;
drop policy if exists "Allow OCR usage inserts" on public.ocr_usage_months;
drop policy if exists "Allow OCR usage updates" on public.ocr_usage_months;

create policy "Allow OCR usage reads"
  on public.ocr_usage_months
  for select
  to anon, authenticated
  using (true);

create policy "Allow OCR usage inserts"
  on public.ocr_usage_months
  for insert
  to anon, authenticated
  with check (true);

create policy "Allow OCR usage updates"
  on public.ocr_usage_months
  for update
  to anon, authenticated
  using (true)
  with check (true);

drop policy if exists "Allow OCR settings reads" on public.ocr_usage_settings;
drop policy if exists "Allow OCR settings inserts" on public.ocr_usage_settings;
drop policy if exists "Allow OCR settings updates" on public.ocr_usage_settings;

create policy "Allow OCR settings reads"
  on public.ocr_usage_settings
  for select
  to anon, authenticated
  using (true);

create policy "Allow OCR settings inserts"
  on public.ocr_usage_settings
  for insert
  to anon, authenticated
  with check (true);

create policy "Allow OCR settings updates"
  on public.ocr_usage_settings
  for update
  to anon, authenticated
  using (true)
  with check (true);

grant select, insert, update on public.ocr_usage_months to anon, authenticated;
grant select, insert, update on public.ocr_usage_settings to anon, authenticated;
