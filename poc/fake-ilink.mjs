#!/usr/bin/env node
/**
 * 本地假 iLink 服务器，用于在没有真实微信账号时验证 probe.mjs。
 * 不联网，不涉及真实 token。
 *
 * 用法：
 *   node poc/fake-ilink.mjs
 *   # 另一个终端：
 *   node poc/probe.mjs login --base-url http://127.0.0.1:8787
 *   node poc/probe.mjs watch --reply-mode group --yes --max 1
 */

import http from "node:http";
import crypto from "node:crypto";
import process from "node:process";

const PORT = Number(process.env.PORT || 8787);
const PNG_1X1 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const FAKE_KEY = Buffer.from("0123456789abcdef", "utf8");
const PNG_PLAIN = Buffer.from(PNG_1X1.split(",")[1], "base64");
const PNG_CIPHER = (() => {
  const c = crypto.createCipheriv("aes-128-ecb", FAKE_KEY, null);
  return Buffer.concat([c.update(PNG_PLAIN), c.final()]);
})();

let updatesCall = 0;
let sent = 0;

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({ raw: data });
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log(`[fake] ${req.method} ${url.pathname}${url.search}`);

  if (req.method === "POST" && url.pathname === "/ilink/bot/get_bot_qrcode") {
    return json(res, 200, {
      qrcode: "fake-qr-code",
      qrcode_img_content: PNG_1X1,
    });
  }

  if (req.method === "GET" && url.pathname === "/ilink/bot/get_qrcode_status") {
    return json(res, 200, {
      status: "confirmed",
      bot_token: "fake-bot-token",
      baseurl: `http://127.0.0.1:${PORT}`,
      ilink_bot_id: "fake-bot@im.bot",
      ilink_user_id: "fake-user@im.wechat",
    });
  }

  if (req.method === "POST" && (url.pathname === "/ilink/bot/msg/notifystart" || url.pathname === "/ilink/bot/msg/notifystop")) {
    return json(res, 200, { ret: 0 });
  }

  if (req.method === "POST" && url.pathname === "/ilink/bot/getupdates") {
    updatesCall += 1;
    if (updatesCall === 1) {
      return json(res, 200, {
        ret: 0,
        msgs: [
          {
            seq: 1,
            message_id: "900000000000000001",
            from_user_id: "fake-member@im.wechat",
            to_user_id: "fake-bot@im.bot",
            group_id: "",
            message_type: 1,
            message_state: 2,
            context_token: "fake-context-token-abc123",
            item_list: [
              {
                type: 1,
                text_item: { text: "你好，这是 fake 私聊消息" },
              },
              {
                type: 2,
                image_item: {
                  media: {
                    full_url: `http://127.0.0.1:${PORT}/fake-encrypted.png`,
                    aes_key: FAKE_KEY.toString("base64"),
                  },
                },
              },
            ],
          },
        ],
        get_updates_buf: "fake-cursor-1",
        longpolling_timeout_ms: 35000,
      });
    }
    return json(res, 200, {
      ret: 0,
      msgs: [],
      get_updates_buf: "fake-cursor-1",
      longpolling_timeout_ms: 35000,
    });
  }

  if (req.method === "GET" && url.pathname === "/fake-encrypted.png") {
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": PNG_CIPHER.length,
    });
    return res.end(PNG_CIPHER);
  }

  if (req.method === "POST" && url.pathname === "/ilink/bot/sendmessage") {
    const body = await readBody(req);
    sent += 1;
    console.log(`[fake] sendmessage #${sent}`, JSON.stringify(body));
    return json(res, 200, {
      ret: 0,
      msg: { message_id: String(800000000000000000 + sent) },
    });
  }

  return json(res, 404, { ret: -1, errmsg: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[fake] listening http://127.0.0.1:${PORT}`);
  console.log(`[fake] 用这个 base url 跑 login：http://127.0.0.1:${PORT}`);
});

process.on("SIGINT", () => {
  console.log("[fake] stopping");
  server.close(() => process.exit(0));
});
