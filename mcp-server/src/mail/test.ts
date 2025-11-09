import { sendEmail } from "./mailer.js";

async function main() {
  await sendEmail(
    "your_email@gmail.com",
    "Test Email",
    "Mail is working ✅"
  );
}

main();