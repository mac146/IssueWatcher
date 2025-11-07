import dotenv from "dotenv";
dotenv.config();

//import { GitHubAPI } from "./github/api";
import { pollOnce } from "./poller/poller";

function startpolling(){
pollOnce();
setInterval(() =>{
    pollOnce();
}, 1800000);
}

async function main () {
  startpolling();
};

main();
