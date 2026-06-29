create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  passcode_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table participants
  add column if not exists account_id uuid references accounts(id) on delete set null;

create index if not exists participants_account_id_idx
  on participants (account_id)
  where account_id is not null;

create index if not exists accounts_email_passcode_idx
  on accounts (lower(email), passcode_hash);
