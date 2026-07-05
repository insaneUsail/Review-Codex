import { Redis } from "ioredis";
import dotenv from "dotenv";
dotenv.config();

/**
 * Single shared Redis connection, reused by both the queue (producer, in index.ts)
 * and the worker (consumer, in workers/reviewWorker.ts).
 *
 * maxRetriesPerRequest: null  -> required by BullMQ; it manages its own retry/backoff
 * logic and doesn't want ioredis silently giving up on a command mid-job.
 */
export const redisConnection = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379", 10),
  password: process.env.REDIS_PASSWORD || undefined,
  tls: process.env.REDIS_TLS === "true" ? {} : undefined,
  maxRetriesPerRequest: null,
});
