# 小栖 Xiaoqi · 详细设计 04 · 数据模型与管理 API

> **归档提示（2026-11-06）**：Phase 0 群聊 No-Go；本文件为群版 future 参考。当前 v1 私聊设计见 [`../design-dm.md`](../../design-dm.md)。


> 对应代码：`packages/core/src/db`、`apps/api/src/routes`  
> 目标：锁定 PostgreSQL DDL、Redis key、REST/SSE 契约和权限模型。  
> 前置：[00 总览](./00-overview.md)、[01 协议适配](./01-ilink-adapter.md)

---

## 1. PostgreSQL

### 1.1 扩展

```sql
create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists vector;     -- pgvector
create extension if not exists citext;     -- 邮箱大小写不敏感
create extension if not exists pg_trgm;    -- 可选：模糊搜索
```

### 1.2 枚举

```sql
create type account_status as enum ('active', 'expired', 'disabled');
create type login_status as enum ('qr_pending', 'scanned', 'verify_required', 'confirmed', 'expired', 'failed', 'disabled');
create type group_status as enum ('active', 'inactive', 'disabled');
create type member_role as enum ('owner', 'admin', 'member');
create type msg_direction as enum ('in', 'out');
create type msg_item_type as enum ('text', 'image', 'voice', 'file', 'video', 'tool', 'unknown');
create type media_kind as enum ('image', 'voice', 'file', 'video');
create type media_status as enum ('pending', 'ready', 'failed');
create type run_status as enum ('queued', 'running', 'sending', 'sent', 'failed', 'dead', 'superseded');
create type trigger_reason as enum ('mention', 'command', 'reply_to_bot', 'dm', 'all_messages', 'scheduled', 'summary');
create type outbound_status as enum ('pending', 'sending', 'sent', 'failed', 'skipped');
create type outbox_status as enum ('pending', 'processing', 'done', 'failed');
create type kb_status as enum ('pending', 'ready', 'failed');
create type reminder_status as enum ('scheduled', 'sending', 'sent', 'failed', 'cancelled');
```

### 1.3 管理员与账号

```sql
create table admin_users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  password_hash text not null,
  totp_secret_enc text,
  role text not null default 'owner' check (role in ('owner', 'operator', 'viewer')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table admin_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references admin_users(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now()
);
create index admin_sessions_user_idx on admin_sessions(user_id);
create index admin_sessions_expires_idx on admin_sessions(expires_at);

create table accounts (
  id uuid primary key default gen_random_uuid(),
  ilink_bot_id text not null unique,
  display_name text not null default '小栖',
  token_enc text,                         -- 绑定确认后写入
  token_kid text not null default 'v1',
  base_url text not null default 'https://ilinkai.weixin.qq.com',
  status account_status not null default 'disabled',
  owner_admin_id uuid references admin_users(id),
  last_poll_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index accounts_status_idx on accounts(status);

create table login_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  status login_status not null default 'qr_pending',
  qr_url text,
  qr_content_enc text,
  expires_at timestamptz not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index login_sessions_account_idx on login_sessions(account_id, created_at desc);

create table account_cursors (
  account_id uuid primary key references accounts(id) on delete cascade,
  buf text not null default '',
  updated_at timestamptz not null default now()
);
```

### 1.4 群与成员

```sql
create table groups (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  wx_group_id text not null,
  name text not null default '',
  status group_status not null default 'active',
  settings jsonb not null default '{}'::jsonb,
  discovered_at timestamptz not null default now(),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, wx_group_id)
);
create index groups_account_status_idx on groups(account_id, status);

create table members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  wx_user_id text not null,
  display_name text,
  role member_role not null default 'member',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  message_count integer not null default 0,
  unique (group_id, wx_user_id)
);
create index members_group_role_idx on members(group_id, role);
```

### 1.5 消息与媒体

```sql
create table messages (
  id bigserial primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  group_id uuid references groups(id) on delete set null,
  conversation_key text not null,          -- group:<group_id> 或 dm:<wx_user_id>
  wx_message_id text not null,
  seq bigint,
  sender_id text not null,
  direction msg_direction not null,
  item_type msg_item_type not null default 'unknown',
  text text,
  quote_wx_id text,
  raw jsonb,
  created_at timestamptz not null,
  inserted_at timestamptz not null default now(),
  unique (account_id, wx_message_id)
);
create index messages_conversation_time_idx on messages(conversation_key, created_at desc);
create index messages_group_time_idx on messages(group_id, created_at desc);
create index messages_account_time_idx on messages(account_id, created_at desc);
create index messages_sender_idx on messages(group_id, sender_id, created_at desc);

create table media_assets (
  id uuid primary key default gen_random_uuid(),
  message_id bigint references messages(id) on delete cascade,
  kind media_kind not null,
  mime text,
  size_bytes bigint,
  sha256 text,
  storage_key text,
  aes_key_enc text,
  width integer,
  height integer,
  duration_ms integer,
  transcript text,
  description text,
  extracted_text text,
  status media_status not null default 'pending',
  error text,
  created_at timestamptz not null default now()
);
create index media_message_idx on media_assets(message_id);
create index media_sha_idx on media_assets(sha256);

create table conversation_state (
  group_id uuid primary key references groups(id) on delete cascade,
  summary text,
  summary_json jsonb,
  summary_tokens integer not null default 0,
  last_summarized_message_id bigint,
  updated_at timestamptz not null default now()
);
```

### 1.6 运行与发送

```sql
create table runs (
  id uuid primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  group_id uuid references groups(id) on delete cascade,
  trigger_message_id bigint references messages(id) on delete set null,
  status run_status not null default 'queued',
  reason trigger_reason not null,
  prompt_version text,
  model text,
  prompt_tokens integer,
  completion_tokens integer,
  cost_usd numeric(12,6) not null default 0,
  latency_ms integer,
  error_code text,
  error_detail jsonb,
  trace_id text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create unique index runs_trigger_unique on runs(account_id, trigger_message_id)
  where trigger_message_id is not null;
create index runs_group_time_idx on runs(group_id, created_at desc);
create index runs_status_idx on runs(status, created_at);

create table outbound_messages (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  chunk_index integer not null,
  wx_message_id text,
  status outbound_status not null default 'pending',
  error_code text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (run_id, chunk_index)
);
create index outbound_status_idx on outbound_messages(status, created_at);

create table context_tokens (
  account_id uuid not null references accounts(id) on delete cascade,
  conversation_key text not null,
  token_enc text not null,
  wx_message_id bigint,
  updated_at timestamptz not null default now(),
  primary key (account_id, conversation_key)
);

create table tool_calls (
  id bigserial primary key,
  run_id uuid not null references runs(id) on delete cascade,
  tool_name text not null,
  args jsonb,
  result jsonb,
  status text not null default 'ok',
  duration_ms integer,
  created_at timestamptz not null default now()
);
create index tool_calls_run_idx on tool_calls(run_id);

create table feedback (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  group_id uuid not null references groups(id) on delete cascade,
  wx_user_id text not null,
  sentiment smallint not null check (sentiment in (-1, 1)),
  created_at timestamptz not null default now(),
  unique (run_id, wx_user_id)
);
```

### 1.7 知识库

```sql
create table kb_documents (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  title text not null,
  source_type text not null check (source_type in ('pdf', 'docx', 'md', 'txt', 'url')),
  source_uri text,
  storage_key text,
  status kb_status not null default 'pending',
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index kb_documents_group_idx on kb_documents(group_id, created_at desc);

create table kb_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references kb_documents(id) on delete cascade,
  chunk_index integer not null,
  heading text,
  content text not null,
  token_count integer not null,
  embedding vector(1024),
  tsv tsvector generated always as (to_tsvector('simple', content)) stored,
  unique (document_id, chunk_index)
);
create index kb_chunks_document_idx on kb_chunks(document_id);
create index kb_chunks_tsv_idx on kb_chunks using gin(tsv);
create index kb_chunks_embedding_idx on kb_chunks
  using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
```

### 1.8 提醒、用量、审计

```sql
create table reminders (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  creator_member_id uuid references members(id) on delete set null,
  text text not null,
  run_at timestamptz not null,
  timezone text not null default 'Asia/Shanghai',
  status reminder_status not null default 'scheduled',
  sent_at timestamptz,
  error_code text,
  created_at timestamptz not null default now()
);
create index reminders_due_idx on reminders(status, run_at);

create table usage_daily (
  group_id uuid not null references groups(id) on delete cascade,
  day date not null,
  runs integer not null default 0,
  prompt_tokens bigint not null default 0,
  completion_tokens bigint not null default 0,
  cost_usd numeric(12,6) not null default 0,
  errors integer not null default 0,
  primary key (group_id, day)
);

create table audit_logs (
  id bigserial primary key,
  actor_id uuid references admin_users(id) on delete set null,
  action text not null,
  target_type text,
  target_id text,
  meta jsonb,
  created_at timestamptz not null default now()
);
create index audit_logs_time_idx on audit_logs(created_at desc);

create table outbox (
  id bigserial primary key,
  topic text not null,
  payload jsonb not null,
  status outbox_status not null default 'pending',
  attempts integer not null default 0,
  next_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  processed_at timestamptz
);
create index outbox_due_idx on outbox(status, next_at);

create table inbound_errors (
  id bigserial primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  wx_message_id text,
  error_code text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

create table system_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table dead_letter (
  id bigserial primary key,
  run_id uuid references runs(id) on delete cascade,
  group_id uuid references groups(id) on delete cascade,
  payload jsonb not null,
  error_code text not null,
  created_at timestamptz not null default now()
);
create index dead_letter_group_idx on dead_letter(group_id, created_at desc);
```

### 1.9 updated_at

```sql
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger accounts_updated before update on accounts
for each row execute function set_updated_at();

create trigger groups_updated before update on groups
for each row execute function set_updated_at();

create trigger login_sessions_updated before update on login_sessions
for each row execute function set_updated_at();

create trigger kb_documents_updated before update on kb_documents
for each row execute function set_updated_at();
```

### 1.10 数据保留

| 表 | 保留 | 清理方式 |
|---|---|---|
| `messages` | 7 天（可配 1–30） | 每日 03:10 分批删除 |
| `media_assets` | 7 天 | 随消息删除 + 文件清理 |
| `runs` | 30 天 | 每日删除；保留 `usage_daily` 聚合 |
| `outbox` | 7 天（done） | 每日删除 |
| `login_sessions` | 1 天 | 每日删除 |
| `audit_logs` | 180 天 | 每日删除 |
| `feedback` | 90 天 | 每日删除 |
| `inbound_errors` | 30 天 | 每日删除 |

清理任务用 `DELETE ... WHERE ctid IN (SELECT ctid ... LIMIT 5000)` 循环，避免长事务。

---

## 2. Redis

| Key | 类型 | TTL | 用途 |
|---|---|---|---|
| `xiaoqi:lock:poll:{accountId}` | string | 45s | 每账号 leader |
| `xiaoqi:lock:group:{groupId}` | string | 120s | 群串行 |
| `xiaoqi:lock:outbox` | string | 30s | outbox dispatcher |
| `xiaoqi:cooldown:{groupId}:{userId}` | string | 3s | 用户冷却 |
| `xiaoqi:rate:account:{accountId}` | hash | 60s | 发送令牌桶 |
| `xiaoqi:rate:group:{groupId}` | hash | 60s | 群发送令牌桶 |
| `xiaoqi:replies:hour:{groupId}` | string | 1h | 每小时回复计数 |
| `xiaoqi:merge:{groupId}:{userId}` | string/list | 10s | 合并窗口 |
| `xiaoqi:typing:{accountId}:{userId}` | string | 10m | typing ticket |
| `xiaoqi:alert:{key}` | string | 5m | 告警去重 |

BullMQ key 前缀：`xiaoqi:bull:*`。

锁实现：

```lua
-- acquire
if redis.call("SET", KEYS[1], ARGV[1], "NX", "PX", ARGV[2]) then return 1 else return 0 end

-- renew (only owner)
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end
```

---

## 3. 权限模型

### 3.1 管理员角色

| 角色 | 权限 |
|---|---|
| `owner` | 全部：账号绑定/解绑、删除数据、管理员管理 |
| `operator` | 群设置、知识库、查看日志、重放任务；不能解绑账号/删管理员 |
| `viewer` | 只读：仪表盘、群、日志、用量 |

### 3.2 群成员角色

| 角色 | 权限 |
|---|---|
| `owner/admin` | `/reset` `/status` `/stop`；后台可绑定 |
| `member` | 提问、`/summary`、`/remind`、`/privacy`、`/whoami` |

- 群成员角色由后台配置，不信任群内自称。
- 首次发现群时，`members` 全部 `member`；管理员在后台提升。

### 3.3 管理后台鉴权

- 邮箱 + 密码（Argon2id）+ TOTP。
- Session cookie：`xiaoqi_session`，`HttpOnly; Secure; SameSite=Lax; Path=/`。
- CSRF：`xiaoqi_csrf` 非 HttpOnly cookie + `x-csrf-token` header，双提交校验。
- Session 12 小时；滑动续期最多 7 天。
- 登录失败 5 次锁 15 分钟（按 IP + 邮箱）。
- 首次启动：`SETUP_TOKEN` 环境变量 + `/setup` 创建 owner；已存在 owner 则 404。

---

## 4. REST API

Base：`/api/v1`  
Content-Type：`application/json`  
限流：登录 5 次/分钟/IP；其他管理接口 60 次/分钟/IP。  
错误格式：

```json
{
  "error": {
    "code": "GROUP_NOT_FOUND",
    "message": "群不存在",
    "requestId": "req_01J..."
  }
}
```

### 4.1 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/setup` | 首次创建 owner（需 `SETUP_TOKEN`） |
| POST | `/auth/login` | 邮箱 + 密码 + TOTP |
| POST | `/auth/logout` | 注销当前 session |
| GET | `/me` | 当前管理员 |

登录请求：

```json
{ "email": "ops@xiaoqi.ai", "password": "…", "totp": "123456" }
```

响应：

```json
{
  "user": { "id": "…", "email": "ops@xiaoqi.ai", "role": "owner" },
  "csrfToken": "…"
}
```

### 4.2 账号与登录

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/accounts` | 账号列表 + 状态 + 最近错误 |
| POST | `/accounts` | 创建待绑定账号（owner）；`ilink_bot_id` 先写 `pending:<uuid>`；响应 `{id,status:"disabled"}` |
| POST | `/accounts/:id/login` | 发起扫码，返回 `loginId` |
| GET | `/accounts/:id/login/:loginId` | 查登录状态 |
| DELETE | `/accounts/:id/login/:loginId` | 取消登录 |
| POST | `/accounts/:id/login/:loginId/verify` | 提交验证码 |
| GET | `/accounts/:id/login/:loginId/events` | SSE 登录状态 |
| POST | `/accounts/:id/logout` | 解绑（owner） |
| POST | `/accounts/:id/poll/restart` | 重启 poller（operator） |

SSE 事件：

```text
event: login.status
data: {"loginId":"…","status":"scanned","expiresAt":"…","error":null}

event: heartbeat
data: {"ts":"2026-11-06T06:10:00.000Z"}
```

### 4.3 群

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/groups?status=active` | 群列表 + 今日用量 + 状态 |
| GET | `/groups/:id` | 群详情 + settings |
| PATCH | `/groups/:id/settings` | 更新设置（operator） |
| POST | `/groups/:id/disable` | 停用（operator） |
| POST | `/groups/:id/enable` | 启用 |
| GET | `/groups/:id/members` | 只展示发过言的成员 |
| PATCH | `/groups/:id/members/:memberId` | 改角色/昵称 |
| GET | `/groups/:id/messages?before=&limit=50` | 消息检索 |
| GET | `/groups/:id/runs?status=&before=&limit=20` | 运行记录 |
| GET | `/groups/:id/usage?from=&to=` | 用量 |

PATCH settings 请求（部分字段）：

```json
{
  "trigger": { "mention": true, "commands": true, "replyToBot": true, "allMessages": false },
  "aliases": ["小栖", "小栖"],
  "cooldownSeconds": 3,
  "maxRepliesPerHour": 30,
  "contextWindowMessages": 30,
  "contextWindowHours": 2,
  "dailyBudgetCny": 2,
  "tools": { "knowledge": true, "reminders": true, "webSearch": false },
  "quietHours": { "start": "23:00", "end": "08:00" },
  "proactiveDigest": false,
  "groupReplyTarget": "auto",
  "pinnedFacts": ""
}
```

校验规则：

- `aliases` 1–5 个，每个 1–12 字符，不能重复。
- `cooldownSeconds` 0–60；`maxRepliesPerHour` 1–200。
- `contextWindowMessages` 5–100；`contextWindowHours` 1–72。
- `dailyBudgetCny` 0–100。
- `groupReplyTarget` ∈ `auto|group|sender`。
- `quietHours` 合法 `HH:mm`，start < end（跨天另行处理）。

服务端默认值（`groups.settings` 为空时合并）：

```json
{
  "trigger": { "mention": true, "commands": true, "replyToBot": true, "allMessages": false },
  "aliases": ["小栖", "小栖"],
  "cooldownSeconds": 3,
  "maxRepliesPerHour": 30,
  "maxConcurrentRuns": 1,
  "contextWindowMessages": 30,
  "contextWindowHours": 2,
  "rawRetentionDays": 7,
  "summaryRetentionDays": 30,
  "dailyBudgetCny": 2,
  "modelTier": "standard",
  "tools": { "knowledge": true, "reminders": true, "webSearch": false },
  "quietHours": { "start": "23:00", "end": "08:00" },
  "proactiveDigest": false,
  "groupReplyTarget": "auto",
  "pinnedFacts": ""
}
```

合并规则：只允许已知 key；未知 key 拒绝；`tools` 深合并；数组整体替换；保存前跑 Zod。

### 4.4 运行

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/runs?status=&groupId=&before=&limit=20` | 全局运行列表 |
| GET | `/runs/:id` | 详情：上下文摘要、工具调用、用量、错误 |
| POST | `/runs/:id/replay` | 重放（operator，生成新 run） |
| GET | `/runs/:id/outbound` | 发送分段状态 |

详情响应：

```json
{
  "id": "…",
  "status": "sent",
  "reason": "mention",
  "model": "deepseek-chat",
  "promptVersion": "system@2026-11-06.1",
  "tokens": { "prompt": 4200, "completion": 380 },
  "costUsd": 0.0021,
  "latencyMs": 5320,
  "error": null,
  "toolCalls": [
    { "name": "search_knowledge", "status": "ok", "durationMs": 220 }
  ],
  "outbound": [
    { "chunkIndex": 0, "status": "sent", "wxMessageId": "…" }
  ]
}
```

### 4.5 知识库

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/groups/:id/knowledge` | 文档列表 + 状态 |
| POST | `/groups/:id/knowledge` | multipart 上传；字段 `file` / `title` |
| DELETE | `/groups/:id/knowledge/:docId` | 删除文档 + chunks |
| POST | `/groups/:id/knowledge/search` | 测试检索 |
| POST | `/groups/:id/knowledge/:docId/reindex` | 重新切块/嵌入 |

上传限制：20MB；MIME 白名单；文件名安全化；异步解析。

### 4.6 摘要与测试

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/groups/:id/summary` | 手动生成摘要；`send=false` 默认 |
| POST | `/groups/:id/test` | 测试台：返回触发判断 + 上下文摘要，不发送 |

`POST /test` 请求：

```json
{ "text": "@小栖 这个方案有什么风险？", "senderId": "manual-test" }
```

响应：

```json
{
  "triggered": true,
  "reason": "mention",
  "cleanText": "这个方案有什么风险？",
  "contextMessages": 12,
  "estimatedTokens": 3200,
  "tools": ["search_knowledge"]
}
```

### 4.7 用量与系统

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/settings` | 系统设置（模型/告警/保留期） |
| PATCH | `/settings` | 更新系统设置（owner） |
| GET | `/usage?from=&to=&groupBy=day|group` | 用量聚合 |
| GET | `/events` | 全局 SSE：bot 状态/告警/队列 |
| GET | `/audit` | 审计日志（owner） |
| GET | `/healthz` | 存活 |
| GET | `/readyz` | DB/Redis/gateway 就绪 |
| GET | `/metrics` | Prometheus（仅内网） |

### 4.8 SSE 事件类型

| event | data |
|---|---|
| `login.status` | `{loginId,status,expiresAt,error}` |
| `bot.status` | `{accountId,status,lastPollAt,error}` |
| `alert` | `{level,code,message,groupId?}` |
| `run.failed` | `{runId,groupId,errorCode}` |
| `queue.depth` | `{queue,depth}` |
| `heartbeat` | `{ts}` |

- 心跳 15s。
- 断线重连：浏览器 `EventSource` 自动重连；服务端用 `Last-Event-ID` 补偿最近 100 条事件（内存 ring buffer）。
- SSE 只读；写操作走 REST + CSRF。

### 4.9 分页

- Cursor 分页：`?before=<ISO>&limit=50`。
- 返回 `nextCursor`（最后一条的 `created_at,id` base64）。
- 默认 20，最大 100。

### 4.10 错误码

| code | HTTP | 说明 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 未登录/ session 过期 |
| `FORBIDDEN` | 403 | 角色不足 |
| `CSRF_INVALID` | 403 | CSRF 校验失败 |
| `VALIDATION_ERROR` | 400 | 参数错误 |
| `ACCOUNT_NOT_FOUND` | 404 | 账号不存在 |
| `GROUP_NOT_FOUND` | 404 | 群不存在 |
| `RUN_NOT_FOUND` | 404 | 运行不存在 |
| `LOGIN_SESSION_EXPIRED` | 409 | 二维码过期 |
| `ACCOUNT_EXPIRED` | 409 | iLink 会话过期 |
| `KB_FILE_TOO_LARGE` | 413 | 文件超限 |
| `KB_UNSUPPORTED_TYPE` | 415 | 文件类型不支持 |
| `RATE_LIMITED` | 429 | 请求过频 |
| `INTERNAL_ERROR` | 500 | 兜底 |

---

## 5. 管理后台页面

| 路由 | 内容 | 关键交互 |
|---|---|---|
| `/setup` | 首次创建 owner | `SETUP_TOKEN` 校验 |
| `/login` | 登录 | 密码 + TOTP |
| `/` | 仪表盘 | bot 状态、群数、今日回答、p95、成本、告警 |
| `/accounts` | 账号 | 扫码弹窗、状态、重登、解绑 |
| `/groups` | 群列表 | 搜索、状态、今日用量 |
| `/groups/:id` | 群详情 | Tabs：概览/设置/成员/消息/知识库/运行 |
| `/groups/:id/knowledge` | 知识库 | 上传、状态、检索测试 |
| `/runs` | 运行列表 | 过滤、错误、重放 |
| `/usage` | 用量 | 日/群/模型，预算进度 |
| `/settings` | 系统 | 模型、预算、Webhook、保留期 |
| `/audit` | 审计 | 操作人、时间、目标 |

交互原则：

- 首页先回答“bot 是否在线、今天是否异常、花了多少钱”。
- 解绑/清空/删除必须二次确认 + 输入群名。
- 扫码弹窗展示二维码、倒计时、状态、失败重试。
- 测试台只读，不发送。
- 所有时间按 `Asia/Shanghai` 展示，悬停显示 UTC。

---

## 6. 迁移与种子

- 迁移工具：Drizzle Kit；文件 `packages/core/drizzle/0001_init.sql` 起。
- 迁移在 `api` 启动时执行一次，使用 PG advisory lock `xiaoqi:migrate`。
- 种子：
  - 无 owner 时由 `/setup` 创建；
  - 不预置群/账号；
  - 开发环境 `pnpm db:seed` 创建 demo 数据。
- 回滚：每个迁移写 `down`；生产先备份。

---

## 7. 数据删除

| 触发 | 行为 |
|---|---|
| 管理员删除群数据 | 删除 messages/media/summary/knowledge，保留 runs 聚合 |
| 群被移出 | `status=inactive`，7 天后硬删 |
| 用户 `/privacy` | 展示说明；运营者人工处理 |
| 账号解绑 | 停 poll；保留数据 7 天；owner 可立即清空 |

删除任务写 `audit_logs`，记录操作人、范围、数量。
