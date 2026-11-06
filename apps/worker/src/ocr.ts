import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AppConfig } from "@xiaoqi/core";

const execFileAsync = promisify(execFile);
const DEFAULT_BIN = fileURLToPath(new URL("../../../tools/ocr-bin", import.meta.url));

export async function ocrFile(config: AppConfig, filePath: string): Promise<string> {
  if (config.OCR_ENABLED === "false") return "";
  if (config.OCR_ENABLED === "auto" && process.platform !== "darwin") return "";

  const bin = config.OCR_BIN || DEFAULT_BIN;
  if (!existsSync(bin)) return "";

  try {
    const { stdout } = await execFileAsync(bin, [filePath, "10"], {
      timeout: 45_000,
      maxBuffer: 12 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as { text?: string };
    return typeof parsed.text === "string" ? parsed.text.trim().slice(0, 20_000) : "";
  } catch {
    return "";
  }
}
