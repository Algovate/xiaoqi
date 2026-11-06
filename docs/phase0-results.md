# Phase 0 结果 · iLink 群聊 No-Go

> 执行日期：2026-11-06  
> 环境：macOS / Node 26 / iLink `ilinkai.weixin.qq.com`  
> 账号：已扫码登录的 iLink bot（`...@im.bot`）  
> 结论：**扫码登录的 iLink bot 身份无法加入普通微信群；群助手方案在当前通道下 No-Go。**

---

## 1. 登录：成功

- 扫码登录成功，拿到 `bot_token`、`baseurl`、`ilink_bot_id`；
- 私聊收发正常；
- `context_token` 约 136 字符，回复可用；
- 发送消息返回 `message_id`（字符串）。

## 2. 群聊：无法加入

### 实测

- Bot 的会话资料页只有：头像、备注名、消息免打扰、置顶消息、清空消息、投诉、解除连接；
- 底部显示 **“微信 ClawBot 插件”**；
- **没有“添加到群聊”**；
- 新建群时无法勾选 bot；
- 群里也没有“邀请机器人”入口。

### 外部佐证

Hermes Agent 的 iLink 文档明确写了同样的限制：

> QR login connects Hermes to an iLink bot identity (e.g. `a5ace6fd482e@im.bot`), not a fully scriptable ordinary personal WeChat account. The iLink bot identity generally cannot be invited into ordinary WeChat groups... iLink typically does not deliver ordinary WeChat group events.

来源：

- [Hermes WeChat 文档](https://github.com/NousResearch/hermes-agent/blob/88b9d35e/website/docs/user-guide/messaging/weixin.md)
- [Issue #17094](https://github.com/NousResearch/hermes-agent/issues/17094)
- [PR #17105](https://github.com/NousResearch/hermes-agent/pull/17105)

### 结论

这不是操作问题，也不是 POC 的 bug。**普通扫码登录拿到的是“个人助理型” iLink bot 身份，不是可拉群的普通联系人。** 除非腾讯/运营商提供支持群事件的 token 或账号类型，否则群消息不会推给这个 bot。

> `bot_type=3` 是当前扫码登录的类型；是否存在群能力类型/白名单，公开文档没有说明，不能假设可用。

---

## 3. 私聊协议实测

### 3.1 消息

- 文本、`/help`、图片、PDF、引用都能收到；
- `group_id` 为空字符串，`to_user_id` 是 bot；
- `context_token` 每条消息不同，回复时回传可用；
- 消息里有 `at_bot_username_list` 字段，但私聊为空；
- 引用消息只有 `ref_msg.message_item.msg_id`，没有 `title`/`svr_id`/被引用文本；
- 要还原引用，必须本地按 `msg_id` 查历史消息。

### 3.2 大整数 ID

`getupdates` 里的 `message_id` 是 JSON number，值超过 JS 安全整数（> 2^53），例如：

```json
"message_id": 7524313909497035000
```

直接 `JSON.parse` 会丢精度；POC 已改为在解析时把大整数转成字符串。`sendmessage` 响应里的 `message_id` 本身是字符串。这个差异必须在生产适配层处理。

### 3.3 媒体

图片：

- `image_item.aeskey` 是 32 位 hex（16 字节 key）；
- `media.aes_key` 是“hex 字符串”的 base64；
- `media.full_url` 形如 `https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=...&taskid=...`；
- 下载后 AES-128-ECB 解密成功，得到 73,040 字节 JPG。

文件：

- `file_item.media.aes_key` 同样是“hex 字符串”的 base64；
- 解密成功，得到 37,656 字节 PDF（`%PDF-1.4`，1 页）；
- 响应 `content-length` 为 37,664，包含 PKCS#7 padding。

> 早期 POC 直接把 `aes_key` 当 16 字节原始 key，导致文件 `missing-key`；已修正并加入自测。

### 3.4 发送

- 私聊回复成功；
- `sendmessage` 返回 `message_id` 字符串；
- 回复后用户能在微信里收到。

---

## 4. 对产品的影响

原设计（`docs/design.md`）的核心是“微信群里的 AI 助手”。Phase 0 证明：**在当前 iLink 扫码登录通道下，群聊不可用。**

需要做产品决策，而不是继续写群逻辑。

### 选项 A：转私聊 AI 助理（推荐，最快）

- 保留 90% 技术设计：gateway、pipeline、Agent、RAG、提醒、知识库；
- 去掉群上下文、群摘要、群内 @、群成员权限；
- 触发改为“所有私聊消息”；
- 产品名/定位从“群栖/群助手”调整为“小栖 · 微信私聊 AI 助理”；
- 立刻可交付，POC 已验证。

### 选项 B：企业微信群助手

- 官方、群能力完整；
- 但用户必须使用企业微信，不能直接服务个人微信群；
- 适合公司/团队内部场景，需重做通道与部分后台。

### 选项 C：转发群聊记录做摘要

- 用户把群聊记录/文件转发给 bot；
- bot 解析并生成纪要、待办、问答；
- 不要求 bot 进群，但只能“事后摘要”，不能实时 @ 问答；
- 可作为群聊场景的过渡产品。

### 选项 D：等待/申请群能力

- 联系腾讯/OpenClaw 运营方，确认是否有支持群事件的 token/账号类型；
- 在拿到明确能力前，不投入群功能开发；
- 风险：时间不可控。

---

## 5. 建议

**先做 A（私聊助理）验证模型质量与用户留存，同时把 C（转发纪要）作为群场景的过渡功能。**

理由：

1. 通道已验证，能最快上线；
2. Agent/RAG/提醒/知识库全部复用；
3. 群聊需求可以用“转发记录 → 纪要”部分满足；
4. 等 iLink 群能力明确后，再把同一套 Agent 接到群通道，不用重写。

---

## 6. POC 当前状态

- `poc/probe.mjs`：登录、私聊长轮询、@ 解析、A/B 回复、媒体解密、bigint 保留；
- `poc/fake-ilink.mjs`：离线测试；
- 已实测：私聊文本/图片/PDF/引用、发送、媒体解密；
- 未实测：群消息、群回复、群 @、主动消息、重启后 context_token。

## 7. 决策（2026-11-06）

- [x] 群聊 No-Go
- [x] 企业微信评估：官方机器人只支持内部员工群；外部客户群（含微信用户）官方不支持双向对话，非官方协议风险高，放弃
- [x] **最终方向：微信私聊 AI 助理（DM）**
- [ ] 是否保留“转发群聊记录 → 纪要”作为后续功能
- [x] 品牌：小栖 Xiaoqi（repo `xiaoqi`，org `xiaoqi-app`）

当前 v1 设计见 [`design-dm.md`](./design.md)。
