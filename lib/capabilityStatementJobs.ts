// Background jobs for Tier 1 capability statement synthesis. Server-only.
//
// Why a chain of steps: a full claude-fable-5-1 synthesis (core call, niche
// call, up to two targeted retries) takes far longer than one 300s function
// invocation, and one combined first call alone ran 307s. Each model call is
// therefore its own step in its own invocation, and each call is aborted at
// SYNTHESIS_CALL_TIMEOUT_MS (240s); the resumable SynthesisState
// (lib/capabilityStatements.ts) is saved to capability_statement_jobs between
// steps.
//
// Flow:
//   admin POST /api/admin/synthesize-capability-statements
//     -> createJob() inserts the row, triggers step 1, returns 202 immediately
//   POST /api/admin/capability-statement-jobs/step  (server-to-server, HMAC token)
//     -> responds 202 at once, then in the background claims the step, runs one
//        model call, saves state, and triggers the next step. After a
//        successful synthesis, one final step regenerates the employer summary
//        from the new statements and - unless dry_run, and only if the
//        evidence is unchanged - writes statements and summary together.
//        Any non-ok outcome is reported to error_logs.
//   admin GET /api/admin/synthesize-capability-statements?jobId=...
//     -> getJobStatus(), which also fails and reports a stalled step.
//
// Failures log to error_logs through reportGenerationFailure, like the rest of
// the pipeline. A step killed at the function limit leaves its own watchdog row
// (lib/generationRunGuard.ts) and is marked failed on the next status check.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildGuardRewritePrompt,
  employerSummaryStoreBlockers,
  generateEmployerSummary,
  type EmployerSummaryInput,
  type EvidenceGroup,
  type StoredDoc,
} from "@/lib/capabilityPipeline";
import { scanEmployerFacingText } from "@/lib/employerTextGuard";
import { readStoredDirection } from "@/lib/candidateDirection";
import { buildSummaryNotice } from "@/lib/summaryNotice";
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
  result: (SynthesisResult & { written?: boolean; writeError?: string | null; employerSummary?: JobEmployerSummary; summaryOnly?: boolean }) | null;
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
  // summaryOnly: regenerate only the employer summary from the statements
  // already stored on the profile. The job starts at the summary step, so the
  // write goes through exactly the same evidence check, identity guard, and
  // employerSummaryStoreBlockers gate as a full run - and writes only
  // employer_summary.
  args: { userId: string; requestedBy: string; model?: string; dryRun: boolean; summaryOnly?: boolean }
): Promise<{ job: JobRow } | { error: string; httpStatus: number }> {
  const { data: profile, error: profileError } = await adminClient
    .from("candidate_profiles")
    .select("display_name, summary, capability_tags, direction, tools, pending_evidence_groups, document_metadata, capability_statements, niche_capabilities, capability_profile_generated_at")
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
    context: {
      summary: profile.summary ?? null,
      capabilityTags: Array.isArray(profile.capability_tags) ? (profile.capability_tags as string[]) : null,
      direction: readStoredDirection(profile.direction),
      tools: Array.isArray(profile.tools) ? (profile.tools as string[]) : null,
    },
  };
  const model = args.model ?? DEFAULT_SYNTHESIS_MODEL;

  let state = createSynthesisState(model);
  let result: JobRow["result"] = null;
  if (args.summaryOnly) {
    const core = Array.isArray(profile.capability_statements) ? (profile.capability_statements as SynthesisResult["core"]) : [];
    if (core.length === 0) {
      return { error: "Profile has no capability statements to write the summary from. Run a full synthesis job first.", httpStatus: 400 };
    }
    state = { ...state, next: "done" };
    result = {
      status: "ok",
      model,
      generatedAt: profile.capability_profile_generated_at ?? new Date().toISOString(),
      core,
      niche: Array.isArray(profile.niche_capabilities) ? (profile.niche_capabilities as SynthesisResult["niche"]) : [],
      uncertainTerms: [],
      rejected: [],
      failureLog: [],
      calls: [],
      notes: ["summary-only job: statements reused from the profile, not regenerated"],
      summaryOnly: true,
    };
  }

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
      state,
      result,
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

// What the job did with the employer summary (written from the new statements).
export type JobEmployerSummary = {
  text: string | null;
  // A generated summary that was NOT stored (failed a check), kept on the
  // admin-only job row for review. Never written to the profile.
  rejectedText?: string | null;
  formatIssues: string[];
  guardViolations: Array<{ category: string; match: string }>;
  guardRewriteAttempted: boolean;
  written: boolean;
  skippedReason: string | null;
};

// Claims step `seq` and runs exactly one unit of work. Claiming is an atomic
// conditional update: it succeeds only when the job is still running and the
// previous step was seq - 1.
//
// Steps: synthesis (one model call each, until the synthesis state is done),
// then - only when synthesis succeeded - one final "summary" step that
// regenerates the employer summary from the new statements and writes
// everything. The summary is its own step so it never adds to a synthesis
// call's time budget. A job whose result is stored but is still running is
// waiting for that summary step.
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
  const anthropic = new Anthropic({ apiKey });

  if (job.result) return runSummaryStep(adminClient, job, seq, anthropic);

  const next = await runSynthesisStep(job.state, { ...job.input, anthropic });

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

  if (result.status !== "ok") {
    const errorText = `synthesis ${result.status}: ${result.notes.join("; ")}`;
    const { error: saveError } = await adminClient
      .from(JOB_TABLE)
      .update({ state: next, result: { ...result, written: false, writeError: null }, status: "failed", error: errorText, updated_at: new Date().toISOString() })
      .eq("id", jobId);
    if (saveError) console.error(`[${JOB_ROUTE}] failed to save final result for job ${jobId}`, saveError);
    await reportGenerationFailure({
      adminClient,
      sendEmailFn: sendEmail,
      route: JOB_ROUTE,
      errorType: `capability_statements_${result.status}`,
      message: errorText,
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
    return { kind: "finished", status: "failed" };
  }

  // Synthesis succeeded: park the result and hand off to the summary step.
  const { error: parkError } = await adminClient
    .from(JOB_TABLE)
    .update({ state: next, result: { ...result, written: false, writeError: null }, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (parkError) {
    await failJob(adminClient, job, "capability_statements_step_failed", `Failed to save synthesis result: ${parkError.message}`, { seq });
    return { kind: "finished", status: "failed" };
  }
  return { kind: "continue", nextSeq: seq + 1 };
}

async function runSummaryStep(adminClient: SupabaseClient, job: JobRow, seq: number, anthropic: Anthropic): Promise<StepOutcome> {
  const result = job.result!;

  const { data: profile, error: profileError } = await adminClient
    .from("candidate_profiles")
    .select("pending_evidence_groups, summary, direction, tools, job_types, work_preference, summary_priority")
    .eq("user_id", job.user_id)
    .maybeSingle();

  // Statements cite positional groupIds, so they are only valid against the
  // exact evidence they were built from. If the profile was regenerated while
  // this job ran, writing would attach statements to different evidence
  // (regeneration already cleared the old ones - see generate-capability).
  if (!job.dry_run) {
    const evidenceUnchanged =
      !profileError && !!profile && JSON.stringify(profile.pending_evidence_groups ?? null) === JSON.stringify(job.input.groups);
    if (!evidenceUnchanged) {
      const message = profileError ? `could not re-read evidence before writing: ${profileError.message}` : "evidence changed during job";
      await adminClient
        .from(JOB_TABLE)
        .update({ result: { ...result, written: false, writeError: message }, updated_at: new Date().toISOString() })
        .eq("id", job.id);
      await failJob(adminClient, job, "capability_statements_evidence_changed", message, {
        seq,
        snapshotGroupCount: job.input.groups.length,
        currentGroupCount: Array.isArray(profile?.pending_evidence_groups) ? profile.pending_evidence_groups.length : null,
      });
      return { kind: "finished", status: "failed" };
    }
  }

  // Employer summary from the new statements. A failure here never blocks the
  // statements: the previous summary simply stays in place, and it is logged.
  const summary: JobEmployerSummary = {
    text: null,
    formatIssues: [],
    guardViolations: [],
    guardRewriteAttempted: false,
    written: false,
    skippedReason: null,
  };
  const knownFullName = job.input.knownFullName;
  try {
    const summaryInput: EmployerSummaryInput = {
      capabilityStatements: result.core,
      capabilitySummary: "",
      selfSummary: profile?.summary ?? job.input.context?.summary ?? null,
      // Read fresh, not from the snapshot: a direction change made while the
      // job ran is what the new summary should reflect.
      direction: readStoredDirection(profile?.direction),
      tools: Array.isArray(profile?.tools) ? (profile.tools as string[]) : job.input.context?.tools ?? null,
      gapEvidence: job.input.groups.flatMap((g) => g.claims).join("\n"),
      desiredRoles: Array.isArray(profile?.job_types) && profile.job_types.length > 0 ? profile.job_types.join(", ") : null,
      workPreference: profile?.work_preference ?? null,
      isAlternateSummary: profile?.summary_priority === "alternate",
    };
    const generated = await generateEmployerSummary(anthropic, summaryInput);
    summary.formatIssues = generated.formatIssues;
    let text = generated.text;
    let violations = text ? scanEmployerFacingText(text, { knownFullName }) : [];
    if (text && violations.length > 0) {
      // Same targeted rewrite the finalize route uses for this field.
      summary.guardRewriteAttempted = true;
      const flags = violations.map((v) => ({ category: v.category, match: v.match }));
      const rewrite = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2048,
        temperature: 0.2,
        messages: [{ role: "user", content: buildGuardRewritePrompt("employer_summary", text, flags) }],
      });
      const rewritten = (rewrite.content.find((b) => b.type === "text") as { text?: string } | undefined)?.text?.trim() ?? "";
      const rewrittenViolations = rewritten ? scanEmployerFacingText(rewritten, { knownFullName }) : violations;
      if (rewritten && rewrittenViolations.length === 0) {
        text = rewritten;
        violations = [];
      } else {
        violations = rewrittenViolations;
      }
    }
    summary.guardViolations = violations.map((v) => ({ category: v.category, match: v.match }));
    // Re-checked on the final text: a guard rewrite can change the format.
    summary.formatIssues = text ? employerSummaryStoreBlockers(text, summaryInput) : summary.formatIssues;
    if (!text) summary.skippedReason = "empty response";
    else if (violations.length > 0) summary.skippedReason = "identity guard still flagged the summary after one rewrite";
    else if (summary.formatIssues.length > 0) summary.skippedReason = `failed format checks: ${summary.formatIssues.join(" ")}`;
    else summary.text = text;
    if (text && !summary.text) summary.rejectedText = text;
  } catch (err) {
    summary.skippedReason = `employer summary call failed: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (summary.skippedReason) {
    await reportGenerationFailure({
      adminClient,
      sendEmailFn: sendEmail,
      route: JOB_ROUTE,
      errorType: "capability_statements_summary_not_updated",
      message: `Employer summary not regenerated: ${summary.skippedReason}`,
      userId: job.user_id,
      severity: "medium",
      metadata: { jobId: job.id, dryRun: job.dry_run, formatIssues: summary.formatIssues, guardViolations: summary.guardViolations },
    });
  }

  let written = false;
  let writeError: string | null = null;
  if (!job.dry_run) {
    // A summary-only job writes nothing but the summary, and only when it
    // passed every check; otherwise the stored statements are rewritten as-is
    // alongside it.
    const update: Record<string, unknown> = result.summaryOnly
      ? {}
      : {
          capability_statements: result.core,
          niche_capabilities: result.niche,
          capability_profile_generated_at: result.generatedAt,
        };
    if (summary.text) update.employer_summary = summary.text;
    // The candidate sees whether this worked: a stored summary clears the
    // notice; a blocked one sets it (the previous summary stays).
    update.employer_summary_notice = summary.text
      ? null
      : buildSummaryNotice(summary.skippedReason?.startsWith("employer summary call failed") ? "failed" : "blocked", JOB_ROUTE, true);
    if (Object.keys(update).length > 0) {
      const { error } = await adminClient.from("candidate_profiles").update(update).eq("user_id", job.user_id);
      if (error) writeError = error.message;
      else {
        written = true;
        summary.written = Boolean(summary.text);
      }
    }
  }

  // A summary-only job exists to produce a summary; one that was blocked failed.
  const summaryOnlyBlocked = Boolean(result.summaryOnly) && !summary.text;
  const status: JobStatus = writeError || summaryOnlyBlocked ? "failed" : "succeeded";
  const errorText = writeError
    ? `candidate_profiles write failed: ${writeError}`
    : summaryOnlyBlocked
      ? `employer summary not stored: ${summary.skippedReason ?? "unknown"}`
      : null;
  const { error: saveError } = await adminClient
    .from(JOB_TABLE)
    .update({ result: { ...result, written, writeError, employerSummary: summary }, status, error: errorText, updated_at: new Date().toISOString() })
    .eq("id", job.id);
  if (saveError) console.error(`[${JOB_ROUTE}] failed to save final result for job ${job.id}`, saveError);

  if (writeError) {
    await reportGenerationFailure({
      adminClient,
      sendEmailFn: sendEmail,
      route: JOB_ROUTE,
      errorType: "capability_statements_write_failed",
      message: errorText!,
      userId: job.user_id,
      metadata: { jobId: job.id, model: job.model },
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
