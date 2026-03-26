# IssueWatcher

IssueWatcher is a service that monitors your starred GitHub repositories, detects new issues, and delivers concise AI summaries with potential fixes to your inbox.

## What it does
- Scans issues from repos you have starred
- Summarizes each issue in simple language
- Suggests possible fixes
- Emails a clean summary + link

## Tech used
- Node.js + TypeScript
- MCP (Model Context Protocol)
- GitHub REST API
- Nodemailer
- LLM providers supported by MCP

## Folder layout
- `mcp-server/` - backend service and scheduler

## Setup
Clone the repo:
```bash
git clone https://github.com/mac146/IssueWatcher
cd IssueWatcher
```

Install dependencies:
```bash
cd mcp-server
npm install
```

## Environment variables
Create a `.env` file inside `mcp-server/`:
```env
GITHUB_TOKEN=your_github_pat
EMAIL_HOST=smtp.example.com
EMAIL_USER=your_email@example.com
EMAIL_PASS=your_password
LLM_API_KEY=your_llm_key
WATCH_INTERVAL=300000
```

`WATCH_INTERVAL` is in milliseconds (default is 5 minutes).

## Commands
Run in `mcp-server/`:

Start dev server (hot reload):
```bash
npm run dev
```

Build TypeScript:
```bash
npm run build
```

Start production build:
```bash
npm run start
```

Lint:
```bash
npm run lint
```

Format:
```bash
npm run format
```

## Example email
Subject: `New Issue in {repo}: {issue title}`

Body includes:
- Issue summary (AI generated)
- Fix suggestion
- Direct GitHub issue link

## Notes
- Extendable to additional sources (Reddit, HackerNews, Jira).
