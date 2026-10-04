import { NextResponse } from "next/server";
import { requireSession, isResponse } from "@/lib/serverSession";
import { isUuid } from "@/lib/serverRelationships";

export const dynamic = "force-dynamic";

// Admin activity events, server-side. Previously the browser inserted
// public.admin_activity_events directly with an RLS INSERT check of `true`, so
// anyone could write any event, as any role, about anyone.
//
// Here: a signed-in session is required, the type must be one the app actually
// logs, user_role is the caller's real role (never the client's claim), and if
// the event names a candidate or employer on the caller's own side, it must be
// the caller. Metadata is capped. A repeated dedupe key is ignored, matching
// the client's own de-duplication.
//
// POST { type, jobId?, applicantId?, employerId?, metadata?, dedupeKey? } -> { ok }
const EVENT_TYPES = new Set([
  "signup_created",
  "job_created",
  "interest_selected",
  "mutual_match_created",
  "notification_clicked",
  "reach_out_clicked",
  "message_sent",
  "schedule_requested",
  "interest_removed"
]);
const MAX_METADATA_BYTES = 2048;
const MAX_DEDUPE_KEY_CHARS = 200;

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const type = typeof body?.type === "string" ? body.type : "";
  if (!EVENT_TYPES.has(type)) {
    return NextResponse.json({ error: "Unknown event type." }, { status: 400 });
  }

  const session = await requireSession();
  if (isResponse(session)) return session;
  const { user, caller, adminClient } = session;

  const applicantId = isUuid(body?.applicantId) ? body.applicantId : null;
  const employerId = isUuid(body?.employerId) ? body.employerId : null;
  const jobId = isUuid(body?.jobId) ? body.jobId : null;
  if (!caller.isAdmin) {
    if (caller.role === "candidate" && applicantId && applicantId !== user.id) {
      return NextResponse.json({ error: "applicantId must be you." }, { status: 403 });
    }
    if (caller.role === "employer" && employerId && employerId !== user.id) {
      return NextResponse.json({ error: "employerId must be you." }, { status: 403 });
    }
    if (caller.role === "pending") {
      return NextResponse.json({ error: "Account type not set." }, { status: 403 });
    }
  }

  let metadata: unknown = body?.metadata && typeof body.metadata === "object" ? body.metadata : {};
  try {
    if (JSON.stringify(metadata).length > MAX_METADATA_BYTES) metadata = { truncated: true };
  } catch {
    metadata = {};
  }
  const dedupeKey = typeof body?.dedupeKey === "string" && body.dedupeKey
    ? body.dedupeKey.slice(0, MAX_DEDUPE_KEY_CHARS)
    : null;

  const row = {
    type,
    user_role: caller.role === "pending" ? null : caller.role,
    job_id: jobId,
    applicant_id: applicantId,
    employer_id: employerId,
    metadata,
    dedupe_key: dedupeKey
  };
  const { error } = dedupeKey
    ? await adminClient.from("admin_activity_events").upsert(row, { onConflict: "dedupe_key", ignoreDuplicates: true })
    : await adminClient.from("admin_activity_events").insert(row);
  if (error) {
    console.error("[api/admin-events] insert failed", { userId: user.id, type, error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
