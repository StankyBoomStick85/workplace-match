import { NextResponse } from "next/server";
import { sendEmail } from "../../../lib/email";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const organization = typeof body?.organization === "string" ? body.organization.trim() : "";
  const message = typeof body?.message === "string" ? body.message.trim() : "";

  if (!name || !email || !message) {
    return NextResponse.json({ error: "Name, email, and message are required." }, { status: 400 });
  }

  const result = await sendEmail({
    to: "joel@workplacematchapp.com",
    subject: `WPM Partnership Inquiry - ${name}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #18181b;">
        <h2 style="color:#991b1b;">WPM Partnership / Investor Inquiry</h2>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Organization:</strong> ${escapeHtml(organization || "Not provided")}</p>
        <hr style="border:none;border-top:1px solid #e4e4e7;margin:16px 0;" />
        <p><strong>Message:</strong></p>
        <p style="white-space:pre-wrap;">${escapeHtml(message)}</p>
      </div>
    `,
    text: `WPM Partnership / Investor Inquiry\n\nName: ${name}\nEmail: ${email}\nOrganization: ${organization || "Not provided"}\n\nMessage:\n${message}`
  });

  if (result === null) {
    return NextResponse.json({ error: "Email service not configured." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
