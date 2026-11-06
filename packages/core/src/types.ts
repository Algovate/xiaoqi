export type AccountStatus = "active" | "expired" | "disabled";
export type MessageDirection = "in" | "out";
export type RunStatus = "queued" | "running" | "sending" | "sent" | "failed" | "dead";

export interface InboundRef {
  accountId: string;
  messageId: string;
  wxMessageId: string;
  conversationKey: string;
  senderId: string;
  text: string;
  contextToken?: string;
  createdAt: Date;
}

export interface OutboundSendInput {
  runId: string;
  chunkIndex: number;
  accountId: string;
  conversationKey: string;
  replyToMessageId: string;
  text: string;
}
