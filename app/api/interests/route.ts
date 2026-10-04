import { NextResponse } from "next/server";
import { requireSession, isResponse } from "@/lib/serverSession";
import { interestExists, isUuid } from "@/lib/serverRelationships";

export const dynamic = "force-dynamic";

// Interest writes, server-side. Previously the browser upserted/deleted
// public.interests directly, and the RLS UPDATE policy let either party edit a
// row - so the recipient could rewrite from_user_id. Here from_user_id is
// always the session user, the other party must hold the opposite role, and
// the job must belong to whichever side is the employer.
//
// POST { action: "add",    toUserId, jobId } -> { ok, mutual }
// POST { action: "remove", toUserId, jobId } -> { ok }
//   "remove" deletes only the caller's own interest, plus any match between
//   the two on this job (a match cannot outlive either side's interest - the
//   same pair of deletes lib/supabaseMvpData.ts removeInterest always did).
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const action = body?.action;
  const toUserId = body?.toUserId;
  const jobId = body?.jobId;
  if (action !== "add" && action !== "remove") {
    return NextResponse.json({ error: "action must be add or remove." }, { status: 400 });
  }
  if (!isUuid(toUserId) || !isUuid(jobId)) {
    return NextResponse.json({ error: "toUserId and jobId must be UUIDs." }, { status: 400 });
  }

  const session = await requireSession();
  if (isResponse(session)) return session;
  const { user, caller, adminClient } = session;

  if (caller.role !== "candidate" && caller.role !== "employer") {
    return NextResponse.json({ error: "Only candidates and employers can express interest." }, { status: 403 });
  }
  if (toUserId === user.id) {
    return NextResponse.json({ error: "Cannot express interest in yourself." }, { status: 400 });
  }

  const [{ data: other, error: otherError }, { data: job, error: jobError }] = await Promise.all([
    adminClient.from("users").select("id, role").eq("id", toUserId).maybeSingle(),
    adminClient.from("job_posts").select("id, employer_id, active").eq("id", jobId).maybeSingle()
  ]);
  if (otherError || jobError) {
    return NextResponse.json({ error: "Lookup failed." }, { status: 500 });
  }
  const expectedOtherRole = caller.role === "candidate" ? "employer" : "candidate";
  if (!other || other.role !== expectedOtherRole) {
    return NextResponse.json({ error: `Interest must go to a ${expectedOtherRole}.` }, { status: 403 });
  }
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  const employerId = caller.role === "employer" ? user.id : toUserId;
  if (job.employer_id !== employerId) {
    return NextResponse.json({ error: "That job does not belong to this employer." }, { status: 403 });
  }

  if (action === "remove") {
    const candidateId = caller.role === "candidate" ? user.id : toUserId;
    const [interestDelete, matchDelete] = await Promise.all([
      adminClient.from("interests").delete().eq("from_user_id", user.id).eq("to_user_id", toUserId).eq("job_id", jobId),
      adminClient.from("matches").delete().eq("candidate_id", candidateId).eq("employer_id", employerId).eq("job_id", jobId)
    ]);
    const failed = interestDelete.error ?? matchDelete.error;
    if (failed) {
      console.error("[api/interests] remove failed", { userId: user.id, toUserId, jobId, error: failed.message });
      return NextResponse.json({ error: failed.message }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }

  if (!job.active) {
    return NextResponse.json({ error: "That job is no longer active." }, { status: 409 });
  }
  const { error: upsertError } = await adminClient
    .from("interests")
    .upsert(
      { from_user_id: user.id, to_user_id: toUserId, job_id: jobId, status: "pending" },
      { onConflict: "from_user_id,to_user_id,job_id" }
    );
  if (upsertError) {
    console.error("[api/interests] add failed", { userId: user.id, toUserId, jobId, error: upsertError.message });
    return NextResponse.json({ error: upsertError.message }, { status: 500 });
  }

  // Live read, so a reciprocal interest written after the caller's page
  // loaded is still detected.
  const mutual = await interestExists(adminClient, toUserId, user.id, jobId);
  return NextResponse.json({ ok: true, mutual });
}
