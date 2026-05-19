import { NextResponse } from "next/server";
import { sendEmail } from "../../../lib/email";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message.trim() : "";
  const userName = typeof body?.userName === "string" ? body.userName.trim() : "Unknown";
  const userEmail = typeof body?.userEmail === "string" ? body.userEmail.trim() : "";

  if (!message) {
    return NextResponse.json({ error: "Message is required." }, { status: 400 });
  }

  const result = await sendEmail({
    to: "joel@workplacematchapp.com",
    subject: `WPM Support Request - ${userName}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #18181b;">
        <h2 style="color:#991b1b;">WPM Support Request</h2>
        <p><strong>Name:</strong> ${escapeHtml(userName)}</p>
        <p><strong>Email:</strong> ${escapeHtml(userEmail)}</p>
        <hr style="border:none;border-top:1px solid #e4e4e7;margin:16px 0;" />
        <p><strong>Message:</strong></p>
        <p style="white-space:pre-wrap;">${escapeHtml(message)}</p>
      </div>
    `,
    text: `WPM Support Request\n\nName: ${userName}\nEmail: ${userEmail}\n\nMessage:\n${message}`
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
