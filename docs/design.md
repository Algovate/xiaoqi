# 小栖 Xiaoqi · 系统设计（当前版）

> 更新：2026-11-06  
> 状态：v1 已实现 M1–M5；本文是**当前系统**的单一入口。  
> 历史设计：[DM v0.1](./archive/design-dm-v0.1.md)、[群助手设计](./archive/group-design.md)。  
> 运行方式：[operations.md](./operations.md)。

---

## 1. 产品边界

小栖是**微信私聊 AI 助理**：

- 用户在微信里直接和小栖对话，不需要建群、不需要 @；
- 能问答、看图片/PDF、总结对话、记提醒、查本地知识库；
- 能通过 `/codex`、`/dsh` 把编码任务交给外部 runner；
- 单运营方、小范围用户，不做公开 SaaS。

**不做**：微信群、外部客户群、逆向协议、多租户计费、语音回复、文件出站。

---

## 2. 运行时

```text
微信/iLink
  → gateway（登录、长轮询、发送、typing、媒体入口）
  → PostgreSQL（messages / outbox / context_token）
  → worker（上下文、LLM、视觉/OCR、知识库、提醒）
  → gateway（sendmessage）
  → 微信

runner ← codex_tasks ← worker（/codex、/dsh 命令）
api    ← PostgreSQL（Admin 读模型 + 静态页面）
```

| 进程 | 端口 | 职责 |
|---|---|---|
| `gateway` | 4101 | iLink 协议边缘：登录、leader 锁、poll、发送、typing |
| `worker` | 4102 | 消息流水线、Agent、媒体、KB、提醒、预算、指标 |
| `runner` | 无 | Codex/DSH 任务执行、超时、diff、通知 |
| `api` | 4100 | Admin 仪表盘、REST、`/metrics` |
| `web` | 由 Caddy/静态托管 | 当前为 `api/public/index.html` 零构建页面 |

内部调用统一 `x-xiaoqi-internal`；Admin 用 `x-admin-token`。

---

## 3. 主要流程

### 3.1 私聊消息

```text
getupdates
  → messages + cursor + outbox（同事务）
  → outbox dispatcher
  → BullMQ dm.message
  → 命令 / 附件 / 知识库 / 上下文 / LLM
  → 清洗 + 900 字分段（最多 3 条）
  → gateway sendmessage
  → 出站写入 messages(direction=out)
  → run 记录 tokens/耗时/状态
```

关键约束：

- `message_id` 必须保留为字符串；iLink 的 JSON number 会超过 JS 安全整数。
- `context_token` 按 `dm:<wx_user_id>` 加密存储。
- 发送幂等键 `(run_id, chunk_index)`。
- 游标只在事务提交后推进。

### 3.2 图片/文件

- 网关只落原始消息；worker 在回答前下载 CDN、AES-128-ECB 解密。
- 图片：DeepSeek Flash 视觉描述；失败回退 macOS Apple Vision OCR。
- PDF/DOCX/TXT/MD：`unpdf` / `mammoth` / 直接读取。
- 提取文本只注入**当前轮**；持久知识库走 `knowledge/`。

### 3.3 提醒

- `/remind` 解析为 `reminders` 行（Asia/Shanghai）。
- worker 每 20s 扫描到期任务，调 gateway `/internal/v1/send-proactive`。
- 需要最近 `context_token`；过期则失败并记录。

### 3.4 Codex / DSH

- `/codex <repo> <task>` / `/dsh <repo> <task>` 写 `codex_tasks`。
- runner 串行领取：
  - Codex：`codex exec --json -C <repo> --sandbox workspace-write -o <tmp> <prompt>`
  - Codex resume：`codex exec resume <session> --json -o <tmp> <prompt>`
  - DSH：`dsh headless "<prompt>"`，cwd 为 repo
- 完成后计算 `git diff --stat` + `git status --short`，私聊通知。
- repo 与用户均在 allowlist；超时杀进程组。

---

## 4. 当前能力

| 能力 | 状态 |
|---|---|
| 私聊问答 + 上下文 | ✅ |
| DeepSeek 回答、typing、分段、兜底 | ✅ |
| 图片视觉（DeepSeek Flash） | ✅ |
| macOS 本地 OCR 兜底 | ✅ |
| PDF/DOCX/TXT 抽取 | ✅ |
| `/summary` `/reset` `/whoami` `/help` | ✅ |
| `/remind` + 定时发送 | ✅ |
| 知识库关键词检索 + `kb:ingest` | ✅ |
| Admin 仪表盘 + 每日 token 预算 | ✅ |
| Prometheus `/metrics` + 预算 Webhook | ✅ |
| Codex / DSH runner + resume + diff | ✅ |
| 语音回复、群聊、RBAC/TOTP、语义检索 | ❌ 未做 |

---

## 5. 命令

| 命令 | 行为 |
|---|---|
| `/help` | 用法 |
| `/whoami` | 当前 wx user id |
| `/reset` | 清空当前对话上下文（设置 reset_at） |
| `/summary` | 总结最近对话并写摘要 |
| `/remind <时间> <内容>` | 定时提醒 |
| `/codex <repo> <任务>` | 启动 Codex |
| `/codex resume <id> <指令>` | 继续 Codex session |
| `/codex list/status/stop` | 任务管理 |
| `/dsh <repo> <任务>` | 启动 DSH |
| `/dsh list/status/stop` | 任务管理 |

> `/translate`、`/privacy` 尚未实现，不要在文档/回答里承诺。

---

## 6. 数据

| 表 | 用途 |
|---|---|
| `accounts` / `account_cursors` | iLink 账号与游标 |
| `users` | 私聊用户 |
| `messages` | 入站/出站消息，`conversation_key=dm:<wxid>` |
| `context_tokens` | 加密的 context_token |
| `runs` / `outbound_messages` | 回答运行与分段 |
| `outbox` | 事务 outbox |
| `media_assets` | 解密后的媒体与抽取文本 |
| `conversation_state` | 摘要 / reset_at |
| `reminders` | 定时提醒 |
| `kb_documents` / `kb_chunks` | 知识库（关键词 tokens） |
| `codex_tasks` / `codex_task_events` | Codex/DSH 任务与事件 |

迁移在 `packages/core/migrations/`，从 `0001_init.sql` 到 `0006_dsh.sql`。

---

## 7. 配置

主要环境变量：

```dotenv
DATABASE_URL=...
REDIS_URL=...
MASTER_KEY=base64:...
INTERNAL_TOKEN=...
ADMIN_TOKEN=...
LLM_BASE_URL=https://api.deepseek.com/v1
LLM_API_KEY=...
LLM_MODEL=deepseek-chat
LLM_VISION_MODEL=deepseek-flash
MAX_DAILY_TOKENS=100000
ALERT_WEBHOOK_URL=
CODEX_BIN=codex
DSH_BIN=dsh
CODEX_REPOS=xiaoqi=/absolute/path
CODEX_ALLOWED_USERS=wxid@im.wechat
OCR_ENABLED=auto
```

完整表见 [operations.md](./operations.md)。

---

## 8. 安全边界

- Admin 单 token，默认只听 `127.0.0.1`；公网必须 TLS + IP allowlist。
- Codex/DSH 只允许 allowlist repo 和 allowlist 用户；固定 `workspace-write`，不用 danger-full-access。
- 任务超时、杀进程组、单 runner 串行。
- 媒体大小限制、MIME/魔数校验；OCR 本地执行。
- 日志默认不记录消息正文；token 加密存储。
- 知识库当前全局、关键词检索；不含用户隔离/embedding。

---

## 9. 已知限制

- 单账号、单 runner；无多租户。
- 知识库不是语义检索，同义改写可能搜不到。
- 附件文本只在当前轮使用，未做持久附件 RAG。
- DSH 只有 `headless`，无 session/resume。
- 无 RBAC/TOTP、无逐行 diff review、无语音回复。
- 群聊方案已归档，等官方群能力再评估。

---

## 10. 下一步

1. 语义检索（embedding + pgvector）。
2. RBAC/TOTP（多管理员/公网后台）。
3. 逐行 diff / code review。
4. 附件持久化 RAG / 语音回复。
5. Grafana/Alertmanager 规则。

---

## 11. 相关文档

- [运行手册](./operations.md)
- [品牌](./brand.md)
- [Phase 0 结果](./phase0-results.md)
- [历史时间线](./history.md)
- [ADR](./adr/)
- [群版归档](./archive/group-design.md)
