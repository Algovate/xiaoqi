import crypto from "node:crypto";
import { Redis } from "ioredis";
import { eq, inArray } from "drizzle-orm";
import type { AppConfig, Database, Logger } from "@xiaoqi/core";
import { accounts, accountCursors, decryptSecret, inboundTotal, pollUp } from "@xiaoqi/core";
import { ILinkClient, ILinkError } from "@xiaoqi/ilink";
import { persistInboundBatch } from "./inbound.js";

const LOCK_TTL_MS = 45_000;
const LOCK_RENEW_MS = 15_000;

interface PollerDeps {
  config: AppConfig;
  db: Database;
  redis: Redis;
  logger: Logger;
}

interface RunningPoller {
  controller: AbortController;
  done: Promise<void>;
}

export class PollerManager {
  private readonly running = new Map<string, RunningPoller>();
  private readonly deps: PollerDeps;
  private refreshTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(deps: PollerDeps) {
    this.deps = deps;
  }

  start(): void {
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), 15_000);
    this.refreshTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    const controllers = [...this.running.values()].map((p) => p.controller);
    for (const c of controllers) c.abort();
    await Promise.allSettled([...this.running.values()].map((p) => p.done));
    this.running.clear();
  }

  private async refresh(): Promise<void> {
    if (this.stopped) return;
    const { db, logger } = this.deps;
    try {
      const active = await db
        .select()
        .from(accounts)
        .where(eq(accounts.status, "active"));
      for (const account of active) {
        if (this.running.has(account.id)) continue;
        if (!account.tokenEnc) continue;
        const controller = new AbortController();
        const done = this.runPoller(account.id, controller)
          .catch((err) => logger.error({ err, accountId: account.id }, "poller crashed"))
          .finally(() => this.running.delete(account.id));
        this.running.set(account.id, { controller, done });
      }

      const ids = [...this.running.keys()];
      if (ids.length > 0) {
        const stillActive = await db
          .select({ id: accounts.id })
          .from(accounts)
          .where(inArray(accounts.id, ids));
        const activeSet = new Set(stillActive.map((a) => a.id));
        for (const [id, poller] of this.running) {
          if (!activeSet.has(id)) {
            poller.controller.abort();
            this.running.delete(id);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, "poller refresh failed");
    }
  }

  private async runPoller(accountId: string, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const { config, db, redis, logger } = this.deps;
    const lockKey = `xiaoqi:lock:poll:${accountId}`;
    const lockValue = `${process.pid}:${crypto.randomUUID()}`;

    const acquired = await redis.set(lockKey, lockValue, "PX", LOCK_TTL_MS, "NX");
    if (acquired !== "OK") {
      logger.debug({ accountId }, "poller leader already held; standby");
      return;
    }

    const renew = setInterval(() => {
      void redis
        .eval(
          `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end`,
          1,
          lockKey,
          lockValue,
          LOCK_TTL_MS,
        )
        .then((ok) => {
          if (Number(ok) !== 1) {
            logger.warn({ accountId }, "poll leader lock lost; aborting");
            controller.abort();
          }
        })
        .catch((err) => logger.warn({ err, accountId }, "poll lock renew failed"));
    }, LOCK_RENEW_MS);
    renew.unref();

    try {
      const rows = await db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1);
      const account = rows[0];
      if (!account?.tokenEnc) return;

      const token = decryptSecret(account.tokenEnc, config.masterKey);
      const client = new ILinkClient({
        baseUrl: account.baseUrl,
        token,
        appId: config.ILINK_APP_ID,
        clientVersion: config.ILINK_APP_VERSION,
      });

      await client.notifyStart().catch((err) => logger.warn({ err }, "notifystart failed"));

      const cursorRows = await db
        .select()
        .from(accountCursors)
        .where(eq(accountCursors.accountId, accountId))
        .limit(1);
      let buf = cursorRows[0]?.buf ?? "";
      if (cursorRows.length === 0) {
        await db.insert(accountCursors).values({ accountId, buf: "" }).onConflictDoNothing();
      }

      let backoff = 1000;
      pollUp.set({ account: accountId }, 1);
      logger.info({ accountId }, "poller started");

      while (!signal.aborted) {
        let resp;
        try {
          resp = await client.getUpdates(buf);
        } catch (err) {
          if (err instanceof ILinkError && (err.errcode === -14 || err.httpStatus === 401)) {
            logger.error({ accountId, err: err.message }, "iLink session expired");
            await db
              .update(accounts)
              .set({ status: "expired", lastError: err.message, updatedAt: new Date() })
              .where(eq(accounts.id, accountId));
            return;
          }
          logger.warn({ accountId, err: err instanceof Error ? err.message : String(err) }, "getupdates failed");
          await sleep(backoff);
          backoff = Math.min(backoff * 2, 15_000);
          continue;
        }
        backoff = 1000;

        const nextBuf = resp.get_updates_buf ?? buf;
        const msgs = resp.msgs ?? [];

        try {
          const result = await persistInboundBatch(db, config, accountId, msgs, nextBuf);
          buf = nextBuf;
          await db
            .update(accounts)
            .set({ lastPollAt: new Date(), lastError: null })
            .where(eq(accounts.id, accountId));
          inboundTotal.inc({ result: "inserted" }, result.inserted);
          inboundTotal.inc({ result: "skipped" }, result.skipped);
          if (result.inserted > 0) {
            logger.info({ accountId, inserted: result.inserted, skipped: result.skipped }, "inbound persisted");
          }
        } catch (err) {
          inboundTotal.inc({ result: "error" });
          logger.error({ accountId, err }, "persist inbound failed; cursor not advanced");
          await sleep(2000);
          continue;
        }

        if (msgs.length === 0) await sleep(300);
      }
    } finally {
      pollUp.set({ account: accountId }, 0);
      clearInterval(renew);
      await redis
        .eval(
          `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
          1,
          lockKey,
          lockValue,
        )
        .catch(() => undefined);
      logger.info({ accountId }, "poller stopped");
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
