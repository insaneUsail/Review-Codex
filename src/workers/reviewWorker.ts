import { Worker } from "bullmq";
import fs from "fs";
import path from "path";
import { redisConnection } from "../config/redis";
import { ghApp } from "../config/github";
import { reviewChunk, type ReviewFinding } from "../services/groq";
import { createCheckRun } from "../services/checkRun";
import type { ReviewJobData } from "../queues/reviewQueue";

function redisKeyPrefix(owner: string, repo: string, pullNumber: number, headSha: string) {
  return `pr-review:${owner}:${repo}:${pullNumber}:${headSha}`;
}

const REPORT_PATH = path.join(process.cwd(), "review-report.md");

/**
 * Overwrites a single local report file with the latest review's findings.
 * Simpler than scrolling terminal logs — just open review-report.md after
 * every push to see the current state of the PR's review.
 */
function writeReportFile(owner: string, repo: string, pullNumber: number, findings: ReviewFinding[]) {
  const timestamp = new Date().toISOString();
  let content = `# PRSentinel Review Report\n\n`;
  content += `**Repo:** ${owner}/${repo}  \n**PR:** #${pullNumber}  \n**Generated:** ${timestamp}\n\n---\n\n`;

  if (findings.length === 0) {
    content += `✅ No issues found.\n`;
  } else {
    const critical = findings.filter((f) => f.severity === "CRITICAL");
    const medium = findings.filter((f) => f.severity === "MEDIUM");
    const low = findings.filter((f) => f.severity === "LOW");

    content += `| Severity | Count |\n|---|---|\n`;
    content += `| 🔴 Critical | ${critical.length} |\n| 🟡 Medium | ${medium.length} |\n| 🔵 Low | ${low.length} |\n\n---\n\n`;

    for (const f of [...critical, ...medium, ...low]) {
      const icon = f.severity === "CRITICAL" ? "🔴" : f.severity === "MEDIUM" ? "🟡" : "🔵";
      const lineRef = f.endLine && f.endLine > f.line ? `${f.line}-${f.endLine}` : `${f.line}`;
      content += `### ${icon} [${f.severity}] \`${f.file}\`:${lineRef}\n${f.comment}\n\n`;
    }
  }

  fs.writeFileSync(REPORT_PATH, content, "utf-8");
  console.log(`📄 Report written to ${REPORT_PATH}`);
}

export const reviewWorker = new Worker<ReviewJobData>(
  "pr-review",
  async (job) => {
    const { chunkContent, installationId, owner, repo, pullNumber, headSha, totalChunks } = job.data;

    const findings = await reviewChunk(chunkContent);
    const keyPrefix = redisKeyPrefix(owner, repo, pullNumber, headSha);

    if (findings.length > 0) {
      await redisConnection.rpush(`${keyPrefix}:findings`, JSON.stringify(findings));
    }
    const completed = await redisConnection.incr(`${keyPrefix}:completed`);

    if (completed === 1) {
      await redisConnection.expire(`${keyPrefix}:completed`, 3600);
      await redisConnection.expire(`${keyPrefix}:findings`, 3600);
    }

    if (completed < totalChunks) {
      return;
    }

    const rawFindings = await redisConnection.lrange(`${keyPrefix}:findings`, 0, -1);
    const allFindings: ReviewFinding[] = rawFindings.flatMap((r) => JSON.parse(r));

    const octokit = await ghApp.getInstallationOctokit(installationId);

    writeReportFile(owner, repo, pullNumber, allFindings);

    if (allFindings.length > 0) {
      console.log(`\n📋 Review results for PR #${pullNumber} in ${owner}/${repo}:\n`);
      for (const f of allFindings) {
        const icon = f.severity === "CRITICAL" ? "🔴" : f.severity === "MEDIUM" ? "🟡" : "🔵";
        console.log(`${icon} [${f.severity}] ${f.file}:${f.line}${f.endLine && f.endLine > f.line ? `-${f.endLine}` : ""}`);
        console.log(`   ${f.comment}\n`);
      }
    } else {
      console.log(`\n✅ No issues found for PR #${pullNumber} in ${owner}/${repo}\n`);
    }

    if (allFindings.length > 0) {
      await octokit.request("POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews", {
        owner,
        repo,
        pull_number: pullNumber,
        event: "COMMENT",
        comments: allFindings.map((f) => {
          const icon = f.severity === "CRITICAL" ? "🔴" : f.severity === "MEDIUM" ? "🟡" : "🔵";
          return {
            path: f.file,
            line: f.endLine && f.endLine > f.line ? f.endLine : f.line,
            ...(f.endLine && f.endLine > f.line ? { start_line: f.line, start_side: "RIGHT" as const } : {}),
            side: "RIGHT" as const,
            body: `${icon} **${f.severity}**: ${f.comment}`,
          };
        }),
      });
    }

    await createCheckRun({ octokit, owner, repo, headSha, findings: allFindings });

    await redisConnection.del(`${keyPrefix}:findings`, `${keyPrefix}:completed`);

    console.log(
      `✅ PR #${pullNumber} in ${owner}/${repo}: ${allFindings.length} finding(s) across ${totalChunks} chunk(s)`
    );
  },
  { connection: redisConnection, concurrency: 5 }
);

reviewWorker.on("failed", (job, err) => {
  console.error(`❌ Job ${job?.id} failed:`, err.message);
});