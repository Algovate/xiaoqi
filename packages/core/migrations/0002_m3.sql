create table if not exists media_assets (
  id uuid primary key default gen_random_uuid(),
  message_id bigint not null references messages(id) on delete cascade,
  kind text not null,
  mime text,
  size_bytes bigint,
  storage_key text not null,
  extracted_text text,
  status text not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  unique (message_id, storage_key)
);
create index if not exists media_message_idx on media_assets(message_id);

create table if not exists conversation_state (
  conversation_key text primary key,
  summary text,
  summary_tokens integer not null default 0,
  reset_at timestamptz,
  updated_at timestamptz not null default now()
);
