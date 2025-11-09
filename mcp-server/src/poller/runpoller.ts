import dotenv from "dotenv";
dotenv.config();

import { pollOnce } from "./poller.js";
function startpolling(){
pollOnce();
setInterval(() =>{
    pollOnce();
}, 1800000);
}
startpolling();
