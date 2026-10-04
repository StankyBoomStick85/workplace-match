import type { SupabaseClient } from "@supabase/supabase-js";

// The match percentage stored on a matches row and shown to an employer in an
// interest notification. Always read server-side; any matchPercent a client
// sends is ignored.
//
// Source: public.employer_match_scores for (job owner, candidate, job) - the
// employer-direction AI score ("could this candidate do this job"), the same
// number the employer's Find Applicants badge shows
// (app/api/scoring/score-candidates-for-job). Deliberately NOT match_scores:
// that table is candidate-direction and per lens - quick mode is a 0/100
// "can anyone start this week" classifier, and career mode scores capable
// candidates LOW on roles below their level by design ("capability is not
// fit") - so it answers a different question than the one an employer is
// being told about, and it expires.
//
// Returns null when the employer has never had this candidate scored for this
// job. Callers store null and omit the percentage - a missing score is never
// shown as 0%. A stored score of 0 is a real score and is returned as 0.
export async function storedEmployerMatchScore(
  adminClient: SupabaseClient,
  employerId: string,
  candidateId: string,
  jobId: string
): Promise<number | null> {
  const { data, error } = await adminClient
    .from("employer_match_scores")
    .select("score")
    .eq("employer_id", employerId)
    .eq("candidate_id", candidateId)
    .eq("job_id", jobId)
    .maybeSingle();
  if (error) {
    console.error("[serverMatchScore] employer_match_scores lookup failed", { employerId, candidateId, jobId, error: error.message });
    return null;
  }
  const score = data?.score;
  return typeof score === "number" && Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;
}
