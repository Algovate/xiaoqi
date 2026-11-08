import fsp from "node:fs/promises";
import type { AppConfig, MessageRow } from "@xiaoqi/core";
import { chunkReply } from "./format.js";

export interface SendMedia {
  path: string;
  mime: string;
  filename: string;
}

export type SendFile = SendMedia;

function headers(config: AppConfig): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-xiaoqi-internal": config.internalToken,
  };
}

async function readMedia(config: AppConfig, media: SendMedia, label: string): Promise<Buffer> {
  const data = await fsp.readFile(media.path);
  if (data.length > config.MEDIA_OUTBOUND_MAX_BYTES) {
    throw new Error(`${label} too large: ${data.length} bytes`);
  }
  return data;
}

async function postBase64(
  config: AppConfig,
  endpoint: string,
  runId: string,
  msg: MessageRow,
  payload: Record<string, unknown>,
  label: string,
): Promise<void> {
  const resp = await fetch(`${config.GATEWAY_INTERNAL_URL}${endpoint}`, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      runId,
      replyToMessageId: String(msg.id),
      ...payload,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`gateway ${label} send failed http=${resp.status} ${body.slice(0, 300)}`);
  }
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
  const data = await readMedia(config, media, "image");
  await postBase64(
    config,
    "/internal/v1/send-image",
    runId,
    msg,
    {
      mime: media.mime,
      filename: media.filename,
      dataBase64: data.toString("base64"),
    },
    "image",
  );
}

export async function sendFile(
  config: AppConfig,
  runId: string,
  msg: MessageRow,
  media: SendFile,
): Promise<void> {
  const data = await readMedia(config, media, "file");
  await postBase64(
    config,
    "/internal/v1/send-file",
    runId,
    msg,
    {
      fileName: media.filename,
      mime: media.mime,
      dataBase64: data.toString("base64"),
    },
    "file",
  );
}
