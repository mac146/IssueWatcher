import nodemailer, { Transporter } from "nodemailer";
import type { Config } from "../config.js";
import { digestSize, type Digest } from "../digest.js";

export type Mailer = {
  sendDigest(digest: Digest): Promise<void>;
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildSubject(digest: Digest): string {
  const total = digestSize(digest);
  const first = digest.top[0] ?? digest.other[0];
  if (total === 1 && first) {
    return `New issue in ${first.issue.repo}: ${first.issue.title}`.slice(0, 200);
  }
  return digest.top.length
    ? `${total} new issues, ${digest.top.length} worth a look`
    : `${total} new issues in your watched repos`;
}

export function renderText(digest: Digest): string {
  const top = digest.top.map(({ issue, summary, score, reasons }) =>
    [
      `[${score}] ${issue.repo}#${issue.number} by @${issue.user}: ${issue.title}`,
      reasons.length ? `Why: ${reasons.join("; ")}` : "",
      summary ?? "(No AI summary available)",
      issue.url,
    ]
      .filter(Boolean)
      .join("\n"),
  );
  const other = digest.other.map(
    ({ issue, score }) => `- [${score}] ${issue.repo}#${issue.number}: ${issue.title}\n  ${issue.url}`,
  );
  return [
    ...top.map((t) => `${t}\n\n---\n`),
    other.length ? `Also new (lower relevance):\n${other.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderHtml(digest: Digest): string {
  const topBlocks = digest.top.map(({ issue, summary, score, reasons }) => {
    const labels = issue.labels.length ? ` <small>[${escapeHtml(issue.labels.join(", "))}]</small>` : "";
    const why = reasons.length
      ? `<div style="color:#555;font-size:13px;margin:2px 0">Why you're seeing this: ${escapeHtml(reasons.join("; "))}</div>`
      : "";
    const body = summary
      ? `<p style="white-space:pre-wrap;margin:6px 0">${escapeHtml(summary)}</p>`
      : `<p style="color:#777;margin:6px 0"><em>No AI summary available.</em></p>`;
    return (
      `<div style="margin-bottom:20px">` +
      `<div><span style="background:#eef;border-radius:4px;padding:1px 6px;font-size:12px">relevance ${score}</span> ` +
      `<strong>${escapeHtml(issue.repo)}#${issue.number}</strong> by @${escapeHtml(issue.user)}${labels}</div>` +
      `<div style="font-size:16px;margin:2px 0">${escapeHtml(issue.title)}</div>` +
      `${why}${body}<a href="${escapeHtml(issue.url)}">View on GitHub</a></div>`
    );
  });

  const otherBlock = digest.other.length
    ? `<h4 style="margin:24px 0 8px">Also new (lower relevance)</h4><ul style="padding-left:18px;margin:0">` +
      digest.other
        .map(
          ({ issue, score }) =>
            `<li style="margin:3px 0"><span style="color:#777">[${score}]</span> ${escapeHtml(issue.repo)}#${issue.number}: ` +
            `<a href="${escapeHtml(issue.url)}">${escapeHtml(issue.title)}</a></li>`,
        )
        .join("") +
      `</ul>`
    : "";

  return `<div style="font-family:sans-serif;max-width:680px">${topBlocks.join("<hr>")}${otherBlock}</div>`;
}

export class SmtpMailer implements Mailer {
  private readonly transporter: Transporter;

  constructor(private readonly config: Pick<Config, "smtp" | "mailFrom" | "mailTo">) {
    const { host, port, secure, user, pass } = config.smtp;
    this.transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  }

  /** Throws on failure so the caller can avoid marking issues as delivered. */
  async sendDigest(digest: Digest): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.mailFrom,
      to: this.config.mailTo,
      subject: buildSubject(digest),
      text: renderText(digest),
      html: renderHtml(digest),
    });
  }
}
