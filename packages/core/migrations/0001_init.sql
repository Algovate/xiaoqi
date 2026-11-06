create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  ilink_bot_id text not null unique,
  display_name text not null default '小栖',
  token_enc text,
  token_kid text not null default 'v1',
  base_url text not null default 'https://ilinkai.weixin.qq.com',
  status text not null default 'disabled',
  last_poll_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists account_cursors (
  account_id uuid primary key references accounts(id) on delete cascade,
  buf text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  wx_user_id text not null,
  display_name text,
  status text not null default 'active',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  settings jsonb not null default '{}'::jsonb,
  unique (account_id, wx_user_id)
);

create table if not exists messages (
  id bigserial primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  conversation_key text not null,
  wx_message_id text not null,
  seq bigint,
  sender_id text not null,
  direction text not null,
  message_type integer not null default 1,
  item_type text not null default 'unknown',
  text text,
  context_token_enc text,
  raw jsonb,
  created_at timestamptz not null,
  inserted_at timestamptz not null default now(),
  unique (account_id, wx_message_id)
);
create index if not exists messages_conversation_time_idx on messages(conversation_key, created_at);
create index if not exists messages_sender_idx on messages(sender_id, created_at);

create table if not exists context_tokens (
  account_id uuid not null references accounts(id) on delete cascade,
  conversation_key text not null,
  token_enc text not null,
  wx_message_id text,
  updated_at timestamptz not null default now(),
  unique (account_id, conversation_key)
);

create table if not exists runs (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  trigger_message_id bigint references messages(id) on delete set null,
  status text not null default 'queued',
  model text,
  prompt_version text,
  prompt_tokens integer,
  completion_tokens integer,
  cost_usd numeric(12,6) not null default 0,
  latency_ms integer,
  error_code text,
  trace_id text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists runs_trigger_uq on runs(account_id, trigger_message_id);
create index if not exists runs_user_time_idx on runs(user_id, created_at);

create table if not exists outbound_messages (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  chunk_index integer not null,
  wx_message_id text,
  status text not null default 'pending',
  error_code text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, chunk_index)
);

create table if not exists outbox (
  id bigserial primary key,
  topic text not null,
  payload jsonb not null,
  status text not null default 'pending',
  attempts integer not null default 0,
  next_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists outbox_due_idx on outbox(status, next_at);
