alter table codex_tasks add column if not exists kind text not null default 'exec';
alter table codex_tasks add column if not exists resume_session_id text;
alter table codex_tasks add column if not exists diff_stat text;
