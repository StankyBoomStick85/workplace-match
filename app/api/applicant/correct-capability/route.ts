import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import {
  buildStep3Prompt,
  buildStep4Prompt,
  buildEmployerSummaryUserPrompt,
  buildSelfReportedEvidenceItems,
  extractEvidenceFromDocuments,
  runEvidenceGrouping,
  parseStep3Response,
  extractSection,
  EMPLOYER_SUMMARY_SYSTEM_PROMPT,
  type EvidenceGroup,
  type StoredDoc,
  type CapabilityEntry
} from "@/lib/capabilityPipeline";

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
    .select("job_types, experience_level, work_preference, capability_tags, summary, summary_priority, pending_evidence_groups, document_metadata")
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
  let finalGroups: EvidenceGroup[] = savedGroups;
  let capabilitySummary = "";
  let capabilityEntries: CapabilityEntry[] = [];
  let usedTier: "naming-only" | "full-regeneration" = "naming-only";

  try {
    const tier1Response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      temperature: 0.2,
      messages: [{ role: "user", content: buildStep3Prompt(savedGroups, correctionMessage) }],
    });

    const rawTier1 = tier1Response.content.find((b) => b.type === "text")?.text ?? "";
    const tier1Result = parseStep3Response(rawTier1, savedGroups, storedDocs);

    if (tier1Result.kind === "entries") {
      capabilitySummary = tier1Result.capabilitySummary;
      capabilityEntries = tier1Result.capabilityEntries;
      console.log("[correct-capability][tier1] naming-only correction applied, entryCount=" + capabilityEntries.length);
    } else {
      console.log("[correct-capability][tier1] escalating to full regeneration (sentinel or unparseable Step 3 output)");
    }
  } catch (err) {
    console.error("[correct-capability][tier1] Sonnet error, escalating to full regeneration", err);
  }

  // --- Tier 2: full re-extraction + re-grouping, with the correction injected upstream ---
  if (capabilityEntries.length === 0) {
    usedTier = "full-regeneration";
    const t2 = Date.now();
    console.log("[correct-capability][tier2] START t=" + t2);

    const { items: extractedItems, unreadableDocLabels, evidenceExtractionFailures } =
      await extractEvidenceFromDocuments(storedDocs, adminClient, anthropic, correctionMessage);

    const allEvidenceItems = [
      ...extractedItems,
      ...buildSelfReportedEvidenceItems({
        summary: profile.summary,
        capabilityTags: Array.isArray(profile.capability_tags) ? (profile.capability_tags as string[]) : null
      })
    ];

    console.log("[correct-capability][tier2] re-extraction complete, evidenceCount=" + allEvidenceItems.length + " unreadable=" + unreadableDocLabels.length + " extractionFailures=" + evidenceExtractionFailures.length);

    const regroupedGroups = await runEvidenceGrouping(allEvidenceItems, anthropic, correctionMessage);
    console.log("[correct-capability][tier2] re-grouping complete, groupCount=" + regroupedGroups.length);

    if (regroupedGroups.length === 0) {
      return NextResponse.json({ error: "Could not regenerate a capability profile from your documents. Please try again." }, { status: 500 });
    }

    // Naming pass runs plain here (no correction instruction) - the correction was
    // already applied at extraction/grouping, so there is nothing left for naming to
    // decide about it, and it means the sentinel can never come back at this stage.
    try {
      const tier2Response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        temperature: 0.2,
        messages: [{ role: "user", content: buildStep3Prompt(regroupedGroups) }],
      });

      const rawTier2 = tier2Response.content.find((b) => b.type === "text")?.text ?? "";
      const tier2Result = parseStep3Response(rawTier2, regroupedGroups, storedDocs);

      if (tier2Result.kind === "escalate") {
        // No further tier to fall back to - fail loudly rather than save partial output.
        console.error("[correct-capability][tier2] Step 3 output was not fully parseable after full regeneration");
        return NextResponse.json({ error: "Failed to regenerate your capability profile. Please try again." }, { status: 500 });
      }

      finalGroups = regroupedGroups;
      capabilitySummary = tier2Result.capabilitySummary;
      capabilityEntries = tier2Result.capabilityEntries;
    } catch (err) {
      console.error("[correct-capability][tier2] Step 3 Sonnet error", err);
      const message = err instanceof Error ? err.message : String(err);
      return NextResponse.json({ error: `AI generation failed: ${message}` }, { status: 500 });
    }

    const tEnd2 = Date.now();
    console.log("[correct-capability][tier2] complete delta=" + (tEnd2 - t2) + "ms entryCount=" + capabilityEntries.length);
  }

  // --- Steps 4 + employer summary always re-run, so recommended_position/entry_point/
  // future_positions/employer_summary can never go stale relative to the capability
  // summary that was just (re)written above, on either tier. ---
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

  const recommendedPosition = extractSection(positionsText, "RECOMMENDED_POSITION", "ENTRY_POINT");
  const entryPoint = extractSection(positionsText, "ENTRY_POINT", "FUTURE_POSITIONS");
  const futurePositions = extractSection(positionsText, "FUTURE_POSITIONS");

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

  const updatePayload: Record<string, unknown> = {
    capability_summary: capabilitySummary,
    capability_entries: capabilityEntries,
    recommended_position: recommendedPosition,
    entry_point: entryPoint,
    future_positions: futurePositions,
    employer_summary: employerSummary,
    is_approved: false,
    correction_notes: correctionMessage,
  };

  // Only overwrite the retained evidence groups if Tier 2 actually produced new ones -
  // a Tier 1 (naming-only) correction never changes grouping, so the saved groups stay
  // exactly as they were for the next correction to reuse.
  if (usedTier === "full-regeneration") {
    updatePayload.pending_evidence_groups = finalGroups;
  }

  const { error: updateError } = await adminClient
    .from("candidate_profiles")
    .update(updatePayload)
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[correct-capability] Failed to save corrected profile", updateError);
    return NextResponse.json({ error: "Failed to save corrected profile." }, { status: 500 });
  }

  const tEnd = Date.now();
  console.log("[correct-capability][timing] complete totalDelta=" + (tEnd - t0) + "ms tier=" + usedTier + " entryCount=" + capabilityEntries.length);

  return NextResponse.json({
    success: true,
    tier: usedTier,
    capabilitySummary,
    capabilityEntries,
    recommendedPosition,
    entryPoint,
    futurePositions,
    employerSummary
  });
}
