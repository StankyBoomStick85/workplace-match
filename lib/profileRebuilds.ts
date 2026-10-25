// Candidate-triggered profile rebuilds. Server-only.
//
// Two kinds, both run as capability statement jobs (lib/capabilityStatementJobs.ts)
// so every write goes through the same checks as an admin run:
//   "summary" - summary-only job: regenerates employer_summary from the
//               statements already stored (e.g. after a direction change).
//   "full"    - full synthesis job: rebuilds statements and niche skills, then
//               the summary (e.g. automatically after profile generation).
//
// Limits per candidate, over a rolling 24 hours: REBUILD_LIMITS. While a job
// for the candidate is running, a new request is queued instead of started -
// exactly one follow-up, upgraded to "full" if either request was full - and
// startQueuedRebuild starts it when the running job finishes.
//
// Every request is recorded in profile_rebuild_log (status: started, queued,
// dequeued, superseded, limited, skipped).

import type { SupabaseClient } from "@supabase/supabase-js";
import { JOB_TABLE, STEP_STALE_MS, createJob, getJobStatus, triggerStep } from "@/lib/capabilityStatementJobs";
import { reportGenerationFailure } from "@/lib/generationAlerts";
import { sendEmail } from "@/lib/email";
import { buildSummaryNotice, setSummaryNotice } from "@/lib/summaryNotice";

export type RebuildKind = "summary" | "full";
export type RebuildSource = "direction_change" | "after_generation" | "candidate_request" | "queued_follow_up";

export const REBUILD_LIMITS: Record<RebuildKind, number> = { full: 3, summary: 20 };
export const REBUILD_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REBUILD_LOG_TABLE = "profile_rebuild_log";

export type RebuildOutcome =
  | { status: "started"; kind: RebuildKind; jobId: string }
  | { status: "queued"; kind: RebuildKind }
  | { status: "limited"; kind: RebuildKind; limit: number }
  | { status: "skipped"; kind: RebuildKind; reason: string }
  | { status: "failed"; kind: RebuildKind; reason: string };

async function log(
  adminClient: SupabaseClient,
  row: { user_id: string; kind: RebuildKind; status: string; source: RebuildSource; job_id?: string | null; detail?: string | null }
): Promise<void> {
  const { error } = await adminClient.from(REBUILD_LOG_TABLE).insert(row);
  if (error) console.error("[profileRebuilds] failed to write rebuild log", { row, error: error.message });
}

// The candidate's running job, if any. Stale jobs (killed at the function
// limit, or never started) are marked failed on the way and do not count.
async function findRunningJob(adminClient: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await adminClient
    .from(JOB_TABLE)
    .select("id, created_at, step_started_at")
    .eq("user_id", userId)
    .eq("status", "running")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`could not check running jobs: ${error.message}`);
  for (const row of data ?? []) {
    if (!row.step_started_at && Date.now() - Date.parse(row.created_at) > STEP_STALE_MS) {
      await adminClient
        .from(JOB_TABLE)
        .update({ status: "failed", error: "never started", updated_at: new Date().toISOString() })
        .eq("id", row.id)
        .eq("status", "running");
      continue;
    }
    const job = await getJobStatus(adminClient, row.id);
    if (job?.status === "running") return row.id;
  }
  return null;
}

async function startedInWindow(adminClient: SupabaseClient, userId: string, kind: RebuildKind): Promise<number> {
  const since = new Date(Date.now() - REBUILD_WINDOW_MS).toISOString();
  const { count, error } = await adminClient
    .from(REBUILD_LOG_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("kind", kind)
    .eq("status", "started")
    .gte("created_at", since);
  if (error) throw new Error(`could not count rebuilds: ${error.message}`);
  return count ?? 0;
}

async function pendingQueued(adminClient: SupabaseClient, userId: string): Promise<{ id: number; kind: RebuildKind } | null> {
  const { data, error } = await adminClient
    .from(REBUILD_LOG_TABLE)
    .select("id, kind")
    .eq("user_id", userId)
    .eq("status", "queued")
    .order("created_at", { ascending: true });
  if (error) throw new Error(`could not read queued rebuilds: ${error.message}`);
  if (!data || data.length === 0) return null;
  // Exactly one follow-up: collapse any extras (from a race) into the first.
  const kind: RebuildKind = data.some((r) => r.kind === "full") ? "full" : "summary";
  if (data.length > 1) {
    await adminClient.from(REBUILD_LOG_TABLE).update({ status: "superseded" }).in("id", data.slice(1).map((r) => r.id));
  }
  return { id: data[0].id as number, kind };
}

async function start(
  adminClient: SupabaseClient,
  origin: string,
  userId: string,
  kind: RebuildKind,
  source: RebuildSource
): Promise<RebuildOutcome> {
  const limit = REBUILD_LIMITS[kind];
  if ((await startedInWindow(adminClient, userId, kind)) >= limit) {
    await log(adminClient, { user_id: userId, kind, status: "limited", source, detail: `limit ${limit} per 24h reached` });
    await reportGenerationFailure({
      adminClient,
      sendEmailFn: sendEmail,
      route: "profile-rebuild",
      errorType: "profile_rebuild_limited",
      message: `${kind} rebuild not started: daily limit of ${limit} reached`,
      userId,
      severity: "medium",
      metadata: { kind, source, limit },
    });
    await setSummaryNotice(adminClient, userId, buildSummaryNotice("limited", `profile-rebuild/${source}`, true, limit));
    return { status: "limited", kind, limit };
  }

  const created = await createJob(adminClient, { userId, requestedBy: userId, dryRun: false, summaryOnly: kind === "summary" });
  if ("error" in created) {
    await log(adminClient, { user_id: userId, kind, status: "skipped", source, detail: created.error });
    return { status: "skipped", kind, reason: created.error };
  }
  await log(adminClient, { user_id: userId, kind, status: "started", source, job_id: created.job.id });
  await triggerStep(adminClient, origin, created.job, 1);
  return { status: "started", kind, jobId: created.job.id };
}

// Start a rebuild now, or queue it behind the candidate's running job.
export async function requestRebuild(
  adminClient: SupabaseClient,
  origin: string,
  userId: string,
  kind: RebuildKind,
  source: RebuildSource
): Promise<RebuildOutcome> {
  const running = await findRunningJob(adminClient, userId);
  const queued = await pendingQueued(adminClient, userId);

  if (running) {
    if (queued) {
      if (kind === "full" && queued.kind !== "full") {
        await adminClient.from(REBUILD_LOG_TABLE).update({ kind: "full" }).eq("id", queued.id);
      }
      return { status: "queued", kind: kind === "full" ? "full" : queued.kind };
    }
    await log(adminClient, { user_id: userId, kind, status: "queued", source, detail: `behind job ${running}` });
    return { status: "queued", kind };
  }

  // Nothing running: a queued follow-up left behind (its job died) is folded
  // into this request rather than started separately.
  let effectiveKind = kind;
  if (queued) {
    if (queued.kind === "full") effectiveKind = "full";
    await adminClient.from(REBUILD_LOG_TABLE).update({ status: "superseded" }).eq("id", queued.id);
  }
  return start(adminClient, origin, userId, effectiveKind, source);
}

// requestRebuild that never throws. A rebuild that cannot be started is
// logged to error_logs (the admin record) and shown to the candidate as a
// notice on their profile, so it never fails silently.
export async function requestRebuildSafely(
  adminClient: SupabaseClient,
  origin: string,
  userId: string,
  kind: RebuildKind,
  source: RebuildSource
): Promise<RebuildOutcome> {
  try {
    return await requestRebuild(adminClient, origin, userId, kind, source);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await reportGenerationFailure({
      adminClient,
      sendEmailFn: sendEmail,
      route: "profile-rebuild",
      errorType: "profile_rebuild_failed",
      message: `${kind} rebuild (${source}) could not be started: ${reason}`,
      userId,
      severity: "high",
      metadata: { kind, source },
    });
    await setSummaryNotice(adminClient, userId, buildSummaryNotice("failed", `profile-rebuild/${source}`, true));
    return { status: "failed", kind, reason };
  }
}

// Called when a candidate's job finishes (step route): starts the queued
// follow-up, if there is one.
export async function startQueuedRebuild(adminClient: SupabaseClient, origin: string, userId: string): Promise<RebuildOutcome | null> {
  const queued = await pendingQueued(adminClient, userId);
  if (!queued) return null;
  if (await findRunningJob(adminClient, userId)) return null;
  const { data: claimed } = await adminClient
    .from(REBUILD_LOG_TABLE)
    .update({ status: "dequeued" })
    .eq("id", queued.id)
    .eq("status", "queued")
    .select("id")
    .maybeSingle();
  if (!claimed) return null; // another finisher already took it
  return start(adminClient, origin, userId, queued.kind, "queued_follow_up");
}
