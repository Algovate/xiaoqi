# M4b · Prometheus 指标 + 预算告警

> 日期：2026-11-06  
> 状态：已实现（指标端点 + 企业微信 Webhook 告警）  
> 目标：让运营者知道“系统是否在线、是否变慢、是否快超预算”

---

## 1. Prometheus 指标

每个进程独立暴露 `/metrics`：

| 进程 | 地址 |
|---|---|
| gateway | `http://127.0.0.1:4101/metrics` |
| worker | `http://127.0.0.1:4102/metrics` |
| api | `http://127.0.0.1:4100/metrics` |

自定义指标：

| 指标 | 类型 | 说明 |
|---|---|---|
| `xiaoqi_poll_up{account}` | gauge | 长轮询是否在线 |
| `xiaoqi_inbound_total{result}` | counter | inserted/skipped/error |
| `xiaoqi_send_total{result}` | counter | sent/failed/deduplicated |
| `xiaoqi_send_duration_seconds` | histogram | 发送耗时 |
| `xiaoqi_runs_total{status}` | counter | sent/failed/budget_exceeded |
| `xiaoqi_agent_duration_seconds{model}` | histogram | Agent 耗时 |
| `xiaoqi_llm_tokens_total{type}` | counter | prompt/completion |
| `xiaoqi_budget_exceeded_total` | counter | 触发日预算次数 |
| `xiaoqi_reminders_total{status}` | counter | 提醒发送结果 |

默认进程指标（CPU/内存/event loop）由 `prom-client` 自动采集。

### 抓取示例

```yaml
scrape_configs:
  - job_name: xiaoqi
    static_configs:
      - targets:
          - 127.0.0.1:4100
          - 127.0.0.1:4101
          - 127.0.0.1:4102
```

> 公网部署时把 `/metrics` 放到内网或加 allowlist，不要直接暴露。

---

## 2. 预算告警

配置：

```dotenv
MAX_DAILY_TOKENS=100000
ALERT_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...
```

- 每次回答前统计该用户当天 tokens；
- 达到 **50% / 80% / 100%** 时发一次企业微信 Webhook；
- 进程内去重（同一用户/同一天/同阈值只发一次）；
- 100% 时仍会硬停止，回复“今日额度已用完”。

Webhook 内容：

```json
{
  "msgtype": "text",
  "text": {
    "content": "⚠️ 小栖预算告警（80%）\n用户：o9cq...\n今日已用：82,000 / 100,000 tokens"
  }
}
```

限制：

- 当前是进程内去重，多 worker 实例会重复告警；换 Redis 去重即可；
- 没有按用户单独配额；
- 没有 Grafana/Alertmanager 规则，只做 Webhook。

---

## 3. 验证

- `pnpm -r typecheck` 通过
- `pnpm test`：23 个测试通过
- 三个进程 `/metrics` 均返回 Prometheus 文本
- 自定义指标已注册；发送/入站/运行后会有数据

---

## 4. 下一步

1. RBAC + TOTP（多管理员/公网后台）；
2. 语义检索（embedding + pgvector）；
3. Grafana 面板与 Alertmanager 规则；
4. 多 worker 的去重与队列指标。
