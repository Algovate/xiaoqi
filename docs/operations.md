# 小栖 Xiaoqi · 运行手册

> 适用：本机 macOS / Node 24+ / Docker。  
> 当前架构见 [design.md](./design.md)。

---

## 1. 启动顺序

```bash
# 1. 依赖
docker compose up -d postgres redis
pnpm install

# 2. 环境
cp .env.example .env
# 填 MASTER_KEY / INTERNAL_TOKEN / ADMIN_TOKEN / LLM_API_KEY

# 3. 迁移
pnpm db:migrate

# 4. 扫码登录
pnpm ilink:login

# 5. 进程（分开终端）
pnpm dev:gateway
pnpm dev:worker
pnpm dev:api
pnpm dev:runner     # Codex/DSH，需要普通终端
```

Admin：

```text
http://127.0.0.1:4100
x-admin-token: <ADMIN_TOKEN>
```

---

## 2. 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | PostgreSQL |
| `REDIS_URL` | ✅ | Redis / BullMQ |
| `MASTER_KEY` | ✅ | 32 字节 base64，加密 token |
| `INTERNAL_TOKEN` | ✅ | gateway ↔ worker/runner |
| `ADMIN_TOKEN` | ✅（api） | Admin REST |
| `LLM_BASE_URL` | ✅ | OpenAI-compatible |
| `LLM_API_KEY` | ✅ | DeepSeek |
| `LLM_MODEL` |  | `deepseek-chat` |
| `LLM_VISION_MODEL` |  | `deepseek-flash` |
| `WEB_SEARCH_ENABLED` |  | 默认 `true`；联网搜索总开关 |
| `WEB_SEARCH_AUTO` |  | 默认 `true`；模型可自动搜索；`false` 仅 `/search` |
| `WEB_SEARCH_MAX_RESULTS` |  | 默认 5，最多 10 |
| `WEB_SEARCH_TIMEOUT_MS` |  | 默认 15000 |
| `ILINK_CDN_BASE` |  | 图片上传 CDN，默认 `https://novac2c.cdn.weixin.qq.com/c2c` |
| `MEDIA_DIR` |  | 媒体目录，默认 `./data/media` |
| `MEDIA_OUTBOUND_ENABLED` |  | 默认 `true`；图片/图表出站开关 |
| `MEDIA_OUTBOUND_MAX_BYTES` |  | 默认 5000000 |
| `MAX_DAILY_TOKENS` |  | 默认 100000 |
| `ALERT_WEBHOOK_URL` |  | 企业微信 Webhook |
| `OCR_ENABLED` |  | `auto/true/false` |
| `CODEX_BIN` |  | 默认 `codex` |
| `CODEX_REPOS` |  | `alias=/abs/path,...` |
| `CODEX_ALLOWED_USERS` |  | 允许触发任务的人 |
| `CODEX_TIMEOUT_MS` |  | 默认 900000 |
| `DSH_BIN` |  | 默认 `dsh` |
| `DSH_TIMEOUT_MS` |  | 默认 900000 |
| `WELCOME_MESSAGE` |  | 首次欢迎语；留空用默认文案 |

生成密钥：

```bash
openssl rand -base64 32   # MASTER_KEY
openssl rand -hex 24      # INTERNAL_TOKEN / ADMIN_TOKEN
```

---

## 3. 常用命令

```text
/help
/whoami
/reset
/summary
/search 今天上海天气
/chart bar 月销量 | 一月=120,二月=180
/remind 明天10点 交周报
/codex list
/codex xiaoqi 修复失败测试
/codex resume <id> 继续
/dsh xiaoqi 分析仓库
```

### 欢迎语

新用户第一条消息前会发送一次欢迎语。自定义：

```dotenv
WELCOME_MESSAGE="我是小栖，你的微信 AI 助理。\n直接发问题，或发图片/PDF 让我看。\n/help 查看命令。"
```

想对老用户重发，把 `users.welcomed_at` 置空即可。

### 联网搜索

使用 DeepSeek 原生 Search API，不需要额外搜索 key：

1. 确认 `LLM_BASE_URL=https://api.deepseek.com/v1`、`LLM_API_KEY` 可用；
2. `WEB_SEARCH_ENABLED=true`（默认），重启 worker；
3. 时效问题由模型按需搜索，也可以 `/search <问题>` 强制搜索。

只关自动搜索：`WEB_SEARCH_AUTO=false`；完全关闭：`WEB_SEARCH_ENABLED=false`。搜索按成功请求计费，复用 DeepSeek 账户余额；不抓取网页正文。

### 数据图表 / 图片出站

`/chart` 生成 PNG 并通过 iLink CDN 发送：

```text
/chart bar 月销量 | 一月=120,二月=180,三月=150
/chart bar 销量/成本 | 一月=12/8,二月=18/10 | 销量/成本
/chart line 温度趋势 | 周一=12,周二=14
/chart pie 流量占比 | 搜索=60,直接=25,其他=15
```

- 也可以直接说“画一个柱状图：一月 12，二月 18”，模型会调用 `render_chart`。
- PNG 渲染使用 macOS 自带 `sips`；Linux 上会失败并回退文本提示。
- `MEDIA_OUTBOUND_ENABLED=false` 可完全关闭；单图上限 `MEDIA_OUTBOUND_MAX_BYTES`。
- 依赖最近一次入站消息的 `context_token`；主动推送图片可能失败。
- 只支持柱状/折线/饼图；AI 生图不在范围内。

---

## 4. 运维端点

| 地址 | 用途 |
|---|---|
| `:4100/healthz` | api |
| `:4100/metrics` | Prometheus |
| `:4101/healthz` | gateway |
| `:4101/metrics` | Prometheus |
| `:4102/healthz` | worker |
| `:4102/metrics` | Prometheus |

Prometheus 抓取示例：

```yaml
scrape_configs:
  - job_name: xiaoqi
    static_configs:
      - targets: ["127.0.0.1:4100", "127.0.0.1:4101", "127.0.0.1:4102"]
```

指标说明见 [archive/milestones/m4b.md](./archive/milestones/m4b.md)。

---

## 5. OCR

```bash
pnpm ocr:build
```

- macOS Apple Vision，本地、免费；
- 产物 `tools/ocr-bin`，已 gitignore；
- Linux 设 `OCR_ENABLED=false` 或换 tesseract/云 OCR。

---

## 6. Codex / DSH

- runner 必须在**普通终端**运行；DSH app sandbox 下 Codex 会 `EPERM`。
- 只允许 `CODEX_REPOS` 中的绝对路径。
- 只允许 `CODEX_ALLOWED_USERS` 中的微信 ID。
- 单 runner 串行，超时杀进程组。
- DSH 使用 `headless` profile；报 profile 不存在时，先普通终端跑一次 `dsh headless --help`。

---

## 7. 常见问题

| 现象 | 处理 |
|---|---|
| 私聊没回复 | 检查 gateway/worker 是否在跑；看 `runs.error_code`；看 gateway 日志 |
| 登录过期 `-14` | 重新 `pnpm ilink:login` |
| 任务只排队不执行 | 启动 `pnpm dev:runner` |
| Codex `EPERM` | runner 移到普通终端，不要在 DSH sandbox 里跑 |
| OCR 没结果 | 确认 `pnpm ocr:build`、`OCR_ENABLED=auto` |
| 知识库搜不到 | 运行 `pnpm kb:ingest`；当前是关键词检索，不是语义检索 |
| 联网搜索不触发 | 确认 `WEB_SEARCH_ENABLED`/`WEB_SEARCH_AUTO`；直接发 `/search <问题>`；看 `xiaoqi_web_search_total` |
| 搜索报 401/402 | 检查 `LLM_API_KEY` 与 DeepSeek 账户余额；Search 复用同一个 key |
| 搜索报 400 / 模型不调用工具 | 确认 `LLM_MODEL` 支持 Tool Calls；可改用 `deepseek-flash` 或 `deepseek-v4-pro` |
| 图表发送失败 | 确认 `MEDIA_OUTBOUND_ENABLED=true`、`sips` 可用；看 worker/gateway 日志和 `xiaoqi_send_total` |
| 图片显示灰色/无法打开 | 检查 `aes_key` 是否为 base64(hex 字符串)、CDN 响应是否有 `x-encrypted-param` |
| 预算告警不发送 | 检查 `ALERT_WEBHOOK_URL`，以及是否已达到 50/80/100% |
| Admin 401 | `ADMIN_TOKEN` 是否与 `.env` 一致；api 是否重启 |

---

## 8. 数据与清理

- `.env`、`.poc`、`tools/ocr-bin`、`node_modules` 均已 gitignore。
- 原始消息默认 7 天，摘要 30 天（代码尚未实现定时清理，当前手工维护）。
- 备份：`pg_dump`；迁移文件在 `packages/core/migrations/`。
