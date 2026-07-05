import { App } from "octokit";
import dotenv from "dotenv";
dotenv.config()

const privateKey = process.env.GITHUB_PRIVATE_KEY;
if (!privateKey) {
  throw new Error("GITHUB_PRIVATE_KEY is missing from environment variables");
}

/**
 * A GitHub App (not a personal access token) is the right auth model here because:
 * - it can be installed on specific repos by other people, not just your own account
 * - it gets its own scoped installation token per repo, auto-rotated, instead of a
 *   long-lived PAT tied to your personal account
 */
export const ghApp = new App({
  appId: process.env.GITHUB_APP_ID!,
  privateKey,
});
