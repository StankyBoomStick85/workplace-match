import { NextResponse } from "next/server";
import { requireSession, isResponse } from "@/lib/serverSession";
import { hasRelationship, interestExists, isUuid, matchExists } from "@/lib/serverRelationships";
import { insertNotification, type UserNotificationType } from "@/lib/serverNotifications";
import { storedEmployerMatchScore } from "@/lib/serverMatchScore";

export const dynamic = "force-dynamic";

// User-to-user in-app notifications, server-side. Previously the browser
// inserted public.notifications directly and the RLS INSERT check was `true`,
// so anyone could put any text into anyone's notification bell.
//
// Every notification is ABOUT a counterpart: the other party of a candidate/
// employer pair on one job. That pair must have a real relationship
// (lib/serverRelationships.ts hasRelationship - the same check
// api/email/notification uses), plus a type-specific check:
//   interest_received - the caller's own interest to the recipient exists
//   new_match         - a mutual match exists between the pair on this job
//   new_message       - a mutual match exists between the pair on this job
// The recipient is the counterpart, except new_match, which is also sent to
// yourself (both parties are notified when a match forms) - then the request
// names the counterpart in otherUserId.
//
// The title and message text are built here from the type and server-read
// data only; the client cannot send free text or a match percentage (any
// matchPercent it sends is ignored). The percentage in a candidate's
// interest_received text is the stored employer-direction AI score
// (lib/serverMatchScore.ts) and is left out entirely when there is none -
// never shown as 0%. Raw candidate-typed skills (capability_tags), which the
// old candidate-side text included, are no longer sent to employers.
//
// POST  { type, recipientUserId, jobId, otherUserId? } -> { ok }
// PATCH { id } | { all: true } -> { ok }   mark the CALLER'S OWN notifications
//   read. Moved server-side so the authenticated UPDATE policy on
//   notifications can be dropped (see the RLS migration); it can only ever
//   touch rows whose user_id is the session user.
const TYPES: UserNotificationType[] = ["interest_received", "new_match", "new_message"];

export async function PATCH(request: Request) {
  const body = await request.json().catch(() => null);
  const id = body?.id;
  const all = body?.all === true;
  if (!all && !isUuid(id)) {
    return NextResponse.json({ error: "Pass { id } or { all: true }." }, { status: 400 });
  }

  const session = await requireSession();
  if (isResponse(session)) return session;
  const { user, adminClient } = session;

  let query = adminClient.from("notifications").update({ read: true }).eq("user_id", user.id);
  if (!all) query = query.eq("id", id);
  const { error } = await query;
  if (error) {
    console.error("[api/notifications] mark read failed", { userId: user.id, error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const type = body?.type as UserNotificationType;
  const recipientUserId = body?.recipientUserId;
  const jobId = body?.jobId;
  if (!TYPES.includes(type)) {
    return NextResponse.json({ error: "Unsupported notification type." }, { status: 400 });
  }
  if (!isUuid(recipientUserId) || !isUuid(jobId)) {
    return NextResponse.json({ error: "recipientUserId and jobId must be UUIDs." }, { status: 400 });
  }

  const session = await requireSession();
  if (isResponse(session)) return session;
  const { user, caller, adminClient } = session;
  if (caller.role !== "candidate" && caller.role !== "employer") {
    return NextResponse.json({ error: "Only candidates and employers send notifications." }, { status: 403 });
  }

  const isSelf = recipientUserId === user.id;
  if (isSelf && type !== "new_match") {
    return NextResponse.json({ error: "Cannot send this notification to yourself." }, { status: 400 });
  }
  const counterpartId = isSelf ? body?.otherUserId : recipientUserId;
  if (!isUuid(counterpartId) || counterpartId === user.id) {
    return NextResponse.json({ error: "otherUserId (the other party) is required for a notification to yourself." }, { status: 400 });
  }

  const candidateId = caller.role === "candidate" ? user.id : counterpartId;
  const employerId = caller.role === "employer" ? user.id : counterpartId;

  const { data: job } = await adminClient.from("job_posts").select("id, title, employer_id").eq("id", jobId).maybeSingle();
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  if (job.employer_id !== employerId) {
    return NextResponse.json({ error: "That job does not belong to this employer." }, { status: 403 });
  }
  const jobTitle = typeof job.title === "string" ? job.title : "a Workplace Match opportunity";

  if (!(await hasRelationship(adminClient, user.id, counterpartId, jobId))) {
    return NextResponse.json({ error: "No relationship with this user for this job." }, { status: 403 });
  }

  let title: string;
  let message: string;
  if (type === "interest_received") {
    if (!(await interestExists(adminClient, user.id, counterpartId, jobId))) {
      return NextResponse.json({ error: "No interest from you to this user on this job." }, { status: 403 });
    }
    if (caller.role === "employer") {
      title = "An employer is interested";
      message = `An employer is interested in you for ${jobTitle}. Take a look and see if you'd like to express interest back.`;
    } else {
      const { data: profile } = await adminClient.from("candidate_profiles").select("zip_code").eq("user_id", user.id).maybeSingle();
      const zip = typeof profile?.zip_code === "string" && profile.zip_code.trim() ? profile.zip_code.trim() : "your area";
      const storedScore = await storedEmployerMatchScore(adminClient, employerId, candidateId, jobId);
      const percentText = storedScore === null ? "" : ` (${storedScore}% match)`;
      title = "A candidate is interested";
      message = `A candidate near ${zip} is interested in your ${jobTitle} listing${percentText}.`;
    }
  } else {
    if (!(await matchExists(adminClient, candidateId, employerId, jobId))) {
      return NextResponse.json({ error: "No mutual match on this job." }, { status: 403 });
    }
    if (type === "new_match") {
      title = "New Match";
      message = "You have a new mutual match.";
    } else {
      title = "New Message";
      message = `New message about ${jobTitle}.`;
    }
  }

  const { error } = await insertNotification(adminClient, {
    recipientUserId,
    type,
    title,
    message,
    jobId,
    jobTitle,
    candidateId,
    employerId
  });
  if (error) {
    return NextResponse.json({ error }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
