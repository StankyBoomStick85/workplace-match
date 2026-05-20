import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { logError } from "../../../../lib/logError";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return NextResponse.json({ error: "Server configuration missing." }, { status: 500 });
  }

  // Authenticate the caller
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
  const candidateId = typeof body.candidateId === "string" ? body.candidateId : "";
  const scoringMode: "quick" | "career" | "gig" =
    body.scoringMode === "quick" ? "quick" : body.scoringMode === "gig" ? "gig" : "career";
  const forceRescore: boolean = body.forceRescore === true;
  const onlyCached: boolean = body.onlyCached === true;
  const priorityJobIds: string[] = Array.isArray(body.priorityJobIds) ? body.priorityJobIds : [];
  console.log("[score-jobs] scoringMode:", scoringMode, "forceRescore:", forceRescore, "onlyCached:", onlyCached, "priorityIds:", priorityJobIds.length);

  if (!candidateId || candidateId !== user.id) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 403 });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI service not configured." }, { status: 500 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // Fetch candidate profile
  const { data: profile, error: profileError } = await adminClient
    .from("candidate_profiles")
    .select("capability_summary, capability_tags, recommended_position, experience_level, desired_pay_min, pay_type, job_types, work_preference, city, state")
    .eq("user_id", candidateId)
    .maybeSingle();

  if (profileError) {
    console.error("[score-jobs] profile fetch error:", profileError);
    return NextResponse.json({ error: "Failed to load profile." }, { status: 500 });
  }
  if (!profile) {
    return NextResponse.json({ scored: 0, skipped: 0, error: "No profile found." });
  }

  // Fetch active WPM job posts
  const { data: wpmJobs, error: jobsError } = await adminClient
    .from("job_posts")
    .select("id, title, summary, required_capabilities, pay_min, pay_max, pay_type, job_type")
    .eq("active", true);

  if (jobsError) {
    console.error("[score-jobs] job_posts fetch error:", jobsError);
    return NextResponse.json({ error: "Failed to load jobs." }, { status: 500 });
  }

  // Fetch unexpired Adzuna cache entries
  const { data: adzunaJobs, error: cacheError } = await adminClient
    .from("adzuna_cache")
    .select("id, title, description, salary_min, salary_max, job_type")
    .gt("expires_at", new Date().toISOString());

  if (cacheError) {
    console.error("[score-jobs] adzuna_cache fetch error:", cacheError);
  }

  // When force-rescoring, delete all existing scores so the poll doesn't return stale data
  if (forceRescore) {
    const { error: deleteError, count } = await adminClient
      .from("match_scores")
      .delete({ count: "exact" })
      .eq("candidate_id", candidateId);
    if (deleteError) {
      console.error("[score-jobs] forceRescore: failed to delete existing scores:", deleteError);
    } else {
      console.log("[score-jobs] forceRescore: deleted", count, "existing match_scores rows");
    }
  }

  // Fetch remaining non-expired scores to skip (empty when forceRescore deleted them)
  const scoredJobIds = new Set<string>();
  const cachedScoreMap: Record<string, number> = {};
  if (!forceRescore) {
    const { data: existingScores } = await adminClient
      .from("match_scores")
      .select("job_id, score")
      .eq("candidate_id", candidateId)
      .gt("expires_at", new Date().toISOString());
    const rows = existingScores ?? [];
    // Detect corrupt scoring run: if every score is <= 3, delete and rescore fresh
    if (rows.length > 0 && rows.every((r: { score: number }) => r.score <= 3)) {
      console.log("[score-jobs] all", rows.length, "existing scores are <= 3 (corrupt) — deleting and rescoring");
      await adminClient.from("match_scores").delete().eq("candidate_id", candidateId);
    } else {
      rows.forEach((r: { job_id: string; score: number }) => {
        scoredJobIds.add(r.job_id);
        cachedScoreMap[r.job_id] = r.score;
      });
      console.log("[score-jobs] cache: found", scoredJobIds.size, "existing scores, will skip");
    }
  }

  // Build the list of jobs that need scoring (skip already-scored)
  type JobToScore = {
    job_id: string;
    source: "wpm" | "adzuna";
    title: string;
    description: string;
    required_capabilities: string[];
    pay_min: number | null;
    pay_max: number | null;
    pay_type: string | null;
    job_type: string | null;
  };

  const jobsToScore: JobToScore[] = [];

  for (const job of wpmJobs ?? []) {
    if (scoredJobIds.has(job.id)) continue;
    jobsToScore.push({
      job_id: job.id,
      source: "wpm",
      title: job.title ?? "",
      description: ((job.summary as string) ?? "").slice(0, 200),
      required_capabilities: (job.required_capabilities as string[]) ?? [],
      pay_min: job.pay_min ?? null,
      pay_max: job.pay_max ?? null,
      pay_type: job.pay_type ?? null,
      job_type: job.job_type ?? null
    });
  }

  for (const job of adzunaJobs ?? []) {
    if (scoredJobIds.has(job.id)) continue;
    jobsToScore.push({
      job_id: job.id,
      source: "adzuna",
      title: job.title ?? "",
      description: ((job.description as string) ?? "").slice(0, 200),
      required_capabilities: [],
      pay_min: job.salary_min ?? null,
      pay_max: job.salary_max ?? null,
      pay_type: "salary",
      job_type: job.job_type ?? null
    });
  }

  const skipped = scoredJobIds.size;

  if (jobsToScore.length === 0) {
    console.log("[score-jobs] all jobs already scored, returning", Object.keys(cachedScoreMap).length, "cached scores");
    return NextResponse.json({ scored: 0, skipped, scores: cachedScoreMap, remaining: 0 });
  }

  // Fast path: caller only wants already-stored scores, no Claude call needed
  if (onlyCached) {
    console.log("[score-jobs] onlyCached=true, returning", Object.keys(cachedScoreMap).length, "cached scores, remaining:", jobsToScore.length);
    return NextResponse.json({ scored: 0, skipped, scores: cachedScoreMap, remaining: jobsToScore.length });
  }

  // Prioritise visible-viewport jobs so they land in the first batch
  if (priorityJobIds.length > 0) {
    const prioritySet = new Set(priorityJobIds);
    jobsToScore.sort((a, b) =>
      (prioritySet.has(a.job_id) ? 0 : 1) - (prioritySet.has(b.job_id) ? 0 : 1)
    );
  }

  // Cap at 20 jobs per call — keeps prompt latency well under Vercel's timeout
  const batch = jobsToScore.slice(0, 20);

  const capabilityTags = Array.isArray(profile.capability_tags) ? profile.capability_tags.join(", ") : "Not specified";
  const jobTypes = Array.isArray(profile.job_types) ? profile.job_types.join(", ") : "Not specified";

  console.log("[score-jobs] profile fields sent to Claude:");
  console.log("  capability_summary:", profile.capability_summary ?? "(null)");
  console.log("  recommended_position:", profile.recommended_position ?? "(null)");
  console.log("  experience_level:", profile.experience_level ?? "(null)");
  console.log("  capabilityTags:", capabilityTags);

  const jobListJson = JSON.stringify(
    batch.map((job) => ({
      job_id: job.job_id,
      title: job.title,
      description: job.description,
      required_capabilities: job.required_capabilities,
      pay_min: job.pay_min,
      pay_max: job.pay_max,
      pay_type: job.pay_type,
      job_type: job.job_type
    })),
    null,
    2
  );

  const prompt = scoringMode === "gig"
    ? `You are a job match scorer for gig and flexible work. Score each job 0-100 based on how accessible and available this work is for the candidate.

CANDIDATE:
- Capability summary: ${profile.capability_summary ?? "Not provided"}
- Capability tags: ${capabilityTags}

SCORING:
- 80-95: Classic gig/flex role — basic mobility and reliability are sufficient, candidate can start immediately
- 60-79: Light skill requirement but candidate clearly qualifies
- 40-59: Some barrier (vehicle type, license, equipment) but likely surmountable
- 20-39: Significant requirement mismatch (CDL, heavy equipment, specialized certification)
- 5-19: Not gig work or candidate is clearly unqualified
- Availability and flexibility matter more than career fit or seniority
- Never penalize overqualification — a senior professional can drive for DoorDash
- Spread your scores — not every gig job is identical

Jobs to score:
${jobListJson}

Return ONLY: [{"job_id": string, "score": number}]`
    : scoringMode === "quick"
    ? `You are a job match scorer. Score each job 0-100 based on whether this candidate can physically perform this job today.

CANDIDATE:
- Capability summary: ${profile.capability_summary ?? "Not provided"}
- Capability tags: ${capabilityTags}

SCORING:
- 80-95: They can clearly do this job with their current skills
- 60-79: They can do this job with minimal adjustment
- 40-59: Possible but requires some skill gap bridging
- 20-39: Significant gaps but not impossible
- 5-19: Missing required credentials or physical requirements
- Overqualification is NOT a penalty - a senior leader who can work a warehouse shift scores 80+
- Military experience = physical capability, discipline, reliability, teamwork, following/giving instructions

Jobs to score:
${jobListJson}

Return ONLY: [{"job_id": string, "score": number}]`
    : `You are a job match scorer. Score each job 0-100 based on how well it fits this candidate's career level and trajectory.

CANDIDATE:
- Capability summary: ${profile.capability_summary ?? "Not provided"}
- Recommended role: ${profile.recommended_position ?? "Not provided"}
- Experience level: ${profile.experience_level ?? "Not specified"}
- Capability tags: ${capabilityTags}

SCORING:
- 75-95: Strong career fit - role matches their experience level and uses core capabilities
- 50-74: Partial fit - related field or one level below their experience
- 25-49: Weak fit - significant underutilization but they could do the job
- 10-24: Poor fit - gig work or entry-level for a senior professional
- 5-15: Not qualified - requires credentials or specialization they don't have
- NEVER score 0-4 unless the candidate is completely unqualified
- Military leadership translates to: operations management, logistics, training, program management, strategy, team leadership
- Spread your scores - not everything should be the same number

Jobs to score:
${jobListJson}

Return ONLY: [{"job_id": string, "score": number}]`;

  console.log("[score-jobs] prompt variant:", scoringMode, "| prompt (first 120):", prompt.slice(0, 120));

  let scored = 0;
  try {
    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }]
      },
      { timeout: 10_000 }
    );

    const text = message.content.find((b) => b.type === "text")?.text ?? "";
    const results = parseJsonArray(text);

    if (results.length === 0) {
      console.error("[score-jobs] Claude returned no parseable scores. Raw:", text.slice(0, 300));
      console.log("[score-jobs] returning (no-parse path): cachedScoreMap size =", Object.keys(cachedScoreMap).length);
      return NextResponse.json({ scored: 0, skipped, scores: cachedScoreMap });
    }

    const firstResult = results[0];
    const firstJobTitle = batch.find((j) => j.job_id === firstResult.job_id)?.title ?? "unknown";
    console.log("[score-jobs] mode:", scoringMode, "| scored", results.length, "jobs | first:", firstJobTitle, "→", firstResult.score);

    // Map job_id → source for expiry calculation
    const sourceMap = new Map(batch.map((j) => [j.job_id, j.source]));

    const wpmExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const adzunaExpiry = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

    const scoreRows = results
      .filter((r) => sourceMap.has(r.job_id))
      .map((r) => {
        const source = sourceMap.get(r.job_id)!;
        return {
          candidate_id: candidateId,
          job_id: r.job_id,
          job_source: source,
          score: Math.max(0, Math.min(100, Math.round(r.score))),
          scored_at: new Date().toISOString(),
          expires_at: source === "wpm" ? wpmExpiry : adzunaExpiry
        };
      });

    if (scoreRows.length > 0) {
      const { error: upsertError } = await adminClient
        .from("match_scores")
        .upsert(scoreRows, { onConflict: "candidate_id,job_id" });

      if (upsertError) {
        console.error("[score-jobs] upsert error:", upsertError);
        await logError({
          route: "/api/scoring/score-jobs",
          errorMessage: upsertError.message,
          errorType: "database",
          severity: "medium",
          userId: candidateId,
          metadata: { attempted: scoreRows.length }
        });
      } else {
        scored = scoreRows.length;
        console.log("[score-jobs] upserted", scored, "scores");
        scoreRows.forEach((r) => { cachedScoreMap[r.job_id] = r.score; });
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    const isTimeout = errorMessage.toLowerCase().includes("timeout") || (err instanceof Error && err.name === "APIConnectionTimeoutError");
    if (isTimeout) {
      console.warn("[score-jobs] Anthropic call timed out after 10s — returning partial results (scored:", scored, ")");
      console.log("[score-jobs] returning (timeout path): cachedScoreMap size =", Object.keys(cachedScoreMap).length);
      return NextResponse.json({ scored, skipped, timedOut: true, scores: cachedScoreMap });
    }
    console.error("[score-jobs] error:", errorMessage);
    await logError({
      route: "/api/scoring/score-jobs",
      errorMessage,
      errorType: "ai_generation",
      severity: "medium",
      userId: candidateId
    });
    console.log("[score-jobs] returning (error path): cachedScoreMap size =", Object.keys(cachedScoreMap).length);
    return NextResponse.json({ scored: 0, skipped, error: errorMessage, scores: cachedScoreMap });
  }

  console.log("[score-jobs] returning (success path): cachedScoreMap size =", Object.keys(cachedScoreMap).length, "| scored this call:", scored, "| skipped (cached):", skipped);
  return NextResponse.json({ scored, skipped, scores: cachedScoreMap });
}

function parseJsonArray(text: string): Array<{ job_id: string; score: number }> {
  const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```\s*$/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) =>
        item !== null &&
        typeof item === "object" &&
        typeof item.job_id === "string" &&
        typeof item.score === "number" &&
        isFinite(item.score)
    );
  } catch {
    // Try to extract JSON array from somewhere in the text
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) return parsed.filter(
          (item) =>
            item !== null &&
            typeof item === "object" &&
            typeof item.job_id === "string" &&
            typeof item.score === "number"
        );
      } catch {
        // give up
      }
    }
    return [];
  }
}
