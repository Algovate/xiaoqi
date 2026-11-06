#!/usr/bin/env node
/**
 * 小栖 Xiaoqi · Phase 0 iLink 协议探针（零依赖 POC）
 *
 * 用法：
 *   node poc/probe.mjs login
 *   node poc/probe.mjs watch --reply-mode none --max 20
 *   node poc/probe.mjs watch --reply-mode sender --yes --max 5
 *   node poc/probe.mjs send --to <id> --text "hello" --context "<context_token>"
 *   node poc/probe.mjs whoami
 *   node poc/probe.mjs selftest
 *
 * 只用于测试群和自己可控的账号。不要在生产群跑 reply 模式。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import process from "node:process";

const DEFAULT_BASE = process.env.ILINK_BASE_URL || "https://ilinkai.weixin.qq.com";
const APP_ID = process.env.ILINK_APP_ID || "bot";
const APP_VERSION = process.env.ILINK_APP_VERSION || "132106";
const ROOT = path.resolve(process.cwd(), ".poc");
const TOKEN_FILE = path.join(ROOT, "token.json");
const CURSOR_FILE = path.join(ROOT, "cursor.json");
const SEEN_FILE = path.join(ROOT, "seen.json");
const CAPTURE_DIR = path.join(ROOT, "captures");
const MEDIA_DIR = path.join(ROOT, "media");
const MEDIA_MAX_BYTES = 20 * 1024 * 1024;
const QR_PNG = path.join(ROOT, "qr.png");
const QR_URL_FILE = path.join(ROOT, "qr-url.txt");
const QR_TEXT_FILE = path.join(ROOT, "qr.txt");
const SEEN_MAX = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ts() {
  return new Date().toISOString().replace("T", " ").replace("Z", "Z");
}

function log(...args) {
  console.log(`[${ts()}]`, ...args);
}
function warn(...args) {
  console.warn(`[${ts()}] WARN`, ...args);
}
function fail(...args) {
  console.error(`[${ts()}] ERROR`, ...args);
}

function normalizeBase(input) {
  let s = String(input || DEFAULT_BASE).trim();
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

function randomUin() {
  const n = crypto.randomBytes(4).readUInt32LE(0);
  return Buffer.from(String(n), "utf8").toString("base64");
}

function buildHeaders(token) {
  const headers = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomUin(),
    "iLink-App-Id": APP_ID,
    "iLink-App-ClientVersion": APP_VERSION,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function safeSnippet(text, max = 500) {
  if (!text) return "";
  return String(text)
    .replace(/("?(?:bot_token|context_token|aes_key|authorization)"?\s*:\s*")([^"]+)/gi, "$1***")
    .slice(0, max);
}

function joinUrl(baseUrl, endpoint) {
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `${normalizeBase(baseUrl)}/${String(endpoint).replace(/^\/+/, "")}`;
}

function parseJsonPreserveBigInts(text) {
  let out = "";
  let i = 0;
  let inString = false;
  let escaped = false;

  while (i < text.length) {
    const c = text[i];
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
      while (j < text.length && text[j] >= "0" && text[j] <= "9") j += 1;
      const token = text.slice(i, j);
      const next = text[j];
      const isFloat = next === "." || next === "e" || next === "E";
      if (!isFloat) {
        try {
          const n = BigInt(token);
          if (n > 9007199254740991n || n < -9007199254740991n) {
            out += `"${token}"`;
            i = j;
            continue;
          }
        } catch {
          // 不是合法整数，按原样处理
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

async function api(endpoint, options = {}) {
  const {
    method = "POST",
    token,
    baseUrl = DEFAULT_BASE,
    body,
    timeoutMs = 15000,
    label = "api",
  } = options;

  const url = joinUrl(baseUrl, endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method,
      headers: buildHeaders(token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? parseJsonPreserveBigInts(text) : {};
    } catch {
      // 保留 text，由调用方决定
    }
    if (!res.ok) {
      const err = new Error(`${label} HTTP ${res.status}: ${safeSnippet(text)}`);
      err.status = res.status;
      err.body = safeSnippet(text);
      throw err;
    }
    if (!json) {
      const err = new Error(`${label} 返回非 JSON: ${safeSnippet(text)}`);
      err.body = safeSnippet(text);
      throw err;
    }
    return json;
  } catch (err) {
    if (err?.name === "AbortError") {
      const e = new Error(`${label} 超时（${timeoutMs}ms）`);
      e.code = "TIMEOUT";
      throw e;
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureDirs() {
  await fsp.mkdir(ROOT, { recursive: true, mode: 0o700 });
  await fsp.mkdir(CAPTURE_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(MEDIA_DIR, { recursive: true, mode: 0o700 });
}

async function writePrivate(file, content) {
  await ensureDirs();
  await fsp.writeFile(file, content, { mode: 0o600 });
  try {
    await fsp.chmod(file, 0o600);
  } catch {
    // 某些文件系统不支持 chmod；忽略
  }
}

async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function saveToken(status, statusBase) {
  const botToken = status.bot_token;
  if (!botToken) throw new Error("confirmed 但没有返回 bot_token");
  const token = {
    botToken,
    baseUrl: normalizeBase(status.baseurl || statusBase || DEFAULT_BASE),
    ilinkBotId: status.ilink_bot_id || "",
    ilinkUserId: status.ilink_user_id || "",
    savedAt: new Date().toISOString(),
  };
  await writePrivate(TOKEN_FILE, JSON.stringify(token, null, 2));
  return token;
}

async function loadToken() {
  const token = await readJson(TOKEN_FILE);
  if (!token?.botToken) {
    throw new Error(`没有找到 token：${TOKEN_FILE}\n先运行：node poc/probe.mjs login`);
  }
  token.baseUrl = normalizeBase(token.baseUrl || DEFAULT_BASE);
  return token;
}

async function saveQr(content) {
  await ensureDirs();
  const raw = String(content || "").trim();
  if (!raw) return { kind: "none" };

  const dataUrl = raw.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  if (dataUrl) {
    const buf = Buffer.from(dataUrl[2], "base64");
    await writePrivate(QR_PNG, buf);
    return { kind: "png", path: QR_PNG };
  }

  if (/^https?:\/\//i.test(raw)) {
    try {
      const res = await fetch(raw, { signal: AbortSignal.timeout(15000) });
      const type = res.headers.get("content-type") || "";
      if (res.ok && type.startsWith("image/")) {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length <= 5 * 1024 * 1024) {
          await writePrivate(QR_PNG, buf);
          return { kind: "png", path: QR_PNG, url: raw };
        }
      }
    } catch {
      // 下载失败也保留 URL
    }
    await writePrivate(QR_URL_FILE, raw + "\n");
    return { kind: "url", path: QR_URL_FILE, url: raw };
  }

  await writePrivate(QR_TEXT_FILE, raw + "\n");
  return { kind: "text", path: QR_TEXT_FILE, content: raw };
}

function extractText(msg) {
  const parts = [];
  for (const item of msg.item_list || []) {
    switch (item.type) {
      case 1:
        if (item.text_item?.text) parts.push(item.text_item.text);
        break;
      case 2:
        parts.push("[图片]");
        break;
      case 3:
        parts.push(item.voice_item?.text ? `[语音] ${item.voice_item.text}` : "[语音]");
        break;
      case 4:
        parts.push(`[文件] ${item.file_item?.file_name || ""}`.trim());
        break;
      case 5:
        parts.push("[视频]");
        break;
      default:
        break;
    }
  }
  return parts.join("\n").trim();
}

function extractMentions(text) {
  const out = new Set();
  const re = /@([^\s@，。！？、,.!?:：]{1,30})/g;
  let m;
  while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}

function contextPrefix(token) {
  if (!token) return "(none)";
  return `${String(token).slice(0, 12)}…(len=${String(token).length})`;
}

function detectExtension(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "%PDF") return "pdf";
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return "zip";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("ascii") === "RIFF" && buf.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  return "bin";
}

function mediaUrl(media) {
  if (!media) return "";
  if (media.full_url) return media.full_url;
  if (media.encrypt_query_param) {
    return `https://novac2c.cdn.weixin.qq.com/c2c?${media.encrypt_query_param}`;
  }
  return "";
}

function normalizeAesKey(kind, payload, media) {
  if (kind === "image" && payload?.aeskey) {
    const key = Buffer.from(String(payload.aeskey), "hex");
    return key.length === 16 ? key : null;
  }
  if (!media?.aes_key) return null;
  const b64 = String(media.aes_key);
  const decoded = Buffer.from(b64, "base64");
  if (decoded.length === 16) return decoded;
  // 实测：file_item.media.aes_key 是“hex 字符串”的 base64，不是 16 字节原始 key
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  if (/^[0-9a-f]{32}$/i.test(b64)) return Buffer.from(b64, "hex");
  return null;
}

async function probeMedia(item, messageId, index, enabled) {
  if (!enabled) return null;
  const kind =
    item.type === 2 ? "image" :
    item.type === 3 ? "voice" :
    item.type === 4 ? "file" :
    item.type === 5 ? "video" : "unknown";
  if (kind === "unknown" || kind === "voice" || kind === "video") {
    return { kind, status: "skipped" };
  }

  const payload =
    kind === "image" ? item.image_item :
    kind === "file" ? item.file_item : null;
  if (!payload) return { kind, status: "missing-payload" };

  const media = payload.media;
  const url = mediaUrl(media);
  if (!url) return { kind, status: "missing-url" };

  const key = normalizeAesKey(kind, payload, media);
  if (!key || key.length !== 16) {
    return {
      kind,
      status: "missing-key",
      url,
      keyHint: media?.aes_key ? `decoded=${Buffer.from(String(media.aes_key), "base64").length}B` : "none",
    };
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { kind, status: `http-${res.status}`, url };
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MEDIA_MAX_BYTES) return { kind, status: "too-large", url, size: len };
    const cipher = Buffer.from(await res.arrayBuffer());
    if (cipher.length > MEDIA_MAX_BYTES) return { kind, status: "too-large", url, size: cipher.length };

    const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
    decipher.setAutoPadding(true);
    const plain = Buffer.concat([decipher.update(cipher), decipher.final()]);
    const ext = detectExtension(plain);
    const file = path.join(MEDIA_DIR, `${messageId}-${index}.${ext}`);
    await writePrivate(file, plain);
    return {
      kind,
      status: "ok",
      file,
      size: plain.length,
      ext,
      url,
    };
  } catch (err) {
    return { kind, status: "error", error: err.message, url };
  }
}

async function login(flags) {
  const baseUrl = normalizeBase(flags["base-url"] || DEFAULT_BASE);
  log(`请求二维码：${baseUrl}`);

  const qr = await api("/ilink/bot/get_bot_qrcode?bot_type=3", {
    baseUrl,
    body: { local_token_list: [] },
    timeoutMs: 15000,
    label: "get_bot_qrcode",
  });

  if (!qr.qrcode) throw new Error(`没有返回 qrcode：${safeSnippet(JSON.stringify(qr))}`);
  const saved = await saveQr(qr.qrcode_img_content || qr.qrcode);
  log(`扫码内容：${qr.qrcode}`);
  if (saved.kind === "png") {
    log(`二维码图片：${saved.path}`);
    if (saved.url) log(`二维码 URL：${saved.url}`);
  } else if (saved.kind === "url") {
    log(`二维码 URL（在手机微信打开或转成二维码）：${saved.url}`);
    log(`已保存：${saved.path}`);
  } else {
    log(`未识别的二维码内容，已保存：${saved.path}`);
  }
  log("请用手机微信扫码；等待确认中（最长 8 分钟）…");

  let statusBase = baseUrl;
  let verifyCode = "";
  let lastWaitLog = 0;
  let lastStatus = "";
  const startedAt = Date.now();
  const deadline = startedAt + 8 * 60 * 1000;

  while (Date.now() < deadline) {
    const qs = new URLSearchParams({ qrcode: qr.qrcode });
    if (verifyCode) qs.set("verify_code", verifyCode);

    let st;
    try {
      st = await api(`/ilink/bot/get_qrcode_status?${qs.toString()}`, {
        method: "GET",
        baseUrl: statusBase,
        timeoutMs: 40000,
        label: "get_qrcode_status",
      });
    } catch (err) {
      if (err.code === "TIMEOUT") {
        if (Date.now() - lastWaitLog > 5000) {
          log("仍在等待扫码…");
          lastWaitLog = Date.now();
        }
        continue;
      }
      warn(`查询扫码状态失败：${err.message}`);
      await sleep(1500);
      continue;
    }

    const status = st.status || "unknown";
    if (status !== lastStatus && status !== "wait") {
      log(`登录状态：${status}`);
      lastStatus = status;
    }

    switch (status) {
      case "wait":
        if (Date.now() - lastWaitLog > 5000) {
          log("仍在等待扫码…");
          lastWaitLog = Date.now();
        }
        await sleep(1000);
        break;

      case "scaned":
        log("已扫码，请在手机上确认");
        await sleep(1000);
        break;

      case "scaned_but_redirect": {
        const host = st.redirect_host;
        if (host) {
          statusBase = normalizeBase(host);
          log(`切换到登录机房：${statusBase}`);
        }
        await sleep(500);
        break;
      }

      case "need_verifycode": {
        if (!verifyCode) {
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          verifyCode = (await rl.question("需要验证码，请输入：")).trim();
          rl.close();
        }
        await sleep(500);
        break;
      }

      case "verify_code_blocked":
        throw new Error("验证码被拦截，请稍后重试");

      case "confirmed": {
        const token = await saveToken(st, statusBase);
        log("登录成功");
        log(`bot id：${token.ilinkBotId || "(unknown)"}`);
        log(`base url：${token.baseUrl}`);
        log(`token 已保存：${TOKEN_FILE}（权限 0600，勿提交）`);
        log("");
        log("下一步：把 bot 拉进测试群，然后运行");
        log("  node poc/probe.mjs watch --reply-mode none --max 20");
        return token;
      }

      case "expired":
        throw new Error("二维码已过期，请重新运行 login");

      case "binded_redirect": {
        if (st.bot_token) {
          const token = await saveToken(st, statusBase);
          log(`已绑定并保存 token：${token.ilinkBotId || "(unknown)"}`);
          return token;
        }
        throw new Error("该账号已绑定，但没有返回 bot_token；请用已有 token 或重新扫码");
      }

      default:
        warn(`未知状态 ${status}：${safeSnippet(JSON.stringify(st))}`);
        await sleep(1000);
        break;
    }
  }

  throw new Error("登录超时（8 分钟）；请重新运行 login");
}

function loadCursor(botId) {
  return readJson(CURSOR_FILE, {}).then((data) => {
    if (data?.botId !== botId) return "";
    return typeof data.buf === "string" ? data.buf : "";
  });
}

async function saveCursor(botId, buf) {
  await writePrivate(
    CURSOR_FILE,
    JSON.stringify({ botId, buf, updatedAt: new Date().toISOString() }, null, 2),
  );
}

async function loadSeen() {
  const data = await readJson(SEEN_FILE, []);
  return new Set(Array.isArray(data) ? data.slice(-SEEN_MAX) : []);
}

async function saveSeen(seen) {
  const arr = [...seen].slice(-SEEN_MAX);
  await writePrivate(SEEN_FILE, JSON.stringify(arr));
}

async function capture(file, entry, enabled) {
  if (!enabled) return;
  await fsp.appendFile(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
}

async function sendMessage(token, { to, text, contextToken, clientId, baseUrl }) {
  if (!to) throw new Error("缺少 to（群 ID 或用户 ID）");
  if (!text) throw new Error("缺少 text");
  if (!contextToken) throw new Error("缺少 context_token；主动消息需要最近一次入站 token");
  const cid = clientId || `poc-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const body = {
    msg: {
      from_user_id: "",
      to_user_id: to,
      client_id: cid,
      message_type: 2,
      message_state: 2,
      context_token: contextToken,
      item_list: [{ type: 1, text_item: { text } }],
    },
  };
  const resp = await api("/ilink/bot/sendmessage", {
    token: token.botToken,
    baseUrl: baseUrl || token.baseUrl,
    body,
    timeoutMs: 20000,
    label: "sendmessage",
  });
  if (resp.ret && resp.ret !== 0) {
    throw new Error(`sendmessage ret=${resp.ret} errmsg=${resp.errmsg || ""}`);
  }
  return { resp, clientId: cid };
}

async function watch(flags) {
  const token = await loadToken();
  const replyMode = String(flags["reply-mode"] || "none");
  if (!["none", "group", "sender", "auto"].includes(replyMode)) {
    throw new Error("--reply-mode 只能是 none|group|sender|auto");
  }
  if (replyMode !== "none" && !flags.yes) {
    fail("reply 模式会真的往微信发消息。确认是测试群后，加 --yes 再运行。");
    fail("示例：node poc/probe.mjs watch --reply-mode group --yes --max 3");
    process.exitCode = 2;
    return;
  }

  const baseUrl = normalizeBase(flags["base-url"] || token.baseUrl);
  const max = Number(flags.max ?? (replyMode === "none" ? 0 : 5));
  if (!Number.isFinite(max) || max < 0) throw new Error("--max 必须是非负整数");
  const captureEnabled = flags.capture !== false;

  let cursor = flags["reset-cursor"] ? "" : await loadCursor(token.ilinkBotId || "unknown");
  const seen = flags["reset-cursor"] ? new Set() : await loadSeen();
  await ensureDirs();
  const captureFile = path.join(
    CAPTURE_DIR,
    `${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );
  if (captureEnabled) await writePrivate(captureFile, "");

  const stats = { inbound: 0, replies: 0, errors: 0, groups: new Set() };
  let stopping = false;
  process.on("SIGINT", () => {
    log("收到 SIGINT，停止轮询…");
    stopping = true;
  });

  log(`开始轮询：${baseUrl}`);
  log(`bot id：${token.ilinkBotId || "(unknown)"}`);
  log(`reply mode：${replyMode}${replyMode === "none" ? "" : "（会发消息）"}`);
  log(`max：${max === 0 ? "不限" : max}`);
  log(`capture：${captureEnabled ? captureFile : "off"}`);
  log("直接在微信里私聊 bot 发消息。Ctrl-C 停止。");
  log("");

  async function handleMessage(msg) {
    const messageId = String(msg.message_id ?? "").trim();
    if (!messageId) return;
    if (seen.has(messageId)) return;

    if (msg.message_type !== 1) {
      seen.add(messageId);
      return;
    }
    if (msg.from_user_id && token.ilinkBotId && msg.from_user_id === token.ilinkBotId) {
      seen.add(messageId);
      return;
    }

    const text = extractText(msg);
    const mentions = extractMentions(text);
    const groupId = String(msg.group_id || "");
    const from = String(msg.from_user_id || "");
    if (groupId) stats.groups.add(groupId);
    stats.inbound += 1;

    const index = stats.inbound;
    log(`--- 消息 #${index} ---`);
    log(`from: ${from || "(unknown)"}`);
    log(`group: ${groupId || "(dm)"}`);
    log(`message_id: ${messageId}`);
    log(`message_type: ${msg.message_type} state: ${msg.message_state}`);
    log(`item types: ${(msg.item_list || []).map((i) => i.type).join(",") || "(none)"}`);
    log(`text: ${text ? JSON.stringify(text) : "(empty)"}`);
    if (mentions.length) log(`mentions: ${mentions.join(", ")}`);
    const atList = [
      ...(Array.isArray(msg.at_bot_username_list) ? msg.at_bot_username_list : []),
      ...(msg.item_list || []).flatMap((i) => Array.isArray(i.at_bot_username_list) ? i.at_bot_username_list : []),
    ];
    if (atList.length) log(`at_bot_username_list: ${atList.join(", ")}`);
    if (msg.context_token) log(`context_token: ${contextPrefix(msg.context_token)}`);
    if (msg.item_list?.some((i) => i.ref_msg)) {
      const ref = msg.item_list.find((i) => i.ref_msg)?.ref_msg;
      const refId = ref?.message_item?.msg_id || ref?.svr_id || "";
      log(`ref: title=${JSON.stringify(ref?.title || "")} msg_id=${refId} svr_id=${ref?.svr_id || ""}`);
    }
    if (flags["show-context-token"] && msg.context_token) {
      log(`context_token(full): ${msg.context_token}`);
    }

    const mediaResults = [];
    if (flags.media) {
      const items = msg.item_list || [];
      for (let i = 0; i < items.length; i++) {
        if (![2, 3, 4, 5].includes(items[i].type)) continue;
        const r = await probeMedia(items[i], messageId, i, true);
        if (!r) continue;
        mediaResults.push({ index: i, ...r });
        if (r.status === "ok") {
          log(`media[${i}] ${r.kind}: ok, ${r.size} bytes → ${r.file}`);
        } else {
          log(`media[${i}] ${r.kind}: ${r.status}${r.url ? ` url=${r.url.slice(0, 80)}…` : ""}`);
        }
      }
    }
    log("");

    await capture(
      captureFile,
      {
        capturedAt: new Date().toISOString(),
        account: token.ilinkBotId || "",
        message: msg,
        parsed: { text, mentions, hasAt: text.includes("@"), atBotUsernameList: atList, isGroup: Boolean(groupId), media: mediaResults },
      },
      captureEnabled,
    );

    if (replyMode !== "none") {
      let target = "";
      if (replyMode === "group") target = groupId;
      else if (replyMode === "sender") target = from;
      else target = groupId || from;

      if (!target) {
        warn("没有可用的回复目标（group_id/from_user_id 都为空），跳过");
      } else {
        const label = replyMode === "group" && !groupId ? "sender-fallback" : replyMode;
        const replyText =
          flags["reply-text"] ||
          `【POC-${label}】收到：${text ? text.slice(0, 100) : "(非文本消息)"}`;

        try {
          const result = await sendMessage(token, {
            to: target,
            text: replyText,
            contextToken: msg.context_token,
            baseUrl,
          });
          stats.replies += 1;
          log(`已发送（${label} → ${target}），client_id=${result.clientId}`);
          log(`响应：${safeSnippet(JSON.stringify(result.resp), 800)}`);
          await capture(
            captureFile,
            {
              capturedAt: new Date().toISOString(),
              account: token.ilinkBotId || "",
              probeReply: {
                mode: replyMode,
                label,
                to: target,
                text: replyText,
                clientId: result.clientId,
                response: result.resp,
              },
            },
            captureEnabled,
          );
          await sleep(1200);
        } catch (err) {
          stats.errors += 1;
          warn(`发送失败：${err.message}`);
        }
      }
    }

    seen.add(messageId);
    await saveSeen(seen);
  }

  let backoff = 1000;
  while (!stopping) {
    let resp;
    try {
      resp = await api("/ilink/bot/getupdates", {
        token: token.botToken,
        baseUrl,
        body: { get_updates_buf: cursor },
        timeoutMs: 45000,
        label: "getupdates",
      });
    } catch (err) {
      stats.errors += 1;
      warn(`getupdates 失败：${err.message}；${backoff}ms 后重试`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 15000);
      continue;
    }
    backoff = 1000;

    if (resp.errcode === -14) {
      fail("iLink 会话过期（errcode=-14）。请重新运行 login 扫码。");
      break;
    }
    if (resp.ret && resp.ret !== 0) {
      stats.errors += 1;
      warn(`getupdates ret=${resp.ret} errmsg=${resp.errmsg || ""}`);
      await sleep(2000);
      continue;
    }

    if (resp.get_updates_buf && resp.get_updates_buf !== cursor) {
      cursor = resp.get_updates_buf;
      await saveCursor(token.ilinkBotId || "unknown", cursor);
    }

    const msgs = Array.isArray(resp.msgs) ? resp.msgs : [];
    if (msgs.length === 0) {
      await sleep(300);
    }

    for (const msg of msgs) {
      if (stopping) break;
      try {
        await handleMessage(msg);
      } catch (err) {
        stats.errors += 1;
        warn(`处理消息失败：${err.message}`);
      }
      if (max > 0 && stats.inbound >= max) {
        log(`达到 --max ${max}，停止`);
        stopping = true;
        break;
      }
    }
  }

  await saveSeen(seen);
  log("");
  log("=== 探针结果 ===");
  log(`收到消息：${stats.inbound}`);
  log(`群数量：${stats.groups.size}${stats.groups.size ? `（${[...stats.groups].join(", ")}）` : ""}`);
  log(`自动回复：${stats.replies}`);
  log(`错误：${stats.errors}`);
  log(`capture：${captureEnabled ? captureFile : "off"}`);
  if (replyMode === "group" || replyMode === "sender") {
    log("");
    log("对照记录：");
    log(`- reply-mode=${replyMode} 的回复是否出现在预期位置？`);
    log("- 群里是否看到重复/串群？");
    log("- 把 capture 文件脱敏后作为 fixture。");
  }
}

async function sendCommand(flags) {
  const token = await loadToken();
  const baseUrl = normalizeBase(flags["base-url"] || token.baseUrl);
  const to = String(flags.to || "").trim();
  const text = String(flags.text || "").trim();
  const contextToken = String(flags.context || "").trim();
  if (!to || !text || !contextToken) {
    throw new Error("用法：node poc/probe.mjs send --to <id> --text <text> --context <token> [--base-url <url>]");
  }
  const result = await sendMessage(token, { to, text, contextToken, baseUrl });
  log(`已发送，client_id=${result.clientId}`);
  log(`响应：${safeSnippet(JSON.stringify(result.resp), 1000)}`);
}

async function whoami() {
  const token = await loadToken();
  log(`bot id：${token.ilinkBotId || "(unknown)"}`);
  log(`user id：${token.ilinkUserId || "(unknown)"}`);
  log(`base url：${token.baseUrl}`);
  log(`saved at：${token.savedAt}`);
  log(`token：${String(token.botToken).slice(0, 8)}…（不打印完整值）`);
}

function printHelp() {
  console.log(`小栖 Xiaoqi · Phase 0 iLink 协议探针（零依赖 POC）

用法：
  node poc/probe.mjs login [--base-url <url>]
  node poc/probe.mjs watch [--reply-mode none|group|sender|auto] [--max N] [--yes]
                           [--reset-cursor] [--no-capture] [--show-context-token] [--media]
  node poc/probe.mjs send --to <group|user> --text <text> --context <token>
  node poc/probe.mjs whoami
  node poc/probe.mjs selftest
  node poc/probe.mjs help

说明：
  login   获取二维码并保存 token 到 .poc/token.json（0600）
  watch   长轮询；默认只记录，不回复
  send    手动发一条文本；context 必须是最近入站消息的 context_token
  --yes   reply 模式必须显式确认，避免误发
  --media 下载图片/文件到 .poc/media 并尝试 AES-128-ECB 解密
  注意：group 模式仅未来群能力验证；当前扫码 bot 无法加入普通微信群。

安全：
  - 只在测试群运行 reply 模式
  - .poc/ 已在 .gitignore；仍建议结束后删除
  - capture 里含消息原文，脱敏后再提交
`);
}

function parseArgs(argv) {
  let command = "help";
  let rest = argv;
  if (argv[0] && !argv[0].startsWith("-")) {
    command = argv[0];
    rest = argv.slice(1);
  }
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("-")) continue;
    if (arg === "-h" || arg === "--help") {
      flags.help = true;
      continue;
    }
    let key;
    let value;
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq >= 0) {
        key = arg.slice(2, eq);
        value = arg.slice(eq + 1);
      } else {
        key = arg.slice(2);
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          value = next;
          i += 1;
        } else {
          value = true;
        }
      }
    } else {
      continue;
    }
    if (key === "no-capture") {
      flags.capture = false;
    } else {
      flags[key] = value;
    }
  }
  return { command, flags };
}

async function selftest() {
  const eq = (a, b, label) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      throw new Error(`selftest ${label}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
    }
  };

  eq(normalizeBase("ilinkai.weixin.qq.com"), "https://ilinkai.weixin.qq.com", "normalizeBase");
  eq(normalizeBase("https://x.test/"), "https://x.test", "normalizeBase slash");

  const msg = {
    item_list: [
      { type: 1, text_item: { text: "@小栖 你好" } },
      { type: 2, image_item: {} },
    ],
  };
  eq(extractText(msg), "@小栖 你好\n[图片]", "extractText");
  eq(extractMentions("@小栖 你好 @群栖"), ["小栖", "群栖"], "extractMentions");
  eq(extractMentions("没有 at"), [], "extractMentions empty");
  eq(safeSnippet('{"bot_token":"secret","x":1}').includes("secret"), false, "safeSnippet");

  const parsed = parseJsonPreserveBigInts('{"message_id":7524313909497035000,"small":1}');
  eq(parsed.message_id, "7524313909497035000", "bigint message_id");
  eq(parsed.small, 1, "small number");

  const hex = "c90e0fb9faebcc500b63e18a1652e5e5";
  eq(
    normalizeAesKey("file", null, { aes_key: Buffer.from(hex, "utf8").toString("base64") }).toString("hex"),
    hex,
    "file aes_key base64-of-hex",
  );
  eq(
    normalizeAesKey("image", { aeskey: hex }, null).toString("hex"),
    hex,
    "image aeskey hex",
  );

  log("selftest ok");
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (flags.help) {
    printHelp();
    return;
  }

  switch (command) {
    case "login":
      await login(flags);
      break;
    case "watch":
    case "poll":
      await watch(flags);
      break;
    case "send":
      await sendCommand(flags);
      break;
    case "whoami":
      await whoami();
      break;
    case "selftest":
      await selftest();
      break;
    case "help":
    default:
      printHelp();
      break;
  }
}

main().catch((err) => {
  fail(err.message || String(err));
  if (process.env.DEBUG) console.error(err);
  process.exitCode = 1;
});
