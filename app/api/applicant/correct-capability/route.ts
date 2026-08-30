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
  extractSection,
  EMPLOYER_SUMMARY_SYSTEM_PROMPT,
  type EvidenceGroup,
  type StoredDoc,
  type Step3Result
} from "@/lib/capabilityPipeline";
import { scanEmployerFacingText, reportTextGuardViolation } from "@/lib/employerTextGuard";
import { sendEmail } from "@/lib/email";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const t0 = Date.now();
  console.log("[correct-capability][timing] START t0=" + t0);

  const body = await request.json().catch(() => null);
  const correctionMessage = typeof body?.correctionMessage === "string" ? body.correctionMessage.trim() : "";

  if (!correctionMessage) {
    return NextResponse.json({ error: "correctionMessage is required." }, { status: 400 });
  }

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
  if (userError || !user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: profile, error: profileError } = await adminClient
    .from("candidate_profiles")
    .select("display_name, job_types, experience_level, work_preference, capability_tags, summary, summary_priority, pending_evidence_groups, document_metadata")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json({ error: "Failed to load profile." }, { status: 500 });
  }
  if (!profile) {
    return NextResponse.json({ error: "No profile found. Please save your profile first." }, { status: 400 });
  }

  const savedGroups: EvidenceGroup[] = Array.isArray(profile.pending_evidence_groups)
    ? (profile.pending_evidence_groups as EvidenceGroup[])
    : [];

  if (savedGroups.length === 0) {
    return NextResponse.json(
      { error: "No capability profile to correct yet. Please generate your capability profile first." },
      { status: 400 }
    );
  }

  const storedDocs: StoredDoc[] = Array.isArray(profile.document_metadata)
    ? (profile.document_metadata as StoredDoc[])
    : [];

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI service not configured." }, { status: 500 });
  }

  const anthropic = new Anthropic({ apiKey });

  const t1 = Date.now();
  console.log("[correct-capability][timing] after profile query t1=" + t1 + " delta=" + (t1 - t0) + "ms savedGroupCount=" + savedGroups.length);

  // --- Tier 1: naming-only re-run against the retained EvidenceGroup[] ---
  // This is the only tier this route runs inline. It is one Sonnet call and never
  // approaches the 300s ceiling. If it can't satisfy the correction (sentinel or an
  // unparseable response) - or the call itself fails - Tier 2 requires re-running
  // extraction and grouping, which does NOT fit in this same request alongside
  // naming/Step 4/employer summary. Instead of running it inline, this route hands
  // off to the client with tier: "escalation_required", and the client chains into
  // generate-capability (extraction+grouping, correction-aware) followed by the
  // unmodified generate-capability-finalize (naming/Step 4/employer summary) - the
  // exact same two-request split the main "Generate" button already uses to avoid
  // this timeout.
  let tier1Result: Step3Result;
  let tier1StopReason: string | null = null;
  try {
    // max_tokens raised 4096->8192 to match generate-capability-finalize's Step 3
    // call and Step 2's grouping ceiling - see that route for why a large
    // evidence-group count can approach the old ceiling on its own.
    const tier1Response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 8192,
      temperature: 0.2,
      messages: [{ role: "user", content: buildStep3Prompt(savedGroups, correctionMessage) }],
    });
    tier1StopReason = tier1Response.stop_reason;
    const rawTier1 = tier1Response.content.find((b) => b.type === "text")?.text ?? "";
    tier1Result = parseStep3Response(rawTier1, savedGroups, storedDocs);
  } catch (err) {
    console.error("[correct-capability][tier1] Sonnet error, escalation required", err);
    return NextResponse.json({ success: true, tier: "escalation_required" });
  }

  if (tier1Result.kind !== "entries") {
    // Diagnostics logged even though this path already has a recovery route
    // (escalation to Tier 2) - a "sentinel" here is expected/normal, but
    // "count_mismatch" is the same failure mode diagnosed on
    // generate-capability-finalize's hard-fail path, and worth the same
    // visibility here even though it isn't fatal in this route.
    console.log("[correct-capability][tier1] escalation required", {
      reason: tier1Result.reason,
      stopReason: tier1StopReason,
      rawTextLength: tier1Result.rawTextLength,
      parsedCount: tier1Result.parsedCount,
      expectedCount: tier1Result.expectedCount,
      missingGroupIds: tier1Result.missingGroupIds
    });
    return NextResponse.json({ success: true, tier: "escalation_required" });
  }

  const { capabilitySummary, capabilityEntries } = tier1Result;

  // --- Steps 4 + employer summary re-run so recommended_position/entry_point/
  // future_positions/employer_summary can never go stale relative to the capability
  // summary that was just rewritten above. A failure here is a real error, not a
  // reason to escalate - Tier 1's naming result was valid. ---
  const desiredRole = Array.isArray(profile.job_types) && profile.job_types.length > 0
    ? profile.job_types.join(", ")
    : "Not specified";
  const skills = Array.isArray(profile.capability_tags) && profile.capability_tags.length > 0
    ? profile.capability_tags.join(", ")
    : "Not specified";

  let positionsText = "";
  try {
    const step4Response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
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
    positionsText = step4Response.content.find((b) => b.type === "text")?.text ?? "";
  } catch (err) {
    console.error("[correct-capability] step4 Anthropic API error", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `AI generation failed: ${message}` }, { status: 500 });
  }

  let recommendedPosition = extractSection(positionsText, "RECOMMENDED_POSITION", "ENTRY_POINT");
  let entryPoint = extractSection(positionsText, "ENTRY_POINT", "FUTURE_POSITIONS");
  let futurePositions = extractSection(positionsText, "FUTURE_POSITIONS");

  const isAlternateSummary = profile.summary_priority === "alternate";
  let employerSummary = "";
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
    employerSummary = employerMessage.content.find((b) => b.type === "text")?.text ?? "";
  } catch (err) {
    console.error("[correct-capability] Employer summary API error", err);
    employerSummary = "";
  }

  // Mechanical safety net: same category of failure that shipped a live
  // name/rank/clearance-sponsor/tenure disclosure in commit e79cd4f7 - a
  // prompt asking for anonymity is not a control, only a check on the actual
  // output is. employer_summary is checked at "high" severity because it is
  // the field that actually reaches an employer's screen; the other three
  // are candidate-facing today but held to the same policy.
  const knownFullName = profile.display_name ?? null;
  const guardChecks: Array<{ field: string; text: string; severity: "high" | "medium" }> = [
    { field: "employer_summary", text: employerSummary, severity: "high" },
    { field: "recommended_position", text: recommendedPosition, severity: "medium" },
    { field: "entry_point", text: entryPoint, severity: "medium" },
    { field: "future_positions", text: futurePositions, severity: "medium" }
  ];
  const redacted: Record<string, string> = {};
  for (const check of guardChecks) {
    const violations = scanEmployerFacingText(check.text, { knownFullName });
    if (violations.length === 0) {
      continue;
    }
    redacted[check.field] = "";
    await reportTextGuardViolation({
      adminClient,
      sendEmailFn: sendEmail,
      route: "correct-capability",
      field: check.field,
      userId: user.id,
      violations,
      text: check.text,
      severity: check.severity
    });
  }
  if ("employer_summary" in redacted) employerSummary = redacted.employer_summary;
  if ("recommended_position" in redacted) recommendedPosition = redacted.recommended_position;
  if ("entry_point" in redacted) entryPoint = redacted.entry_point;
  if ("future_positions" in redacted) futurePositions = redacted.future_positions;

  // Tier 1 never changes grouping, so pending_evidence_groups is left exactly as it
  // was for the next correction to reuse.
  const { error: updateError } = await adminClient
    .from("candidate_profiles")
    .update({
      capability_summary: capabilitySummary,
      capability_entries: capabilityEntries,
      recommended_position: recommendedPosition,
      entry_point: entryPoint,
      future_positions: futurePositions,
      employer_summary: employerSummary,
      is_approved: false,
      correction_notes: correctionMessage,
    })
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[correct-capability] Failed to save corrected profile", updateError);
    return NextResponse.json({ error: "Failed to save corrected profile." }, { status: 500 });
  }

  const tEnd = Date.now();
  console.log("[correct-capability][timing] tier1 complete totalDelta=" + (tEnd - t0) + "ms entryCount=" + capabilityEntries.length);

  return NextResponse.json({
    success: true,
    tier: "naming-only",
    capabilitySummary,
    capabilityEntries,
    recommendedPosition,
    entryPoint,
    futurePositions,
    employerSummary
  });
}
