import type { MessageItem, WeixinMessage } from "./types.js";
import { ItemType, MessageType } from "./types.js";

/** Preserve uint64 IDs as strings; JSON.parse loses precision above 2^53. */
export function parseJsonPreserveBigInts(text: string): unknown {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i += 1;
      continue;
    }
    if (c === "-" || (c >= "0" && c <= "9")) {
      let j = i;
      if (c === "-") j += 1;
      while (j < text.length && text[j]! >= "0" && text[j]! <= "9") j += 1;
      const token = text.slice(i, j);
      const next = text[j];
      if (next !== "." && next !== "e" && next !== "E") {
        try {
          const n = BigInt(token);
          if (n > 9007199254740991n || n < -9007199254740991n) {
            out += `"${token}"`;
            i = j;
            continue;
          }
        } catch {
          // ignore
        }
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i += 1;
  }
  return JSON.parse(out);
}

export function wxId(value: string | number | undefined | null): string {
  return value === undefined || value === null ? "" : String(value);
}

export function extractText(msg: WeixinMessage): string {
  const parts: string[] = [];
  for (const item of msg.item_list ?? []) {
    switch (item.type) {
      case ItemType.TEXT:
        if (item.text_item?.text) parts.push(item.text_item.text);
        break;
      case ItemType.IMAGE:
        parts.push("[图片]");
        break;
      case ItemType.VOICE:
        parts.push(item.voice_item?.text ? `[语音] ${item.voice_item.text}` : "[语音]");
        break;
      case ItemType.FILE:
        parts.push(`[文件] ${item.file_item?.file_name ?? ""}`.trim());
        break;
      case ItemType.VIDEO:
        parts.push("[视频]");
        break;
      default:
        break;
    }
  }
  return parts.join("\n").trim();
}

export function itemTypeOf(items: MessageItem[] | undefined): string {
  const types = new Set((items ?? []).map((i) => i.type));
  if (types.has(ItemType.IMAGE)) return "image";
  if (types.has(ItemType.VOICE)) return "voice";
  if (types.has(ItemType.FILE)) return "file";
  if (types.has(ItemType.VIDEO)) return "video";
  if (types.has(ItemType.TEXT)) return "text";
  return "unknown";
}

export function isUserMessage(msg: WeixinMessage): boolean {
  return msg.message_type === MessageType.USER;
}

export function conversationKeyOf(msg: WeixinMessage): string {
  if (msg.group_id) return `group:${msg.group_id}`;
  return `dm:${msg.from_user_id ?? "unknown"}`;
}
