# 小栖 Xiaoqi

**小栖（Xiaoqi）** 是微信里的私人 AI 助理，基于腾讯 **iLink Bot API**（微信 ClawBot）接入个人微信。

> 当前阶段：**M5c 已实现**（Codex + DSH runner）。下一步：RBAC / diff review。  
> 仓库名：`xiaoqi` · 品牌：**小栖 Xiaoqi** · Bot：**小栖**

## 文档

| 文档 | 内容 |
|---|---|
| [品牌命名](docs/brand.md) | 小栖 Xiaoqi：中英文名、Bot 名、Git repo、命名体系 |
| [DM v1 设计](docs/design-dm.md) | **当前开发依据**：私聊助理范围、架构、数据、里程碑 |
| [M1 骨架](docs/m1.md) | 登录/轮询/落库/outbox/echo 的启动与验证 |
| [M2 LLM](docs/m2.md) | 上下文、DeepSeek、typing、分段、失败兜底 |
| [M3 文件与命令](docs/m3.md) | PDF/DOCX 抽取、DeepSeek 视觉 + macOS OCR、`/summary`、`/reset` |
| [M3b 提醒与知识库](docs/m3b.md) | `/remind` 定时提醒、本地知识库 ingest/检索 |
| [M4a 后台与预算](docs/m4.md) | 静态 Admin、运行/用户/提醒/知识库、每日 token 预算 |
| [M4b 指标与告警](docs/m4b.md) | Prometheus `/metrics`、预算 50/80/100% Webhook 告警 |
| [M5 Codex Runner](docs/m5.md) | `/codex` 任务、仓库 allowlist、Runner、Admin 任务页 |
| [群助手设计（归档）](docs/design.md) | 原群聊方案，保留作历史/future 参考 |
| [群版详细设计（归档）](docs/detailed-design/README.md) | 群聊实现级设计，future 参考 |
| [协议探针](docs/protocol-probe.md) | Phase 0：群聊能力 Go/No-Go 验证清单 |
| [Phase 0 结果](docs/phase0-results.md) | 实测结论：iLink 扫码 bot 无法加入普通微信群 |
| [POC 脚本](poc/README.md) | 零依赖 Node 探针：扫码、私聊、媒体解密 |
| [ADR-0001](docs/adr/0001-direct-ilink-client.md) | 自建 iLink 客户端 |
| [ADR-0002](docs/adr/0002-mention-only-trigger.md) | 默认仅 @ / 命令触发 |
| [ADR-0003](docs/adr/0003-modular-monolith.md) | gateway / worker 分进程 |
| [ADR-0004](docs/adr/0004-no-streaming.md) | 不做流式输出 |
| [ADR-0005](docs/adr/0005-dm-pivot.md) | 群聊 No-Go，v1 转私聊助理 |

## 一句话方案

- **入口**：微信私聊，直接发问题，不需要 @；
- **能力**：上下文问答、DeepSeek 回答、PDF/DOCX、图片视觉 + OCR、摘要、提醒、知识库、Codex 任务；
- **架构**：TypeScript 模块化单体；gateway 管长轮询/发送，worker 管 Agent，Postgres + Redis；
- **原则**：不打扰、可删除、可停用、可追溯。

## 已验证与约束

- 私聊：文本、图片、PDF、引用、发送、媒体解密全部跑通；
- 群聊：扫码 iLink bot 无法加入普通微信群，**v1 不做**；
- 企业微信：官方机器人只支持内部员工群，外部客户群不支持双向对话；
- 详见 [Phase 0 结果](docs/phase0-results.md)。

## 下一步

1. 普通终端运行 `pnpm dev:runner`；
2. 微信发 `/codex xiaoqi 修复失败测试` 或 `/dsh xiaoqi 分析仓库`；
3. `/codex resume <id> 继续`；
4. Admin 查看任务、状态、diff。
