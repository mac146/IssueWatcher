import dotenv from "dotenv";
dotenv.config();

import nodemailer from "nodemailer";

const transporter =nodemailer.createTransport({
    service:"gmail",
    auth:{
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    }
});

export async function sendEmail(to: string, subject:string, text:string){
    try{
        await transporter.sendMail({
            from: process.env.SMTP_USER,
            to,
            subject,
            text,
        });
        console.log(" Email sent to:", to);
    } catch (err){
        console.error(" Email error:", err);
    }
}