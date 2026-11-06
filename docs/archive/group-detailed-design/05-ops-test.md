# 小栖 Xiaoqi · 详细设计 05 · 部署、运维与测试

> **归档提示（2026-11-06）**：Phase 0 群聊 No-Go；本文件为群版 future 参考。当前 v1 私聊设计见 [`../design-dm.md`](../../design.md)。


> 对应代码：`docker-compose.yml`、`deploy/`、`test/`  
> 目标：让一个工程师能在 2C4G 单机上部署、观测、排障、验收。  
> 前置：[00 总览](./00-overview.md)、[04 数据与 API](./04-data-api.md)

---

## 1. 部署

### 1.1 目标环境

| 项 | 值 |
|---|---|
| 云 | 腾讯云轻量/ECS（广州/上海） |
| 规格 | 2 vCPU / 4GB / 50GB SSD |
| OS | Ubuntu 24.04 LTS |
| 运行时 | Docker 27+ / Compose v2 |
| 域名 | `admin.<domain>`（仅后台）、`api.<domain>`（可选） |
| TLS | Caddy 自动证书 |
| 时区 | 容器 UTC，业务展示 Asia/Shanghai |

### 1.2 Compose 服务

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    restart: unless-stopped
    environment:
      POSTGRES_DB: xiaoqi
      POSTGRES_USER: xiaoqi
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U xiaoqi -d xiaoqi"]
      interval: 10s
      timeout: 3s
      retries: 10

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ["redis-server", "--appendonly", "yes", "--maxmemory", "256mb", "--maxmemory-policy", "noeviction"]
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 3s
      retries: 10

  api:
    build: { context: ., dockerfile: apps/api/Dockerfile }
    restart: unless-stopped
    env_file: [.env]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    ports: ["127.0.0.1:4100:4100"]
    healthcheck:
      test: ["CMD", "node", "dist/healthcheck.js", "http://127.0.0.1:4100/healthz"]
      interval: 15s
      timeout: 5s
      retries: 5

  gateway:
    build: { context: ., dockerfile: apps/gateway/Dockerfile }
    restart: unless-stopped
    env_file: [.env]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    expose: ["4101"]
    healthcheck:
      test: ["CMD", "node", "dist/healthcheck.js", "http://127.0.0.1:4101/internal/v1/health"]
      interval: 15s
      timeout: 5s
      retries: 5

  worker:
    build: { context: ., dockerfile: apps/worker/Dockerfile }
    restart: unless-stopped
    env_file: [.env]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      gateway: { condition: service_started }
    expose: ["4102"]
    volumes:
      - media:/data/media

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./deploy/Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    depends_on: [api]

volumes:
  pgdata:
  redisdata:
  media:
  caddy_data:
  caddy_config:
```

### 1.3 Caddyfile

```caddy
admin.example.com {
  encode zstd gzip
  reverse_proxy api:4100
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options "nosniff"
    Referrer-Policy "strict-origin-when-cross-origin"
  }
}
```

- 只暴露 443；`api/gateway/worker` 不映射公网端口。
- 管理后台可加 IP allowlist：`@allowed remote_ip 1.2.3.4/32`。

### 1.4 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `DATABASE_URL` | ✅ | — | `postgres://xiaoqi:...@postgres:5432/xiaoqi` |
| `REDIS_URL` | ✅ | — | `redis://redis:6379` |
| `MASTER_KEY` | ✅ | — | 32 字节 base64；token/TOTP 加密 |
| `INTERNAL_TOKEN` | ✅ | — | gateway ↔ api/worker |
| `SETUP_TOKEN` | ✅ | — | 首次创建 owner |
| `ILINK_BASE_URL` |  | `https://ilinkai.weixin.qq.com` | 登录返回的 baseurl 优先 |
| `ILINK_APP_ID` |  | `bot` | `iLink-App-Id` |
| `ILINK_APP_VERSION` |  | `132106` | 0x00MMNNPP |
| `ILINK_GROUP_REPLY_TARGET` |  | `group` | Phase 0 结论：`group`/`sender` |
| `LLM_BASE_URL` | ✅ | — | OpenAI-compatible |
| `LLM_API_KEY` | ✅ | — | — |
| `LLM_MODEL` |  | `deepseek-chat` | — |
| `LLM_FALLBACK_MODEL` |  | `qwen-plus` | — |
| `EMBEDDING_BASE_URL` | ✅ | — | — |
| `EMBEDDING_API_KEY` | ✅ | — | — |
| `EMBEDDING_MODEL` |  | `bge-m3` | — |
| `MEDIA_DIR` |  | `/data/media` | 媒体卷 |
| `ADMIN_ORIGIN` | ✅ | — | CORS/CSRF |
| `LOG_LEVEL` |  | `info` | pino |
| `LOG_MESSAGE_CONTENT` |  | `false` | 调试开关 |
| `TZ` |  | `Asia/Shanghai` | 展示时区 |
| `DAILY_BUDGET_CNY` |  | `2` | 默认群预算 |
| `FEATURE_WEB_SEARCH` |  | `false` | 全局开关 |

校验：`packages/core/src/config.ts` 用 Zod；缺失/非法直接退出并打印字段名（不打印值）。

### 1.5 构建

多阶段 Dockerfile（三个 app 共用基础）：

```dockerfile
FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages ./packages
COPY apps/gateway/package.json ./apps/gateway/package.json
RUN pnpm install --frozen-lockfile

FROM base AS build
COPY . .
RUN pnpm --filter @xiaoqi/gateway build

FROM node:24-alpine AS runtime
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/gateway/dist ./dist
COPY --from=build /app/packages ./packages
USER app
CMD ["node", "dist/server.js"]
```

- 镜像固定 digest；非 root；只读根文件系统（除 `/data/media`）。
- `NODE_ENV=production`；关闭 devDependencies。

### 1.6 备份与恢复

- 每日 03:00：`pg_dump -Fc` → 对象存储（COS/S3），服务端加密，保留 7 天。
- 每周日：完整备份保留 30 天。
- Redis 不是事实源；丢失后从 outbox/DB 重建队列。
- 媒体卷每日增量备份；保留 7 天。
- 恢复演练：每季度一次，新建库 → restore → smoke test。
- 备份脚本失败告警；连续 2 天失败升级。

### 1.7 升级

```text
1. 备份
2. docker compose pull/build
3. api 运行迁移（advisory lock）
4. 滚动重启 gateway → worker → api
5. 验证 /healthz、/readyz、群内 echo
6. 失败回滚：镜像 tag + 数据库迁移 down（若可）
```

- 迁移必须向后兼容一个版本（先加列，再迁数据，最后删旧列）。
- 不在高峰期发布；发布窗口 10:00–18:00。

---

## 2. 可观测性

### 2.1 指标

| 指标 | 类型 | 说明 |
|---|---|---|
| `xiaoqi_poll_up{account}` | gauge | 1/0 |
| `xiaoqi_poll_errors_total{reason}` | counter | 轮询错误 |
| `xiaoqi_poll_lag_seconds{account}` | gauge | 最后成功轮询距今 |
| `xiaoqi_inbound_total{result}` | counter | received/ignored/queued |
| `xiaoqi_queue_depth{queue}` | gauge | BullMQ |
| `xiaoqi_outbox_lag_seconds` | gauge | 最老 pending |
| `xiaoqi_agent_runs_total{status}` | counter | — |
| `xiaoqi_agent_duration_seconds{model}` | histogram | p50/p95 |
| `xiaoqi_llm_tokens_total{model,type}` | counter | — |
| `xiaoqi_llm_cost_usd_total{group}` | counter | — |
| `xiaoqi_send_total{result}` | counter | sent/failed/dedup |
| `xiaoqi_send_duration_seconds` | histogram | — |
| `xiaoqi_http_requests_total{route,status}` | counter | — |

### 2.2 日志

```json
{
  "level": "info",
  "time": "2026-11-06T06:10:00.000Z",
  "service": "worker",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "accountId": "…",
  "groupId": "…",
  "runId": "…",
  "event": "agent.completed",
  "durationMs": 5320,
  "tokens": { "prompt": 4200, "completion": 380 }
}
```

- 默认不记录正文；`LOG_MESSAGE_CONTENT=true` 启动时打印警告。
- 脱敏字段：`authorization`, `x-xiaoqi-internal`, `token`, `aes_key`, `cookie`, `email`, `phone`.
- 错误日志带 `errorCode` + `stack`（内部），用户只看到 trace。

### 2.3 追踪

一个入站消息一个 trace：

```text
poll.getupdates
  └─ inbound.persist
      └─ queue.publish
          └─ worker.inbound
              └─ agent.run
                  ├─ context.build
                  ├─ rag.search
                  ├─ llm.chat
                  └─ gateway.send
```

- OpenTelemetry OTLP → 本地 collector 或直接导出。
- span 属性：`xiaoqi.account_id`, `xiaoqi.group_id`, `xiaoqi.run_id`, `xiaoqi.model`。
- 不记录 prompt/response 正文到 span；只记 token/长度。

### 2.4 告警

| 告警 | 条件 | 级别 | 动作 |
|---|---|---|---|
| Bot 掉线 | `poll_up=0` 2 分钟 | P1 | Webhook/邮件 |
| 会话过期 | `errcode=-14` | P1 | 立即；引导扫码 |
| 发送失败 | 5 分钟失败率 > 5% | P1 | 降速 + 告警 |
| 队列积压 | depth > 100 或最老 > 2 分钟 | P2 | 扩容/检查 LLM |
| 延迟劣化 | p95 > 20s 10 分钟 | P2 | 告警 |
| 成本 | 日成本 > 80% 预算 | P2 | 告警；100% 降级 |
| 磁盘 | > 80% | P2 | 清理媒体 |
| 备份失败 | 连续 2 天 | P2 | 告警 |
| 注入命中 | 输出过滤命中 | P3 | 日报汇总 |

- 告警去重：Redis `xiaoqi:alert:{key}` 5 分钟。
- 通知渠道：企业微信 Webhook / 邮件；v1 至少一个。

---

## 3. 运行手册

| 场景 | 操作 |
|---|---|
| 会话过期 | 后台横幅 → 账号页重新扫码 → 确认群内 echo；不要反复重启 gateway |
| 轮询卡死 | 看 `last_poll_at`；重启 gateway；检查游标；必要时从空游标重建并告警 |
| 队列积压 | 看 `queue_depth`；扩 worker；检查 LLM 超时/限流；降低摘要优先级 |
| 发送失败 | 看 `send_total` 错误码；检查 token/群状态/平台限流；不要盲目重试 |
| 成本飙升 | 看 group 用量；切经济模型；关闭 web search/RAG；核对异常用户 |
| 数据删除 | 验证身份 → 后台执行 → 审计 → 24h 内确认 |
| 内容事故 | 一键停用群/账号 → 保留证据 → 通知管理员 → 复盘提示词/工具 |
| 平台限制 | 停止发送 → 切备用通道预案 → 联系平台 |

---

## 4. 测试

### 4.1 测试金字塔

| 层 | 工具 | 范围 | 目标 |
|---|---|---|---|
| 单元 | Vitest | 解析、分段、预算、脱敏、时间 | 快、无外部依赖 |
| 契约 | Vitest + fixtures | iLink 请求/响应 | 协议字段不漂移 |
| 集成 | Testcontainers | PG/Redis/fake iLink | 事务、锁、队列 |
| E2E | Playwright | 后台流程 | 登录/设置/知识库/日志 |
| 真实 | 手工 | 测试群 | @、图片、文件、多群 |
| 压测 | k6 | 50 群 × 20 msg/min | p95/内存/队列 |
| 安全 | 脚本 + 人工 | 注入/越权/SSRF/上传 | 不泄露/不越权 |

### 4.2 Fake iLink 场景

- 正常群消息、@、引用、图片、文件、语音转写。
- 重复 `message_id`。
- `errcode=-14`。
- 429/500/超时。
- `getupdates` 返回空但更新 buf。
- 扫码状态：wait → scanned → confirmed；expired/verify。
- 发送成功/重复/失败。

### 4.3 关键测试用例

| # | 用例 | 期望 |
|---|---|---|
| 1 | 入站事务失败 | 游标不前进，下轮重试，不重复 |
| 2 | 重复消息 | 只入队一次 |
| 3 | 群锁冲突 | 第二个 job 延迟，最终串行 |
| 4 | 发送重复 | 第二次 dedup，不重复发 |
| 5 | 会话过期 | 停 poll、告警、状态 expired |
| 6 | 上下文超预算 | 从最旧裁剪，保留问题 |
| 7 | 注入 | 不泄露系统提示/密钥 |
| 8 | 越权命令 | 拒绝，不执行 |
| 9 | 文件炸弹 | 拒绝，不写盘 |
| 10 | 预算耗尽 | 降级，有记录 |
| 11 | 删除群数据 | 消息/媒体/摘要不可查 |
| 12 | 重启恢复 | 游标续传，无重复回复 |

### 4.4 压测

```text
50 群 × 20 msg/min × 10 分钟
  = 10,000 条消息
  = 约 1,000 次 @/命令
```

指标：

- 入站到开始处理 p95 < 2s
- 回答完成 p95 < 10s
- 发送成功率 > 99%
- 内存 < 1.5GB/进程
- 队列深度 < 100

### 4.5 验收清单

- [ ] 测试群 @ 触发，10s 内回答；普通消息不响应
- [ ] 连续追问能指代
- [ ] `/summary` 输出结论/待办/分歧
- [ ] 图片报错截图能识别
- [ ] PDF 知识库回答带出处
- [ ] 重复 `message_id` 不重复回复
- [ ] 杀 worker 任务恢复；杀 gateway 游标续传
- [ ] `-14` 2 分钟内告警，扫码恢复
- [ ] 普通成员 `/reset` 被拒绝
- [ ] 注入不泄露系统提示
- [ ] 预算 100% 降级有记录
- [ ] 后台可查 run 的 token/成本/错误
- [ ] 删除群数据不可查
- [ ] 50 群压测 p95 < 10s，无内存泄漏

---

## 5. 实施顺序

### 5.1 里程碑

| 阶段 | 内容 | 产出 |
|---|---|---|
| M0 | 协议探针 | Go/No-Go + fixtures |
| M1 | monorepo、config、DB、迁移、fake iLink、登录、轮询、echo | 群里 echo，可重启续传 |
| M2 | 触发、上下文、LLM、分段、typing、冷却、兜底 | 测试群日常问答 |
| M3 | 摘要、引用、提醒、知识库、权限 | `/summary`、RAG、`/remind` |
| M4 | 后台、用量、审计、告警 | 可运营 |
| M5 | 压测、安全、隐私、试点 | 上线检查单 |

### 5.2 文件级顺序

```text
1. packages/core: config, logger, errors, db schema, migrations
2. packages/ilink: types, crypto, client, auth, poll, send, media
3. apps/gateway: internal server, login, poll, inbound, sender
4. packages/contracts: internal API, SSE, DTO
5. apps/worker: jobs, pipeline, agent, tools, rag
6. apps/api: auth, routes, sse
7. apps/web: pages
8. test/fake-ilink + fixtures
9. deploy: Dockerfiles, compose, Caddy
```

### 5.3 Definition of Done

每个里程碑：

- 单元测试通过；关键路径有集成测试。
- `pnpm lint` / `pnpm typecheck` 通过。
- 有 runbook/README 更新。
- 不引入未审计的依赖。
- 变更日志记录。

---

## 6. 风险与待确认

| 风险 | 影响 | 缓解 |
|---|---|---|
| 群回复字段/ @ 行为未确认 | 高 | Phase 0；resolver/parser 隔离 |
| 无群/成员/昵称 API | 中 | 手动命名/绑定；不承诺真 @ |
| 主动消息 token 过期 | 中 | 只对活跃群发；失败告警 |
| 平台限流/条款变化 | 高 | 合规；降速；备用通道 |
| LLM 成本/延迟 | 中 | 预算、裁剪、缓存、降级 |
| 媒体解析失败 | 中 | 大小/格式限制；明确告知 |
| 单机故障 | 中 | 备份、恢复演练、重启策略 |

**待确认（Phase 0 / 产品）**：

1. 试点群与管理员名单
2. LLM provider、预算、数据合规
3. 部署域名/地域
4. 是否允许读取全部群消息做摘要
5. 提醒/日报是否保留
6. 商标/域名/公众号名检索
