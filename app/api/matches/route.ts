import { NextResponse } from "next/server";
import { requireSession, isResponse } from "@/lib/serverSession";
import { interestExists, isUuid } from "@/lib/serverRelationships";
import { storedEmployerMatchScore } from "@/lib/serverMatchScore";

export const dynamic = "force-dynamic";

// Mutual match creation, server-side. Previously the browser upserted
// public.matches directly, and the RLS INSERT check only required the caller
// to be one of the two ids - so anyone could create a "mutual" match with
// anyone, which unlocks the employer's fuller view of that candidate. The only
// legitimate way a match exists is BOTH parties having marked interest in each
// other on this job, and that is verified here before anything is written.
//
// POST { candidateId, employerId, jobId } -> { ok, created }
//   score / capability_match come from the stored employer-direction AI score
//   (lib/serverMatchScore.ts), or null when there is none. Any matchPercent
//   the client sends is ignored.
//   The caller must be one of the two, on the matching side for their role.
//   created = false when the match already existed (callers only send the
//   match emails/notifications when it is newly created).
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const candidateId = body?.candidateId;
  const employerId = body?.employerId;
  const jobId = body?.jobId;
  if (!isUuid(candidateId) || !isUuid(employerId) || !isUuid(jobId)) {
    return NextResponse.json({ error: "candidateId, employerId and jobId must be UUIDs." }, { status: 400 });
  }

  const session = await requireSession();
  if (isResponse(session)) return session;
  const { user, caller, adminClient } = session;

  const callerIsCandidate = caller.role === "candidate" && user.id === candidateId;
  const callerIsEmployer = caller.role === "employer" && user.id === employerId;
  if (!callerIsCandidate && !callerIsEmployer) {
    return NextResponse.json({ error: "You are not a party to this match." }, { status: 403 });
  }
  const otherUserId = callerIsCandidate ? employerId : candidateId;
  const { data: other } = await adminClient.from("users").select("role").eq("id", otherUserId).maybeSingle();
  const expectedOtherRole = callerIsCandidate ? "employer" : "candidate";
  if (!other || other.role !== expectedOtherRole) {
    return NextResponse.json({ error: "A match is between a candidate and an employer." }, { status: 403 });
  }

  const { data: job } = await adminClient.from("job_posts").select("employer_id").eq("id", jobId).maybeSingle();
  if (!job || job.employer_id !== employerId) {
    return NextResponse.json({ error: "That job does not belong to this employer." }, { status: 403 });
  }

  const [candidateInterested, employerInterested] = await Promise.all([
    interestExists(adminClient, candidateId, employerId, jobId),
    interestExists(adminClient, employerId, candidateId, jobId)
  ]);
  if (!candidateInterested || !employerInterested) {
    return NextResponse.json(
      { error: "A match requires interest from both sides.", candidateInterested, employerInterested },
      { status: 409 }
    );
  }

  const { data: existing } = await adminClient
    .from("matches")
    .select("id")
    .eq("candidate_id", candidateId)
    .eq("employer_id", employerId)
    .eq("job_id", jobId)
    .maybeSingle();

  const matchPercent = await storedEmployerMatchScore(adminClient, employerId, candidateId, jobId);

  const { error } = await adminClient.from("matches").upsert(
    {
      candidate_id: candidateId,
      employer_id: employerId,
      job_id: jobId,
      capability_match: matchPercent,
      score: matchPercent,
      status: "mutual_match"
    },
    { onConflict: "candidate_id,employer_id,job_id" }
  );
  if (error) {
    console.error("[api/matches] upsert failed", { candidateId, employerId, jobId, error: error.message });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, created: !existing });
}
