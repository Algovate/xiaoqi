create table if not exists codex_tasks (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  user_id uuid references users(id) on delete set null,
  conversation_key text not null,
  repo_alias text not null,
  repo_path text not null,
  prompt text not null,
  status text not null default 'queued',
  session_id text,
  pid integer,
  last_event text,
  summary text,
  error text,
  exit_code integer,
  cancel_requested boolean not null default false,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists codex_tasks_queue_idx on codex_tasks(status, created_at);

create table if not exists codex_task_events (
  id bigserial primary key,
  task_id uuid not null references codex_tasks(id) on delete cascade,
  event_type text,
  payload jsonb,
  created_at timestamptz not null default now()
);
create index if not exists codex_task_events_task_idx on codex_task_events(task_id, id);
