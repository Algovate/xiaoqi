import crypto from "node:crypto";
import readline from "node:readline/promises";
import process from "node:process";
import { eq } from "drizzle-orm";
import { accounts, accountCursors, encryptSecret } from "@xiaoqi/core";
import { ILinkClient, loginFlow } from "@xiaoqi/ilink";
import { createGatewayContext } from "./context.js";

async function main() {
  const ctx = createGatewayContext();
  const { db } = ctx.dbHandle;
  const { config, logger } = ctx;
  let rl: readline.Interface | undefined;

  try {
    const existing = await db.select().from(accounts).limit(1);
    let account = existing[0];

    if (!account) {
      const inserted = await db
        .insert(accounts)
        .values({
          ilinkBotId: `pending:${crypto.randomUUID()}`,
          displayName: "小栖",
          baseUrl: config.ILINK_BASE_URL,
          status: "disabled",
        })
        .returning();
      account = inserted[0]!;
      logger.info({ accountId: account.id }, "created pending account");
    }

    const client = new ILinkClient({
      baseUrl: account.baseUrl || config.ILINK_BASE_URL,
      appId: config.ILINK_APP_ID,
      clientVersion: config.ILINK_APP_VERSION,
    });

    const token = await loginFlow(client, {
      onQr: async (qr) => {
        console.log("");
        console.log("扫码内容：", qr.qrcode);
        if (qr.qrcode_img_content) console.log("二维码 URL：", qr.qrcode_img_content);
        console.log("用手机微信扫码并确认；等待中…");
        console.log("");
      },
      onStatus: (status) => {
        console.log(`登录状态：${status}`);
      },
      askVerifyCode: async () => {
        rl ??= readline.createInterface({ input: process.stdin, output: process.stdout });
        return rl.question("需要验证码，请输入：");
      },
    });

    const tokenEnc = encryptSecret(token.botToken, config.masterKey, "v1");
    await db
      .update(accounts)
      .set({
        ilinkBotId: token.ilinkBotId || account.ilinkBotId,
        tokenEnc,
        tokenKid: "v1",
        baseUrl: token.baseUrl,
        status: "active",
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(accounts.id, account.id));

    await db
      .insert(accountCursors)
      .values({ accountId: account.id, buf: "" })
      .onConflictDoNothing();

    logger.info({ accountId: account.id, botId: token.ilinkBotId }, "iLink login saved");
    console.log("");
    console.log("登录成功，token 已加密保存。");
    console.log("下一步：pnpm dev:worker 和 pnpm dev:gateway，然后私聊 bot。");
  } finally {
    rl?.close();
    await ctx.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
