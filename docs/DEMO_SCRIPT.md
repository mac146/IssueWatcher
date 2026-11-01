# Demo recording script

A shot list for the walkthrough video / GIF. Target: a **45-second main demo** for the top of the README and social posts, plus a **3-minute full walkthrough** (token, install, usage) for people who want every step.

## Before you record

- [ ] Use a **throwaway token** (fine-grained, read-only, 1 day expiry) and **revoke it right after**. Never show a real token on screen; blur the token field when you paste it.
- [ ] Use a clean terminal and a clean AI-app window. Large font (at least 18 pt) so it reads on a phone.
- [ ] Run `npx -y issuewatcher-mcp --check` once beforehand so the dependency cache is warm and the first answer is quick (in the video, mention "the first run takes a few seconds").
- [ ] Choose a good moment: weekday, so there are fresh issues. Try the prompts first and pick the ones with a convincing top result.
- [ ] Close notifications and other tabs; hide any private repository names (the "watched repos" answer lists your projects). **Skip the "What repos are you watching?" prompt in the video**, or blur the answer: it names your own projects and any course repos you starred.
- [ ] Install the **latest** release first (`issuewatcher-0.2.4.mcpb` or newer), remove any older IssueWatcher extension, and fully quit and reopen Claude Desktop.
- [ ] After enabling the extension, **wait about 30 seconds before you ask**: it loads your repos in the background, and a first question asked at once can take 20 to 30 seconds. Do one full dry run first so the cache is warm, then record. If the first answer is slow on camera, cut it in editing; do not speed up the real answer so it looks instant.
- [ ] Use the exact question with "GitHub issues" in it. The vague "What should I work on today?" is sometimes answered as general life advice by Claude Desktop (D-049).
- [ ] The question that triggers the tool may vary by app. Rehearse the three questions you will ask and keep the ones that call IssueWatcher the first time.
- [ ] Record the screen at 1080p. Add captions: many people watch with the sound off.

## 45-second main demo

| Time | On screen | Say / caption |
| --- | --- | --- |
| 0:00 | The AI app, empty chat | "GitHub notifications are all-or-nothing. I wanted: *what should I actually work on today?*" |
| 0:05 | Type: *What GitHub issues should I work on today?* | (caption) "Asking my AI assistant" |
| 0:08 | The ranked list appears: top 5, each with a score and a "why" line | "It ranks new issues in repos I starred and libraries I depend on, and tells me why." |
| 0:20 | Point at one reason line, for example `you depend on pg (^8.16.3); title says "crashes"; unassigned; opened 16h ago` | "A crash in a library I use, fresh, nobody on it." |
| 0:24 | Type: *Why did you rank the first one so high?* The breakdown appears (+40 you depend on pg, +20 title says "crashes", +10 unassigned...) | "Every point is explained. No black box." |
| 0:32 | Point at the assistant's own caveat (for example "this only matters if your server uses GSSAPI auth") | "And my assistant tells me whether it really applies to me." |
| 0:38 | Type: *What broke in my dependencies this week?* | "Or flip it: what may break my projects." |
| 0:42 | Results show `you depend on pymupdf` or `you depend on pg` | "It found my dependencies from my own repos." |
| 0:45 | End card: repo URL, "free, read-only, no AI key needed" | "Free. Read-only. Link below." |

## 3-minute full walkthrough

### 1. The problem (0:00 - 0:20)
Show your GitHub notification inbox. "I star repos I care about, but I either get everything or nothing."

### 2. Get a GitHub token (0:20 - 1:00)
Screen-record the real page: <https://github.com/settings/personal-access-tokens/new>

1. Token name `IssueWatcher`, expiration 90 days.
2. Repository access: *Public repositories (read-only)*. Mention: "to also read the dependencies of my private repos I would choose All repositories and set **Contents: Read-only**."
3. Generate token, copy it. **Blur it.** Say: "Treat it like a password: don't paste it in chat or commit it."

### 3. Install (1:00 - 1:40)
Show the option for your audience (do Claude Desktop first, it is one click):

- **Claude Desktop:** download the `.mcpb` from Releases, double-click, paste the token, switch it on.
- **Claude Code:** `claude mcp add issuewatcher -e GITHUB_TOKEN=... -- npx -y issuewatcher-mcp`
- **Cursor / VS Code:** paste the JSON from the docs.

### 4. Check it works (1:40 - 2:00)
In a terminal: `npx -y issuewatcher-mcp --check`. Read out the four green lines. Say: "If anything is wrong, this tells you exactly what, in plain words."

### 5. Use it (2:00 - 2:40)
The same prompts as the main demo, a little slower. Add *"Show me only good first issues from the last 24 hours"* and *"What repos are you watching for me?"*.

### 6. "Do I need an AI API key?" (2:40 - 3:00)
Say clearly: "**No.** IssueWatcher never calls an AI model. Your assistant uses its own. API keys like Gemini or OpenAI are only for the optional *email digest* part of the project." (Show the README section if you want to show where keys go for the digest: `GOOGLE_API_KEY` in `.env`.)

### 7. Close (3:00)
Safety in one sentence: "Everything is read-only; it can't change anything on GitHub." Say the honest limit in one sentence too: "The score ranks by signals like 'you depend on it' and 'title says crash'. It does not judge how bad a bug is for you, so your assistant helps you decide whether it applies." Show the repo link and ask for feedback: "Tell me what would make this useful for you."

## Prompts that demo well

- *What GitHub issues should I work on today?*
- *Show me good first issues from the last 24 hours.*
- *What broke in my dependencies this week?*
- *Why did you rank the first one so high?*
- *Only show issues from nodejs/node and pydantic/pydantic.*
- *What repos are you watching for me?*

## After recording

- [ ] Revoke the throwaway token at <https://github.com/settings/personal-access-tokens>.
- [ ] Re-watch with sound off: can you follow it from the captions alone?
- [ ] Export a short GIF (under 10 MB) of the 45-second demo for the README, and the full video for YouTube / the posts.
