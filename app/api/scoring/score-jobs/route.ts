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

  // Fetch existing non-expired scores for this candidate (skipped when forceRescore)
  const scoredJobIds = new Set<string>();
  if (!forceRescore) {
    const { data: existingScores } = await adminClient
      .from("match_scores")
      .select("job_id")
      .eq("candidate_id", candidateId)
      .gt("expires_at", new Date().toISOString());
    (existingScores ?? []).forEach((row: { job_id: string }) => scoredJobIds.add(row.job_id));
    console.log("[score-jobs] cache check: found", scoredJobIds.size, "existing scores (will skip these)");
  } else {
    console.log("[score-jobs] forceRescore=true: skipping cache check, will score all jobs fresh");
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

  const modeInstructions = scoringMode === "quick"
    ? `Mode: QUICK WORK
Focus: Can this candidate physically and practically perform this job given their current skills?
Key rule: Overqualification is NOT a penalty. A senior operations leader who CAN work a retail or warehouse shift should score 80+.
Score high (70-95) whenever the candidate has the baseline capability to do the job.
Score low (below 50) only when there is a genuine capability gap — the candidate lacks skills or physical/technical requirements to perform the role.
Do NOT penalize for the role being below the candidate's career level. That is irrelevant in this mode.`
    : `Mode: CAREER MOVE
Focus: Does this job represent a good use of this candidate's full capability profile?
Consider: skill utilization, compensation alignment, career trajectory, seniority match, and growth potential.
A fast food or entry-level role for a senior operations leader should score 15-25% — it wastes their capability.
A management, director, or leadership role that matches their experience and pay expectations should score 80-95%.
Penalize significant underutilization of the candidate's skills and seniority.`;

  const prompt = `You are a job match scorer. Given a candidate profile and a list of jobs, return a JSON array of match scores.

${modeInstructions}

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

Score ranges:
${scoringMode === "quick"
  ? `- 80-95: candidate clearly has the capability to perform this job
- 60-79: candidate can likely do this job with minimal ramp-up
- 40-59: candidate could probably do this job
- 20-39: significant capability gap
- 0-19: candidate lacks basic capability for this role`
  : `- 85-100: exceptional career fit — role fully utilizes candidate's capability and trajectory
- 65-84: strong career fit — good skill utilization with appropriate seniority and pay
- 45-64: partial fit — some skill use but underutilizes or mismatches candidate profile
- 25-44: poor fit — role underutilizes or mismatches candidate's career level
- 0-24: very poor fit — major career step-down or capability mismatch`}

Return ONLY a JSON array: [{"job_id": string, "score": number}]
No preamble, no explanation, just the array.`;

  console.log("[score-jobs] prompt mode block (first 100 chars):", prompt.slice(0, 100));

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

    console.log("[score-jobs] Claude scored", results.length, "jobs");

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
