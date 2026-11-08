# 小栖 Xiaoqi · 历史时间线

> 当前系统见 [design.md](./design.md)。更细的里程碑文档已归档在 [archive/milestones/](./archive/milestones/)。

| 阶段 | 内容 | 关键提交 |
|---|---|---|
| Phase 0 | 扫码登录；群聊 No-Go；私聊/媒体/context_token 验证 | — |
| M1 | monorepo、登录、轮询、落库、outbox、echo | `bcd6fe0` |
| M2 | DeepSeek、上下文、typing、分段、兜底 | `8c60dbb` |
| M3 | PDF/DOCX、macOS OCR、`/summary`、`/reset` | `abc1be2` / `ec76fb1` |
| M3+ | DeepSeek Flash 视觉 | `37b7016` |
| M3b | 提醒、知识库关键词检索 | `1db7c98` |
| M4a | Admin 仪表盘、每日 token 预算 | `5c01fcd` |
| M4b | Prometheus 指标、预算 Webhook | `21f1f28` |
| M5 | Codex runner、`/codex` | `570b4e3` |
| M5b | Codex resume、diff | `e208656` |
| M5c | DSH runner、`/dsh` | `2b53d50` |
| 收尾 | 拆分 typing/task/runner、文档整理 | `7706ae4` / `09761c3` / `18bf977` |
| Web Search | DeepSeek Search、按需工具循环、`/search` | — |
| Charts | `/chart` 数据图表、iLink 图片出站 | — |

## 已归档

- 群助手方案：群聊 No-Go，见 [archive/group-design.md](./archive/group-design.md)。
- 群版详细设计：见 [archive/group-detailed-design/](./archive/group-detailed-design/README.md)。
- Phase 0 协议探针：见 [archive/protocol-probe.md](./archive/protocol-probe.md)。
- 旧 DM v0.1 设计：见 [archive/design-dm-v0.1.md](./archive/design-dm-v0.1.md)。

## 当前状态

M1–M5c + 联网搜索 + 数据图表已实现；下一步是语义检索、RBAC/TOTP、逐行 diff review。
