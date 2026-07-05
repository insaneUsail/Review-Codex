import { Queue } from "bullmq";
import { redisConnection } from "../config/redis";

export interface ReviewJobData {
  chunkContent: string;
  filePaths: string[];
  installationId: number;
  owner: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  chunkIndex: number;
  totalChunks: number;
}

export const reviewQueue = new Queue<ReviewJobData>("pr-review", {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: true,
    removeOnFail: { count: 50 },
  },
});
