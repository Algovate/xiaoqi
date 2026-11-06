# ADR-0001：自建 iLink 客户端，不依赖 OpenClaw 运行时

- 状态：已接受（2026-11-06）
- 决策者：产品/架构
- 相关：设计文档 §0.2、§5

## 背景

iLink 能力可以通过两种方式接入：

1. 安装官方 `@tencent-weixin/openclaw-weixin` 插件，运行 OpenClaw Gateway；
2. 自建 HTTP 客户端，直接调用 `ilinkai.weixin.qq.com`。

官方插件成熟、扫码/媒体/长轮询都已实现，但它把消息接入绑定到 OpenClaw 的 Agent 运行时和配置体系上；本项目需要自己的群管理、权限、预算、知识库与后台，且要能独立演进。

## 决策

自建 `packages/ilink`，只实现协议层：

- 扫码登录、token 持久化；
- `getupdates` 长轮询 + 游标；
- `sendmessage` / `getuploadurl` / `sendtyping`；
- 媒体 AES-128-ECB 加解密；
- 错误码与重试。

业务层通过 `InboundMessage`、`OutboundMessage`、`ReplyTarget` 等领域类型与协议层交互，不直接碰 wire JSON。

## 后果

**正面**

- 完全控制重试、限流、游标、日志与安全；
- 不引入 OpenClaw 运行时，部署更轻；
- 协议变更只影响 `packages/ilink`；
- 可以按群/账号做路由和预算。

**负面**

- 官方插件升级时，需要自己跟进协议差异；
- 扫码重定向、验证码、媒体等边界要自己处理；
- 需要维护 fixture 与契约测试。

**缓解**

- Phase 0 抓真实流量，建立 fixture；
- 订阅官方包 changelog，每月对比一次；
- 协议层不做业务判断，便于替换。

## 备选方案

- **直接用官方插件**：开发量最小，但被 OpenClaw 架构绑定，群策略当前还是 `disabled`，不适合本产品。
- **Fork 官方插件**：能复用实现，但升级合并成本高，且仍带 OpenClaw 依赖。
