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
  type CapabilityEntry
} from "@/lib/capabilityPipeline";

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
    .select("job_types, experience_level, work_preference, capability_tags, summary, summary_priority, pending_evidence_groups, capability_generation_status, document_metadata")
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

  if (evidenceGroups.length > 0) {
    try {
      const step3Response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        temperature: 0.2,
        messages: [{ role: "user", content: buildStep3Prompt(evidenceGroups) }],
      });

      const rawStep3Text = step3Response.content.find((b) => b.type === "text")?.text ?? "";
      const result = parseStep3Response(rawStep3Text, evidenceGroups, storedDocs);

      if (result.kind === "escalate") {
        // Phase 2 always calls buildStep3Prompt without a correction instruction, so the
        // model has no sentinel to return here - this branch only fires on a genuine
        // parse failure (partial/garbled output), which is why it's a hard error rather
        // than a silent partial save.
        console.error("[generate-capability-finalize] Step 3 output was not fully parseable (unexpected without a correction in play)");
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
    const tStep4Err = Date.now();
    console.log("[generate-capability-finalize][timing] step4 FAILED t=" + tStep4Err + " delta=" + (tStep4Err - t7) + "ms");
    console.error("[generate-capability-finalize] step4 Anthropic API error", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `AI generation failed: ${message}` }, { status: 500 });
  }

  const tStep4End = Date.now();
  console.log("[generate-capability-finalize][timing] step4 complete t=" + tStep4End + " delta=" + (tStep4End - t7) + "ms responseLen=" + positionsText.length);

  const recommendedPosition = extractSection(positionsText, "RECOMMENDED_POSITION", "ENTRY_POINT");
  const entryPoint = extractSection(positionsText, "ENTRY_POINT", "FUTURE_POSITIONS");
  const futurePositions = extractSection(positionsText, "FUTURE_POSITIONS");

  const t8 = Date.now();

  // --- Employer Summary ---
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
    console.error("[generate-capability-finalize] Employer summary API error", err);
    employerSummary = "";
  }

  const t9 = Date.now();
  console.log("[generate-capability-finalize][timing] employer summary complete t9=" + t9 + " delta=" + (t9 - t8) + "ms employerSummaryLen=" + employerSummary.length);

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

  const tEnd = Date.now();
  console.log("[generate-capability-finalize][timing] phase2 complete tEnd=" + tEnd + " totalDelta=" + (tEnd - t0) + "ms entryCount=" + capabilityEntries.length);

  return NextResponse.json({ success: true, capabilitySummary, capabilityEntries, recommendedPosition, entryPoint, futurePositions, employerSummary });
}
