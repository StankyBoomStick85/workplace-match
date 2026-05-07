import { NextResponse } from "next/server";
import { sendEmail, welcomeEmailTemplate } from "../../../../lib/email";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = body?.role === "employer" ? "employer" : body?.role === "candidate" ? "candidate" : null;

  if (!email || !role) {
    return NextResponse.json({ error: "Missing email or role." }, { status: 400 });
  }

  const template = welcomeEmailTemplate(role);
  await sendEmail({
    to: email,
    subject: template.subject,
    html: template.html,
    text: template.text
  });

  return NextResponse.json({ ok: true });
}
