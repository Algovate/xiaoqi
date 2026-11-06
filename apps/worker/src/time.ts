export interface ParsedReminder {
  runAt: Date;
  text: string;
}

const WEEKDAYS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0,
};

export function parseReminder(input: string, now = new Date()): ParsedReminder | null {
  const raw = input.trim();
  if (!raw) return null;

  // 30分钟后 / 2小时后
  const relative = raw.match(/^(\d+)\s*(分钟|小时)后\s*([\s\S]+)$/);
  if (relative) {
    const amount = Number(relative[1]);
    const ms = relative[2] === "小时" ? amount * 3600_000 : amount * 60_000;
    const runAt = new Date(now.getTime() + ms);
    const text = relative[3]!.trim();
    return valid(runAt, text, now);
  }

  // 11/12 20:00 / 11月12日 20:00
  const date = raw.match(/^(\d{1,2})\s*[/月]\s*(\d{1,2})\s*日?\s*(\d{1,2})\s*[:：点时]\s*(半|\d{1,2})?\s*([\s\S]+)$/);
  if (date) {
    const local = shanghaiParts(now);
    let year = local.year;
    const month = Number(date[1]);
    const day = Number(date[2]);
    const hour = Number(date[3]);
    const minute = date[4] === "半" ? 30 : Number(date[4] ?? 0);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    let runAt = shanghaiDate(year, month, day, hour, minute);
    if (runAt.getTime() <= now.getTime()) {
      year += 1;
      runAt = shanghaiDate(year, month, day, hour, minute);
    }
    return valid(runAt, date[5]!.trim(), now);
  }

  // 今天/明天/后天 + 周几? + HH:mm / H点
  const m = raw.match(
    /^(?:(今天|明天|后天)\s*)?(?:(?:周|星期)([一二三四五六日天])\s*)?(\d{1,2})\s*[:：点时]\s*(半|\d{1,2})?\s*([\s\S]+)$/,
  );
  if (!m) return null;

  const dayWord = m[1];
  const weekWord = m[2];
  const hour = Number(m[3]);
  const minute = m[4] === "半" ? 30 : Number(m[4] ?? 0);
  const text = m[5]!.trim();
  if (hour > 23 || minute > 59 || !text) return null;

  const local = shanghaiParts(now);
  let year = local.year;
  let month = local.month;
  let day = local.day;

  if (dayWord === "明天") day += 1;
  else if (dayWord === "后天") day += 2;

  let runAt = shanghaiDate(year, month, day, hour, minute);

  if (weekWord) {
    const targetDow = WEEKDAYS[weekWord]!;
    let diff = (targetDow - local.weekday + 7) % 7;
    if (diff === 0 && runAt.getTime() <= now.getTime()) diff = 7;
    runAt = new Date(runAt.getTime() + diff * 86400_000);
  } else if (!dayWord && runAt.getTime() <= now.getTime()) {
    runAt = new Date(runAt.getTime() + 86400_000);
  }

  return valid(runAt, text, now);
}

export function formatShanghai(date: Date): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function valid(runAt: Date, text: string, now: Date): ParsedReminder | null {
  if (!text) return null;
  const diff = runAt.getTime() - now.getTime();
  if (diff < 60_000 || diff > 90 * 86400_000) return null;
  return { runAt, text };
}

function shanghaiDate(year: number, month: number, day: number, hour: number, minute: number): Date {
  // Asia/Shanghai 固定 UTC+8（无夏令时）
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, 0, 0));
}

function shanghaiParts(date: Date): {
  year: number;
  month: number;
  day: number;
  weekday: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}
