export type CommandTier = "core" | "advanced";

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  tier: CommandTier;
  budgetExempt: boolean;
  detail?: string;
}

export const COMMANDS: CommandSpec[] = [
  {
    name: "help",
    summary: "查看常用命令",
    usage: "/help all",
    tier: "core",
    budgetExempt: true,
    detail: "用 /help all 查看全部命令；用 /help chart 查看单个命令用法。",
  },
  {
    name: "summary",
    summary: "总结最近对话",
    usage: "/summary",
    tier: "core",
    budgetExempt: false,
  },
  {
    name: "remind",
    summary: "设置提醒",
    usage: "/remind 明天10点 交周报",
    tier: "core",
    budgetExempt: true,
  },
  {
    name: "export",
    summary: "导出对话 CSV",
    usage: "/export",
    tier: "core",
    budgetExempt: true,
    detail: "/export csv 也兼容。",
  },
  {
    name: "reset",
    summary: "清除上下文",
    usage: "/reset",
    tier: "core",
    budgetExempt: true,
  },
  {
    name: "search",
    summary: "强制联网搜索",
    usage: "/search <问题>",
    tier: "advanced",
    budgetExempt: false,
    detail: "例：/search 今天上海天气。日常时效问题会自动搜索，不必手动加命令。",
  },
  {
    name: "chart",
    summary: "确定性生成图表",
    usage: "/chart bar 标题 | 一月=12,二月=18",
    tier: "advanced",
    budgetExempt: true,
    detail: "多系列：/chart bar 对比 | 一月=12/8,二月=18/10 | 销量/成本\n堆叠：/chart stacked bar 总量 | ...\n也可以直接说“画一个柱状图”。",
  },
  {
    name: "mermaid",
    summary: "确定性生成架构/流程图",
    usage: "/mermaid graph TD; A[用户]-->B[小栖]",
    tier: "advanced",
    budgetExempt: true,
    detail: "也可以直接说“画一个小栖的架构图”。",
  },
  {
    name: "whoami",
    summary: "查看微信 ID",
    usage: "/whoami",
    tier: "advanced",
    budgetExempt: true,
  },
  {
    name: "codex",
    summary: "启动 Codex 编码任务",
    usage: "/codex <repo> <任务>",
    tier: "advanced",
    budgetExempt: false,
    detail: "/codex help 查看 list/status/stop/resume。",
  },
  {
    name: "dsh",
    summary: "启动 DSH 编码任务",
    usage: "/dsh <repo> <任务>",
    tier: "advanced",
    budgetExempt: false,
    detail: "/dsh help 查看 list/status/stop。",
  },
];

const byName = new Map(COMMANDS.map((spec) => [spec.name, spec]));

export function isKnownCommand(name: string | undefined): boolean {
  return Boolean(name && byName.has(name));
}

export function isBudgetExempt(name: string | undefined): boolean {
  return Boolean(name && byName.get(name)?.budgetExempt);
}

export function helpText(topic?: string): string {
  const arg = topic?.trim().toLowerCase();
  if (arg === "all") return renderHelp("all");
  if (arg) {
    const spec = byName.get(arg);
    if (!spec) return `没有 /${arg} 的帮助。\n\n${renderHelp("core")}`;
    return `${spec.usage}\n${spec.summary}${spec.detail ? `\n\n${spec.detail}` : ""}`;
  }
  return renderHelp("core");
}

function renderHelp(scope: "core" | "all"): string {
  const core = COMMANDS.filter((spec) => spec.tier === "core");
  const advanced = COMMANDS.filter((spec) => spec.tier === "advanced");
  const lines = ["我是小栖。直接发问题或文件即可。", "", "常用："];
  for (const spec of core) {
    lines.push(format(spec));
  }
  if (scope === "all") {
    lines.push("", "高级：");
    for (const spec of advanced) {
      lines.push(format(spec));
    }
  } else {
    lines.push("", "图表、架构图、交互页面直接用自然语言说。");
  }
  return lines.join("\n");
}

function format(spec: CommandSpec): string {
  if (spec.name === "help") return "/help all  查看全部命令";
  if (spec.name === "codex" || spec.name === "dsh") {
    return `/${spec.name} help  查看任务子命令`;
  }
  return `${spec.usage}  ${spec.summary}`;
}
