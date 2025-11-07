import dotenv from "dotenv";
dotenv.config();

import { pollOnce } from "./poller";
function startpolling(){
pollOnce();
setInterval(() =>{
    pollOnce();
}, 1800000);
}
startpolling();
