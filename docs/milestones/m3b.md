# M3b · 提醒 + 知识库

> 日期：2026-11-06  
> 状态：已实现（关键词检索版）  
> 目标：`/remind` 定时提醒；把本地资料变成可检索的知识库

---

## 1. 提醒

### 命令

```text
/remind 明天10点 交周报
/remind 周五18:00 发版检查
/remind 30分钟后 喝水
/remind 11/12 20:00 发布
```

### 支持的时间格式

| 形式 | 示例 |
|---|---|
| 今天/明天/后天 + 时间 | `明天10点`、`今天18:30` |
| 周几 + 时间 | `周五18:00`、`周天9点` |
| 只有时间 | `18:00`（已过则明天） |
| 相对时间 | `30分钟后`、`2小时后` |
| 月/日 + 时间 | `11/12 20:00` |

- 时区固定 `Asia/Shanghai`；
- 只接受未来 1 分钟–90 天；
- 解析失败会给格式示例。

### 调度

- `reminders` 表：`scheduled → sending → sent | failed`
- Worker 每 20s 扫描到期任务，`FOR UPDATE SKIP LOCKED` 防并发
- 通过 gateway `POST /internal/v1/send-proactive` 发送
- 需要该用户最近一次 `context_token`；过期会失败并记录
- 进程崩溃时，`sending` 超过 5 分钟会回到 `scheduled`

### 已知限制

- 没有“重复提醒”（每天/每周）；
- 没有取消提醒命令（M4 后台可加）；
- 用户长时间不互动导致 token 过期时，提醒可能发不出。

---

## 2. 知识库

### 使用

把 PDF/DOCX/TXT/MD 放到 `knowledge/`：

```bash
mkdir -p knowledge
cp ~/docs/产品手册.pdf knowledge/
pnpm kb:ingest
```

也可以指定文件/目录：

```bash
pnpm kb:ingest knowledge/产品手册.pdf
pnpm kb:ingest ./docs
```

然后直接问：

```text
发布流程里的回滚阈值是多少？
```

回答会带上文档标题作为依据。

### 实现

- `kb_documents` + `kb_chunks`
- 切块：1200 字符 / 100 overlap
- 检索：中文 bigram + 英文词，GIN 索引，按命中数排序
- 每次回答取 top 5 chunk 注入 `<knowledge>`
- 不需要 embedding 服务，纯本地关键词检索

### 已知限制

- **不是语义检索**：同义改写可能搜不到；后续可换 embedding/pgvector；
- 全局知识库，不区分用户/群；
- 没有后台管理 UI，靠 CLI；
- 没有引用页码；
- 文档更新需要重新 ingest（会新增文档记录）。

---

## 3. 数据库

`0003_m3b.sql`：

```sql
reminders(
  id, account_id, user_id, conversation_key,
  text, run_at, status, sent_at, error_code, created_at
)

kb_documents(id, title, source_path, status, created_at)

kb_chunks(
  id, document_id, chunk_index, content, tokens text[]
)
```

索引：

- `reminders(status, run_at)`
- `kb_chunks using gin(tokens)`

---

## 4. 验证

- `pnpm -r typecheck` 通过
- `pnpm test`：23 个测试通过
- 时间解析覆盖明天/周几/相对/月日
- KB ingest + search 已用测试库验证（命中 4 个关键词）

---

## 5. 下一步 M4

1. 管理后台：用户/会话/运行记录/知识库上传；
2. 提醒取消与重复规则；
3. 预算/限流；
4. 语义检索（embedding）；
5. 评测集与可观测。
