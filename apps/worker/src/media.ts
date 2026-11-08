import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { AppConfig, Database, MessageRow } from "@xiaoqi/core";
import { mediaAssets } from "@xiaoqi/core";
import { describeImage } from "./llm.js";
import { ocrFile } from "./ocr.js";

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_TEXT = 20_000;

interface RawItem {
  type?: number;
  image_item?: { media?: CDN; aeskey?: string };
  file_item?: { media?: CDN; file_name?: string };
}

interface CDN {
  full_url?: string;
  encrypt_query_param?: string;
  aes_key?: string;
}

export function normalizeAesKey(kind: "image" | "file", payload: RawItem): Buffer | null {
  if (kind === "image" && payload.image_item?.aeskey) {
    const key = Buffer.from(String(payload.image_item.aeskey), "hex");
    return key.length === 16 ? key : null;
  }
  const b64 = payload.file_item?.media?.aes_key;
  if (!b64) return null;
  const decoded = Buffer.from(String(b64), "base64");
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString("ascii");
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(ascii)) {
    return Buffer.from(ascii, "hex");
  }
  return null;
}

export async function extractAttachments(
  db: Database,
  config: AppConfig,
  msg: MessageRow,
): Promise<string> {
  const raw = msg.raw as { item_list?: RawItem[] } | null;
  const items = raw?.item_list ?? [];
  const blocks: string[] = [];

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.type !== 2 && item.type !== 4) continue;
    try {
      const block = await ingestOne(db, config, msg, item, index);
      if (block) blocks.push(block);
    } catch (err) {
      blocks.push(`[附件处理失败：${err instanceof Error ? err.message : String(err)}]`);
    }
  }
  return blocks.join("\n\n");
}

async function ingestOne(
  db: Database,
  config: AppConfig,
  msg: MessageRow,
  item: RawItem,
  index: number,
): Promise<string> {
  const kind = item.type === 2 ? "image" : "file";
  const payload = item;
  const media = kind === "image" ? payload.image_item?.media : payload.file_item?.media;
  const url = mediaUrl(media);
  const key = normalizeAesKey(kind, payload);
  if (!url || !key) {
    return `[附件无法读取：缺少 CDN URL 或 key]`;
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) return `[附件下载失败：HTTP ${res.status}]`;
  const cipher = Buffer.from(await res.arrayBuffer());
  if (cipher.length > MAX_BYTES) return `[附件超过 20MB，已跳过]`;

  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(true);
  const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
  if (plain.length > MAX_BYTES) return `[附件超过 20MB，已跳过]`;

  const rawFileName = payload.file_item?.file_name ?? "";
  let ext = detectExtension(plain);
  if (ext === "bin" && rawFileName.toLowerCase().endsWith(".csv")) ext = "csv";
  const fileName = rawFileName || `attachment-${index}.${ext}`;
  const storageKey = path.join("media", msg.accountId, `${msg.id}-${index}.${ext}`);
  const fullPath = path.join(config.MEDIA_DIR, msg.accountId, `${msg.id}-${index}.${ext}`);
  await fsp.mkdir(path.dirname(fullPath), { recursive: true });
  await fsp.writeFile(fullPath, plain, { mode: 0o600 });

  let text = "";
  let mime = mimeOf(ext);
  try {
    if (ext === "pdf") {
      const { extractText } = await import("unpdf");
      const result = await extractText(new Uint8Array(plain), { mergePages: true });
      if (result.totalPages > 200) throw new Error("PDF 超过 200 页");
      text = String(result.text).trim();
      if (!text) {
        const ocr = await ocrFile(config, fullPath);
        text = ocr ? `[PDF OCR]\n${ocr}` : "[PDF 未提取到文本，可能是扫描件]";
      }
    } else if (ext === "docx" || fileName.toLowerCase().endsWith(".docx")) {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: plain });
      text = result.value.trim();
      mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    } else if (ext === "csv") {
      text = csvPreview(plain.toString("utf8"));
      mime = "text/csv";
    } else if (ext === "txt" || ext === "md" || mime.startsWith("text/")) {
      text = plain.toString("utf8").trim();
    } else if (kind === "image") {
      let visionText = "";
      try {
        const vision = await describeImage(config, plain, mime);
        visionText = vision.text;
      } catch {
        visionText = "";
      }
      if (visionText) {
        text = `[图片内容]\n${visionText}`;
      } else {
        const ocr = await ocrFile(config, fullPath);
        text = ocr ? `[图片 OCR]\n${ocr}` : "[图片已收到，但未识别出文字]";
      }
    } else {
      text = `[文件 ${fileName} 暂不支持解析]`;
    }
  } catch (err) {
    text = `[附件解析失败：${err instanceof Error ? err.message : String(err)}]`;
  }

  await db
    .insert(mediaAssets)
    .values({
      messageId: msg.id,
      kind,
      mime,
      sizeBytes: plain.length,
      storageKey,
      extractedText: text.slice(0, MAX_TEXT),
      status: "ready",
    })
    .onConflictDoNothing();

  if (kind === "image") {
    return `[图片] ${text}`;
  }
  return `[文件：${fileName}]\n${text.slice(0, 12_000)}`;
}

export function csvPreview(text: string): string {
  return text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .slice(0, 200)
    .join("\n")
    .trim();
}

function mediaUrl(media: CDN | undefined): string {
  if (!media) return "";
  if (media.full_url) return media.full_url;
  if (media.encrypt_query_param) {
    return `https://novac2c.cdn.weixin.qq.com/c2c?${media.encrypt_query_param}`;
  }
  return "";
}

function detectExtension(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "%PDF") return "pdf";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return "docx";
  return "bin";
}

function mimeOf(ext: string): string {
  switch (ext) {
    case "jpg": return "image/jpeg";
    case "png": return "image/png";
    case "pdf": return "application/pdf";
    case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "txt": return "text/plain";
    case "md": return "text/markdown";
    case "csv": return "text/csv";
    default: return "application/octet-stream";
  }
}
