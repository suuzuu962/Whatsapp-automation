/**
 * Thin wrapper over Resend's plain HTTP API — no SDK, consistent with
 * this codebase's "raw fetch, no vendor SDK" convention (see
 * src/lib/whatsapp/meta-api.ts, src/lib/ai/providers/*.ts). Used by the
 * AI agent's send_email tool (src/lib/ai/tools.ts).
 */

export class EmailNotConfiguredError extends Error {
  constructor() {
    super("Email is not configured for this deployment — set RESEND_API_KEY and RESEND_FROM_EMAIL");
    this.name = "EmailNotConfiguredError";
  }
}

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
}

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

export async function sendEmail(input: SendEmailInput): Promise<{ id: string }> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new EmailNotConfiguredError();
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: input.to,
      subject: input.subject,
      text: input.text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Resend API error (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { id: string };
  return { id: data.id };
}
