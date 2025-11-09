import dotenv from "dotenv";
dotenv.config();

import {run} from "./llm/summarizer.js"


import { GitHubAPI } from "./github/api.js";
import { pollOnce } from "./poller/poller.js";

async function startpolling(){
await pollOnce();
await run();
setInterval(async () =>{
    await  pollOnce();
    await run();
}, 1800000);
}

async function main () {
  startpolling();
};

main();


