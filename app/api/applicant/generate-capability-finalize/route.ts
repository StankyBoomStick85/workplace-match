import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildStep3Prompt,
  buildStep3GuardRetryPrompt,
  buildGuardRewritePrompt,
  buildStep4Prompt,
  buildEmployerSummaryUserPrompt,
  parseStep3Response,
  extractStep4Sections,
  EMPLOYER_SUMMARY_SYSTEM_PROMPT,
  STEP3_CATEGORY_RANK,
  type Step3Category,
  type EvidenceGroup,
  type StoredDoc,
  type CapabilityEntry
} from "@/lib/capabilityPipeline";
import {
  scanEmployerFacingText,
  reportTextGuardViolation,
  scanCapabilityEntries,
  buildGuardAbortViolationRows,
  type TextGuardViolation
} from "@/lib/employerTextGuard";
import { reportGenerationFailure } from "@/lib/generationAlerts";
import { createRunContext, runWithGenerationGuard, type GenerationRunContext } from "@/lib/generationRunGuard";
import { sendEmail } from "@/lib/email";
import { addNotificationByUserId } from "@/lib/supabaseMvpData";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ROUTE = "generate-capability-finalize";
const STEP3_MODEL = "claude-sonnet-4-6";
const STEP3_MAX_TOKENS = 8192;

// Every Step 3 call - the initial naming pass AND the targeted retries - runs
// over chunks of at most this many groups, in parallel. The 2026-09-30 run sent
// all 129 groups in one call: it hit max_tokens (8192) after 117 entries, and at
// the ~41 output tokens/s measured for this prompt that single call alone took
// ~180s of the 300s maxDuration, leaving no room for a retry plus Step 4 and the
// employer summary. 25 groups is ~2.5k output tokens (~60s), far below the
// ceiling, and the chunks run concurrently so Step 3's wall time stays roughly
// constant as the group count grows (Step 2 already fans its 7 batches out the
// same way).
const STEP3_CHUNK_SIZE = 25;

// Elapsed-time cutoffs (from request start) past which a retry is SKIPPED and
// the run fails with a logged reason, instead of starting work that the 300s
// maxDuration would kill mid-flight with nothing recorded. Step 4 + the
// employer summary (~50s together) still have to run after the Step 3 / entry
// retries.
const STEP3_RETRY_DEADLINE_MS = 185_000;
const GUARD_ENTRY_RETRY_DEADLINE_MS = 195_000;
const GUARD_ENTRY_RETRY_ATTEMPTS = 2;
const GUARD_FIELD_RETRY_DEADLINE_MS = 255_000;

type ChunkRecord = {
  chunkIndex: number;
  groupIds: string[];
  stopReason: string | null;
  parsedCount: number;
  expectedCount: number;
  missingGroupIds: string[];
  // Emitted twice (only the first kept) / emitted but not in this chunk (e.g. a
  // mistyped groupId) - both explain an otherwise puzzling missing group.
  duplicateGroupIds: string[];
  unknownGroupIds: string[];
  error: string | null;
  elapsedMs: number;
  outputTokens: number | null;
  rawLength: number;
  raw: string;
};

// A response cut off at max_tokens ends mid-line, and that last partial line
// still matches the entry regex - its description is simply cut short. Dropping
// everything after the final newline discards that one partial entry so its
// group is reported missing (and retried) rather than silently saved truncated.
function trimTruncatedTail(raw: string): string {
  const lastNewline = raw.lastIndexOf("\n");
  return lastNewline === -1 ? "" : raw.slice(0, lastNewline);
}

// Evenly sized chunks of at most `maxSize` (129 -> 22x5 + 19, not
// 25x5 + 4), so no single call is the long pole.
function chunk<T>(items: T[], maxSize: number): T[][] {
  if (items.length === 0) return [];
  const count = Math.ceil(items.length / maxSize);
  const size = Math.ceil(items.length / count);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function buildCapabilitySummary(entries: CapabilityEntry[]): string {
  return entries.map((e) => `**${e.name}** [${e.verificationStatus}]: ${e.description}`).join("\n\n");
}

export async function POST() {
  const t0 = Date.now();
  const ctx = createRunContext(ROUTE, t0);
  return runWithGenerationGuard(ctx, maxDuration, () => finalize(ctx, t0));
}

async function finalize(ctx: GenerationRunContext, t0: number): Promise<Response> {
  console.log("[generate-capability-finalize][timing] START t0=" + t0);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return NextResponse.json({ error: "Server configuration missing." }, { status: 500 });
  }

  ctx.stage = "auth";
  const cookieStore = cookies();
  const authClient = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) { return cookieStore.get(name)?.value; },
      set(name: string, value: string, options: CookieOptions) { cookieStore.set(name, value, options); },
      remove(name: string, options: CookieOptions) { cookieStore.set(name, "", options); }
    }
  });

  const { data: { user }, error: userError } = await authClient.auth.getUser();
  const t1 = Date.now();
  console.log("[generate-capability-finalize][timing] after getUser() t1=" + t1 + " delta=" + (t1 - t0) + "ms");
  if (userError || !user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  ctx.userId = user.id;

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Every FATAL failure goes through this so the run guard knows a record was
  // actually written. Non-fatal warnings keep calling reportGenerationFailure
  // directly - they must not mark the run as "failure already logged".
  const reportFatal = async (args: {
    errorType: string;
    message: string;
    severity?: "high" | "medium";
    metadata?: Record<string, unknown>;
  }) => {
    const ok = await reportGenerationFailure({
      adminClient,
      sendEmailFn: sendEmail,
      route: ROUTE,
      userId: user.id,
      ...args,
      metadata: { stage: ctx.stage, elapsedMs: Date.now() - t0, ...args.metadata }
    });
    if (ok) ctx.failureLogged = true;
  };

  ctx.stage = "load_profile";
  const { data: profile, error: profileError } = await adminClient
    .from("candidate_profiles")
    .select("display_name, job_types, experience_level, work_preference, capability_tags, summary, summary_priority, pending_evidence_groups, capability_generation_status, document_metadata")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json({ error: "Failed to load profile." }, { status: 500 });
  }
  if (!profile) {
    return NextResponse.json(
      { error: "No profile found. Please save your profile first." },
      { status: 400 }
    );
  }

  if (profile.capability_generation_status !== "groups_ready" || !profile.pending_evidence_groups) {
    // Previously an unlogged 400 - and the one every "Retry finishing your
    // profile" click hit after a failed run left the status at
    // "writing_profile". Reported explicitly (with the status it saw) so a
    // stuck gate is visible instead of looking like the retry did nothing.
    await reportFatal({
      errorType: "finalize_gate_rejected",
      message: `Finalize rejected: capability_generation_status is "${profile.capability_generation_status}" (needs "groups_ready"), pending_evidence_groups ${profile.pending_evidence_groups ? "present" : "missing"}`,
      severity: "medium",
      metadata: {
        capabilityGenerationStatus: profile.capability_generation_status,
        hasPendingEvidenceGroups: Boolean(profile.pending_evidence_groups)
      }
    });
    return NextResponse.json(
      { error: "No pending evidence groups found. Please run capability generation from the start." },
      { status: 400 }
    );
  }

  // Phase feedback: written after the "groups_ready" gate check above (never
  // before it - overwriting that value before checking it would break the gate)
  // so a client polling this profile mid-request sees the real final stage
  // running. Overwritten by "complete" on success; on ANY failure the run guard
  // puts it back to "groups_ready" (pending_evidence_groups is retained), so the
  // client's retry-finalize path can pass the gate above again.
  const { error: phaseStatusError } = await adminClient
    .from("candidate_profiles")
    .update({ capability_generation_status: "writing_profile" })
    .eq("user_id", user.id);
  if (phaseStatusError) {
    console.error("[generate-capability-finalize] Failed to write writing_profile status", phaseStatusError);
  }
  ctx.statusOnFailure = "groups_ready";

  const evidenceGroups: EvidenceGroup[] = Array.isArray(profile.pending_evidence_groups)
    ? (profile.pending_evidence_groups as EvidenceGroup[])
    : [];

  const storedDocs: StoredDoc[] = Array.isArray(profile.document_metadata)
    ? (profile.document_metadata as StoredDoc[])
    : [];

  const t2 = Date.now();
  console.log("[generate-capability-finalize][timing] after profile query t2=" + t2 + " delta=" + (t2 - t1) + "ms groupCount=" + evidenceGroups.length);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI service not configured." }, { status: 500 });
  }

  const desiredRole = Array.isArray(profile.job_types) && profile.job_types.length > 0
    ? profile.job_types.join(", ")
    : "Not specified";
  const skills = Array.isArray(profile.capability_tags) && profile.capability_tags.length > 0
    ? profile.capability_tags.join(", ")
    : "Not specified";

  const anthropic = new Anthropic({ apiKey });
  const knownFullName = profile.display_name ?? null;

  // Runs Step 3 over `groups` in parallel chunks, each with its own prompt, and
  // returns every parsed entry (with its groupId and category tag) plus every
  // groupId that did not come back. A chunk that throws or truncates degrades
  // to "its groups are missing" - never to a silently shorter list.
  const runStep3Chunks = async (
    groups: EvidenceGroup[],
    buildPrompt: (chunkGroups: EvidenceGroup[]) => string
  ): Promise<{
    entries: CapabilityEntry[];
    groupIds: string[];
    categories: Array<Step3Category | null>;
    missingGroupIds: string[];
    chunks: ChunkRecord[];
  }> => {
    const chunks = chunk(groups, STEP3_CHUNK_SIZE);
    const records = await Promise.all(
      chunks.map(async (chunkGroups, chunkIndex) => {
        const base = { chunkIndex, groupIds: chunkGroups.map((g) => g.groupId), expectedCount: chunkGroups.length };
        const tChunk = Date.now();
        try {
          const response = await anthropic.messages.create({
            model: STEP3_MODEL,
            max_tokens: STEP3_MAX_TOKENS,
            temperature: 0.2,
            messages: [{ role: "user", content: buildPrompt(chunkGroups) }],
          });
          const raw = response.content.find((b) => b.type === "text")?.text ?? "";
          const parseInput = response.stop_reason === "max_tokens" ? trimTruncatedTail(raw) : raw;
          const parsed = parseStep3Response(parseInput, chunkGroups, storedDocs);
          const entries = parsed.kind === "entries" ? parsed.capabilityEntries : parsed.matchedEntries;
          const groupIds = parsed.kind === "entries" ? parsed.entryGroupIds : parsed.matchedEntryGroupIds;
          const categories = parsed.kind === "entries" ? parsed.entryCategories : parsed.matchedEntryCategories;
          const missing = base.groupIds.filter((id) => !groupIds.includes(id));
          const unknownGroupIds = Array.from(parseInput.matchAll(/^\[([\w-]+)\]/gm), (m) => m[1]).filter((id) => !base.groupIds.includes(id));
          const record: ChunkRecord = {
            ...base,
            stopReason: response.stop_reason,
            parsedCount: entries.length,
            missingGroupIds: missing,
            duplicateGroupIds: parsed.duplicateGroupIds,
            unknownGroupIds,
            error: null,
            elapsedMs: Date.now() - tChunk,
            outputTokens: response.usage?.output_tokens ?? null,
            rawLength: raw.length,
            raw
          };
          return { entries, groupIds, categories, record };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error("[generate-capability-finalize] Step 3 chunk " + chunkIndex + " threw", err);
          const record: ChunkRecord = {
            ...base,
            stopReason: null,
            parsedCount: 0,
            missingGroupIds: base.groupIds,
            duplicateGroupIds: [],
            unknownGroupIds: [],
            error: message,
            elapsedMs: Date.now() - tChunk,
            outputTokens: null,
            rawLength: 0,
            raw: ""
          };
          return { entries: [] as CapabilityEntry[], groupIds: [] as string[], categories: [] as Array<Step3Category | null>, record };
        }
      })
    );
    for (const r of records) {
      console.log(
        "[generate-capability-finalize][timing] step3 chunk " + r.record.chunkIndex + " delta=" + r.record.elapsedMs + "ms" +
        " groups=" + r.record.expectedCount + " parsed=" + r.record.parsedCount + " stopReason=" + r.record.stopReason +
        " outputTokens=" + r.record.outputTokens + (r.record.error ? " error=" + JSON.stringify(r.record.error) : "")
      );
    }
    return {
      entries: records.flatMap((r) => r.entries),
      groupIds: records.flatMap((r) => r.groupIds),
      categories: records.flatMap((r) => r.categories),
      missingGroupIds: records.flatMap((r) => r.record.missingGroupIds),
      chunks: records.map((r) => r.record)
    };
  };
  const chunkSummaries = (chunks: ChunkRecord[]) =>
    chunks.map(({ raw: _raw, ...rest }) => rest);

  // --- Step 3: civilian-language naming pass ---
  const t6 = Date.now();

  let capabilitySummary = "";
  let capabilityEntries: CapabilityEntry[] = [];
  let entryGroupIds: string[] = [];
  let step3InitialChunks: ChunkRecord[] = [];
  let step3MissingRetryChunks: ChunkRecord[] = [];
  const guardEntryRetryChunks: ChunkRecord[] = [];

  if (evidenceGroups.length > 0) {
    ctx.stage = "step3_initial";
    const initial = await runStep3Chunks(evidenceGroups, (g) => buildStep3Prompt(g));
    step3InitialChunks = initial.chunks;
    let entries = initial.entries;
    let groupIds = initial.groupIds;
    let categories = initial.categories;

    const baseMetadata = {
      groupCount: evidenceGroups.length,
      chunkSize: STEP3_CHUNK_SIZE,
      maxTokens: STEP3_MAX_TOKENS,
      initialChunks: chunkSummaries(initial.chunks),
      initialParsedCount: entries.length,
      initialMissingGroupIds: initial.missingGroupIds
    };

    if (initial.missingGroupIds.length > 0) {
      // Groups missing from the first pass - a chunk that threw, truncated, or
      // simply skipped some groups on a completed response. All get the same
      // remedy: one targeted retry of just those groups (the partial trailing
      // line of a truncated chunk was already dropped, so every entry kept from
      // the first pass is complete). Truncation used to get no retry at all,
      // which is exactly how the 2026-09-30 run died.
      const missingGroups = evidenceGroups.filter((g) => initial.missingGroupIds.includes(g.groupId));
      const elapsed = Date.now() - t0;
      console.log(
        "[generate-capability-finalize] Step 3 first pass missing " + missingGroups.length + " of " +
        evidenceGroups.length + " group(s) - retrying: " + JSON.stringify(initial.missingGroupIds)
      );

      if (elapsed > STEP3_RETRY_DEADLINE_MS) {
        await reportFatal({
          errorType: "step3_failed",
          message: `Step 3 naming pass: ${missingGroups.length} group(s) missing and retry skipped - ${Math.round(elapsed / 1000)}s already elapsed, not enough time budget left before maxDuration`,
          metadata: { reason: "retry_skipped_time_budget", retryAttempted: false, ...baseMetadata },
        });
        return NextResponse.json({ error: "Failed to generate capability entries. Please try again." }, { status: 500 });
      }

      ctx.stage = "step3_missing_retry";
      const retry = await runStep3Chunks(missingGroups, (g) => buildStep3Prompt(g));
      step3MissingRetryChunks = retry.chunks;

      if (retry.missingGroupIds.length > 0) {
        // Only ONE retry (constraint D) - a second shortfall fails for good, but
        // reported with both attempts' numbers so the log distinguishes "transient
        // omission, recovered" from "these specific groupIds consistently will not
        // name" instead of requiring another multi-session diagnostic to tell them apart.
        const allThrew = [...initial.chunks, ...retry.chunks].every((c) => c.error !== null);
        await reportFatal({
          errorType: "step3_failed",
          message: allThrew
            ? `Step 3 naming pass API calls failed: ${initial.chunks[0]?.error ?? "unknown error"}`
            : `Step 3 naming pass: retry did not recover all missing groups (${retry.missingGroupIds.length} of ${missingGroups.length} still missing after one retry)`,
          metadata: {
            reason: allThrew ? "api_error" : "retry_exhausted",
            retryAttempted: true,
            ...baseMetadata,
            retryChunks: chunkSummaries(retry.chunks),
            stillMissingGroupIds: retry.missingGroupIds
          },
        });
        return NextResponse.json({ error: "Failed to generate capability entries. Please try again." }, { status: 500 });
      }

      entries = [...entries, ...retry.entries];
      groupIds = [...groupIds, ...retry.groupIds];
      categories = [...categories, ...retry.categories];
      console.log(
        "[generate-capability-finalize] Step 3 retry recovered all " + missingGroups.length + " missing group(s)"
      );
    }

    // Merge the parallel chunks back into one leadership -> technical ->
    // credentials list (the order buildStep3Prompt asks for within a call).
    // Stable sort, so within a category the model's own order is kept. No entry
    // is dropped: every group is accounted for across the calls above or the
    // run has already failed.
    const order = entries
      .map((entry, i) => ({ entry, groupId: groupIds[i], rank: STEP3_CATEGORY_RANK[categories[i] ?? "TECHNICAL"], i }))
      .sort((a, b) => a.rank - b.rank || a.i - b.i);
    capabilityEntries = order.map((o) => o.entry);
    entryGroupIds = order.map((o) => o.groupId);
    capabilitySummary = buildCapabilitySummary(capabilityEntries);

    const tStep3End = Date.now();
    console.log("[generate-capability-finalize][timing] step3 END t=" + tStep3End + " delta=" + (tStep3End - t6) + "ms capabilityLen=" + capabilitySummary.length + " entryCount=" + capabilityEntries.length + " chunks=" + initial.chunks.length);
  }

  // --- Identity guard, targeted retry: capability entries ---
  // Previously ONE flagged phrase in any of ~90-130 entries aborted the entire
  // run at the very end (after Step 4 and the employer summary had also been
  // paid for), and the next attempt regenerated everything from scratch. Now the
  // flagged entries - and only those - are re-generated from their evidence
  // groups with the rejected output and the exact failing phrases spelled out,
  // the same pattern as the missing-groups retry above. Done BEFORE Step 4 so
  // Step 4 and the employer summary are written from the corrected summary, not
  // from text that already contains the identifying detail.
  //
  // Nothing is dropped: an entry whose retry is still flagged (or whose retry
  // did not come back) keeps its original text, and the final guard block below
  // aborts on it exactly as before. This changes recovery, not detection - every
  // replacement is re-scanned by the same scanEmployerFacingText.
  ctx.stage = "guard_entry_retry";
  const initialEntryViolations = scanCapabilityEntries(capabilityEntries, { knownFullName });
  type FlaggedEntry = {
    entryIndex: number;
    groupId: string;
    name: string;
    description: string;
    flags: Array<{ category: string; match: string }>;
  };
  const entryRetryAttempts: Array<Record<string, unknown>> = [];
  const entryRetryReport: Record<string, unknown> = {
    flaggedEntryCount: 0,
    initialViolations: [] as unknown[],
    attempts: entryRetryAttempts,
    skippedReason: null,
    recoveredEntryIndexes: [] as number[],
    unresolvedGroupIds: [] as string[]
  };
  const recoveredEntries: Array<{ entryIndex: number; groupId: string; attempt: number; before: { name: string; description: string }; after: { name: string; description: string } }> = [];

  if (initialEntryViolations.length > 0) {
    const flaggedIndexes = Array.from(new Set(initialEntryViolations.map((v) => v.index))).sort((a, b) => a - b);
    entryRetryReport.flaggedEntryCount = flaggedIndexes.length;
    entryRetryReport.initialViolations = buildGuardAbortViolationRows({
      stringFields: [],
      capabilityEntries,
      capabilityEntryViolations: initialEntryViolations
    });

    let pending: FlaggedEntry[] = flaggedIndexes.map((entryIndex) => ({
      entryIndex,
      groupId: entryGroupIds[entryIndex],
      name: capabilityEntries[entryIndex].name,
      description: capabilityEntries[entryIndex].description,
      flags: initialEntryViolations
        .filter((v) => v.index === entryIndex)
        .flatMap((v) => v.violations.map((x) => ({ category: x.category, match: x.match })))
    }));
    console.log(
      "[generate-capability-finalize] guard flagged " + pending.length + " of " + capabilityEntries.length +
      " capability entries - targeted retry of groups " + JSON.stringify(pending.map((f) => f.groupId))
    );

    // Up to two attempts. The second covers only what the first did not fix:
    // entries whose rewrite still tripped the guard (retried again with the NEW
    // flagged phrases, so the model sees what it got wrong this time) and
    // entries that did not come back at all (seen 2026-09-30: the model wrote
    // [b5-g13] for group b5-g14 - clean content, wrong label - so the group read
    // as "not returned"). Anything still unresolved after that keeps its
    // original flagged text and the final guard aborts on it.
    for (let attempt = 1; attempt <= GUARD_ENTRY_RETRY_ATTEMPTS && pending.length > 0; attempt++) {
      const elapsed = Date.now() - t0;
      if (elapsed > GUARD_ENTRY_RETRY_DEADLINE_MS) {
        entryRetryReport.skippedReason = `attempt ${attempt} skipped: time_budget (${Math.round(elapsed / 1000)}s elapsed)`;
        break;
      }

      const byGroupId = new Map(pending.map((f) => [f.groupId, f]));
      const groups = evidenceGroups.filter((g) => byGroupId.has(g.groupId));
      const retry = await runStep3Chunks(groups, (chunkGroups) =>
        buildStep3GuardRetryPrompt(chunkGroups, chunkGroups.map((g) => byGroupId.get(g.groupId)!))
      );
      guardEntryRetryChunks.push(...retry.chunks);

      const nextPending: FlaggedEntry[] = [];
      const stillFlagged: Array<Record<string, unknown>> = [];
      let recoveredThisAttempt = 0;
      retry.entries.forEach((candidate, i) => {
        const groupId = retry.groupIds[i];
        const f = byGroupId.get(groupId);
        if (!f) return;
        const nameViolations = scanEmployerFacingText(candidate.name, { knownFullName });
        const descriptionViolations = scanEmployerFacingText(candidate.description, { knownFullName });
        if (nameViolations.length === 0 && descriptionViolations.length === 0) {
          const before = capabilityEntries[f.entryIndex];
          recoveredEntries.push({
            entryIndex: f.entryIndex,
            groupId,
            attempt,
            before: { name: before.name, description: before.description },
            after: { name: candidate.name, description: candidate.description }
          });
          capabilityEntries[f.entryIndex] = candidate;
          (entryRetryReport.recoveredEntryIndexes as number[]).push(f.entryIndex);
          recoveredThisAttempt++;
        } else {
          const newFlags = [...nameViolations, ...descriptionViolations].map((v) => ({ category: v.category, match: v.match }));
          stillFlagged.push({
            entryIndex: f.entryIndex,
            groupId,
            retriedName: candidate.name,
            retriedDescription: candidate.description,
            violations: [
              ...nameViolations.map((v) => ({ part: "name", category: v.category, match: v.match })),
              ...descriptionViolations.map((v) => ({ part: "description", category: v.category, match: v.match }))
            ]
          });
          nextPending.push({ ...f, name: candidate.name, description: candidate.description, flags: [...f.flags, ...newFlags] });
        }
      });
      for (const groupId of retry.missingGroupIds) {
        const f = byGroupId.get(groupId);
        if (f) nextPending.push(f);
      }

      entryRetryAttempts.push({
        attempt,
        requestedGroupIds: pending.map((f) => f.groupId),
        recoveredCount: recoveredThisAttempt,
        stillFlagged,
        notReturnedGroupIds: retry.missingGroupIds,
        chunks: chunkSummaries(retry.chunks)
      });
      console.log(
        "[generate-capability-finalize] guard entry retry attempt " + attempt + ": recovered " + recoveredThisAttempt +
        " of " + pending.length + ", still flagged " + stillFlagged.length + ", not returned " + retry.missingGroupIds.length
      );
      pending = nextPending;
    }
    entryRetryReport.unresolvedGroupIds = pending.map((f) => f.groupId);

    if (recoveredEntries.length > 0) {
      capabilitySummary = buildCapabilitySummary(capabilityEntries);
    }
  }

  const t6b = Date.now();
  console.log("[generate-capability-finalize][timing] step3 + entry guard retry complete t6b=" + t6b + " delta=" + (t6b - t6) + "ms capabilityLen=" + capabilitySummary.length);

  // --- Step 4: RECOMMENDED_POSITION, ENTRY_POINT, FUTURE_POSITIONS ---
  ctx.stage = "step4";
  const t7 = Date.now();

  let positionsText = "";
  let step4StopReason: string | null = null;
  let rawEmployerText = "";
  let employerStopReason: string | null = null;
  try {
    // max_tokens raised 4096->8192, matching Step 3: this call asks for three full
    // sections in one response, and the old ceiling was confirmed to truncate after
    // RECOMMENDED_POSITION on a real profile - see the diagnostic that traced this
    // route's silently-incomplete profiles to exactly that.
    const step4Response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      temperature: 0.2,
      messages: [{
        role: "user",
        content: buildStep4Prompt({
          desiredRole,
          experienceLevel: profile.experience_level ?? "Not specified",
          workPreference: profile.work_preference ?? "Not specified",
          skills,
          summary: profile.summary ?? "Not provided",
          capabilitySummary
        })
      }],
    });
    step4StopReason = step4Response.stop_reason;
    positionsText = step4Response.content.find((b) => b.type === "text")?.text ?? "";
    if (step4StopReason === "max_tokens") {
      console.error("[generate-capability-finalize] Step 4 response TRUNCATED (stop_reason=max_tokens)", {
        responseLength: positionsText.length
      });
    }
  } catch (err) {
    const tStep4Err = Date.now();
    console.log("[generate-capability-finalize][timing] step4 FAILED t=" + tStep4Err + " delta=" + (tStep4Err - t7) + "ms");
    console.error("[generate-capability-finalize] step4 Anthropic API error", err);
    const message = err instanceof Error ? err.message : String(err);
    // Previously console-only: this exit left no error_logs row.
    await reportFatal({
      errorType: "step4_failed",
      message: `Step 4 API call failed: ${message}`,
      metadata: { reason: "api_error", capabilityEntryCount: capabilityEntries.length }
    });
    return NextResponse.json({ error: `AI generation failed: ${message}` }, { status: 500 });
  }

  const tStep4End = Date.now();
  console.log(
    "[generate-capability-finalize][timing] step4 complete t=" + tStep4End + " delta=" + (tStep4End - t7) +
    "ms responseLen=" + positionsText.length + " stopReason=" + step4StopReason
  );

  const step4Sections = extractStep4Sections(positionsText);
  let recommendedPosition = step4Sections.recommendedPosition;
  let entryPoint = step4Sections.entryPoint;
  let futurePositions = step4Sections.futurePositions;
  let employerSummary = "";

  // --- Observability: stage tracing + raw-response persistence --------------
  // traceStage logs each field's length + first 200 chars at every stage it
  // passes through, so a populated field going empty is pinned to an exact
  // stage instead of inferred from the final DB row. persistGenerationDebug
  // writes the FULL raw Step 3 / Step 4 / employer-summary text to a durable,
  // queryable error_logs row (error_type "generation_debug") for every run -
  // success or failure - and also echoes it to stdout so the raw text survives
  // even if that insert fails. Chose error_logs over a jsonb column on
  // candidate_profiles: error_logs rows are append-only and timestamped so
  // every run is retained for good-vs-bad comparison (a profile column would be
  // overwritten each run), it needs no migration (error_type is free-text), it
  // reuses the query surface already in use for this investigation, and it
  // keeps raw model output - which can contain identity detail - out of the
  // more widely-read candidate_profiles row.
  const traceStage = (stage: string) => {
    const fmt = (v: string) => "len=" + (v ?? "").length + " head=" + JSON.stringify((v ?? "").slice(0, 200));
    console.log(
      "[generate-capability-finalize][step4-trace][" + stage + "] " +
      JSON.stringify({
        recommended_position: fmt(recommendedPosition),
        entry_point: fmt(entryPoint),
        future_positions: fmt(futurePositions),
        employer_summary: fmt(employerSummary)
      })
    );
  };
  const persistGenerationDebug = async (reason: string) => {
    const payload = {
      reason,
      step3: {
        initialChunks: step3InitialChunks,
        missingGroupsRetry: step3MissingRetryChunks.length === 0 ? null : step3MissingRetryChunks,
        guardEntryRetry: guardEntryRetryChunks.length === 0 ? null : guardEntryRetryChunks
      },
      step4: { stopReason: step4StopReason, length: positionsText.length, raw: positionsText },
      employerSummary: { stopReason: employerStopReason, length: rawEmployerText.length, raw: rawEmployerText },
      step4Sections: {
        recommendedPositionLength: step4Sections.recommendedPosition.length,
        entryPointLength: step4Sections.entryPoint.length,
        futurePositionsLength: step4Sections.futurePositions.length,
        missingSections: step4Sections.missingSections
      }
    };
    console.log("[generate-capability-finalize][generation-debug] " + JSON.stringify(payload));
    try {
      const { error } = await adminClient.from("error_logs").insert({
        route: ROUTE,
        error_message: "Raw capability-generation responses captured for run (" + reason + ")",
        error_type: "generation_debug",
        user_id: user.id,
        severity: "low",
        metadata: payload
      });
      if (error) console.error("[generate-capability-finalize] generation_debug insert rejected", error);
    } catch (err) {
      console.error("[generate-capability-finalize] Failed to write generation_debug row", err);
    }
  };
  traceStage("after-extractStep4Sections");

  if (step4Sections.missingSections.length > 0) {
    // Fail loudly rather than write a profile that's missing two-thirds of its
    // content with a "complete" status and a 200 response - this is the exact
    // failure mode diagnosed: nothing throws on a truncated-but-200 response, so
    // this check is the only thing standing between that and a silent partial save.
    await persistGenerationDebug("step4-missing-sections");
    await reportFatal({
      errorType: "step4_incomplete",
      message: `Step 4 response missing required section(s): ${step4Sections.missingSections.join(", ")}`,
      metadata: {
        missingSections: step4Sections.missingSections,
        stopReason: step4StopReason,
        responseLength: positionsText.length,
        rawStep4Text: positionsText
      }
    });
    return NextResponse.json(
      { error: "Failed to generate your recommended positions. Please try again." },
      { status: 500 }
    );
  }

  traceStage("after-missingSections-check");

  ctx.stage = "employer_summary";
  const t8 = Date.now();

  // --- Employer Summary ---
  const isAlternateSummary = profile.summary_priority === "alternate";

  try {
    const employerMessage = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: EMPLOYER_SUMMARY_SYSTEM_PROMPT,
      temperature: 0.2,
      messages: [{
        role: "user",
        content: buildEmployerSummaryUserPrompt({ capabilitySummary, recommendedPosition, entryPoint, isAlternateSummary })
      }],
    });
    employerStopReason = employerMessage.stop_reason;
    rawEmployerText = employerMessage.content.find((b) => b.type === "text")?.text ?? "";
    employerSummary = rawEmployerText;

    if (!employerSummary) {
      // The call succeeded (no exception) but returned no usable text block - a
      // distinct failure mode from the catch below, and previously indistinguishable
      // from it since both just set employerSummary = "" with only a console.error.
      // Not blocking the overall save on this (unlike Step 4 above): the profile
      // itself is still complete and useful to the candidate without this one
      // employer-facing paragraph, so it's reported loudly rather than treated as fatal.
      await reportGenerationFailure({
        adminClient,
        sendEmailFn: sendEmail,
        route: ROUTE,
        errorType: "employer_summary_empty_response",
        message: "Employer summary call returned no usable text block",
        userId: user.id,
        severity: "high",
        metadata: { stopReason: employerStopReason }
      });
    } else if (employerStopReason === "max_tokens") {
      console.error("[generate-capability-finalize] Employer summary response TRUNCATED (stop_reason=max_tokens)", {
        responseLength: employerSummary.length
      });
    }
  } catch (err) {
    // Distinct from the empty-text-block case above: this is a thrown API error
    // (network, auth, rate limit, etc.), not a malformed-but-successful response.
    const message = err instanceof Error ? err.message : String(err);
    await reportGenerationFailure({
      adminClient,
      sendEmailFn: sendEmail,
      route: ROUTE,
      errorType: "employer_summary_api_error",
      message: `Employer summary API call threw: ${message}`,
      userId: user.id,
      severity: "high"
    });
    employerSummary = "";
  }

  const t9 = Date.now();
  console.log("[generate-capability-finalize][timing] employer summary complete t9=" + t9 + " delta=" + (t9 - t8) + "ms employerSummaryLen=" + employerSummary.length);

  // --- Identity guard, targeted retry: free-text fields ---
  // Same recovery posture as the entry retry above, for the four single-block
  // fields: a flagged field gets one minimal rewrite with its failing phrases
  // named, and the rewrite is kept only if it re-scans clean. On 2026-09-27 a
  // single "bridge to" in future_positions was enough to discard the run.
  ctx.stage = "guard_field_retry";
  type GuardedField = "employer_summary" | "recommended_position" | "entry_point" | "future_positions";
  const getField = (f: GuardedField) =>
    f === "employer_summary" ? employerSummary : f === "recommended_position" ? recommendedPosition : f === "entry_point" ? entryPoint : futurePositions;
  const setField = (f: GuardedField, value: string) => {
    if (f === "employer_summary") employerSummary = value;
    else if (f === "recommended_position") recommendedPosition = value;
    else if (f === "entry_point") entryPoint = value;
    else futurePositions = value;
  };
  const guardedFields: Array<{ field: GuardedField; severity: "high" | "medium" }> = [
    { field: "employer_summary", severity: "high" },
    { field: "recommended_position", severity: "medium" },
    { field: "entry_point", severity: "medium" },
    { field: "future_positions", severity: "medium" }
  ];
  const fieldRetryReport: Array<Record<string, unknown>> = [];
  const recoveredFields: Array<{ field: string; initialViolations: unknown[]; before: string; after: string }> = [];

  const initialFieldFlags = guardedFields
    .map((g) => ({ ...g, text: getField(g.field), violations: scanEmployerFacingText(getField(g.field), { knownFullName }) }))
    .filter((g) => g.violations.length > 0);

  if (initialFieldFlags.length > 0) {
    const elapsed = Date.now() - t0;
    if (elapsed > GUARD_FIELD_RETRY_DEADLINE_MS) {
      for (const g of initialFieldFlags) {
        fieldRetryReport.push({
          field: g.field,
          attempted: false,
          skippedReason: `time_budget (${Math.round(elapsed / 1000)}s elapsed)`,
          initialViolations: buildGuardAbortViolationRows({ stringFields: [g] })
        });
      }
    } else {
      await Promise.all(initialFieldFlags.map(async (g) => {
        const initialViolations = buildGuardAbortViolationRows({ stringFields: [g] });
        try {
          const response = await anthropic.messages.create({
            model: "claude-sonnet-4-6",
            max_tokens: 8192,
            temperature: 0.2,
            messages: [{
              role: "user",
              content: buildGuardRewritePrompt(g.field, g.text, g.violations.map((v) => ({ category: v.category, match: v.match })))
            }],
          });
          const rewritten = (response.content.find((b) => b.type === "text")?.text ?? "").trim();
          const retryViolations = scanEmployerFacingText(rewritten, { knownFullName });
          const accepted = rewritten.length > 0 && response.stop_reason !== "max_tokens" && retryViolations.length === 0;
          if (accepted) {
            setField(g.field, rewritten);
            recoveredFields.push({ field: g.field, initialViolations, before: g.text, after: rewritten });
          }
          fieldRetryReport.push({
            field: g.field,
            attempted: true,
            recovered: accepted,
            stopReason: response.stop_reason,
            rewrittenLength: rewritten.length,
            initialViolations,
            retryViolations: retryViolations.map((v) => ({ category: v.category, match: v.match })),
            rewrittenPreview: accepted ? null : rewritten.slice(0, 1000)
          });
        } catch (err) {
          fieldRetryReport.push({
            field: g.field,
            attempted: true,
            recovered: false,
            error: err instanceof Error ? err.message : String(err),
            initialViolations
          });
        }
      }));
    }
  }

  await persistGenerationDebug("success-path");

  // --- Final identity guard (unchanged detection, same abort posture) ---
  // Mechanical safety net: this is the same category of failure that shipped
  // a live name/rank/clearance-sponsor/tenure disclosure in commit e79cd4f7 -
  // a prompt asking for anonymity is not a control, only a check on the
  // actual output is. employer_summary is checked at "high" severity because
  // it is the field that actually reaches an employer's screen; the other
  // three are candidate-facing today but held to the same policy, so they're
  // checked too, at "medium," to catch the same failure mode before it can
  // ever reach a future employer-facing surface. Every value checked here is
  // the post-retry value - a retry that did not come back clean left the
  // original text in place, so it is caught here exactly as before.
  ctx.stage = "guard_final";
  const redactedFields: string[] = [];
  const finalStringViolations: Array<{ field: string; text: string; violations: TextGuardViolation[] }> = [];
  for (const g of guardedFields) {
    const text = getField(g.field);
    const violations = scanEmployerFacingText(text, { knownFullName });
    if (violations.length === 0) {
      continue;
    }
    redactedFields.push(g.field);
    finalStringViolations.push({ field: g.field, text, violations });
    await reportTextGuardViolation({
      adminClient,
      sendEmailFn: sendEmail,
      route: ROUTE,
      field: g.field,
      userId: user.id,
      violations,
      text,
      severity: g.severity
    });
  }

  // capability_entries checked separately from the string-field loop above: it's
  // an array of {name, description} entries, not one block of text, and it DOES
  // reach an employer today - the "candidate-profiles" read endpoint sends this
  // field raw (see the aiFields fix in api/mvp/read/route.ts), so it is held to
  // the same "high" severity as employer_summary, not "medium".
  const capabilityEntryViolations = scanCapabilityEntries(capabilityEntries, { knownFullName });
  if (capabilityEntryViolations.length > 0) {
    redactedFields.push("capability_entries");
  }

  traceStage("after-guard-block");

  // ABORT on any remaining violation - same failure posture as the Step 4
  // missing-sections check above. A hollowed-out profile is not a success: it
  // must never be written with status "complete" or returned as 200.
  if (redactedFields.length > 0) {
    // metadata.violations: one flat row per violation, per failing field - the
    // category, the exact matched string, and the surrounding context with the
    // match bracketed [[like this]]. This was previously absent (only the list
    // of failing field names was recorded here, with string-field details split
    // off into separate privacy_violation rows), which is what turned each abort
    // into a guessing session.
    const violationRows = buildGuardAbortViolationRows({
      stringFields: finalStringViolations,
      capabilityEntries,
      capabilityEntryViolations
    });
    await reportFatal({
      errorType: "guard_redaction_abort",
      message: `Text guard flagged field(s) after targeted retry; aborted before write: ${redactedFields.join(", ")} (${violationRows.length} violation(s))`,
      metadata: {
        redactedFields,
        violationCount: violationRows.length,
        violations: violationRows,
        step4StopReason,
        employerSummaryLength: employerSummary.length,
        capabilityEntryCount: capabilityEntries.length,
        guardRetry: {
          capabilityEntries: entryRetryReport,
          stringFields: fieldRetryReport
        }
      }
    });
    return NextResponse.json(
      { error: "Failed to generate your profile. Please try again." },
      { status: 500 }
    );
  }

  // The run is going to succeed, but the model DID produce identifying text
  // that the retry corrected - record exactly what was caught and what replaced
  // it, so a recovered run is visible (and prompt drift can be tracked) rather
  // than indistinguishable from a clean first pass.
  if (recoveredEntries.length > 0 || recoveredFields.length > 0) {
    await reportGenerationFailure({
      adminClient,
      sendEmailFn: sendEmail,
      route: ROUTE,
      errorType: "guard_retry_recovered",
      message: `Identity guard flagged ${recoveredEntries.length} capability entr${recoveredEntries.length === 1 ? "y" : "ies"} and ${recoveredFields.length} field(s); targeted retry corrected all of them`,
      userId: user.id,
      severity: "medium",
      metadata: {
        capabilityEntries: {
          initialViolations: entryRetryReport.initialViolations,
          recovered: recoveredEntries
        },
        stringFields: recoveredFields
      }
    });
  }

  traceStage("before-db-write");

  ctx.stage = "db_write";
  ctx.committing = true;
  const { error: updateError } = await adminClient
    .from("candidate_profiles")
    .update({
      capability_summary: capabilitySummary,
      capability_entries: capabilityEntries,
      recommended_position: recommendedPosition,
      entry_point: entryPoint,
      future_positions: futurePositions,
      employer_summary: employerSummary,
      // pending_evidence_groups is retained (not cleared) so the correction flow
      // (correct-capability/route.ts) has a stable EvidenceGroup[] to reuse for
      // naming-only corrections instead of re-running extraction from scratch.
      capability_generation_status: "complete"
    })
    .eq("user_id", user.id);

  if (updateError) {
    ctx.committing = false;
    console.error("[generate-capability-finalize] Failed to save AI output", updateError);
    // Previously console-only.
    await reportFatal({
      errorType: "profile_write_failed",
      message: `Final candidate_profiles write failed: ${updateError.message}`,
      metadata: { code: updateError.code, details: updateError.details, capabilityEntryCount: capabilityEntries.length }
    });
    return NextResponse.json({ error: "Failed to save generated profile." }, { status: 500 });
  }
  ctx.stage = "done";

  // Completion notification - so someone who navigates away from the profile
  // page while this was running still learns it finished. Fired here rather
  // than at the end of generate-capability (phase 1) because this is the point
  // the profile is actually fully written and viewable.
  const { error: notifyError } = await addNotificationByUserId({
    recipientUserId: user.id,
    type: "capability_ready",
    title: "Your capability profile is ready",
    message: "Your capability profile has finished generating. Review it and approve when you're ready."
  });
  if (notifyError) {
    console.error("[generate-capability-finalize] Failed to send completion notification", notifyError);
  }

  const tEnd = Date.now();
  console.log("[generate-capability-finalize][timing] phase2 complete tEnd=" + tEnd + " totalDelta=" + (tEnd - t0) + "ms entryCount=" + capabilityEntries.length);

  return NextResponse.json({ success: true, capabilitySummary, capabilityEntries, recommendedPosition, entryPoint, futurePositions, employerSummary });
}
