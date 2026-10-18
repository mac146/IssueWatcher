import nodemailer, { Transporter } from "nodemailer";
import type { Config } from "../config.js";
import type { SummarizedIssue } from "../llm/summarizer.js";

export type Mailer = {
  sendDigest(items: SummarizedIssue[]): Promise<void>;
};

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function buildSubject(items: SummarizedIssue[]): string {
  if (items.length === 1) {
    const { issue } = items[0]!;
    return `New issue in ${issue.repo}: ${issue.title}`.slice(0, 200);
  }
  return `${items.length} new issues in your starred repos`;
}

export function renderText(items: SummarizedIssue[]): string {
  return items
    .map(({ issue, summary }) =>
      [
        `${issue.repo}#${issue.number} by @${issue.user}: ${issue.title}`,
        summary ?? "(No AI summary available)",
        issue.url,
      ].join("\n"),
    )
    .join("\n\n---\n\n");
}

export function renderHtml(items: SummarizedIssue[]): string {
  const blocks = items.map(({ issue, summary }) => {
    const labels = issue.labels.length ? ` <small>[${escapeHtml(issue.labels.join(", "))}]</small>` : "";
    const body = summary
      ? `<p style="white-space:pre-wrap;margin:4px 0">${escapeHtml(summary)}</p>`
      : `<p style="color:#777;margin:4px 0"><em>No AI summary available.</em></p>`;
    return (
      `<div style="margin-bottom:20px">` +
      `<div><strong>${escapeHtml(issue.repo)}#${issue.number}</strong> by @${escapeHtml(issue.user)}${labels}</div>` +
      `<div style="font-size:16px;margin:2px 0">${escapeHtml(issue.title)}</div>` +
      `${body}<a href="${escapeHtml(issue.url)}">View on GitHub</a></div>`
    );
  });
  return `<div style="font-family:sans-serif;max-width:640px">${blocks.join("<hr>")}</div>`;
}

export class SmtpMailer implements Mailer {
  private readonly transporter: Transporter;

  constructor(private readonly config: Pick<Config, "smtp" | "mailFrom" | "mailTo">) {
    const { host, port, secure, user, pass } = config.smtp;
    this.transporter = nodemailer.createTransport({ host, port, secure, auth: { user, pass } });
  }

  /** Throws on failure so the caller can avoid marking issues as delivered. */
  async sendDigest(items: SummarizedIssue[]): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.mailFrom,
      to: this.config.mailTo,
      subject: buildSubject(items),
      text: renderText(items),
      html: renderHtml(items),
    });
  }
}
