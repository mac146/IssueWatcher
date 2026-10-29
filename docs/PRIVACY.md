# Privacy

IssueWatcher's MCP server runs on your computer. This page says exactly what it does with your data.

**What it reads.** With your GitHub token it reads: the list of repositories you starred; the names and `package.json` / `requirements.txt` files of your own recently pushed repositories (to find the libraries you use); and the public titles, labels, dates and counts of issues in the repositories it watches. Issue bodies are fetched only to score them and are not sent to your AI app unless you ask for an excerpt.

**Who it talks to.**
- `api.github.com`, using your token.
- `registry.npmjs.org` and `pypi.org`, to look up where a library's source code lives. Only package names are sent.
- Your AI app, over a local connection: it receives titles, labels, scores, reasons and links.

**What it stores.** One small cache file (`dependencies.json`) in `~/.issuewatcher`, listing the libraries found in your repositories, kept for 24 hours. Delete the folder at any time. In Claude Desktop, the token is kept in your system keychain; elsewhere it is whatever you configure in your app.

**What it does not do.** No telemetry, no analytics, no accounts, no data sent to the author or to any third party. It never writes to GitHub. The token is never logged and never appears in tool output.

**Your AI app's own terms apply** to what you and your assistant discuss, including the issue titles it shows you.

Questions or concerns: [open an issue](https://github.com/mac146/IssueWatcher/issues).
