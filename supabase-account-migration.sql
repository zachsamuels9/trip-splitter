alter table participants
  add column if not exists email text,
  add column if not exists passcode_hash text,
  add column if not exists account_created_at timestamptz not null default now();

create index if not exists participants_email_idx
  on participants (lower(email))
  where email is not null;

create index if not exists participants_email_passcode_idx
  on participants (lower(email), passcode_hash)
  where email is not null and passcode_hash is not null;
