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
  const scoringMode: "quick" | "career" = body.scoringMode === "quick" ? "quick" : "career";
  const forceRescore: boolean = body.forceRescore === true;
  console.log("[score-jobs] scoringMode:", scoringMode, "forceRescore:", forceRescore);

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
  if (!forceRescore) {
    const { data: existingScores } = await adminClient
      .from("match_scores")
      .select("job_id")
      .eq("candidate_id", candidateId)
      .gt("expires_at", new Date().toISOString());
    (existingScores ?? []).forEach((row: { job_id: string }) => scoredJobIds.add(row.job_id));
    console.log("[score-jobs] cache: found", scoredJobIds.size, "existing scores, will skip");
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
    console.log("[score-jobs] all jobs already scored, skipped:", skipped);
    return NextResponse.json({ scored: 0, skipped });
  }

  // Cap at 100 jobs per call to keep prompt manageable
  const batch = jobsToScore.slice(0, 100);

  const capabilityTags = Array.isArray(profile.capability_tags) ? profile.capability_tags.join(", ") : "Not specified";
  const jobTypes = Array.isArray(profile.job_types) ? profile.job_types.join(", ") : "Not specified";

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

  const prompt = scoringMode === "quick"
    ? `You are evaluating whether a candidate can perform each job. For each job:
1. Extract what the job actually requires from its title and description.
2. Compare those requirements against the candidate's capability profile using semantic equivalence — "led small unit operations under pressure" covers "project management and crisis decision-making".
3. Score = what percentage of this job's requirements does this candidate cover?
4. Overqualification is not penalized. If they cover 90% of requirements, score is 90.
Score reflects: capability coverage only, not utilization or career fit.

Candidate profile:
- Capability summary: ${profile.capability_summary ?? "Not provided"}
- Capability tags: ${capabilityTags}
- Recommended position: ${profile.recommended_position ?? "Not provided"}
- Experience level: ${profile.experience_level ?? "Not specified"}
- Desired pay: ${profile.desired_pay_min ?? "Not specified"} ${profile.pay_type ?? ""}
- Job types wanted: ${jobTypes}
- Work preference: ${profile.work_preference ?? "Not specified"}

Jobs to score (return score 0-100 for each):
${jobListJson}

Return ONLY a JSON array: [{"job_id": string, "score": number}]
No preamble, no explanation, just the array.`
    : `You are evaluating job fit for a candidate. For each job:
1. Extract what capabilities, skills, and experience the job actually requires from its title and description.
2. Compare those requirements against the candidate's capability profile using semantic equivalence — "led small unit operations under pressure" is equivalent to "project management and crisis decision-making".
3. Score = what percentage of this job's actual requirements does this candidate's translated capability profile genuinely cover?
4. Then apply a utilization multiplier: if the job only uses a small fraction of the candidate's total capability, reduce the score proportionally. A warehouse picker role using 3 of 20 capabilities = low score regardless of whether they can do it.
Score reflects: capability coverage × utilization fit.

Candidate profile:
- Capability summary: ${profile.capability_summary ?? "Not provided"}
- Capability tags: ${capabilityTags}
- Recommended position: ${profile.recommended_position ?? "Not provided"}
- Experience level: ${profile.experience_level ?? "Not specified"}
- Desired pay: ${profile.desired_pay_min ?? "Not specified"} ${profile.pay_type ?? ""}
- Job types wanted: ${jobTypes}
- Work preference: ${profile.work_preference ?? "Not specified"}

Jobs to score (return score 0-100 for each):
${jobListJson}

Return ONLY a JSON array: [{"job_id": string, "score": number}]
No preamble, no explanation, just the array.`;

  console.log("[score-jobs] prompt variant:", scoringMode, "| prompt (first 120):", prompt.slice(0, 120));

  let scored = 0;
  try {
    const anthropic = new Anthropic({ apiKey });
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }]
    });

    const text = message.content.find((b) => b.type === "text")?.text ?? "";
    const results = parseJsonArray(text);

    if (results.length === 0) {
      console.error("[score-jobs] Claude returned no parseable scores. Raw:", text.slice(0, 300));
      return NextResponse.json({ scored: 0, skipped });
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
      }
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error("[score-jobs] error:", errorMessage);
    await logError({
      route: "/api/scoring/score-jobs",
      errorMessage,
      errorType: "ai_generation",
      severity: "medium",
      userId: candidateId
    });
    return NextResponse.json({ scored: 0, skipped, error: errorMessage });
  }

  return NextResponse.json({ scored, skipped });
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
