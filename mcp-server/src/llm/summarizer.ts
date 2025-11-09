import dotenv from "dotenv";
dotenv.config();

import { GoogleGenerativeAI } from "@google/generative-ai";
import { prompt } from "./prompt.js";

const apiKey = process.env.GOOGLE_API_KEY;

if (!apiKey) {
  throw new Error("GOOGLE_API_KEY is missing in .env file");
}


const genAI = new GoogleGenerativeAI(apiKey);


export async function run() {
  const promptText = await prompt();

  if (!promptText) {
    console.log("No new issues.");
    return;
  }

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
  });

  const result = await model.generateContent(promptText);


  const summary = result.response.text();

  console.log("AI Summary:\n", summary);
}

run();