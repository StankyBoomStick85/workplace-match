import { NextResponse } from "next/server";
import {
  interestNotificationTemplate,
  matchNotificationTemplate,
  sendEmail
} from "../../../../lib/email";
import { supabase } from "../../../../lib/supabase";

type NotificationEmailType = "match_notification" | "interest_notification";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const type = body?.type as NotificationEmailType | undefined;
  const recipientUserId = typeof body?.recipientUserId === "string" ? body.recipientUserId : "";
  const recipientEmail = typeof body?.recipientEmail === "string" ? body.recipientEmail.trim().toLowerCase() : "";
  const jobId = typeof body?.jobId === "string" ? body.jobId : "";
  const providedJobTitle = typeof body?.jobTitle === "string" ? body.jobTitle : "";

  if (type !== "match_notification" && type !== "interest_notification") {
    return NextResponse.json({ error: "Unsupported email type." }, { status: 400 });
  }

  const email = recipientEmail || (recipientUserId ? await getUserEmail(recipientUserId) : "");
  if (!email) {
    return NextResponse.json({ error: "Recipient not found." }, { status: 404 });
  }

  const jobTitle = providedJobTitle || (jobId ? await getJobTitle(jobId) : "") || "a Workplace Match opportunity";
  const template =
    type === "match_notification"
      ? matchNotificationTemplate(jobTitle)
      : interestNotificationTemplate(jobTitle);

  await sendEmail({
    to: email,
    subject: template.subject,
    html: template.html,
    text: template.text
  });

  return NextResponse.json({ ok: true });
}

async function getUserEmail(userId: string) {
  const { data } = await supabase.from("users").select("email").eq("id", userId).maybeSingle();
  return typeof data?.email === "string" ? data.email : "";
}

async function getJobTitle(jobId: string) {
  const { data } = await supabase.from("job_posts").select("title").eq("id", jobId).maybeSingle();
  return typeof data?.title === "string" ? data.title : "";
}
