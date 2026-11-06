import crypto from "node:crypto";
import { parseJsonPreserveBigInts } from "./parse.js";
import type {
  GetUpdatesResp,
  ILinkClientOptions,
  LoginQr,
  QrStatusResp,
  SendTextInput,
} from "./types.js";
import { MessageState, MessageType } from "./types.js";

export class ILinkError extends Error {
  constructor(
    readonly op: string,
    readonly ret: number,
    readonly errcode: number,
    message: string,
    readonly httpStatus: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ILinkError";
  }
}

export class ILinkClient {
  private baseUrl: string;
  private token?: string;
  private readonly appId: string;
  private readonly clientVersion: string;
  private readonly timeoutMs: number;
  private readonly longPollTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ILinkClientOptions) {
    this.baseUrl = normalizeBase(options.baseUrl);
    this.token = options.token;
    this.appId = options.appId ?? "bot";
    this.clientVersion = options.clientVersion ?? "132106";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.longPollTimeoutMs = options.longPollTimeoutMs ?? 35_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  getToken(): string | undefined {
    return this.token;
  }

  setBaseUrl(baseUrl: string): void {
    this.baseUrl = normalizeBase(baseUrl);
  }

  setToken(token: string | undefined): void {
    this.token = token;
  }

  async getBotQrcode(botType = "3", localTokenList: string[] = []): Promise<LoginQr> {
    return this.request<LoginQr>(`/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, {
      method: "POST",
      body: { local_token_list: localTokenList },
      timeoutMs: 15_000,
      label: "get_bot_qrcode",
    });
  }

  async getQrcodeStatus(qrcode: string, verifyCode?: string): Promise<QrStatusResp> {
    const qs = new URLSearchParams({ qrcode });
    if (verifyCode) qs.set("verify_code", verifyCode);
    return this.request<QrStatusResp>(`/ilink/bot/get_qrcode_status?${qs.toString()}`, {
      method: "GET",
      timeoutMs: 40_000,
      label: "get_qrcode_status",
    });
  }

  async getUpdates(buf: string): Promise<GetUpdatesResp> {
    return this.request<GetUpdatesResp>("/ilink/bot/getupdates", {
      method: "POST",
      body: { get_updates_buf: buf, base_info: this.baseInfo() },
      timeoutMs: this.longPollTimeoutMs + 10_000,
      label: "getupdates",
    });
  }

  async sendText(input: SendTextInput): Promise<Record<string, unknown>> {
    const clientId = input.clientId ?? `xiaoqi-${crypto.randomUUID()}`;
    const resp = await this.request<Record<string, unknown>>("/ilink/bot/sendmessage", {
      method: "POST",
      body: {
        msg: {
          from_user_id: "",
          to_user_id: input.toUserId,
          client_id: clientId,
          message_type: MessageType.BOT,
          message_state: MessageState.FINISH,
          context_token: input.contextToken,
          item_list: [{ type: 1, text_item: { text: input.text } }],
        },
      },
      timeoutMs: 20_000,
      label: "sendmessage",
    });
    const ret = Number(resp.ret ?? 0);
    if (ret !== 0) {
      throw new ILinkError("sendmessage", ret, Number(resp.errcode ?? 0), String(resp.errmsg ?? ""), 200, false);
    }
    return resp;
  }

  async getConfig(ilinkUserId: string, contextToken: string): Promise<{ typing_ticket?: string }> {
    return this.request("/ilink/bot/getconfig", {
      method: "POST",
      body: { ilink_user_id: ilinkUserId, context_token: contextToken, base_info: this.baseInfo() },
      timeoutMs: 10_000,
      label: "getconfig",
    });
  }

  async sendTyping(ilinkUserId: string, typingTicket: string, on: boolean): Promise<void> {
    await this.request("/ilink/bot/sendtyping", {
      method: "POST",
      body: {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status: on ? 1 : 2,
        base_info: this.baseInfo(),
      },
      timeoutMs: 5_000,
      label: "sendtyping",
    });
  }

  async notifyStart(): Promise<void> {
    await this.request("/ilink/bot/msg/notifystart", {
      method: "POST",
      body: { base_info: this.baseInfo() },
      timeoutMs: 5_000,
      label: "notifystart",
    });
  }

  async notifyStop(): Promise<void> {
    await this.request("/ilink/bot/msg/notifystop", {
      method: "POST",
      body: { base_info: this.baseInfo() },
      timeoutMs: 5_000,
      label: "notifystop",
    });
  }

  private baseInfo(): Record<string, string> {
    return { channel_version: "0.1.0", bot_agent: "Xiaoqi/0.1" };
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      AuthorizationType: "ilink_bot_token",
      "X-WECHAT-UIN": randomUin(),
      "iLink-App-Id": this.appId,
      "iLink-App-ClientVersion": this.clientVersion,
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return headers;
  }

  private async request<T>(
    path: string,
    opts: {
      method: "GET" | "POST";
      body?: unknown;
      timeoutMs: number;
      label: string;
    },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/${path.replace(/^\/+/, "")}`, {
        method: opts.method,
        headers: this.headers(),
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? parseJsonPreserveBigInts(text) : {};
      } catch {
        throw new ILinkError(opts.label, 0, 0, `non-JSON response: ${snippet(text)}`, res.status, false);
      }
      const obj = json as Record<string, unknown>;
      const ret = Number(obj.ret ?? 0);
      const errcode = Number(obj.errcode ?? 0);
      if (!res.ok || ret !== 0 || errcode !== 0) {
        const retryable = res.status >= 500 || res.status === 429 || ret === -1;
        throw new ILinkError(
          opts.label,
          ret,
          errcode,
          `iLink ${opts.label} http=${res.status} ret=${ret} errcode=${errcode} errmsg=${String(obj.errmsg ?? "")}`,
          res.status,
          retryable,
        );
      }
      return obj as T;
    } catch (err) {
      if (err instanceof ILinkError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new ILinkError(opts.label, 0, 0, `iLink ${opts.label} timeout (${opts.timeoutMs}ms)`, 0, true);
      }
      throw new ILinkError(opts.label, 0, 0, err instanceof Error ? err.message : String(err), 0, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeBase(input: string): string {
  const withScheme = /^https?:\/\//i.test(input) ? input : `https://${input}`;
  return withScheme.replace(/\/+$/, "");
}

function randomUin(): string {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32LE(0)), "utf8").toString("base64");
}

function snippet(text: string): string {
  return text
    .replace(/("?(?:bot_token|context_token|aes_key|authorization)"?\s*:\s*")([^"]+)/gi, "$1***")
    .slice(0, 300);
}
