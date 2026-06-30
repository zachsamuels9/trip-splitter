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
