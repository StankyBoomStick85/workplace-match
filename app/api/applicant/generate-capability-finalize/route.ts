import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildStep3Prompt,
  buildStep4Prompt,
  buildEmployerSummaryUserPrompt,
  parseStep3Response,
  extractStep4Sections,
  EMPLOYER_SUMMARY_SYSTEM_PROMPT,
  type EvidenceGroup,
  type StoredDoc,
  type CapabilityEntry
} from "@/lib/capabilityPipeline";
import { scanEmployerFacingText, reportTextGuardViolation } from "@/lib/employerTextGuard";
import { reportGenerationFailure } from "@/lib/generationAlerts";
import { sendEmail } from "@/lib/email";
import { addNotificationByUserId } from "@/lib/supabaseMvpData";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST() {
  const t0 = Date.now();
  console.log("[generate-capability-finalize][timing] START t0=" + t0);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return NextResponse.json({ error: "Server configuration missing." }, { status: 500 });
  }

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

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

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
    return NextResponse.json(
      { error: "No pending evidence groups found. Please run capability generation from the start." },
      { status: 400 }
    );
  }

  // Phase feedback: written after the "groups_ready" gate check above (never
  // before it - overwriting that value before checking it would break the gate)
  // so a client polling this profile mid-request sees the real final stage
  // running. Overwritten by "complete" before this request returns.
  await adminClient
    .from("candidate_profiles")
    .update({ capability_generation_status: "writing_profile" })
    .eq("user_id", user.id);

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

  // --- Step 3: civilian-language naming pass ---
  const t6 = Date.now();

  let capabilitySummary = "";
  let capabilityEntries: CapabilityEntry[] = [];
  let rawStep3Text = "";
  let step3StopReason: string | null = null;

  if (evidenceGroups.length > 0) {
    try {
      // max_tokens raised 4096->8192 (matching Step 2's grouping ceiling): with no
      // description-length cap in buildStep3Prompt, 17+ evidence groups can plausibly
      // approach 4096 output tokens on their own, and a response cut off mid-line
      // fails the exact-count check below just like a genuinely malformed one - see
      // the diagnostic that traced this route's 500s to exactly that failure mode.
      const step3Response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        temperature: 0.2,
        messages: [{ role: "user", content: buildStep3Prompt(evidenceGroups) }],
      });

      step3StopReason = step3Response.stop_reason;
      rawStep3Text = step3Response.content.find((b) => b.type === "text")?.text ?? "";
      const result = parseStep3Response(rawStep3Text, evidenceGroups, storedDocs);

      if (result.kind === "escalate") {
        // Phase 2 always calls buildStep3Prompt without a correction instruction, so
        // "sentinel" should never happen here - only "count_mismatch" is expected,
        // and even that shouldn't happen with the raised ceiling above. Logged with
        // full diagnostics (previously just a bare string with no data behind it) so
        // a recurrence is immediately explainable instead of requiring a repro.
        console.error(
          "[generate-capability-finalize] Step 3 output was not fully parseable (unexpected without a correction in play)",
          {
            reason: result.reason,
            stopReason: step3Response.stop_reason,
            rawTextLength: result.rawTextLength,
            parsedCount: result.parsedCount,
            expectedCount: result.expectedCount,
            missingGroupIds: result.missingGroupIds
          }
        );
        return NextResponse.json({ error: "Failed to generate capability entries. Please try again." }, { status: 500 });
      }

      capabilitySummary = result.capabilitySummary;
      capabilityEntries = result.capabilityEntries;
      const tStep3End = Date.now();
      console.log("[generate-capability-finalize][timing] step3 END t=" + tStep3End + " delta=" + (tStep3End - t6) + "ms capabilityLen=" + capabilitySummary.length + " entryCount=" + capabilityEntries.length);
    } catch (err) {
      console.error("[generate-capability-finalize] step3 Sonnet error", err);
    }
  }

  const t6b = Date.now();
  console.log("[generate-capability-finalize][timing] step3 complete t6b=" + t6b + " delta=" + (t6b - t6) + "ms capabilityLen=" + capabilitySummary.length);

  // --- Step 4: RECOMMENDED_POSITION, ENTRY_POINT, FUTURE_POSITIONS ---
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
    return NextResponse.json({ error: `AI generation failed: ${message}` }, { status: 500 });
  }

  const tStep4End = Date.now();
  console.log(
    "[generate-capability-finalize][timing] step4 complete t=" + tStep4End + " delta=" + (tStep4End - t7) +
    "ms responseLen=" + positionsText.length + " stopReason=" + step4StopReason
  );

  const step4Sections = extractStep4Sections(positionsText);
  const recommendedPosition = step4Sections.recommendedPosition;
  const entryPoint = step4Sections.entryPoint;
  const futurePositions = step4Sections.futurePositions;
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
      step3: { stopReason: step3StopReason, length: rawStep3Text.length, raw: rawStep3Text },
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
      await adminClient.from("error_logs").insert({
        route: "generate-capability-finalize",
        error_message: "Raw capability-generation responses captured for run (" + reason + ")",
        error_type: "generation_debug",
        user_id: user.id,
        severity: "low",
        metadata: payload
      });
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
    await reportGenerationFailure({
      adminClient,
      sendEmailFn: sendEmail,
      route: "generate-capability-finalize",
      errorType: "step4_incomplete",
      message: `Step 4 response missing required section(s): ${step4Sections.missingSections.join(", ")}`,
      userId: user.id,
      severity: "high",
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
        route: "generate-capability-finalize",
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
      route: "generate-capability-finalize",
      errorType: "employer_summary_api_error",
      message: `Employer summary API call threw: ${message}`,
      userId: user.id,
      severity: "high"
    });
    employerSummary = "";
  }

  const t9 = Date.now();
  console.log("[generate-capability-finalize][timing] employer summary complete t9=" + t9 + " delta=" + (t9 - t8) + "ms employerSummaryLen=" + employerSummary.length);

  await persistGenerationDebug("success-path");

  // Mechanical safety net: this is the same category of failure that shipped
  // a live name/rank/clearance-sponsor/tenure disclosure in commit e79cd4f7 -
  // a prompt asking for anonymity is not a control, only a check on the
  // actual output is. employer_summary is checked at "high" severity because
  // it is the field that actually reaches an employer's screen; the other
  // three are candidate-facing today but held to the same policy, so they're
  // checked too, at "medium," to catch the same failure mode before it can
  // ever reach a future employer-facing surface.
  const knownFullName = profile.display_name ?? null;
  const guardChecks: Array<{ field: string; text: string; severity: "high" | "medium" }> = [
    { field: "employer_summary", text: employerSummary, severity: "high" },
    { field: "recommended_position", text: recommendedPosition, severity: "medium" },
    { field: "entry_point", text: entryPoint, severity: "medium" },
    { field: "future_positions", text: futurePositions, severity: "medium" }
  ];
  const redactedFields: string[] = [];
  for (const check of guardChecks) {
    const violations = scanEmployerFacingText(check.text, { knownFullName });
    if (violations.length === 0) {
      continue;
    }
    redactedFields.push(check.field);
    await reportTextGuardViolation({
      adminClient,
      sendEmailFn: sendEmail,
      route: "generate-capability-finalize",
      field: check.field,
      userId: user.id,
      violations,
      text: check.text,
      severity: check.severity
    });
  }

  traceStage("after-guard-block");

  // ABORT on any redaction - same failure posture as the Step 4 missing-sections
  // check above. A hollowed-out profile is not a success: it must never be written
  // with status "complete" or returned as 200. (Previously this block zeroed each
  // flagged field in place and let the save proceed.)
  if (redactedFields.length > 0) {
    await reportGenerationFailure({
      adminClient,
      sendEmailFn: sendEmail,
      route: "generate-capability-finalize",
      errorType: "guard_redaction_abort",
      message: `Text guard flagged field(s); aborted before write: ${redactedFields.join(", ")}`,
      userId: user.id,
      severity: "high",
      metadata: {
        redactedFields,
        step4StopReason,
        employerSummaryLength: rawEmployerText.length
      }
    });
    return NextResponse.json(
      { error: "Failed to generate your profile. Please try again." },
      { status: 500 }
    );
  }

  traceStage("before-db-write");

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
    console.error("[generate-capability-finalize] Failed to save AI output", updateError);
    return NextResponse.json({ error: "Failed to save generated profile." }, { status: 500 });
  }

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
