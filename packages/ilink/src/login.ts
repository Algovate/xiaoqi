import type { ILinkClient } from "./client.js";
import type { LoginQr, QrStatus, QrStatusResp, Token } from "./types.js";

export interface LoginHooks {
  onQr?: (qr: LoginQr) => void | Promise<void>;
  onStatus?: (status: QrStatus, resp: QrStatusResp) => void | Promise<void>;
  askVerifyCode?: () => Promise<string>;
  maxWaitMs?: number;
}

export async function loginFlow(client: ILinkClient, hooks: LoginHooks = {}): Promise<Token> {
  const qr = await client.getBotQrcode("3", []);
  await hooks.onQr?.(qr);

  const deadline = Date.now() + (hooks.maxWaitMs ?? 8 * 60_000);
  let verifyCode: string | undefined;
  let lastStatus: QrStatus | undefined;

  while (Date.now() < deadline) {
    let resp: QrStatusResp;
    try {
      resp = await client.getQrcodeStatus(qr.qrcode, verifyCode);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("timeout")) continue;
      await new Promise((r) => setTimeout(r, 1500));
      continue;
    }

    if (resp.status !== lastStatus) {
      await hooks.onStatus?.(resp.status, resp);
      lastStatus = resp.status;
    }

    switch (resp.status) {
      case "wait":
      case "scaned":
        await sleep(1000);
        break;
      case "scaned_but_redirect":
        if (resp.redirect_host) client.setBaseUrl(resp.redirect_host);
        await sleep(500);
        break;
      case "need_verifycode":
        if (!verifyCode) {
          if (!hooks.askVerifyCode) throw new Error("需要验证码，但没有提供输入回调");
          verifyCode = (await hooks.askVerifyCode()).trim();
        }
        await sleep(500);
        break;
      case "verify_code_blocked":
        throw new Error("验证码被拦截，请稍后重试");
      case "expired":
        throw new Error("二维码已过期");
      case "confirmed": {
        if (!resp.bot_token) throw new Error("confirmed 但没有 bot_token");
        const token: Token = {
          botToken: resp.bot_token,
          baseUrl: normalizeBase(resp.baseurl ?? client.getBaseUrl()),
          ilinkBotId: resp.ilink_bot_id ?? "",
          ilinkUserId: resp.ilink_user_id,
        };
        client.setBaseUrl(token.baseUrl);
        client.setToken(token.botToken);
        return token;
      }
      case "binded_redirect": {
        if (!resp.bot_token) throw new Error("binded_redirect 但没有 bot_token");
        const token: Token = {
          botToken: resp.bot_token,
          baseUrl: normalizeBase(resp.baseurl ?? client.getBaseUrl()),
          ilinkBotId: resp.ilink_bot_id ?? "",
          ilinkUserId: resp.ilink_user_id,
        };
        client.setBaseUrl(token.baseUrl);
        client.setToken(token.botToken);
        return token;
      }
    }
  }

  throw new Error("登录超时");
}

function normalizeBase(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  return withScheme.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
