# 小栖 Xiaoqi · 文档索引

> 当前产品：微信私聊 AI 助理。群聊方案已归档。

## 当前设计

| 文档 | 内容 |
|---|---|
| [DM v1 设计](./design-dm.md) | 当前开发依据：范围、架构、数据、里程碑 |
| [品牌命名](./brand.md) | 小栖 Xiaoqi、Bot 名、repo、命名体系 |
| [Phase 0 结果](./phase0-results.md) | 群聊 No-Go、私聊验证、最终决策 |

## 里程碑

| 文档 | 内容 |
|---|---|
| [M1](./milestones/m1.md) | 登录、轮询、落库、outbox、echo |
| [M2](./milestones/m2.md) | DeepSeek、上下文、typing、分段 |
| [M3](./milestones/m3.md) | PDF/DOCX、视觉 + OCR、摘要、命令 |
| [M3b](./milestones/m3b.md) | 提醒、知识库 |
| [M4](./milestones/m4.md) | Admin 后台、每日预算 |
| [M4b](./milestones/m4b.md) | Prometheus 指标、预算告警 |
| [M5](./milestones/m5.md) | Codex / DSH runner、resume、diff |

## 架构与决策

| 文档 | 内容 |
|---|---|
| [ADR](./adr/) | 架构决策记录 |
| [图表](./diagrams/) | 架构、流水线、登录状态机 |
| [详细设计（群版归档）](./archive/group-detailed-design/README.md) | 群聊实现级设计，future 参考 |

## 归档

| 文档 | 内容 |
|---|---|
| [群助手设计](./archive/group-design.md) | 原群聊产品/架构设计 |
| [群版详细设计](./archive/group-detailed-design/README.md) | 群聊实现级设计 |
| [Phase 0 协议探针](./archive/protocol-probe.md) | 群聊能力验证清单（历史） |

## 工具

| 路径 | 内容 |
|---|---|
| [`poc/`](../poc/README.md) | Phase 0 探针、fake iLink/Codex/DSH |
| [`tools/ocr.swift`](../tools/ocr.swift) | macOS Apple Vision OCR |
| [`tools/build-ocr.sh`](../tools/build-ocr.sh) | 编译 OCR |
| [`knowledge/`](../knowledge/README.md) | 知识库源文件 |
