import type { AppConfig } from "@xiaoqi/core";

export const DEFAULT_WELCOME = `我是小栖，你的微信 AI 助理。
直接发问题，或发图片/PDF 让我看。
/chart 生成数据图表。
/help 查看命令。`;

export function welcomeText(config: AppConfig): string {
  return config.WELCOME_MESSAGE.trim() || DEFAULT_WELCOME;
}
