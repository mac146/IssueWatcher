import dotenv from "dotenv";
dotenv.config();

import { run } from "./llm/summarizer.js";
import { pollOnce } from "./poller/poller.js";

async function startpolling() {
  const initialIssues = await pollOnce();
  await run(initialIssues);

  setInterval(async () => {
    const newIssues = await pollOnce();
    await run(newIssues);
  }, 1800000);
}

async function main () {
  startpolling();
};

main();


