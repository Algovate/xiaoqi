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
| `MAX_DAILY_TOKENS` |  | 默认 100000 |
| `ALERT_WEBHOOK_URL` |  | 企业微信 Webhook |
| `OCR_ENABLED` |  | `auto/true/false` |
| `CODEX_BIN` |  | 默认 `codex` |
| `CODEX_REPOS` |  | `alias=/abs/path,...` |
| `CODEX_ALLOWED_USERS` |  | 允许触发任务的人 |
| `CODEX_TIMEOUT_MS` |  | 默认 900000 |
| `DSH_BIN` |  | 默认 `dsh` |
| `DSH_TIMEOUT_MS` |  | 默认 900000 |

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
/remind 明天10点 交周报
/codex list
/codex xiaoqi 修复失败测试
/codex resume <id> 继续
/dsh xiaoqi 分析仓库
```

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
| 预算告警不发送 | 检查 `ALERT_WEBHOOK_URL`，以及是否已达到 50/80/100% |
| Admin 401 | `ADMIN_TOKEN` 是否与 `.env` 一致；api 是否重启 |

---

## 8. 数据与清理

- `.env`、`.poc`、`tools/ocr-bin`、`node_modules` 均已 gitignore。
- 原始消息默认 7 天，摘要 30 天（代码尚未实现定时清理，当前手工维护）。
- 备份：`pg_dump`；迁移文件在 `packages/core/migrations/`。
