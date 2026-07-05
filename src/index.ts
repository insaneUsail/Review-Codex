import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import parseDiff from "parse-diff";

import { ghApp } from "./config/github";
import { redisConnection } from "./config/redis";
import { chunkDiff } from "./services/chunker";
import { reviewQueue } from "./queues/reviewQueue";
import "./workers/reviewWorker"; // side-effect import: starts the worker in this same process

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const MAX_DIFF_SIZE_BYTES = parseInt(process.env.MAX_DIFF_SIZE_BYTES || "102400", 10);
const MAX_REVIEWS_PER_HOUR = parseInt(process.env.MAX_REVIEWS_PER_HOUR || "10", 10);
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET!;

/**
 * GitHub signs every webhook payload with HMAC-SHA256 using your app's webhook
 * secret. Verifying this BEFORE trusting the payload is what stops anyone who
 * finds your webhook URL from forging a fake "PR opened" event and getting
 * PRSentinel to run against arbitrary content, or from spoofing installation
 * IDs to make calls against repos they don't control.
 *
 * We need the raw request body (not the parsed JSON) to compute the signature
 * correctly, since re-serializing parsed JSON can produce different bytes than
 * what GitHub actually signed. Hence express.raw() below instead of express.json().
 */
function verifySignature(req: express.Request): boolean {
  const signature = req.headers["x-hub-signature-256"] as string | undefined;
  if (!signature) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", WEBHOOK_SECRET).update(req.body).digest("hex");

  // timingSafeEqual prevents leaking info about how much of the signature
  // matched via response-time differences (a timing side-channel attack)
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!verifySignature(req)) {
      console.warn("⚠️ Rejected webhook: invalid signature");
      return res.status(401).send("Invalid signature");
    }

    const event = req.headers["x-github-event"];
    const payload = JSON.parse(req.body.toString());

    // Ack immediately for anything we don't care about, so GitHub doesn't retry it
    if (event !== "pull_request" || !["opened", "synchronize"].includes(payload.action)) {
      return res.status(200).send("Ignored");
    }

    const { installation, pull_request, repository } = payload;
    const owner = repository.owner.login;
    const repo = repository.name;
    const pullNumber = pull_request.number;
    const headSha = pull_request.head.sha;

    try {
      const octokit = await ghApp.getInstallationOctokit(installation.id);

      // --- Rate limit: cap reviews per repo per hour to protect API costs ---
      const rateLimitKey = `rate-limit:${repository.id}`;
      const currentUsage = await redisConnection.incr(rateLimitKey);
      if (currentUsage === 1) await redisConnection.expire(rateLimitKey, 3600);

      if (currentUsage > MAX_REVIEWS_PER_HOUR) {
        console.warn(`🚫 Rate limit hit for ${owner}/${repo}`);
        return res.status(429).send("Rate limit exceeded");
      }

      // --- Fetch the diff ---
      const { data: diff } = (await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}",
        { owner, repo, pull_number: pullNumber, mediaType: { format: "diff" } }
      )) as unknown as { data: string };

      if (diff.length > MAX_DIFF_SIZE_BYTES) {
        console.warn(`⚠️ Diff too large for PR #${pullNumber} (${diff.length} bytes)`);
        return res.status(200).send("Diff too large, skipped");
      }

      // --- Chunk and enqueue ---
      const files = parseDiff(diff);
      const chunks = chunkDiff(files);

      for (let i = 0; i < chunks.length; i++) {
        await reviewQueue.add("review-chunk", {
          chunkContent: chunks[i].content,
          filePaths: chunks[i].filePaths,
          installationId: installation.id,
          owner,
          repo,
          pullNumber,
          headSha,
          chunkIndex: i,
          totalChunks: chunks.length,
        });
      }

      console.log(`🚀 Queued ${chunks.length} chunk(s) for PR #${pullNumber} in ${owner}/${repo}`);
      return res.status(200).send("Queued");
    } catch (error) {
      console.error("❌ Error handling webhook:", error);
      return res.status(500).send("Internal error");
    }
  }
);

app.listen(PORT, () => console.log(`🚀 PRSentinel running on port ${PORT}`));
