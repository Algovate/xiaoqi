# Phase 0 · iLink 群聊协议探针

> 目标：在写业务代码前，确认 iLink 群聊的真实行为，产出可复用的 fixture 与结论。  
> 时间盒：1–2 个工作日。  
> 结论只有两种：**Go**（进入 M1）或 **No-Go**（换通道/改范围）。
>
> **实测结论（2026-11-06）：群聊 No-Go。** 扫码 bot 无法加入普通微信群，详见 [Phase 0 结果](./phase0-results.md)。
>
> 已提供零依赖 POC：[`poc/README.md`](../poc/README.md)。跑 `node poc/probe.mjs login` 即可开始。

---

## 1. 前置条件

- [ ] 一个可扫码的微信账号，已开通「微信 ClawBot」插件能力（微信 → 我 → 设置 → 插件）。
- [ ] 一个**测试群**（不要用生产群），群内只有自己和 1–2 个同事。
- [ ] 测试账号已把 bot 拉进群（iLink 没有邀请 API，只能像普通成员一样手动拉）。
- [ ] 一台可执行 Node 22+ 的机器，能访问 `ilinkai.weixin.qq.com`。
- [ ] 一个本地目录存 token，权限 `0600`，**不要提交到 git**。

> 合规提醒：只用测试群和测试数据；不要抓取无关成员隐私；不要群发；探针结束后解绑或停用测试 bot。

---

## 2. 登录：拿 token

> 已提供零依赖 POC：`node poc/probe.mjs login`。下面的 curl 用于理解协议；直接跑 POC 更快。

> `X-WECHAT-UIN` 每次请求都要随机：十进制 uint32 → base64。示例用 `$RANDOM$$` 图省事，正式实现用 `crypto.randomBytes(4).readUInt32LE()`。`iLink-App-ClientVersion` 按 `0x00MMNNPP` 编码，示例按官方 2.4.10 计算为 `132106`；自建客户端可声明自己的版本，实测为准。

### 2.1 获取二维码

```bash
BASE=https://ilinkai.weixin.qq.com
curl -sS -X POST "$BASE/ilink/bot/get_bot_qrcode?bot_type=3" \
  -H 'Content-Type: application/json' \
  -H 'AuthorizationType: ilink_bot_token' \
  -H "X-WECHAT-UIN: $(printf '%s' "$RANDOM$$" | base64)" \
  -H 'iLink-App-Id: bot' \
  -H 'iLink-App-ClientVersion: 132106' \
  -d '{"local_token_list":[]}' | tee qr.json
```

预期返回：

```json
{
  "qrcode": "....",
  "qrcode_img_content": "https://...."
}
```

用手机微信扫描 `qrcode_img_content` 对应的二维码（或打开该 URL）。

### 2.2 轮询扫码状态

```bash
QRC=$(python3 -c "import json;print(json.load(open('qr.json'))['qrcode'])")
curl -sS "$BASE/ilink/bot/get_qrcode_status?qrcode=$QRC" \
  -H 'AuthorizationType: ilink_bot_token' \
  -H "X-WECHAT-UIN: $(printf '%s' "$RANDOM$$" | base64)" \
  -H 'iLink-App-Id: bot' \
  -H 'iLink-App-ClientVersion: 132106' | tee status.json
```

状态机：

| status | 含义 | 动作 |
|---|---|---|
| `wait` | 未扫 | 继续轮询（建议 1s 间隔） |
| `scaned` | 已扫，待确认 | 继续 |
| `confirmed` | 确认 | 保存 `bot_token`、`baseurl`、`ilink_bot_id` |
| `expired` | 过期 | 重新获取二维码 |
| `scaned_but_redirect` | 需要换机房 | 用 `redirect_host` 继续轮询 |
| `need_verifycode` | 需要验证码 | 提交 `verify_code` |
| `binded_redirect` | 已绑定 | 走已有 token |

保存：

```bash
python3 - <<'PY'
import json, os
s = json.load(open('status.json'))
if s.get('status') == 'confirmed':
    os.makedirs('secrets', exist_ok=True)
    with open('secrets/token.json', 'w') as f:
        json.dump({
            'bot_token': s['bot_token'],
            'baseurl': s.get('baseurl', 'https://ilinkai.weixin.qq.com'),
            'ilink_bot_id': s.get('ilink_bot_id'),
        }, f, ensure_ascii=False, indent=2)
    os.chmod('secrets/token.json', 0o600)
    print('saved')
else:
    print('not confirmed:', s.get('status'))
PY
```

> 若返回里有 `baseurl`，后续请求优先用它；否则用 `https://ilinkai.weixin.qq.com`。

---

## 3. 收消息：抓群消息原始结构

### 3.1 长轮询

```bash
TOKEN=$(python3 -c "import json;print(json.load(open('secrets/token.json'))['bot_token'])")
BASEURL=$(python3 -c "import json;print(json.load(open('secrets/token.json'))['baseurl'])")

curl -sS -X POST "$BASEURL/ilink/bot/getupdates" \
  -H 'Content-Type: application/json' \
  -H 'AuthorizationType: ilink_bot_token' \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-WECHAT-UIN: $(printf '%s' "$RANDOM$$" | base64)" \
  -H 'iLink-App-Id: bot' \
  -H 'iLink-App-ClientVersion: 132106' \
  -d '{"get_updates_buf":""}' | tee updates-1.json
```

服务端会挂起最多约 35 秒。返回：

```json
{
  "ret": 0,
  "msgs": [{ "..." : "..." }],
  "get_updates_buf": "....",
  "longpolling_timeout_ms": 35000
}
```

**每次都要用最新的 `get_updates_buf`**，否则会重复收到旧消息。

### 3.2 测试矩阵

在测试群里依次执行，每步记录 `updates-*.json`：

| # | 操作 | 要确认 |
|---|---|---|
| 1 | 群里连发 5 条普通消息（不 @） | **是否全部收到**；只推 @ 的话摘要功能要降级；同时看 `group_id`、`from_user_id`、`to_user_id` |
| 2 | 发“@bot 你好” | 文本里 @ 的原始形态；是否有结构化 mention 字段 |
| 3 | 引用 bot 上一条回复 + “展开说说” | `ref_msg` 结构；是否带 `message_item`、`title`、`svr_id` |
| 4 | 发 `/help` | 命令是否能原样到达 |
| 5 | 另一个群成员发“@bot 1+1” | `from_user_id` 是否区分；`context_token` 是否变化 |
| 6 | 看任意消息的完整 JSON | 是否有昵称、群名片、成员列表、群名等字段 |
| 7 | 发一张图片 + “这是什么” | `image_item.media`、`aeskey`、`full_url` |
| 8 | 发一个 PDF + “总结” | `file_item.file_name`、`len`、`md5` |
| 9 | 发一条语音 | `voice_item.text` 是否有转写；`encode_type` |
| 10 | 10 秒内发 10 条 | ret/errcode；是否限流 |
| 11 | 距上次入站 10 分钟后，用旧 `context_token` 发一条提醒 | 是否成功；失败错误码；决定提醒/日报能否做 |
| 12 | 杀掉进程 2 分钟再拉 | 游标是否续传；是否重复 |

**关键判断：@ 是结构化字段还是纯文本？** 目前官方类型里只有 `text_item`，没有 at 字段，因此大概率是文本 `@昵称`。如果是纯文本：

- 记录 bot 在群里的显示名；
- 测试 `@小栖`、`@小栖 `（不同空格）、`@小栖`；
- 确认 @ 是否会被微信转成特殊字符/零宽字符；
- 设计 `MentionParser` 时同时支持“文本匹配”和“结构化 mentions（若未来出现）”。

### 3.3 群/成员元数据

iLink 没有公开的群列表、成员列表、昵称接口。确认原始消息里到底有没有这些字段：

- [ ] 是否有 `group_name` / `chat_room_name`？
- [ ] 是否有 `from_user_name` / `nickname` / `remark` / `alias`？
- [ ] 是否有 `member_list` / `at_list` / `mentioned_list`？
- [ ] 是否只有 `group_id` + `from_user_id`（最可能）？

若只有 ID：

- 后台群名手动填；
- 成员昵称由管理员在后台绑定（页面展示“ID + 最近一条发言”辅助识别）；
- 成员发 `/whoami` 获取自己的 ID；
- 回答里只用时间引用，不猜名字；
- 不承诺“@某成员”能通知到人。

---

## 4. 回消息：确定群回复字段

这是最关键的一步。用同一个 `context_token`，分别尝试：

### 方案 A：`to_user_id = group_id`

```bash
curl -sS -X POST "$BASEURL/ilink/bot/sendmessage" \
  -H 'Content-Type: application/json' \
  -H 'AuthorizationType: ilink_bot_token' \
  -H "Authorization: Bearer $TOKEN" \
  -H "X-WECHAT-UIN: $(printf '%s' "$RANDOM$$" | base64)" \
  -H 'iLink-App-Id: bot' \
  -H 'iLink-App-ClientVersion: 132106' \
  -d '{
    "msg": {
      "to_user_id": "<group_id>",
      "message_type": 2,
      "message_state": 2,
      "context_token": "<inbound context_token>",
      "item_list": [{ "type": 1, "text_item": { "text": "probe A" } }]
    }
  }'
```

### 方案 B：`to_user_id = from_user_id`

把 `to_user_id` 换成发送者 ID，其余不变。

### 记录

| 方案 | 是否出现在群里 | 是否出现在私聊 | ret/errcode | 备注 |
|---|---|---|---|---|
| A: group_id | | | | |
| B: sender | | | | |

判定：

- 只有 A 成功 → 群回复用 `group_id`，私聊用 `from_user_id`。
- 只有 B 成功 → 群回复也要发给发送者，但微信侧可能显示在群/私聊，需要记录实际效果。
- 都失败 → 检查 `context_token` 是否必须来自同一条消息、`message_type/state` 是否正确、bot 是否仍在群。
- 都成功 → 优先 A（语义正确），B 作为兜底。

同时确认：

- `context_token` 是群级还是用户级：让 A、B 两个成员分别发消息，交叉用 token 回复，看是否串话。
- 重启进程后，旧 token 是否还能回复；不能的话，缓存策略要调整（只保留最近 N 条）。

### 4.1 主动消息：提醒/日报能不能做

等 10–30 分钟（或次日），用最后一条入站消息的 `context_token` 主动发一条文本：

- 成功 → 提醒/日报可做，但仍需检查 token 新鲜度；
- 失败 → 记录错误码；提醒/日报降级为“仅在群内最近有互动时发送”，或直接砍掉；
- 若 token 只能用于回复对应消息 → 所有主动推送都不可做，产品范围收缩为纯被动问答。

---

## 5. 媒体下载与解密

对图片消息：

1. 取 `image_item.media.full_url`；为空则拼：
   `https://novac2c.cdn.weixin.qq.com/c2c?<encrypt_query_param>`
2. 下载密文；
3. 用 `image_item.aeskey`（hex）或 `media.aes_key`（base64）做 AES-128-ECB/PKCS7 解密；
4. 校验文件头（JPEG/PNG/PDF），保存。

记录：

| 项 | 值 |
|---|---|
| CDN URL 形态 | |
| key 字段 | `aeskey` / `media.aes_key` |
| 解密后大小 | |
| 文件头 | |
| 失败原因 | |

语音：

- 优先用 `voice_item.text`（微信转写）；为空再考虑 SILK 解码 + STT。
- 记录 `encode_type`、`sample_rate`、`playtime`。

---

## 6. 频率与限流

在测试群做三组：

1. 10 秒 10 条 @；
2. 1 分钟 30 条 @；
3. 连续发送 3 条长回复（每段 900 字）。

记录：

- 第几条开始变慢/失败；
- 返回的 `ret`/`errcode`/`errmsg`；
- 是否有 `Retry-After` 类字段；
- 失败后多久恢复。

结论写入设计文档 §4.2 的限流参数。

---

## 7. 记录模板

把以下内容填好，作为 M1 的 fixture 输入（脱敏后提交到 `packages/ilink/fixtures/`）：

```markdown
## 环境
- 日期：
- 微信版本：
- bot 显示名：
- 测试群 ID：xxxx@chatroom
- 群人数：

## 入站样本
### 普通群消息
- 是否全部推送（5 条中收到几条）:
- raw:
- group_id:
- from_user_id:
- to_user_id:
- context_token 前缀:
- item_list:

### 元数据
- 群名:
- 发送者昵称:
- 成员列表/at 列表:
- 只有 ID 时的展示方案:

### @ 消息
- 原始文本（含不可见字符）:
- 匹配到的 @ 形式:
- 剥离后的问题:

### 引用消息
- ref_msg:
- 是否包含被引用文本:

## 出站
- 群回复成功方案：A / B
- 私聊回复字段：
- context_token 粒度：群 / 用户
- 重登后旧 token 是否可用：

## 主动消息
- 10 分钟后用旧 token 发送：成功/失败
- 错误码：
- 结论：提醒/日报可做 / 不可做

## 媒体
- 图片解密：成功/失败
- 文件：
- 语音转写：

## 限流
- 阈值：
- 错误码：
- 恢复时间：

## 结论
- [ ] Go
- [ ] No-Go，原因：
```

---

## 8. Go / No-Go 清单

**Go 条件（全部满足）**：

- [ ] 群消息能稳定收到，`group_id` 正确。
- [ ] 非 @ 消息也能收到（否则 `/summary` 降级或砍掉）。
- [ ] 能区分 @ 与普通消息，且能拿到干净的问题文本。
- [ ] 能找到稳定的群回复字段组合，回复落在正确的群。
- [ ] `context_token` 的粒度明确，重启后能恢复或能接受“重启后需先发一条消息”。
- [ ] 图片/文件至少一种能下载解密。
- [ ] 10 条突发不被永久限流。

**No-Go 时**：

1. 群回复不可用 → 先做私聊助手（同一套 Agent），群能力等官方更新。
2. 群消息不可达 → 改用企业微信（内部群/外部群）或公众号，重做接入层。
3. @ 无法区分 → 改为“命令触发”或“引用触发”，不做全量监听。
4. 限流极严 → 降低频率、只做摘要/提醒等低频场景。

---

## 9. 清理

- [ ] 删除本地 `secrets/` 与抓包文件中的 token/手机号/昵称。
- [ ] 测试群移除 bot（或后台解绑）。
- [ ] 把脱敏后的 fixture 提交到仓库；原始文件不进 git。
- [ ] 在设计文档 §4.4 记录结论与日期。
