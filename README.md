IssueWatcher — Smart GitHub Issue Notifier (MCP Powered)

IssueWatcher is an automation tool that monitors your starred GitHub repositories, detects new issues, and sends you AI-powered summaries + proposed fixes directly to your inbox.
Built using Model Context Protocol (MCP), it acts like your personal GitHub assistant.

✅ Features

🔍 Automatic GitHub Issue Scanning
Fetches new issues from all repositories you have starred.

🤖 LLM-Powered Summaries
Uses an LLM to summarise each issue in simple language.

🧠 Smart Fix Suggestions
Generates potential fixes/approach ideas for each issue.

✉️ Email Notifications
Sends nicely formatted emails whenever a new issue appears.

🪄 MCP Tooling
Everything runs through MCP servers + tools for modular automation.

🏗 Tech Stack
Core

Node.js (server + scheduler)

MCP (Model Context Protocol)

GitHub REST API

Email Service (Nodemailer)

AI

Any MCP-compatible LLM (OpenAI, Anthropic, etc.)

Custom prompt templates for summaries + fixes

📦 Installation
git clone https://github.com/mac146/IssueWatcher
cd issuewatcher
npm install

🔧 Configuration

Create a .env file:

GITHUB_TOKEN=your_github_pat
EMAIL_HOST=smtp.example.com
EMAIL_USER=your_email@example.com
EMAIL_PASS=your_password
LLM_API_KEY=your_llm_key
WATCH_INTERVAL=300000


WATCH_INTERVAL is milliseconds (default 5 min).

▶️ Running IssueWatcher

Start the MCP server:

node --loader ts-node/esm src/index.ts


📬 What the Emails Look Like

Subject: New Issue in {repo}: {issue title}
Body Includes:

✅ Issue summary (LLM generated)

🔧 Steps or fix idea

🔗 Direct link to GitHub issue


🤝 Contributing

Pull requests are welcome!
If you want to add more sources (Reddit, HackerNews, JIRA), open an issue.

⭐ Support the Project

If IssueWatcher helped you, give the repo a star — it motivates me to add more features!