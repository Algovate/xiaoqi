# 小栖 Xiaoqi · 详细设计

> 目标：从“产品架构”推进到“可直接开工”的实现级设计。  
> 前置：[产品与架构设计](../group-design.md)、[品牌命名](../../brand.md)、[Phase 0 探针](../protocol-probe.md)

> **2026-11-06 Phase 0 结果：群聊 No-Go。** 本目录的群聊实现级设计保留作 future 参考；  
> **当前 v1 私聊设计见 [`../design-dm.md`](../../design-dm.md)。** 文中 group-specific 部分不进入 v1。

## 文档

| # | 文档 | 内容 | 主要读者 |
|---|---|---|---|
| 00 | [总览与运行时](./00-overview.md) | 进程、模块、内部 API、并发、失败域 | 所有人 |
| 01 | [iLink 协议适配](./01-ilink-adapter.md) | 登录、轮询、发送、媒体、错误映射 | 后端 |
| 02 | [消息流水线](./02-pipeline.md) | 归一化、触发、上下文、分段、重试 | 后端 |
| 03 | [Agent 与 RAG](./03-agent.md) | 模型、提示词、工具、检索、安全、评测 | AI/后端 |
| 04 | [数据与管理 API](./04-data-api.md) | DDL、Redis、REST、SSE、权限 | 后端/前端 |
| 05 | [部署、运维与测试](./05-ops-test.md) | Compose、观测、Runbook、测试、里程碑 | 运维/QA |

## 设计原则

1. **协议可替换**：Phase 0 未确认的行为都放在 `packages/ilink` 适配层。
2. **至少一次 + 幂等**：入站靠 outbox/唯一约束，出站靠 `(run_id, chunk_index)`。
3. **作用域强制**：所有查询/工具强制 `account_id` + `group_id`。
4. **不猜数据**：没有昵称就用短 ID，没有依据就说没有。
5. **可回滚**：迁移向后兼容一个版本；提示词/模型变更跑评测。
