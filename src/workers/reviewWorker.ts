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

// Set PROJECTS_ROOT once in .env to the parent folder containing all your local
// project folders, e.g. E:\DEVELOPMENT. As long as each local folder name matches
// its GitHub repo name (CollabDraw, game, etc.), the report lands in the right
// project automatically for any repo you install this app on — no per-project
// config needed.
function resolveReportPath(repo: string): string {
  if (process.env.PROJECTS_ROOT) {
    return path.join(process.env.PROJECTS_ROOT, repo, "review-report.md");
  }
  return path.join(process.cwd(), "review-report.md");
}

function writeReportFile(owner: string, repo: string, pullNumber: number, findings: ReviewFinding[]) {
  const reportPath = resolveReportPath(repo);
  const reportDir = path.dirname(reportPath);

  if (!fs.existsSync(reportDir)) {
    console.warn(`⚠️ Report folder not found (${reportDir}) — check PROJECTS_ROOT and repo name match. Skipping local report write.`);
    return;
  }

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

  fs.writeFileSync(reportPath, content, "utf-8");
  console.log(`📄 Report written to ${reportPath}`);
}

export const reviewWorker = new Worker<ReviewJobData>(
  "pr-review",
  async (job) => {
    const { chunkContent, installationId, owner, repo, pullNumber, headSha, totalChunks } = job.data;

    const findings = await reviewChunk(chunkContent);