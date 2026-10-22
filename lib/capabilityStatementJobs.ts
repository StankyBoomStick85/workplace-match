// Background jobs for Tier 1 capability statement synthesis. Server-only.
//
// Why a chain of steps: a full claude-fable-5-1 synthesis (initial call plus
// up to two targeted retries) takes ~320s, longer than one 300s function
// invocation. Each model call is therefore its own step in its own
// invocation; the resumable SynthesisState (lib/capabilityStatements.ts) is
// saved to capability_statement_jobs between steps.
//
// Flow:
//   admin POST /api/admin/synthesize-capability-statements
//     -> createJob() inserts the row, triggers step 1, returns 202 immediately
//   POST /api/admin/capability-statement-jobs/step  (server-to-server, HMAC token)
//     -> responds 202 at once, then in the background claims the step, runs one
//        model call, saves state, and triggers the next step - or finishes:
//        stores the result, writes candidate_profiles unless dry_run, and
//        reports any non-ok outcome to error_logs.
//   admin GET /api/admin/synthesize-capability-statements?jobId=...
//     -> getJobStatus(), which also fails and reports a stalled step.
//
// Failures log to error_logs through reportGenerationFailure, like the rest of
// the pipeline. A step killed at the function limit leaves its own watchdog row
// (lib/generationRunGuard.ts) and is marked failed on the next status check.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import type { EvidenceGroup, StoredDoc } from "@/lib/capabilityPipeline";
import {
  DEFAULT_SYNTHESIS_MODEL,
  createSynthesisState,
  finishSynthesis,
  runSynthesisStep,
  type SynthesisInput,
  type SynthesisResult,
  type SynthesisState,
} from "@/lib/capabilityStatements";
import { reportGenerationFailure } from "@/lib/generationAlerts";
import { sendEmail } from "@/lib/email";

export const JOB_TABLE = "capability_statement_jobs";
export const STEP_PATH = "/api/admin/capability-statement-jobs/step";
export const JOB_ROUTE = "capability-statement-jobs";
// A step past this age without progress was killed by the platform (the step
// route's maxDuration is 300s).
export const STEP_STALE_MS = 330_000;

export type JobStatus = "running" | "succeeded" | "failed";

export type JobRow = {
  id: string;
  created_at: string;
  updated_at: string;
  user_id: string;
  requested_by: string | null;
  model: string;
  dry_run: boolean;
  status: JobStatus;
  step_seq: number;
  step_started_at: string | null;
  input: SynthesisInput;
  state: SynthesisState;
  result: (SynthesisResult & { written?: boolean; writeError?: string | null }) | null;
  error: string | null;
};

// ---------- step authentication ----------

// Steps are triggered server-to-server, with no user session. Each trigger
// carries an HMAC of (jobId, seq) keyed by the service-role key, so only this
// server can start a step and a token cannot be replayed for another step.
function stepSecret(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured");
  return key;
}

export function stepToken(jobId: string, seq: number): string {
  return createHmac("sha256", stepSecret()).update(`capability-statement-job:${jobId}:${seq}`).digest("hex");
}

export function verifyStepToken(jobId: string, seq: number, token: string): boolean {
  const expected = Buffer.from(stepToken(jobId, seq), "hex");
  const given = Buffer.from(typeof token === "string" ? token : "", "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

// Fire one step. The step route answers 202 before doing any work, so this
// returns quickly; a failed trigger is reported, never thrown.
export async function triggerStep(adminClient: SupabaseClient, origin: string, job: { id: string; user_id: string }, seq: number): Promise<void> {
  try {
    const res = await fetch(`${origin}${STEP_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: job.id, seq, token: stepToken(job.id, seq) }),
    });
    if (res.status !== 202) throw new Error(`step route answered ${res.status}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await failJob(adminClient, job, "capability_statements_trigger_failed", `Could not start step ${seq}: ${message}`, { seq });
  }
}

// ---------- job lifecycle ----------

export async function createJob(
  adminClient: SupabaseClient,
  args: { userId: string; requestedBy: string; model?: string; dryRun: boolean }
): Promise<{ job: JobRow } | { error: string; httpStatus: number }> {
  const { data: profile, error: profileError } = await adminClient
    .from("candidate_profiles")
    .select("display_name, pending_evidence_groups, document_metadata")
    .eq("user_id", args.userId)
    .maybeSingle();
  if (profileError) return { error: `Failed to load profile: ${profileError.message}`, httpStatus: 500 };
  if (!profile) return { error: "No profile for that userId.", httpStatus: 404 };
  const groups: EvidenceGroup[] = Array.isArray(profile.pending_evidence_groups) ? (profile.pending_evidence_groups as EvidenceGroup[]) : [];
  if (groups.length === 0) return { error: "Profile has no saved evidence groups. Run capability generation first.", httpStatus: 400 };

  // Snapshot the input so every step works from the same evidence even if
  // the profile is regenerated mid-job. Only the document fields synthesis
  // reads are kept.
  const docs = Array.isArray(profile.document_metadata) ? (profile.document_metadata as StoredDoc[]) : [];
  const input: SynthesisInput = {
    groups,
    storedDocs: docs.map((d) => ({ id: d.id, label: d.label, contentType: d.contentType }) as StoredDoc),
    knownFullName: profile.display_name ?? null,
  };
  const model = args.model ?? DEFAULT_SYNTHESIS_MODEL;

  const { data, error } = await adminClient
    .from(JOB_TABLE)
    .insert({
      user_id: args.userId,
      requested_by: args.requestedBy,
      model,
      dry_run: args.dryRun,
      status: "running",
      step_seq: 0,
      input,
      state: createSynthesisState(model),
    })
    .select("*")
    .single();
  if (error || !data) return { error: `Failed to create job: ${error?.message ?? "no row returned"}`, httpStatus: 500 };
  return { job: data as JobRow };
}

async function failJob(
  adminClient: SupabaseClient,
  job: { id: string; user_id: string },
  errorType: string,
  message: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  const { error } = await adminClient
    .from(JOB_TABLE)
    .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
    .eq("id", job.id);
  if (error) console.error(`[${JOB_ROUTE}] failed to mark job ${job.id} failed`, error);
  await reportGenerationFailure({
    adminClient,
    sendEmailFn: sendEmail,
    route: JOB_ROUTE,
    errorType,
    message,
    userId: job.user_id,
    metadata: { jobId: job.id, ...metadata },
  });
}

export type StepOutcome =
  | { kind: "not_claimed" }
  | { kind: "continue"; nextSeq: number }
  | { kind: "finished"; status: JobStatus };

// Claims step `seq`, runs exactly one synthesis step, and saves the result.
// Claiming is an atomic conditional update: it succeeds only when the job is
// still running and the previous step was seq - 1.
export async function runJobStep(adminClient: SupabaseClient, jobId: string, seq: number): Promise<StepOutcome> {
  const { data: claimed, error: claimError } = await adminClient
    .from(JOB_TABLE)
    .update({ step_seq: seq, step_started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", jobId)
    .eq("status", "running")
    .eq("step_seq", seq - 1)
    .select("*")
    .maybeSingle();
  if (claimError) throw new Error(`claim failed: ${claimError.message}`);
  if (!claimed) return { kind: "not_claimed" };
  const job = claimed as JobRow;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    await failJob(adminClient, job, "capability_statements_step_failed", "ANTHROPIC_API_KEY not configured", { seq });
    return { kind: "finished", status: "failed" };
  }

  const next = await runSynthesisStep(job.state, { ...job.input, anthropic: new Anthropic({ apiKey }) });

  if (next.next !== "done") {
    const { error } = await adminClient
      .from(JOB_TABLE)
      .update({ state: next, updated_at: new Date().toISOString() })
      .eq("id", jobId);
    if (error) {
      await failJob(adminClient, job, "capability_statements_step_failed", `Failed to save state after step ${seq}: ${error.message}`, { seq });
      return { kind: "finished", status: "failed" };
    }
    return { kind: "continue", nextSeq: seq + 1 };
  }

  const result = finishSynthesis(next, job.input);
  let written = false;
  let writeError: string | null = null;
  if (!job.dry_run && result.status === "ok") {
    const { error } = await adminClient
      .from("candidate_profiles")
      .update({
        capability_statements: result.core,
        niche_capabilities: result.niche,
        capability_profile_generated_at: result.generatedAt,
      })
      .eq("user_id", job.user_id);
    if (error) writeError = error.message;
    else written = true;
  }

  const status: JobStatus = result.status === "ok" && !writeError ? "succeeded" : "failed";
  const errorText =
    result.status !== "ok"
      ? `synthesis ${result.status}: ${result.notes.join("; ")}`
      : writeError
        ? `candidate_profiles write failed: ${writeError}`
        : null;
  const { error: saveError } = await adminClient
    .from(JOB_TABLE)
    .update({ state: next, result: { ...result, written, writeError }, status, error: errorText, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (saveError) console.error(`[${JOB_ROUTE}] failed to save final result for job ${jobId}`, saveError);

  if (status === "failed") {
    await reportGenerationFailure({
      adminClient,
      sendEmailFn: sendEmail,
      route: JOB_ROUTE,
      errorType: writeError ? "capability_statements_write_failed" : `capability_statements_${result.status}`,
      message: errorText ?? "capability statement job failed",
      userId: job.user_id,
      severity: result.status === "insufficient" ? "medium" : "high",
      metadata: {
        jobId,
        model: job.model,
        dryRun: job.dry_run,
        coreCount: result.core.length,
        nicheCount: result.niche.length,
        rejectedCount: result.rejected.length,
        calls: result.calls,
        notes: result.notes,
      },
    });
  }
  return { kind: "finished", status };
}

// Status for the admin route. A running job whose current step is older than
// the function limit was killed by the platform: mark it failed and report it
// (once - the conditional update makes the second caller a no-op).
export async function getJobStatus(adminClient: SupabaseClient, jobId: string): Promise<JobRow | null> {
  const { data, error } = await adminClient.from(JOB_TABLE).select("*").eq("id", jobId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const job = data as JobRow;
  if (job.status === "running" && job.step_started_at && Date.now() - Date.parse(job.step_started_at) > STEP_STALE_MS) {
    const message = `Step ${job.step_seq} made no progress for over ${Math.round(STEP_STALE_MS / 1000)}s - the function was most likely killed at its time limit`;
    const { data: marked } = await adminClient
      .from(JOB_TABLE)
      .update({ status: "failed", error: message, updated_at: new Date().toISOString() })
      .eq("id", jobId)
      .eq("status", "running")
      .eq("step_seq", job.step_seq)
      .select("id")
      .maybeSingle();
    if (marked) {
      await reportGenerationFailure({
        adminClient,
        sendEmailFn: sendEmail,
        route: JOB_ROUTE,
        errorType: "capability_statements_stalled",
        message,
        userId: job.user_id,
        metadata: { jobId, stepSeq: job.step_seq, stepStartedAt: job.step_started_at, model: job.model },
      });
      return { ...job, status: "failed", error: message };
    }
  }
  return job;
}
