import { Resend } from "resend";

const resendApiKey = process.env.RESEND_API_KEY;
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const fromEmail = "noreply@workplacematchapp.com";

export type EmailTemplate = "welcome" | "match_notification" | "interest_notification";

export async function sendEmail({
  to,
  subject,
  html,
  text
}: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}) {
  if (!resend) {
    console.warn("RESEND_API_KEY is not configured. Email skipped.");
    return null;
  }

  return resend.emails.send({
    from: fromEmail,
    to,
    subject,
    html,
    text
  });
}

export function welcomeEmailTemplate(role: "candidate" | "employer") {
  const roleLabel = role === "employer" ? "employer" : "applicant";
  return {
    subject: "Welcome to Workplace Match",
    text: `Welcome to Workplace Match. Your ${roleLabel} account is ready.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #18181b;">
        <h1 style="color:#991b1b;">Welcome to Workplace Match</h1>
        <p>Your ${roleLabel} account is ready.</p>
        <p>Sign in any time to continue building matches around capability, fit, and opportunity.</p>
      </div>
    `
  };
}

export function matchNotificationTemplate(jobTitle: string) {
  return {
    subject: "You have a new match",
    text: `You have a new mutual match for ${jobTitle}.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #18181b;">
        <h1 style="color:#991b1b;">You have a new match</h1>
        <p>Both sides expressed interest in ${escapeHtml(jobTitle)}.</p>
        <p>Open Workplace Match to review next steps.</p>
      </div>
    `
  };
}

export function interestNotificationTemplate(jobTitle: string) {
  return {
    subject: "Someone expressed interest",
    text: `Someone expressed interest in ${jobTitle}.`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #18181b;">
        <h1 style="color:#991b1b;">New interest</h1>
        <p>Someone expressed interest in ${escapeHtml(jobTitle)}.</p>
        <p>Open Workplace Match to review the match status.</p>
      </div>
    `
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
