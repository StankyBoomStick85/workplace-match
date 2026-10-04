import type { SupabaseClient } from "@supabase/supabase-js";

// Server-only checks for "do these two users have a real relationship on this
// job". Shared by every route that lets one user cause a write or a message
// that reaches another user (api/email/notification, api/notifications,
// api/messages, api/matches, api/interests), so there is exactly one
// definition of a relationship instead of one per route.
//
// Every id passed in here must already be validated with isUuid(): the ids
// are interpolated into PostgREST or() filters, and anything that is not a
// plain UUID could inject filter syntax.

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// True when the two users share, on this job: an interest in either direction
// (any status), a matches row (either side as candidate), or a message thread.
export async function hasRelationship(adminClient: SupabaseClient, a: string, b: string, jobId: string): Promise<boolean> {
  const [interests, matches, messages] = await Promise.all([
    adminClient
      .from("interests")
      .select("id")
      .eq("job_id", jobId)
      .or(`and(from_user_id.eq.${a},to_user_id.eq.${b}),and(from_user_id.eq.${b},to_user_id.eq.${a})`)
      .limit(1),
    adminClient
      .from("matches")
      .select("id")
      .eq("job_id", jobId)
      .or(`and(candidate_id.eq.${a},employer_id.eq.${b}),and(candidate_id.eq.${b},employer_id.eq.${a})`)
      .limit(1),
    adminClient
      .from("match_messages")
      .select("id")
      .eq("job_id", jobId)
      .or(`and(applicant_id.eq.${a},employer_id.eq.${b}),and(applicant_id.eq.${b},employer_id.eq.${a})`)
      .limit(1)
  ]);
  for (const result of [interests, matches, messages]) {
    if (result.error) {
      console.error("[serverRelationships] relationship lookup failed", result.error);
      continue;
    }
    if ((result.data ?? []).length > 0) return true;
  }
  return false;
}

// A pending interest from -> to on this job.
export async function interestExists(adminClient: SupabaseClient, fromUserId: string, toUserId: string, jobId: string): Promise<boolean> {
  const { data, error } = await adminClient
    .from("interests")
    .select("id")
    .eq("from_user_id", fromUserId)
    .eq("to_user_id", toUserId)
    .eq("job_id", jobId)
    .limit(1);
  if (error) {
    console.error("[serverRelationships] interest lookup failed", error);
    return false;
  }
  return (data ?? []).length > 0;
}

// A mutual match between this candidate and employer on this job.
export async function matchExists(adminClient: SupabaseClient, candidateId: string, employerId: string, jobId: string): Promise<boolean> {
  const { data, error } = await adminClient
    .from("matches")
    .select("id")
    .eq("candidate_id", candidateId)
    .eq("employer_id", employerId)
    .eq("job_id", jobId)
    .limit(1);
  if (error) {
    console.error("[serverRelationships] match lookup failed", error);
    return false;
  }
  return (data ?? []).length > 0;
}
