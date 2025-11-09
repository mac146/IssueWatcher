import dotenv from "dotenv";
dotenv.config();

import { GoogleGenerativeAI } from "@google/generative-ai";
import { pollOnce } from "../poller/poller.js";
import { sendEmail } from "../mail/mailer.js";

const apiKey = process.env.GOOGLE_API_KEY;
if (!apiKey) throw new Error("GOOGLE_API_KEY is missing in .env file");

const genAI = new GoogleGenerativeAI(apiKey);

export async function run() {
  const newissues = await pollOnce();

  if (!newissues.length) {
    console.log("No new issues.");
    return;
  }

  const summaries: { issue: string; summary: string }[] = [];

  for (const issue of newissues) {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const result = await model.generateContent(
      `Summarize this GitHub issue:\nTitle: ${issue.title}\nBody: ${issue.body}`
    );

    const summary = result.response.text();

    // Push summary to array
    summaries.push({
      issue: `${issue.repo}#${issue.number} by @${issue.user}: ${issue.title}`,
      summary,
    });
  }

  // Print all issues + summaries neatly
  for (const s of summaries) {
    console.log("Issue:", s.issue);
    console.log("Summary:", s.summary, "\n");
  }

  let emailBody = "Here are the new issues from your starred repos:\n\n";
    for (const s of summaries) {
        emailBody += `Issue: ${s.issue}\nSummary: ${s.summary}\n\n`;
    }

    // Send email
    await sendEmail("mayankkumars584@gmail.com", "New GitHub Issues Summary", emailBody);

    console.log("✅ Email sent with all new issues");
}



run();
