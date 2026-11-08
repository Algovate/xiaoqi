alter table outbound_messages add column if not exists kind text not null default 'text';
alter table outbound_messages add column if not exists storage_key text;
alter table outbound_messages add column if not exists mime text;
alter table outbound_messages add column if not exists size_bytes bigint;
