create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  conversation_key text not null,
  text text not null,
  run_at timestamptz not null,
  status text not null default 'scheduled',
  sent_at timestamptz,
  error_code text,
  created_at timestamptz not null default now()
);
create index if not exists reminders_due_idx on reminders(status, run_at);

create table if not exists kb_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_path text,
  status text not null default 'ready',
  created_at timestamptz not null default now()
);

create table if not exists kb_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references kb_documents(id) on delete cascade,
  chunk_index integer not null,
  content text not null,
  tokens text[] not null default '{}',
  unique (document_id, chunk_index)
);
create index if not exists kb_chunks_tokens_idx on kb_chunks using gin(tokens);
