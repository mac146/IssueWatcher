import fs from "fs";
import path from "path";

import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const stateFilePath = path.join(__dirname,"../data/lastissues.json");

export function loadState(): Record<string, number[]> {
    try{
        if (!fs.existsSync(stateFilePath)){
            return {};
        }
        const data= fs.readFileSync (stateFilePath,"utf-8");
        return JSON.parse(data);
    } catch (err){
        console.log("error :" , err);
        return {};
    }
}

export function saveState(state: Record<string, number[]>): void {
   try {
    fs.writeFileSync(stateFilePath, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("Error saving state:", err);
  }
}


