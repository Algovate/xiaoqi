# Phase 0 · iLink 私聊协议探针 POC

零依赖 Node 脚本，用来验证 iLink 私聊通道：

- 扫码登录、token 保存
- 私聊文本、图片、PDF、引用、`/help`
- 发送回复与 `context_token`
- 图片/文件 CDN 下载 + AES-128-ECB 解密
- 大整数 `message_id` 保留
- 基础错误码/重试

> **群聊 No-Go**：扫码 iLink bot 无法加入普通微信群，详见 [`../docs/phase0-results.md`](../docs/phase0-results.md)。POC 里仍保留 `--reply-mode group`，只用于未来群能力验证，当前不可用。

---

## 0. 安全

- 只用自己的测试微信号；**不要在生产群/生产号跑**。
- `.poc/` 已加入 `.gitignore`；里面含 token、消息原文、媒体，**不要提交**。
- 结束：`rm -rf .poc`。
- `--reply-mode sender` 会真的发私聊消息；默认最多 5 条，防止误发。

---

## 1. 前置

- [ ] 微信已开通「ClawBot」插件能力（微信 → 我 → 设置 → 插件）。
- [ ] Node 22+（本机 Node 26 已验证）。
- [ ] 手机微信可扫码。

---

## 2. 登录

```bash
cd /path/to/xiaoqi
node poc/probe.mjs login
```

脚本会：

1. 请求二维码；
2. 保存为 `.poc/qr.png` 或 `.poc/qr-url.txt`；
3. 等待扫码；
4. 确认后把 token 写到 `.poc/token.json`（0600）。

打开二维码：

```bash
open .poc/qr.png          # macOS
# xdg-open .poc/qr.png    # Linux
```

如果只有 URL：

```bash
cat .poc/qr-url.txt
```

> 二维码实际有效期约 2 分钟；没扫就重新 `login`。

---

## 3. 抓私聊消息

登录后，直接在微信里给 bot 发消息，无需拉群。

```bash
node poc/probe.mjs watch --reply-mode none --max 30 --media
```

依次发：

1. `hello`
2. `@小栖 你好`（DM 里 @ 不影响触发，只用于观察文本）
3. `/help`
4. 一张截图
5. 一个 PDF
6. 引用一条消息 + `展开说说`
7. 一条语音

观察输出：

| 要确认 | 看什么 |
|---|---|
| 私聊是否可达 | `group: (dm)` |
| `context_token` | `context_token: ...(len=...)` |
| 引用 | `ref: ... msg_id=...` |
| `at_bot_username_list` | 私聊一般为空 |
| 图片 | `media[i] image: ok, ...` |
| PDF | `media[i] file: ok, ...` |
| 大整数 ID | `message_id` 是否精确（POC 已保留字符串） |

原始消息在 `.poc/captures/*.jsonl`，媒体在 `.poc/media/`。

---

## 4. 测发送

### 自动回复

```bash
node poc/probe.mjs watch --reply-mode sender --yes --max 3
```

在私聊里发一条消息，观察：

- 微信里是否收到 `【POC-sender】收到：...`；
- 终端是否打印 `已发送（sender → ...）`；
- 是否只发到当前私聊，不串到别处。

### 手动发

```bash
node poc/probe.mjs watch --show-context-token --max 1
# 复制完整 context_token
node poc/probe.mjs send \
  --to "<你的用户 ID>" \
  --text "POC manual send" \
  --context "<完整 context_token>"
```

---

## 5. 测 context_token

1. 发一条消息，拿到 `context_token`；
2. `Ctrl-C` 停 watch；
3. 等 10 分钟；
4. 再 `watch`，发消息；
5. 观察回复是否正常。

记录：

- token 是否每条都变；
- 重启后旧 token 还能否用；
- 主动消息（距上次入站 10 分钟后）是否成功。

---

## 6. 已知协议细节（实测）

| 项 | 结论 |
|---|---|
| `group_id` | 私聊为空字符串 |
| `message_id` | `getupdates` 里是超出 JS 安全整数的 JSON number；POC 解析时转字符串 |
| `sendmessage` 响应 | `message_id` 是字符串 |
| 引用 | 只有 `ref_msg.message_item.msg_id`，没有文本；需本地查 |
| 图片 key | `image_item.aeskey` 是 32 位 hex |
| 文件 key | `file_item.media.aes_key` 是“hex 字符串”的 base64 |
| 文件 URL | `full_url` 形如 `/c2c/download?encrypted_query_param=...&taskid=...` |
| 文件解密 | 成功；`content-length` 含 PKCS#7 padding |

---

## 7. 离线自测（不需要微信）

```bash
# 终端 A
node poc/fake-ilink.mjs

# 终端 B
node poc/probe.mjs login --base-url http://127.0.0.1:8787
node poc/probe.mjs watch --media --max 1
node poc/probe.mjs watch --reply-mode sender --yes --max 1 --no-capture
```

预期：

- login 直接 confirmed；
- watch 收到 fake 私聊/群消息；
- `--media` 解密出 `.poc/media/*.png`；
- reply 模式向 fake 服务器发一条 `sendmessage`。

---

## 8. 清理

```bash
rm -rf .poc
```

- 后台解绑或退出 bot。
- 要提交 fixture：只保留消息结构，删除 `context_token`、`from_user_id`、昵称、媒体原文。
- 不要提交 `.poc/token.json`、`.poc/qr.png`、`.poc/media/`。

---

## 9. 已知限制

- 不实现媒体上传/出站。
- 不做语音 SILK 转码；只用微信转写文本。
- 不做完整限流/重试；只做基础退避。
- token 只做 0600 文件保护，未加密；生产实现会 AES-GCM。
- 没有数据库；游标/去重是本地文件。
- 群聊不可用（Phase 0 结论）。

---

## 10. 输出文件

```text
.poc/
├─ token.json              # bot_token/baseUrl/botId（0600）
├─ cursor.json             # get_updates_buf
├─ seen.json               # 去重 message_id
├─ qr.png / qr-url.txt     # 登录二维码
├─ captures/*.jsonl        # 原始消息 + 探针回复结果
└─ media/*.jpg|png|pdf     # 解密后的媒体
```

---

## 11. Codex / DSH runner 假 CLI

`poc/fake-codex.mjs` 和 `poc/fake-dsh.mjs` 是 runner 的离线夹具，已带可执行权限。没有真实 `codex`/`dsh` 时，可这样启动 runner：

```bash
CODEX_BIN="$PWD/poc/fake-codex.mjs" \
DSH_BIN="$PWD/poc/fake-dsh.mjs" \
pnpm dev:runner
```

或在 `.env` 中把 `CODEX_BIN` / `DSH_BIN` 指向这两个文件的绝对路径。它们只输出固定 JSON/文本，不会真的修改仓库。
