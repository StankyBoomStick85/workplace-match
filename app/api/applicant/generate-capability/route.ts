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

  // --- Step 1: per-document evidence extraction ---
  const { items: extractedItems, unreadableDocLabels, evidenceExtractionFailures } =
    await extractEvidenceFromDocuments(storedDocs, adminClient, anthropic, correctionMessage);

  const allEvidenceItems: EvidenceItem[] = [...extractedItems];

  const t4 = Date.now();
  console.log("[generate-capability][timing] step1 complete t4=" + t4 + " delta=" + (t4 - t2) + "ms extractedEvidence=" + allEvidenceItems.length + " unreadable=" + unreadableDocLabels.length + " extractionFailures=" + evidenceExtractionFailures.length);

  // Add self-reported profile evidence as USER_PROVIDED items
  allEvidenceItems.push(...buildSelfReportedEvidenceItems({
    summary: profile.summary,
    capabilityTags: Array.isArray(profile.capability_tags) ? (profile.capability_tags as string[]) : null
  }));

  console.log("[generate-capability][timing] totalEvidence (incl. self-reported)=" + allEvidenceItems.length);

  // --- Step 2: cross-document grouping pass (chunked + merge) ---
  const t5 = Date.now();
  const evidenceGroups = await runEvidenceGrouping(allEvidenceItems, anthropic, correctionMessage);
  const t5b = Date.now();
  console.log("[generate-capability][timing] step2 complete delta=" + (t5b - t5) + "ms groupCount=" + evidenceGroups.length);

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

  const { error: updateError } = await adminClient
    .from("candidate_profiles")
    .update(updatePayload)
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[generate-capability] Failed to save pending evidence groups", updateError);
    return NextResponse.json({ error: "Failed to save evidence groups." }, { status: 500 });
  }

  // Temporary debug gate: when set, Phase 1 still saves pending_evidence_groups as
  // normal but tells the frontend not to auto-chain into Phase 2, so the raw groups
  // can be inspected via Supabase SQL before finalize overwrites/clears them.
  const skipAutoFinalize = process.env.SKIP_AUTO_FINALIZE === "true";

  const tEnd = Date.now();
  console.log("[generate-capability][timing] phase1 complete tEnd=" + tEnd + " totalDelta=" + (tEnd - t0) + "ms evidenceCount=" + allEvidenceItems.length + " groupCount=" + evidenceGroups.length + " skipAutoFinalize=" + skipAutoFinalize);

  return NextResponse.json({
    success: true,
    status: "groups_ready",
    evidenceCount: allEvidenceItems.length,
    groupCount: evidenceGroups.length,
    skipAutoFinalize
  });
}
