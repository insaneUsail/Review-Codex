# Review-Codex

**AI-powered GitHub App that automatically reviews pull requests** — flags critical issues, posts inline feedback, and can block merges until problems are resolved.

Review-Codex listens for GitHub webhook events, queues each PR for analysis, runs the diff through an LLM (Groq/Llama), and posts structured review comments back on the PR — with the option to fail a GitHub Check Run on CRITICAL findings so merges are blocked automatically.

🔗 **Install it directly:** [github.com/apps/review-codex](https://github.com/apps/review-codex)

---

## Features

- 🔍 **Automated PR analysis** — triggers on every PR open/update
- 🛡️ **HMAC-verified webhooks** — rejects unsigned/tampered payloads
- ⚡ **Async processing** — Redis + BullMQ queue so webhook responses stay fast
- 🚦 **Rate limiting** — Redis-backed, prevents API abuse
- 🧠 **LLM-powered review** — uses Groq-hosted Llama models to analyze diffs
- ✅ **Merge gating** — GitHub Check Runs API blocks merges on CRITICAL severity findings
- 🔁 **Process management** — runs under PM2 for auto-restart and uptime

---

## Architecture

```
GitHub PR Event
      │
      ▼
Webhook Endpoint (Express) ──► HMAC Signature Verification
      │
      ▼
Redis Rate Limiter
      │
      ▼
BullMQ Job Queue ──► Worker Process
                          │
                          ▼
                  Fetch PR Diff (GitHub API)
                          │
                          ▼
                  Groq LLM Analysis
                          │
                          ▼
              Post PR Comments + Check Run
                          │
                          ▼
              Block/Allow Merge (based on severity)
```

---

## Tech Stack

Express.js · Redis · BullMQ · Groq API (Llama) · GitHub Webhooks & Check Runs API · PM2

---

## Using Review-Codex on your repo (no setup required)

If you just want to use Review-Codex on your own repositories, you don't need to run any of this code yourself:

1. Install the app: [github.com/apps/review-codex](https://github.com/apps/review-codex)
2. Choose which repos to grant access to
3. Open a PR — Review-Codex reviews it automatically within seconds
4. (Recommended) Add **Review-Codex** as a required status check under **Settings → Branches → Branch protection rules** on your repo, so CRITICAL findings actually block merges

The rest of this README is for anyone who wants to **self-host or contribute to** Review-Codex itself.

---

## Self-hosting: Prerequisites

- **Node.js** v18 or higher
- **Redis** instance (local or hosted, e.g. Upstash, Redis Cloud)
- **A GitHub account** with permission to create a GitHub App on your target org/repo
- **A Groq API key** ([console.groq.com](https://console.groq.com))
- A server or VM to host the app (Azure, Railway, Render, etc.)

---

## 1. Create your own GitHub App

1. Go to **GitHub Settings → Developer settings → GitHub Apps → New GitHub App**
2. Fill in the basics:
   - **GitHub App name**: your own unique name
   - **Homepage URL**: your repo URL
   - **Webhook URL**: `https://<your-domain>/webhook` (must be publicly reachable)
   - **Webhook secret**: generate a strong random string — you'll need this as `GITHUB_WEBHOOK_SECRET`
3. **Permissions**:
   | Permission | Access |
   |---|---|
   | Pull requests | Read & write |
   | Checks | Read & write |
   | Contents | Read-only |
   | Metadata | Read-only |
4. **Subscribe to events**: `Pull request`, `Pull request review`, `Check run` (optional)
5. Click **Create GitHub App**
6. Note the **App ID** and generate/download a **Private Key** (`.pem` file)
7. **Install the app** on the repo(s) or org you want it to monitor

---

## 2. Clone and configure

```bash
git clone https://github.com/insaneUsail/review-codex.git
cd review-codex
npm install
```

Create a `.env` file in the project root:

```env
# GitHub App credentials
GITHUB_APP_ID=your_app_id
GITHUB_PRIVATE_KEY_PATH=./keys/private-key.pem
GITHUB_WEBHOOK_SECRET=your_webhook_secret

# Groq API
GROQ_API_KEY=your_groq_api_key
GROQ_MODEL=llama-3.3-70b-versatile

# Redis
REDIS_URL=redis://localhost:6379

# Server
PORT=3000
NODE_ENV=production

# Review behavior
BLOCK_MERGE_ON_CRITICAL=true
```

Place your downloaded private key at the path referenced in `GITHUB_PRIVATE_KEY_PATH`.

---

## 3. Run locally

Start Redis (if running locally):

```bash
redis-server
```

Start the webhook server:

```bash
npm run dev
```

Start the worker (in a separate terminal):

```bash
npm run worker
```

To test locally before deploying, expose your local server with a tunnel (e.g. `ngrok http 3000`) and point the GitHub App's Webhook URL to the generated `https://<id>.ngrok.io/webhook` URL temporarily.

---

## 4. Deploy to production

Example using PM2 on a VM:

```bash
npm install -g pm2
pm2 start src/server.js --name review-codex-server
pm2 start src/worker.js --name review-codex-worker
pm2 save
pm2 startup
```

Update your GitHub App's **Webhook URL** to your production domain.

---

## Troubleshooting

| Issue | Likely cause |
|---|---|
| Webhook not firing | Webhook URL unreachable, or wrong secret in `.env` |
| 401/signature errors | `GITHUB_WEBHOOK_SECRET` mismatch |
| Jobs stuck in queue | Redis not running or `REDIS_URL` misconfigured |
| No comments posted | Check GitHub App permissions include Pull requests: Read & write |
| Check run not blocking merge | Confirm `BLOCK_MERGE_ON_CRITICAL=true` and branch protection requires this check |

---

## Contributing

Issues and PRs are welcome. If you're proposing a larger change (new LLM provider, different queue system, etc.), open an issue first to discuss the approach.

---

## License

[MIT](LICENSE)
