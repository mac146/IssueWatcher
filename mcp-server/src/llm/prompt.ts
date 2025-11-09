import { pollOnce } from "../poller/poller.js";
import { Issue } from "../poller/types.js";
export async function prompt(): Promise<string | null> { 
    const allNewIssues:Issue[]= await pollOnce();

    if (allNewIssues.length===0){
        return null;
    }

    let promptText = "You are an AI assistant. Summarize the following new GitHub issues and suggest possible fixes:\n\n";

  allNewIssues.forEach((issue, index) => {
    promptText += `${index + 1}. Repo: ${issue.repo}\n`;
    promptText += `   Issue #${issue.number}: ${issue.title}\n`;
    promptText += `   Author: @${issue.user}\n`;
    promptText += `   URL: ${issue.url}\n`;
    if (issue.labels && issue.labels.length > 0) {
      promptText += `   Labels: ${issue.labels.join(", ")}\n`;
    }
    
    const bodyText = issue.body || "";
    const bodySnippet = bodyText.length > 300 ? bodyText.slice(0, 300) + "..." : bodyText;
    promptText += `   Body: ${bodySnippet}\n\n`;
  });

  return promptText;
}
