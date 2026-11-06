import { Queue } from "bullmq";
import type { Redis } from "ioredis";

export const DM_QUEUE = "dm.message";

export function createDmQueue(redis: Redis): Queue {
  return new Queue(DM_QUEUE, { connection: redis });
}
