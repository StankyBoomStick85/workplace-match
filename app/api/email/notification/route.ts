import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { hasRelationship, isUuid } from "@/lib/serverRelationships";
import {
  interestNotificationTemplate,
  matchNotificationTemplate,
  sendEmail
} from "../../../../lib/email";

export const dynamic = "force-dynamic";

type NotificationEmailType = "match_notification" | "interest_notification";

// Signed-in only. The recipient is always resolved server-side from
// recipientUserId -> public.users.email, and only when the caller has a real
// relationship with that user on this job: an interest (either direction), a
// mutual match, or a message thread between them. A raw recipient email and a
// client-supplied job title are no longer accepted - previously anyone, logged
// out, could send this email to any address with any job title in it. The job
// title is read from job_posts.
//
// Callers: lib/supabaseMvpData.ts triggerTransactionalEmail, from addInterest
// (recipient = the interest's other party, written just before this call) and
// addMutualMatch (both parties of the match row written just before this call,
// which includes the caller - sending to yourself is allowed).
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const type = body?.type as NotificationEmailType | undefined;
  const recipientUserId = typeof body?.recipientUserId === "string" ? body.recipientUserId.trim() : "";
  const jobId = typeof body?.jobId === "string" ? body.jobId.trim() : "";

  if (type !== "match_notification" && type !== "interest_notification") {
    return NextResponse.json({ error: "Unsupported email type." }, { status: 400 });
  }
  if (!recipientUserId || !jobId) {
    return NextResponse.json({ error: "recipientUserId and jobId are required." }, { status: 400 });
  }
  // Both values are interpolated into PostgREST or() filters below, so they must
  // be plain UUIDs - anything else could inject filter syntax.
  if (!isUuid(recipientUserId) || !isUuid(jobId)) {
    return NextResponse.json({ error: "recipientUserId and jobId must be UUIDs." }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return NextResponse.json({ error: "Server configuration missing." }, { status: 500 });
  }

  const cookieStore = cookies();
  const authClient = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) { return cookieStore.get(name)?.value; },
      set(name: string, value: string, options: CookieOptions) { cookieStore.set(name, value, options); },
      remove(name: string, options: CookieOptions) { cookieStore.set(name, "", options); }
    }
  });
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const related =
    recipientUserId === user.id ||
    (await hasRelationship(adminClient, user.id, recipientUserId, jobId));
  if (!related) {
    return NextResponse.json({ error: "No relationship with this user for this job." }, { status: 403 });
  }

  const { data: recipient, error: recipientError } = await adminClient
    .from("users")
    .select("email")
    .eq("id", recipientUserId)
    .maybeSingle();
  if (recipientError) {
    console.error("[api/email/notification] Failed to look up recipient", { recipientUserId, error: recipientError.message });
    return NextResponse.json({ error: "Recipient lookup failed." }, { status: 500 });
  }
  const email = typeof recipient?.email === "string" ? recipient.email.trim().toLowerCase() : "";
  if (!email) {
    return NextResponse.json({ error: "Recipient not found." }, { status: 404 });
  }

  const jobTitle = (await getJobTitle(adminClient, jobId)) || "a Workplace Match opportunity";
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

async function getJobTitle(adminClient: SupabaseClient, jobId: string) {
  const { data, error } = await adminClient.from("job_posts").select("title").eq("id", jobId).maybeSingle();
  if (error) {
    console.error("[api/email/notification] Failed to look up job title", { jobId, error: error.message });
    return "";
  }
  return typeof data?.title === "string" ? data.title : "";
}
