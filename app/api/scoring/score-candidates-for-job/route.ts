import { createHash } from "crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Employer-direction scoring: "how well does this candidate fit this job" -
// the mirror of score-jobs/route.ts's candidate-direction "how well does this
// job fit this candidate". Deliberately a separate route and a separate
// prompt, not a parameter on score-jobs - the two directions ask genuinely
// different questions and must not be forced to converge (see the diagnostic
// this shipped with).

const CANDIDATE_BATCH_SIZE = 20;
const CLAUDE_CALL_TIMEOUT_MS = 10_000;

type CapabilityEntry = { name: string; description: string; verificationStatus: "VERIFIED" | "USER_PROVIDED" };

function parseCapabilityEntries(raw: unknown): CapabilityEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: CapabilityEntry[] = [];
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

function hashContent(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

// Exactly the fields sent to the prompt below - the allowlist already used by
// the "candidate-profiles" employer-facing read resource (app/api/mvp/read/route.ts),
// gated on is_approved. Deliberately excludes capability_summary (the
// candidate's own unreviewed draft - documented elsewhere in this codebase as
// "must never be shown to an employer") and zip_code (answers "where", not
// "can this person do the job").
function candidateContentHash(profile: {
  employer_summary: string | null;
  capability_entries: unknown;
  capability_tags: string[] | null;
  experience_level: string | null;
  job_types: string[] | null;
  work_preference: string | null;
}) {
  return hashContent({
    employer_summary: profile.employer_summary ?? "",
    capability_entries: profile.capability_entries ?? null,
    capability_tags: profile.capability_tags ?? [],
    experience_level: profile.experience_level ?? "",
    job_types: profile.job_types ?? [],
    work_preference: profile.work_preference ?? ""
  });
}

function jobContentHash(job: {
  title: string | null;
  summary: string | null;
  required_capabilities: string[] | null;
  pay_min: number | null;
  pay_max: number | null;
  pay_type: string | null;
  job_type: string | null;
}) {
  return hashContent({
    title: job.title ?? "",
    summary: job.summary ?? "",
    required_capabilities: job.required_capabilities ?? [],
    pay_min: job.pay_min ?? null,
    pay_max: job.pay_max ?? null,
    pay_type: job.pay_type ?? "",
    job_type: job.job_type ?? ""
  });
}

function parseScoreArray(text: string): Array<{ candidate_id: string; score: number }> {
  const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*$/g, "").trim();
  const tryParse = (raw: string) => {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is { candidate_id: string; score: number } =>
          item !== null &&
          typeof item === "object" &&
          typeof item.candidate_id === "string" &&
          typeof item.score === "number" &&
          isFinite(item.score)
      );
    } catch {
      return [];
    }
  };

  const direct = tryParse(cleaned);
  if (direct.length > 0) return direct;

  const match = cleaned.match(/\[[\s\S]*\]/);
  return match ? tryParse(match[0]) : [];
}

export async function POST(request: Request) {
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

  const body = await request.json().catch(() => ({}));
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  const candidateIds: string[] = Array.isArray(body.candidateIds)
    ? body.candidateIds.filter((id: unknown): id is string => typeof id === "string")
    : [];

  if (!jobId || candidateIds.length === 0) {
    return NextResponse.json({ error: "jobId and candidateIds are required." }, { status: 400 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Ownership check - an employer may only score candidates against a job
  // they themselves posted.
  const { data: job, error: jobError } = await adminClient
    .from("job_posts")
    .select("id, employer_id, title, summary, required_capabilities, pay_min, pay_max, pay_type, job_type")
    .eq("id", jobId)
    .maybeSingle();

  if (jobError) {
    console.error("[score-candidates-for-job] job fetch error:", jobError);
    return NextResponse.json({ error: "Failed to load job." }, { status: 500 });
  }
  if (!job || job.employer_id !== user.id) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  const jobHash = jobContentHash(job);

  const { data: profiles, error: profilesError } = await adminClient
    .from("candidate_profiles")
    .select("user_id, employer_summary, capability_entries, capability_tags, experience_level, job_types, work_preference, is_approved")
    .in("user_id", candidateIds);

  if (profilesError) {
    console.error("[score-candidates-for-job] profiles fetch error:", profilesError);
    return NextResponse.json({ error: "Failed to load candidate profiles." }, { status: 500 });
  }

  const profileByCandidateId = new Map((profiles ?? []).map((p) => [p.user_id as string, p]));

  const { data: existingScores, error: existingScoresError } = await adminClient
    .from("employer_match_scores")
    .select("candidate_id, score, candidate_content_hash, job_content_hash")
    .eq("employer_id", user.id)
    .eq("job_id", jobId)
    .in("candidate_id", candidateIds);

  if (existingScoresError) {
    console.error("[score-candidates-for-job] existing scores fetch error:", existingScoresError);
  }

  const existingByCandidateId = new Map((existingScores ?? []).map((row) => [row.candidate_id as string, row]));

  const scores: Record<string, number> = {};
  const toScore: Array<{ candidateId: string; hash: string; content: ReturnType<typeof buildCandidateSummary> }> = [];

  for (const candidateId of candidateIds) {
    const profile = profileByCandidateId.get(candidateId);
    // No profile, or not yet approved for employer eyes: nothing safe to
    // score against - stays unscored (no badge), not a fabricated 0.
    if (!profile || !profile.is_approved) {
      continue;
    }

    const hash = candidateContentHash(profile);
    const existing = existingByCandidateId.get(candidateId);
    if (existing && existing.candidate_content_hash === hash && existing.job_content_hash === jobHash) {
      scores[candidateId] = existing.score;
      continue;
    }

    toScore.push({ candidateId, hash, content: buildCandidateSummary(profile) });
  }

  if (toScore.length === 0) {
    return NextResponse.json({ scores });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ scores, error: "AI service not configured." });
  }

  const anthropic = new Anthropic({ apiKey });

  for (let i = 0; i < toScore.length; i += CANDIDATE_BATCH_SIZE) {
    const batch = toScore.slice(i, i + CANDIDATE_BATCH_SIZE);
    const candidateListJson = JSON.stringify(
      batch.map((c) => ({ candidate_id: c.candidateId, ...c.content })),
      null,
      2
    );

    const prompt = `You are scoring how well a candidate's demonstrated capability fits a SPECIFIC job opening, from the EMPLOYER's point of view: could this person actually do this job?

JOB:
- Title: ${job.title ?? ""}
- Full description: ${job.summary || "Not provided"}
- Required capabilities: ${Array.isArray(job.required_capabilities) && job.required_capabilities.length > 0 ? job.required_capabilities.join(", ") : "Not specified"}

CANDIDATES:
${candidateListJson}

SCORING (0-100, use the full range - do not default to the middle):
- 80-100: Strong fit - demonstrated capability directly transfers to this role's core requirements
- 55-79: Partial fit - meaningful overlap, with real gaps
- 25-54: Weak fit - some transferable capability, but a genuine stretch
- 0-24: Not a fit - no relevant transferable capability for this role

Judge TRANSFERABLE CAPABILITY, not job titles or keyword overlap. Someone who has led teams, owned budgets, and built programs is a real fit for an operations or management role even with no matching job title anywhere in their background. Someone with no relevant capability is not a fit, and the score must say so plainly - this must be able to return a genuinely low number. Do not inflate scores to be encouraging, and do not let an unfamiliar job title alone drag a score down when the underlying capability clearly transfers.

Return ONLY: [{"candidate_id": string, "score": number}]`;

    try {
      const message = await anthropic.messages.create(
        {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          messages: [{ role: "user", content: prompt }]
        },
        { timeout: CLAUDE_CALL_TIMEOUT_MS }
      );

      const text = message.content.find((b) => b.type === "text")?.text ?? "";
      const results = parseScoreArray(text);
      const hashByCandidateId = new Map(batch.map((c) => [c.candidateId, c.hash]));

      const rows = results
        .filter((r) => hashByCandidateId.has(r.candidate_id))
        .map((r) => ({
          employer_id: user.id,
          candidate_id: r.candidate_id,
          job_id: jobId,
          score: Math.max(0, Math.min(100, Math.round(r.score))),
          candidate_content_hash: hashByCandidateId.get(r.candidate_id)!,
          job_content_hash: jobHash,
          scored_at: new Date().toISOString()
        }));

      if (rows.length > 0) {
        const { error: upsertError } = await adminClient
          .from("employer_match_scores")
          .upsert(rows, { onConflict: "employer_id,candidate_id,job_id" });

        if (upsertError) {
          console.error("[score-candidates-for-job] upsert error:", upsertError);
          await logError({
            route: "/api/scoring/score-candidates-for-job",
            errorMessage: upsertError.message,
            errorType: "database",
            severity: "medium",
            userId: user.id,
            metadata: { attempted: rows.length }
          });
        } else {
          rows.forEach((r) => { scores[r.candidate_id] = r.score; });
        }
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isTimeout = errorMessage.toLowerCase().includes("timeout") || (err instanceof Error && err.name === "APIConnectionTimeoutError");
      if (isTimeout) {
        console.warn("[score-candidates-for-job] Anthropic call timed out - continuing with partial results");
        continue;
      }
      console.error("[score-candidates-for-job] error:", errorMessage);
      await logError({
        route: "/api/scoring/score-candidates-for-job",
        errorMessage,
        errorType: "ai_generation",
        severity: "medium",
        userId: user.id
      });
      // Leave this batch unscored (no badge) and keep going with the rest.
    }
  }

  return NextResponse.json({ scores });
}

function buildCandidateSummary(profile: {
  employer_summary: string | null;
  capability_entries: unknown;
  capability_tags: string[] | null;
  experience_level: string | null;
  job_types: string[] | null;
  work_preference: string | null;
}) {
  const entries = parseCapabilityEntries(profile.capability_entries);
  return {
    employer_summary: profile.employer_summary || "Not provided",
    capabilities: entries.length > 0
      ? entries.map((e) => `[${e.verificationStatus}] ${e.name}: ${e.description}`)
      : [],
    capability_tags: Array.isArray(profile.capability_tags) ? profile.capability_tags : [],
    experience_level: profile.experience_level || "Not specified",
    desired_job_types: Array.isArray(profile.job_types) ? profile.job_types : [],
    work_preference: profile.work_preference || "Not specified"
  };
}
