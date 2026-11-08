import fsp from "node:fs/promises";
import type { AppConfig, Logger, MessageRow } from "@xiaoqi/core";
import type { OutboundFile } from "./outbound-file.js";
import { sendFile, sendImage } from "./send.js";

export interface DeliveryResult {
  errorCode: string | null;
  notes: string[];
}

export async function deliverAttachments(
  deps: { config: AppConfig; logger: Logger },
  runId: string,
  msg: MessageRow,
  files: { media?: OutboundFile; file?: OutboundFile },
): Promise<DeliveryResult> {
  let errorCode: string | null = null;
  const notes: string[] = [];

  for (const [kind, file] of [
    ["image", files.media],
    ["file", files.file],
  ] as const) {
    if (!file) continue;
    try {
      if (kind === "image") {
        await sendImage(deps.config, runId, msg, file);
      } else {
        await sendFile(deps.config, runId, msg, file);
      }
      await fsp.unlink(file.path).catch(() => undefined);
    } catch (err) {
      deps.logger.warn({ err, runId, kind }, "answer attachment send failed");
      if (kind === "image") {
        errorCode = errorCode ?? "IMAGE_SEND_FAILED";
        notes.push("（图片发送失败，稍后再试）");
      } else {
        errorCode = errorCode ?? "FILE_SEND_FAILED";
        notes.push("（文件发送失败，稍后再试）");
      }
    }
  }

  return { errorCode, notes };
}
