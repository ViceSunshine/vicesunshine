// Direct email sending for the standalone build, via Resend.
// Replaces the Muse Gmail-connector spawned task: in Muse the server
// had no direct mail channel, so every code email was handed to a
// background agent task that sent it from officialvicesunshine@gmail.com.
// Here the server calls the Resend API directly — no agent, no Gmail
// handoff, no human touching anything. The HTML/text bodies are
// unchanged (built in server/src/actions.ts, same dark ViceSunshine
// design, same subjects, same 1-minute expiry).
//
// Setup (see README.md): create a Resend account, verify
// vicesunshine.com as a sending domain, create an API key, and set
// RESEND_API_KEY in Railway. Never put the key in chat or in the repo.

export interface CodeEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendCodeEmail(email: CodeEmail): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Email sending is not configured on this server (RESEND_API_KEY is missing). " +
        "The code was created but could not be emailed — set RESEND_API_KEY in Railway and try Resend again.",
    );
  }
  const from = process.env.EMAIL_FROM ?? "ViceSunshine <noreply@vicesunshine.com>";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: email.to, subject: email.subject, html: email.html, text: email.text }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend rejected the code email (HTTP ${res.status}): ${detail.slice(0, 300)}`);
  }
}
