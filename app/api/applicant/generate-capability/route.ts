import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { extractEvidenceFromDocuments, runEvidenceGrouping, buildSelfReportedEvidenceItems, type EvidenceItem, type StoredDoc } from "@/lib/capabilityPipeline";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const t0 = Date.now();
  console.log("[generate-capability][timing] START t0=" + t0);

  // Optional: present only when this run is the first half of a correction's Tier 2
  // escalation (see correct-capability/route.ts). Absent for a normal "Generate My
  // Capability Profile" run, which behaves exactly as before.
  const body = await request.json().catch(() => null);
  const correctionMessage = typeof body?.correctionMessage === "string" && body.correctionMessage.trim()
    ? body.correctionMessage.trim()
    : undefined;

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
  console.log("[generate-capability][timing] after getUser() t1=" + t1 + " delta=" + (t1 - t0) + "ms");
  if (userError || !user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: profile, error: profileError } = await adminClient
    .from("candidate_profiles")
    .select("capability_tags, summary, document_metadata")
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

  const t2 = Date.now();
  console.log("[generate-capability][timing] after profile query t2=" + t2 + " delta=" + (t2 - t1) + "ms docCount=" + (profile.document_metadata?.length ?? "null"));

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI service not configured." }, { status: 500 });
  }

  const storedDocs: StoredDoc[] = Array.isArray(profile.document_metadata)
    ? (profile.document_metadata as StoredDoc[])
    : [];

  const anthropic = new Anthropic({ apiKey });

  console.log("[generate-capability][timing] STAGE INPUT docCount=" + storedDocs.length + " correctionMessagePresent=" + Boolean(correctionMessage));

  // --- Step 1: per-document evidence extraction ---
  const { items: extractedItems, unreadableDocLabels, evidenceExtractionFailures } =
    await extractEvidenceFromDocuments(storedDocs, adminClient, anthropic, correctionMessage);

  const allEvidenceItems: EvidenceItem[] = [...extractedItems];

  const t4 = Date.now();
  console.log("[generate-capability][timing] document extraction complete delta=" + (t4 - t2) + "ms docCount=" + storedDocs.length + " extractedEvidence=" + allEvidenceItems.length + " unreadable=" + unreadableDocLabels.length + " extractionFailures=" + evidenceExtractionFailures.length + " correctionMessagePresent=" + Boolean(correctionMessage));

  // Add self-reported profile evidence as USER_PROVIDED items
  allEvidenceItems.push(...buildSelfReportedEvidenceItems({
    summary: profile.summary,
    capabilityTags: Array.isArray(profile.capability_tags) ? (profile.capability_tags as string[]) : null
  }));

  console.log("[generate-capability][timing] totalEvidence (incl. self-reported)=" + allEvidenceItems.length);

  // --- Step 2: cross-document grouping pass (chunked + merge) ---
  const t5 = Date.now();
  const groupingResult = await runEvidenceGrouping(allEvidenceItems, anthropic, correctionMessage);
  const evidenceGroups = groupingResult.groups;

  for (const batchTiming of groupingResult.batchTimings) {
    console.log(
      "[generate-capability][timing] each grouping batch complete batchIndex=" + batchTiming.batchIndex +
      " delta=" + batchTiming.elapsedMs + "ms itemsIn=" + batchTiming.itemsIn + " groupsOut=" + batchTiming.groupsOut
    );
  }

  if (groupingResult.mergeRan) {
    console.log(
      "[generate-capability][timing] merge pass complete delta=" + groupingResult.mergeElapsedMs + "ms" +
      " preliminaryGroups=" + groupingResult.preliminaryGroupCount + " finalGroups=" + evidenceGroups.length
    );
  } else {
    console.log("[generate-capability][timing] merge pass SKIPPED (preliminaryGroupCount=" + groupingResult.preliminaryGroupCount + ", batchCount=" + groupingResult.batchCount + ")");
  }

  const t5b = Date.now();
  console.log(
    "[generate-capability][timing] step2 (grouping) complete delta=" + (t5b - t5) + "ms" +
    " batchCount=" + groupingResult.batchCount +
    " totalEvidenceItems=" + allEvidenceItems.length +
    " mergeRan=" + groupingResult.mergeRan +
    " groupCount=" + evidenceGroups.length +
    " correctionMessagePresent=" + Boolean(correctionMessage)
  );

  // --- Phase 1 handoff: save grouped evidence for Phase 2 (and later corrections) to pick up ---
  // A correction invalidates any prior approval and is recorded on the profile here,
  // since this is the one write both the normal flow and a correction's Tier 2
  // escalation always pass through. The normal (no-correction) flow's is_approved
  // handling is unchanged - this only fires when correctionMessage is present.
  const updatePayload: Record<string, unknown> = {
    pending_evidence_groups: evidenceGroups,
    capability_generation_status: "groups_ready"
  };
  if (correctionMessage) {
    updatePayload.correction_notes = correctionMessage;
    updatePayload.is_approved = false;
  }

  const tDbWriteStart = Date.now();
  const { error: updateError } = await adminClient
    .from("candidate_profiles")
    .update(updatePayload)
    .eq("user_id", user.id);
  const tDbWriteEnd = Date.now();

  if (updateError) {
    console.error("[generate-capability] Failed to save pending evidence groups", updateError);
    console.log("[generate-capability][timing] DB write FAILED delta=" + (tDbWriteEnd - tDbWriteStart) + "ms");
    return NextResponse.json({ error: "Failed to save evidence groups." }, { status: 500 });
  }

  console.log("[generate-capability][timing] DB write complete delta=" + (tDbWriteEnd - tDbWriteStart) + "ms");

  // Temporary debug gate: when set, Phase 1 still saves pending_evidence_groups as
  // normal but tells the frontend not to auto-chain into Phase 2, so the raw groups
  // can be inspected via Supabase SQL before finalize overwrites/clears them.
  const skipAutoFinalize = process.env.SKIP_AUTO_FINALIZE === "true";

  const tEnd = Date.now();
  const totalElapsedSeconds = (tEnd - t0) / 1000;
  console.log(
    "[generate-capability][timing] phase1 complete tEnd=" + tEnd +
    " totalDelta=" + (tEnd - t0) + "ms" +
    " totalElapsedSeconds=" + totalElapsedSeconds.toFixed(2) +
    " docCount=" + storedDocs.length +
    " evidenceCount=" + allEvidenceItems.length +
    " batchCount=" + groupingResult.batchCount +
    " mergeRan=" + groupingResult.mergeRan +
    " groupCount=" + evidenceGroups.length +
    " correctionMessagePresent=" + Boolean(correctionMessage) +
    " skipAutoFinalize=" + skipAutoFinalize
  );

  return NextResponse.json({
    success: true,
    status: "groups_ready",
    evidenceCount: allEvidenceItems.length,
    groupCount: evidenceGroups.length,
    batchCount: groupingResult.batchCount,
    mergeRan: groupingResult.mergeRan,
    totalElapsedSeconds,
    skipAutoFinalize
  });
}
