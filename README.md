# 小栖 Xiaoqi

**小栖（Xiaoqi）** 是微信里的私人 AI 助理，基于腾讯 **iLink Bot API**（微信 ClawBot）接入个人微信。

> 当前阶段：**M1–M5c + 联网搜索 + 图表/Mermaid/文件/HTML + P0 稳定性 已实现**：私聊问答/视觉/文件/摘要/提醒/知识库/联网搜索/图表/Mermaid 发图/CSV 导出/Admin/指标/Codex/DSH。
>
> 仓库名：`xiaoqi` · 品牌：**小栖 Xiaoqi** · Bot：**小栖**

## 文档

| 文档 | 内容 |
|---|---|
| [系统设计](docs/design.md) | 当前架构、流程、能力、数据、限制 |
| [运行手册](docs/operations.md) | 启动、环境变量、命令、指标、排障 |
| [文档索引](docs/README.md) | 当前/归档/工具完整列表 |
| [品牌命名](docs/brand.md) | 小栖 Xiaoqi、Bot 名、repo |
| [Phase 0 结果](docs/phase0-results.md) | 群聊 No-Go、私聊验证 |
| [历史时间线](docs/history.md) | M1–M5c + 联网搜索 + 图表/Mermaid/文件出站 与提交 |
| [POC 脚本](poc/README.md) | 零依赖探针/fake 工具 |

## 目录

```text
apps/        gateway / worker / runner / api
packages/    core / ilink
docs/        当前设计、运行手册、ADR、归档
poc/         Phase 0 探针与离线 fake
tools/       macOS Vision OCR 构建脚本
knowledge/   知识库源文件
```

## 一句话方案

- **入口**：微信私聊，直接发问题，不需要 @
- **能力**：首次欢迎语、上下文问答、DeepSeek、图片视觉/OCR、PDF/DOCX/CSV、长文档分块总结、代码/交互式 HTML 文件发送、摘要、提醒、知识库、DeepSeek 联网搜索、`/chart` 数据图表、`/mermaid` 架构/流程图发图、`/export` 文件出站
- **任务**：`/codex`、`/dsh` 调度外部编码 runner
- **运营**：Admin 仪表盘、每日 token 预算、Prometheus 指标
- **架构**：TypeScript monorepo；gateway/worker/runner/api + PostgreSQL/Redis

## 快速开始

```bash
docker compose up -d postgres redis
pnpm install
pnpm db:migrate
pnpm ilink:login
pnpm dev:gateway    # 4101
pnpm dev:worker     # 4102
pnpm dev:api        # 4100
pnpm dev:runner     # /codex、/dsh，普通终端运行
```

详见 [运行手册](docs/operations.md)。

## 最大约束

iLink 扫码 bot 无法加入普通微信群，所以 v1 只做私聊；群聊设计已归档。Codex/DSH runner 只操作 allowlist 仓库。
