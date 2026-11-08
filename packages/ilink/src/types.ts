export const MessageType = { USER: 1, BOT: 2 } as const;
export const MessageState = { FINISH: 2 } as const;
export const ItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
export const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;

export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
  full_url?: string;
}

export interface MessageItem {
  type?: number;
  create_time_ms?: number;
  update_time_ms?: number;
  is_completed?: boolean;
  msg_id?: string;
  ref_msg?: {
    message_item?: MessageItem;
    title?: string;
    svr_id?: string;
  };
  text_item?: { text?: string };
  image_item?: {
    media?: CDNMedia;
    thumb_media?: CDNMedia;
    aeskey?: string;
    full_url?: string;
    mid_size?: number;
  };
  voice_item?: { media?: CDNMedia; text?: string; encode_type?: number };
  file_item?: { media?: CDNMedia; file_name?: string; len?: string };
  video_item?: { media?: CDNMedia };
  at_bot_username_list?: string[];
}

export interface WeixinMessage {
  seq?: number;
  message_id?: string | number;
  from_user_id?: string;
  to_user_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  context_token?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  item_list?: MessageItem[];
  client_id?: string;
  at_bot_username_list?: string[];
}

export interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface LoginQr {
  qrcode: string;
  qrcode_img_content?: string;
}

export type QrStatus =
  | "wait"
  | "scaned"
  | "confirmed"
  | "expired"
  | "scaned_but_redirect"
  | "need_verifycode"
  | "verify_code_blocked"
  | "binded_redirect";

export interface QrStatusResp {
  status: QrStatus;
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
  redirect_host?: string;
}

export interface Token {
  botToken: string;
  baseUrl: string;
  ilinkBotId: string;
  ilinkUserId?: string;
}

export interface ILinkClientOptions {
  baseUrl: string;
  token?: string;
  appId?: string;
  clientVersion?: string;
  timeoutMs?: number;
  longPollTimeoutMs?: number;
  cdnBaseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface SendTextInput {
  toUserId: string;
  contextToken: string;
  text: string;
  clientId?: string;
}

export interface GetUploadUrlInput {
  toUserId: string;
  contextToken: string;
  mediaType: number;
  filekey: string;
  rawSize: number;
  rawFileMd5: string;
  fileSize: number;
  aesKeyHex: string;
  noNeedThumb?: boolean;
}

export interface GetUploadUrlResp {
  upload_param?: string;
  upload_full_url?: string;
  thumb_upload_param?: string;
  thumb_upload_full_url?: string;
}

export interface SendImageInput {
  toUserId: string;
  contextToken: string;
  data: Buffer;
  mime: string;
  clientId?: string;
}
