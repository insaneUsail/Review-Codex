import type { Octokit } from "octokit";
import type { ReviewFinding } from "./groq";

interface CheckRunParams {
  octokit: Octokit;
  owner: string;
  repo: string;
  headSha: string;
  findings: ReviewFinding[];
}

const BLOCK_ON_CRITICAL = process.env.BLOCK_MERGE_ON_CRITICAL !== "false";

/**
 * Creates a GitHub Check Run against the PR's head commit.
 *
 * This is the piece that makes PRSentinel more than an advisory linter: a
 * Check Run with conclusion "failure" shows up as a required-status failure
 * in the PR's merge box. If the repo has branch protection set to require
 * this check, GitHub will grey out the merge button until it's addressed —
 * a plain PR comment can never do that, it's purely advisory.
 *
 * Design choice: only CRITICAL findings fail the check. MEDIUM/LOW still get
 * surfaced as inline comments (posted separately) but don't block merging —
 * otherwise every minor style nit would halt shipping, which teams would
 * just disable the check to work around, defeating the point.
 */
export async function createCheckRun({ octokit, owner, repo, headSha, findings }: CheckRunParams) {
  const criticalCount = findings.filter((f) => f.severity === "CRITICAL").length;
  const mediumCount = findings.filter((f) => f.severity === "MEDIUM").length;
  const lowCount = findings.filter((f) => f.severity === "LOW").length;

  const shouldBlock = BLOCK_ON_CRITICAL && criticalCount > 0;

  await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
    owner,
    repo,
    name: "PRSentinel Review",
    head_sha: headSha,
    status: "completed",
    conclusion: shouldBlock ? "failure" : "success",
    output: {
      title: shouldBlock
        ? `${criticalCount} critical issue(s) must be resolved`
        : "No critical issues found",
      summary:
        `| Severity | Count |\n` +
        `|---|---|\n` +
        `| 🔴 Critical | ${criticalCount} |\n` +
        `| 🟡 Medium | ${mediumCount} |\n` +
        `| 🔵 Low | ${lowCount} |\n\n` +
        (shouldBlock
          ? "Critical findings block merge while this check is required in branch protection. See inline comments for details."
          : "Nothing blocking. See inline comments for any medium/low suggestions."),
    },
  });
}
