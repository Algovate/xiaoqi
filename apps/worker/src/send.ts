import fsp from "node:fs/promises";
import type { AppConfig, MessageRow } from "@xiaoqi/core";
import { chunkReply } from "./format.js";

export interface SendMedia {
  path: string;
  mime: string;
  filename: string;
}

function headers(config: AppConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-xiaoqi-internal": config.internalToken,
  };
}

export async function sendTextChunks(
  config: AppConfig,
  runId: string,
  msg: MessageRow,
  text: string,
): Promise<number> {
  const chunks = chunkReply(text);
  for (let i = 0; i < chunks.length; i += 1) {
    const resp = await fetch(`${config.GATEWAY_INTERNAL_URL}/internal/v1/send`, {
      method: "POST",
      headers: headers(config),
      body: JSON.stringify({
        runId,
        chunkIndex: i,
        replyToMessageId: String(msg.id),
        text: chunks[i],
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      throw new Error(`gateway send failed http=${resp.status} ${body.slice(0, 300)}`);
    }
  }
  return chunks.length;
}

export async function sendImage(
  config: AppConfig,
  runId: string,
  msg: MessageRow,
  media: SendMedia,
): Promise<void> {
  const data = await fsp.readFile(media.path);
  if (data.length > config.MEDIA_OUTBOUND_MAX_BYTES) {
    throw new Error(`image too large: ${data.length} bytes`);
  }
  const resp = await fetch(`${config.GATEWAY_INTERNAL_URL}/internal/v1/send-image`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      runId,
      replyToMessageId: String(msg.id),
      mime: media.mime,
      filename: media.filename,
      dataBase64: data.toString("base64"),
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`gateway image send failed http=${resp.status} ${body.slice(0, 300)}`);
  }
}
