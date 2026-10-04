import { NextResponse } from "next/server";
import { requireSession, isResponse } from "@/lib/serverSession";
import { isUuid, matchExists } from "@/lib/serverRelationships";

export const dynamic = "force-dynamic";

const MAX_MESSAGE_CHARS = 4000;

// Match-thread messages, server-side. Previously the browser inserted
// public.match_messages directly with a client-chosen sender_role, so a user
// could post into a thread with anyone they were not matched with, and could
// label their own message as coming from the other party.
//
// Here: the caller must be the thread's applicant (as a candidate) or its
// employer (as an employer), the two must have a mutual match on this job, and
// sender_role is derived from the caller's role - never accepted from the
// client. The row is inserted with the service role; Supabase Realtime still
// delivers it to both parties through the existing match_messages SELECT
// policy, which this change does not touch.
//
// POST { applicantId, employerId, jobId, text } -> { ok, message }
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const applicantId = body?.applicantId;
  const employerId = body?.employerId;
  const jobId = body?.jobId;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!isUuid(applicantId) || !isUuid(employerId) || !isUuid(jobId)) {
    return NextResponse.json({ error: "applicantId, employerId and jobId must be UUIDs." }, { status: 400 });
  }
  if (!text) {
    return NextResponse.json({ error: "Message text is required." }, { status: 400 });
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json({ error: `Messages are limited to ${MAX_MESSAGE_CHARS} characters.` }, { status: 400 });
  }

  const session = await requireSession();
  if (isResponse(session)) return session;
  const { user, caller, adminClient } = session;

  let senderRole: "applicant" | "employer";
  if (caller.role === "candidate" && user.id === applicantId) {
    senderRole = "applicant";
  } else if (caller.role === "employer" && user.id === employerId) {
    senderRole = "employer";
  } else {
    return NextResponse.json({ error: "You are not a party to this thread." }, { status: 403 });
  }

  if (!(await matchExists(adminClient, applicantId, employerId, jobId))) {
    return NextResponse.json({ error: "Messaging requires a mutual match." }, { status: 403 });
  }

  const { data, error } = await adminClient
    .from("match_messages")
    .insert({ applicant_id: applicantId, employer_id: employerId, job_id: jobId, sender_role: senderRole, text })
    .select("id, applicant_id, employer_id, job_id, sender_role, text, created_at")
    .single();
  if (error) {
    console.error("[api/messages] insert failed", { userId: user.id, applicantId, employerId, jobId, error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, message: data });
}
