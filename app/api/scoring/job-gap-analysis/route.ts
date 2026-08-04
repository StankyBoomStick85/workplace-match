import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type GapKind = "hard_blocker" | "closeable" | "experience_only";

type CapabilityGap = {
  missing: string;
  isHardRequirement: boolean;
  kind: GapKind;
  closingPath: string;
  estimatedTime: string;
  rampUpOnly: boolean;
};

type MatchingStrength = {
  capability: string;
  relevance: string;
  sourceCapability: string;
  isDocumented: boolean;
};

type JobGapAnalysis = {
  strengths: MatchingStrength[];
  gaps: CapabilityGap[];
};

// The structured shape candidate_profiles.capability_entries stores per entry -
// only the three fields this route actually uses (name, description,
// verificationStatus). The full stored shape also carries doc-provenance fields
// (primaryDocLabel, primaryDocId, corroboratingDocLabels) that aren't needed here.
type CandidateCapabilityEntry = {
  name: string;
  description: string;
  verificationStatus: "VERIFIED" | "USER_PROVIDED";
};

function parseCapabilityEntries(raw: unknown): CandidateCapabilityEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: CandidateCapabilityEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.name === "string" &&
      typeof record.description === "string" &&
      (record.verificationStatus === "VERIFIED" || record.verificationStatus === "USER_PROVIDED")
    ) {
      entries.push({ name: record.name, description: record.description, verificationStatus: record.verificationStatus });
    }
  }
  return entries;
}

function isValidGapKind(value: unknown): value is GapKind {
  return value === "hard_blocker" || value === "closeable" || value === "experience_only";
}

function parseGapAnalysis(raw: string): JobGapAnalysis | null {
  const cleaned = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.strengths) || !Array.isArray(obj.gaps)) return null;

  const strengths: MatchingStrength[] = [];
  for (const item of obj.strengths as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.capability === "string" && typeof record.relevance === "string") {
      strengths.push({
        capability: record.capability,
        relevance: record.relevance,
        // Lenient on this one field: it's new, and dropping an otherwise-valid
        // strength just because the model omitted the trace-back name would lose
        // more than it protects.
        sourceCapability: typeof record.sourceCapability === "string" ? record.sourceCapability : "",
        // Placeholder - never trust a model-reported verification flag. The real
        // value is resolved in POST by looking sourceCapability up against the
        // candidate's actual capability_entries, the same way capability_entries'
        // own verificationStatus is only ever derived from stored data, not from
        // anything a model wrote about it.
        isDocumented: false
      });
    }
  }

  const gaps: CapabilityGap[] = [];
  for (const item of obj.gaps as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (
      typeof record.missing === "string" &&
      typeof record.isHardRequirement === "boolean" &&
      isValidGapKind(record.kind) &&
      typeof record.closingPath === "string" &&
      typeof record.estimatedTime === "string"
    ) {
      gaps.push({
        missing: record.missing,
        isHardRequirement: record.isHardRequirement,
        kind: record.kind,
        closingPath: record.closingPath,
        estimatedTime: record.estimatedTime,
        // Treat missing/non-boolean as false - undefined only means the model
        // (or an older cached row, though those are returned before this parser
        // ever runs) didn't mark it as ramp-up, not that it safely is.
        rampUpOnly: record.rampUpOnly === true
      });
    }
  }

  return { strengths, gaps };
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const jobId = typeof body?.jobId === "string" ? body.jobId : "";
  const jobSource = body?.jobSource === "wpm" || body?.jobSource === "adzuna" ? body.jobSource : "";
  const matchPercent = typeof body?.matchPercent === "number" ? body.matchPercent : null;

  if (!jobId || !jobSource) {
    return NextResponse.json({ error: "jobId and jobSource are required." }, { status: 400 });
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

  // Cache hit: return the stored analysis without calling the model again.
  const { data: cached, error: cacheError } = await adminClient
    .from("job_gap_analysis")
    .select("gap_data")
    .eq("candidate_id", user.id)
    .eq("job_id", jobId)
    .maybeSingle();

  if (cacheError) {
    console.error("[job-gap-analysis] cache lookup error", cacheError);
  }
  if (cached?.gap_data) {
    return NextResponse.json({ success: true, cached: true, gapAnalysis: cached.gap_data });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI service not configured." }, { status: 500 });
  }

  const { data: profile, error: profileError } = await adminClient
    .from("candidate_profiles")
    .select("capability_summary, capability_tags, capability_entries, recommended_position, experience_level")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError || !profile) {
    return NextResponse.json({ error: "Failed to load profile." }, { status: 500 });
  }

  // Read at the moment the profile is used as input to this analysis - see the
  // migration's comment on why this isn't sourced from a real profile-updated-at
  // column (none exists on candidate_profiles today).
  const generatedAgainstProfileAt = new Date().toISOString();

  let jobTitle = "";
  let fullDescription = "";
  let requiredCapabilities: string[] = [];

  if (jobSource === "wpm") {
    const { data: job, error: jobError } = await adminClient
      .from("job_posts")
      .select("title, summary, required_capabilities")
      .eq("id", jobId)
      .maybeSingle();
    if (jobError || !job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }
    jobTitle = job.title ?? "";
    // Full text, no 200-char slice - gap analysis needs real requirement language.
    fullDescription = (job.summary as string) ?? "";
    requiredCapabilities = Array.isArray(job.required_capabilities) ? (job.required_capabilities as string[]) : [];
  } else {
    const { data: job, error: jobError } = await adminClient
      .from("adzuna_cache")
      .select("title, description")
      .eq("id", jobId)
      .maybeSingle();
    if (jobError || !job) {
      return NextResponse.json({ error: "Job not found." }, { status: 404 });
    }
    jobTitle = job.title ?? "";
    // Already capped at 1500 chars at ingestion (refresh-adzuna-cache) - used here
    // in full, not re-sliced to 200 the way the batch scorer does.
    fullDescription = (job.description as string) ?? "";
  }

  const capabilityTags = Array.isArray(profile.capability_tags) ? (profile.capability_tags as string[]).join(", ") : "Not specified";

  // capability_entries is the structured, per-capability record (name, description,
  // verification status) the rest of the app already treats as the source of truth -
  // capability_summary is prose generated FROM these entries, so comparing a job
  // against the summary alone throws away exactly the verification signal this
  // analysis needs. Fall back to the summary only for older profiles that predate
  // capability_entries.
  const capabilityEntries = parseCapabilityEntries(profile.capability_entries);
  const hasCapabilityEntries = capabilityEntries.length > 0;

  const candidateCapabilitiesSection = hasCapabilityEntries
    ? capabilityEntries.map((e) => `- [${e.verificationStatus}] ${e.name}: ${e.description}`).join("\n")
    : (profile.capability_summary ?? "Not provided");

  const prompt = `CANDIDATE:
Demonstrated capabilities${hasCapabilityEntries ? " (VERIFIED = backed by an uploaded document; USER_PROVIDED = self-reported, not independently confirmed)" : ""}:
${candidateCapabilitiesSection}
${hasCapabilityEntries ? `\nBackground summary (supporting context only, not the primary source): ${profile.capability_summary ?? "Not provided"}\n` : ""}
- Capability tags: ${capabilityTags}
- Recommended role: ${profile.recommended_position ?? "Not provided"}
- Experience level: ${profile.experience_level ?? "Not specified"}

JOB:
- Title: ${jobTitle}
- Full description: ${fullDescription || "Not provided"}
- Required capabilities: ${requiredCapabilities.length > 0 ? requiredCapabilities.join(", ") : "Not specified"}
- Match score already assigned: ${matchPercent !== null ? `${matchPercent}%` : "Not provided"}

Identify what specifically separates this candidate from a stronger match for this role. For each distinct capability, credential, or requirement the job calls for that this candidate's profile does not clearly demonstrate:
- State it in plain language.
- Say whether the posting treats it as a hard requirement or a preference.
- Classify it as exactly one of: "hard_blocker" (the candidate cannot currently satisfy this - an active clearance, a state-issued license they do not hold, a degree requirement with no substitution path), "closeable" (a specific certification, course, or credential would close it), or "experience_only" (only time actually spent in a role like this closes it - no certification substitutes).
- Give a specific, realistic closing path - name the actual certification, course, or license if there is one, not "get more experience."
- Estimate how long that realistically takes.
- Set "rampUpOnly" to distinguish knowledge a capable person absorbs during normal onboarding from knowledge that takes real time to build. Learning an employer's internal systems, vocabulary, reporting structure, or administrative processes is normal ramp-up, not a gap - mark those rampUpOnly true. Learning a regulated domain, earning a credential, or building genuine operational experience in a field is a real gap - mark those rampUpOnly false. Do not treat unfamiliarity with an organization's internal way of doing things as a barrier to someone who has done equivalent work elsewhere.
${hasCapabilityEntries ? `
Verification status is a confidence signal, not a scoring signal - it describes how provable a match is, not whether it is a match. A capability the candidate claims, VERIFIED or USER_PROVIDED, counts as meeting any requirement it addresses. Do not treat a USER_PROVIDED capability as weaker evidence of fit than a VERIFIED one, and do not list a requirement as a gap just because the capability addressing it happens to be self-reported rather than documented - most candidates cannot produce paperwork for most of their work history, and that absence says nothing about whether they can actually do the job. A requirement is only a gap when nothing in the candidate's demonstrated capabilities addresses it at all. When a strength is drawn from a USER_PROVIDED capability, describe it exactly as you would describe a VERIFIED one - do not downgrade, hedge, or qualify it in the strength text.
` : ""}
Separately, identify what the candidate's background already demonstrates that maps to this role's requirements. Be specific about which stated requirement each strength addresses, so this reads as evidence, not a generic skills list.${hasCapabilityEntries ? ` For each strength, set "sourceCapability" to the exact name of the demonstrated capability above it is drawn from, copied exactly as given, so the candidate can trace it back to that specific entry.` : ""}

Return ONLY valid JSON matching this exact shape, no markdown fences, no explanation, no text outside the JSON:
{
  "strengths": [{ "capability": string, "relevance": string, "sourceCapability": string }],
  "gaps": [{ "missing": string, "isHardRequirement": boolean, "kind": "hard_blocker" | "closeable" | "experience_only", "closingPath": string, "estimatedTime": string, "rampUpOnly": boolean }]
}`;

  const anthropic = new Anthropic({ apiKey });

  let gapAnalysis: JobGapAnalysis | null = null;
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }]
    });
    const raw = message.content.find((b) => b.type === "text")?.text ?? "";
    gapAnalysis = parseGapAnalysis(raw);
  } catch (err) {
    console.error("[job-gap-analysis] Anthropic API error", err);
    const errMessage = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Gap analysis failed: ${errMessage}` }, { status: 500 });
  }

  if (!gapAnalysis) {
    console.error("[job-gap-analysis] failed to parse model response");
    return NextResponse.json({ error: "Failed to generate gap analysis. Please try again." }, { status: 500 });
  }

  // isDocumented is resolved here, not asked of the model - it's looked up against
  // the candidate's actual capability_entries, the same "never trust the model for
  // a verification fact" rule the capability-generation pipeline already follows.
  // Falls back to false when there are no capability_entries at all (older profile,
  // capability_summary-only) - there's no per-item verification data to check then.
  gapAnalysis.strengths = gapAnalysis.strengths.map((strength) => ({
    ...strength,
    isDocumented: hasCapabilityEntries
      ? capabilityEntries.some((entry) => entry.name === strength.sourceCapability && entry.verificationStatus === "VERIFIED")
      : false
  }));

  const { error: upsertError } = await adminClient
    .from("job_gap_analysis")
    .upsert(
      {
        candidate_id: user.id,
        job_id: jobId,
        job_source: jobSource,
        gap_data: gapAnalysis,
        generated_at: new Date().toISOString(),
        generated_against_profile_at: generatedAgainstProfileAt
      },
      { onConflict: "candidate_id,job_id" }
    );

  if (upsertError) {
    console.error("[job-gap-analysis] failed to cache gap analysis", upsertError);
    // Not fatal to the caller - they still got a valid analysis, it just won't be
    // cached for next time.
  }

  return NextResponse.json({ success: true, cached: false, gapAnalysis });
}
