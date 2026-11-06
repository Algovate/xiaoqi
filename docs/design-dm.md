# 小栖 · 微信私聊 AI 助理设计（v1 / DM）

> 版本：v0.1  
> 日期：2026-11-06  
> 状态：Phase 0 后定稿；替代原“群助手”v1 范围  
> 依据：[Phase 0 结果](./phase0-results.md)  
> 说明：原群助手设计保留在 [`design.md`](./archive/group-design.md) 作为历史/future 参考；**当前开发以本文为准**。

---

## 1. 为什么转私聊

Phase 0 实测确认：

- 扫码登录拿到的是 `...@im.bot` 的 iLink bot 身份；
- 该身份不能加入普通微信群，群消息不推送；
- 私聊通道完整可用：文本、图片、PDF、引用、发送、媒体解密都已验证；
- 企业微信官方机器人只支持内部员工群；外部客户群（含微信用户）官方不支持双向对话，非官方协议风险高。

因此 v1 收缩为**微信私聊 AI 助理**：用户在微信里直接和小栖对话，不需要建群、不需要 @、不需要管理员拉群。

---

## 2. 产品定义

### 2.1 一句话

**小栖是微信里的私人 AI 助理：发消息就能问、能看文件、能记住上下文、能提醒你。**

### 2.2 目标用户

- 个人用户：把微信当成工作/生活入口，不想再开一个 App；
- 小团队/自由职业者：需要快速总结文件、查资料、记待办；
- 运营者：自己或小范围用户使用，不面向公众大规模开放。

### 2.3 v1 能力

| 能力 | 说明 |
|---|---|
| 对话问答 | 结合最近对话、引用消息、附件回答 |
| 图片理解 | 截图、报错、表格、界面 |
| 文件理解 | PDF/DOCX/TXT/MD，抽取文本后回答 |
| 语音理解 | 优先用微信转写；无转写提示发文字 |
| 记忆 | 最近 30 条 / 2 小时 + 滚动摘要；`/reset` 可清 |
| 提醒 | `/remind 明天10点 …`，到点私聊提醒 |
| 翻译/润色 | `/translate`、自然语言 |
| 知识库 | 管理员上传的共享资料；回答带出处 |
| 隐私 | 一对一；可查看/删除自己的数据 |

### 2.4 非目标（v1）

- 不加群、不做群聊总结、不做群内 @；
- 不做外部客户群/个人微信群自动客服；
- 不做多租户 SaaS、开放注册、计费；
- 不做语音回复、图片/文件出站；
- 不做主动营销/群发；
- 不做成员画像。

---

## 3. 用户旅程

### 3.1 首次使用

```text
用户扫码/添加 bot → 私聊发“你好”
  → 小栖欢迎语 + 能力提示 + 隐私说明
  → 用户发问题/文件
  → 小栖回答
```

欢迎语：

```text
我是小栖，你的微信 AI 助理。
直接发问题，或发图片/PDF 让我看。
/help 查看命令，/privacy 查看数据说明。
```

### 3.2 日常

```text
用户：帮我总结这份 PDF
小栖：[文件解析中] → 结论/要点/待办
用户：那第二点展开
小栖：结合上一轮回答展开
用户：/remind 明天10点 交周报
小栖：已设置
```

### 3.3 数据控制

- `/privacy`：说明读取范围、保留期、删除方式；
- `/reset`：清空当前对话的短期上下文与摘要；
- 后台：按用户删除消息/媒体/摘要；
- 默认原始消息 7 天，摘要 30 天。

---

## 4. 交互规则

### 4.1 触发

| 输入 | 行为 |
|---|---|
| 任意私聊文本 | 触发（无需 @） |
| 图片/文件/语音 | 触发，先解析附件 |
| `/` 命令 | 确定性处理 |
| 引用 bot 消息 | 视为追问 |
| 转发聊天记录/文件 | 解析后总结（P1，需验证格式） |
| bot 自己发的消息 | 忽略，防自循环 |

### 4.2 命令

| 命令 | 权限 | 行为 |
|---|---|---|
| `/help` | 用户 | 用法卡片 |
| `/summary [30m\|2h\|50]` | 用户 | 总结当前私聊最近消息 |
| `/translate <语言> <文本>` | 用户 | 翻译 |
| `/remind <时间> <内容>` | 用户 | 创建提醒 |
| `/privacy` | 用户 | 数据说明 |
| `/whoami` | 用户 | 返回自己的 iLink 用户 ID |
| `/reset` | 用户 | 清空当前对话短期上下文 |
| `/status` | 管理员 | 模型/队列/用量 |
| `/stop` | 用户 | 取消当前生成 |

> DM 里 `/reset` 只影响自己的对话，不需要管理员权限；这是和群版最大的权限差异。

### 4.3 回复

- 单条 ≤900 字，最多 3 条；段间 400–800ms；
- 纯文本，不用 Markdown 标题/表格；
- 图片/文件先给“已收到，正在看…”（超过 5 秒时），再给结论；
- 失败给固定文案 + trace；
- 不伪造“已发送/已完成”。

### 4.4 频率与预算

| 项 | 默认 |
|---|---|
| 单用户并发 | 1 |
| 用户冷却 | 1s（DM 比群宽松） |
| 单用户日预算 | ¥2 |
| 单次输入 | 12k tokens |
| 单次输出 | 1.5k tokens |
| 附件 | 20MB / 200 页 |

---

## 5. 架构

### 5.1 复用

```text
微信用户 ↔ iLink ↔ gateway ↔ Redis/BullMQ ↔ worker ↔ LLM/RAG
                                      ↕
                                  PostgreSQL
```

- gateway：iLink 登录、长轮询、发送、媒体、context_token；
- worker：归一化、上下文、Agent、RAG、提醒；
- api/web：管理后台（用户、会话、用量、知识库）；
- PostgreSQL/Redis：同一套。

### 5.2 相对群版的简化

| 群版 | DM 版 |
|---|---|
| 群锁 `lock:group:{id}` | 用户锁 `lock:dm:{wxUserId}` |
| 群回复 resolver（group_id/sender） | 固定回复 `from_user_id` |
| @ 解析 / 群成员权限 | 无 @；无群角色 |
| 群摘要 `/summary` | 私聊摘要（最近 N 条） |
| 群知识库 | 全局知识库 + 当前附件 |
| 群设置 | 用户设置（屏蔽/预算/保留期） |
| 群表/成员表 | `users` / `conversations`（群表保留但不使用） |

### 5.3 进程

与详细设计 00 一致：`gateway` / `worker` / `api` / `web`。  
**Phase 0 已验证**：gateway 可登录、长轮询、发送；worker 尚未实现。

---

## 6. 消息流水线（DM）

### 6.1 入站

1. `getupdates` 收到 DM；`group_id` 为空；
2. 事务写 `messages` + 游标 + outbox；
3. `conversation_key = "dm:" + from_user_id`；
4. 写 `users`（upsert，记录 last_seen）；
5. outbox → worker。

### 6.2 归一化

- 文本、图片、语音转写、文件、引用；
- 引用只有 `ref_msg.message_item.msg_id`：按 `messages.wx_message_id` 或 `item msg_id` 本地查；
- `message_id` **必须按字符串保留**（getupdates 里是超出 JS 安全整数的 JSON number）；
- 无昵称：用“你”或短 ID；后台可绑定备注名。

### 6.3 触发

- 私聊所有文本/附件都触发；
- 命令优先；
- 用户 1s 冷却；同用户串行；
- 800ms 合并窗口（连续发多条）；
- 预算/频率超限：固定提示 + 记录。

### 6.4 上下文

| 部分 | 预算 |
|---|---|
| 系统提示 | 2,000 |
| 用户资料/偏好 | 200 |
| 固定事实 | 300 |
| 滚动摘要 | 700 |
| 最近消息 | 4,800（30 条 / 2h） |
| 引用 | 800 |
| 附件 | 1,300 |
| RAG | 1,400 |
| 当前问题 | 500 |
| **合计** | **12,000** |

- 对话格式：`[14:02] 你：…` / `[14:03] 小栖：…`；
- 附件用 `<attachment>`；
- 引用用 `<quoted_message>`；
- 记忆只属于该用户，绝不跨用户。

### 6.5 输出

- 与详细设计 02 相同的清洗/分段/发送；
- 发送目标固定 `from_user_id`；
- `context_token` 按 `dm:<user>` 缓存；
- 发送失败重试 3 次；`-14` → 后台告警 + 重登。

---

## 7. 数据模型（DM 增量）

### 7.1 新增/调整

```sql
create table users (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  wx_user_id text not null,
  display_name text,
  status text not null default 'active' check (status in ('active','blocked','deleted')),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  settings jsonb not null default '{}'::jsonb,
  unique (account_id, wx_user_id)
);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  conversation_key text not null unique, -- dm:<wx_user_id>
  summary text,
  summary_tokens integer not null default 0,
  last_summarized_message_id bigint,
  updated_at timestamptz not null default now()
);
```

- `messages.conversation_key` 沿用，`group_id` 留空；
- `context_tokens.conversation_key` 沿用；
- `usage_daily` 改为按 `user_id` 聚合（或新增 `usage_daily_user`）；
- `reminders` 增加 `user_id`，去掉 `group_id`（群版字段保留 nullable）；
- `kb_documents` 增加 `scope`（`global`/`user`），v1 只做 global；
- 群表保留但不写；未来群能力开放时再启用。

### 7.2 保留期

| 数据 | 默认 |
|---|---|
| 原始消息 | 7 天 |
| 媒体 | 7 天 |
| 摘要 | 30 天 |
| runs | 30 天 |
| 审计 | 180 天 |

---

## 8. 管理 API（DM）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/users` | 用户列表、最近活跃、用量 |
| GET | `/api/v1/users/:id` | 用户详情 + 设置 |
| PATCH | `/api/v1/users/:id` | 备注名/状态/预算 |
| GET | `/api/v1/users/:id/messages` | 会话消息 |
| GET | `/api/v1/users/:id/runs` | 运行记录 |
| DELETE | `/api/v1/users/:id/data` | 删除该用户数据 |
| GET | `/api/v1/conversations` | 会话列表（按用户） |
| GET | `/api/v1/knowledge` | 全局知识库 |
| POST | `/api/v1/knowledge` | 上传 |
| GET | `/api/v1/usage` | 按用户/天 |
| GET | `/api/v1/settings` | 模型/预算/告警 |
| GET | `/api/v1/audit` | 审计 |

- 群相关路径不实现；
- 保留 `/accounts` 登录/扫码；
- SSE：`bot.status`、`alert`、`run.failed`。

---

## 9. Agent / RAG（DM 差异）

- 系统提示去掉“群聊/多人/@”；
- 称呼用户“你”，不猜名字；
- 摘要只总结当前用户对话；
- 知识库 v1 全局；用户附件只在当前 run 使用；
- 工具：`get_conversation_messages`、`search_knowledge`、`read_attachment`、`create_reminder`、`web_search`、`get_usage`；
- 安全：一人一域，禁止跨用户检索；输出过滤保留。

---

## 10. 品牌

**产品名：小栖 Xiaoqi；Bot：小栖；Git repo：`xiaoqi`；组织：`xiaoqi-app`。**

> 小栖 · 微信私聊 AI 助理  
> 有事，问小栖。

---

## 11. 里程碑（DM 版）

| 阶段 | 内容 | 产出 |
|---|---|---|
| M0 | Phase 0（已完成） | 私聊收发、媒体、context_token 验证 |
| M1 | monorepo、config、DB、fake iLink、登录、轮询、DM echo | 私聊 echo，重启续传 |
| M2 | DM 上下文、LLM、图片/文件、分段、typing、兜底 | 可日常问答 |
| M3 | 摘要、提醒、知识库、`/reset`、隐私 | 完整个人助理 |
| M4 | 后台：用户/会话/用量/知识库/告警 | 可运营 |
| M5 | 压测、安全、试点 | 上线检查单 |

**不做**：群锁、群成员、@ 解析、群回复 resolver、群摘要。

---

## 12. 验收（DM v1）

- [ ] 私聊任意文本，10s 内回答
- [ ] 连续追问能指代
- [ ] 图片报错截图能识别
- [ ] PDF 能总结并给出处
- [ ] 重复 `message_id` 不重复回复
- [ ] 杀掉 worker 任务恢复；杀掉 gateway 游标续传
- [ ] `-14` 2 分钟内告警，扫码恢复
- [ ] `/reset` 只清自己的上下文
- [ ] 注入不泄露系统提示
- [ ] 预算 100% 降级有记录
- [ ] 删除用户数据后不可查

---

## 13. 待确认

1. 是否做“转发聊天记录 → 纪要”（P1，需验证微信转发格式）；
2. 知识库是全局还是允许用户上传个人库；
3. 试点用户数量与邀请方式；
4. LLM provider/预算/部署地域。
