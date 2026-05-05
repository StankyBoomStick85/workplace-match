import { hasSupabaseEnv } from "@/lib/env";
import { findMatches } from "@/lib/matching";
import { createClient } from "@/lib/supabase/server";
import type { CandidateProfile, JobPost } from "@/lib/types";
import { demoCandidates, demoJobs } from "@/lib/demo-data";

async function loadData() {
  if (!hasSupabaseEnv()) {
    return { candidates: demoCandidates, jobs: demoJobs, isDemo: true };
  }

  const supabase = createClient();
  const [candidateResponse, jobResponse] = await Promise.all([
    supabase.from("candidate_profiles").select("*"),
    supabase.from("job_posts").select("*")
  ]);

  return {
    candidates: (candidateResponse.data ?? []) as CandidateProfile[],
    jobs: (jobResponse.data ?? []) as JobPost[],
    isDemo: false
  };
}

export default async function MatchesPage() {
  const { candidates, jobs, isDemo } = await loadData();
  const matches = findMatches(candidates, jobs);

  return (
    <section className="mx-auto max-w-6xl px-4 py-12">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-clay">
            Basic matching
          </p>
          <h1 className="mt-2 text-3xl font-bold">Candidate and job matches</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ink/68">
            Matches are scored by location, desired role, shared skills, and pay range overlap.
          </p>
        </div>
        {isDemo ? (
          <span className="rounded-full border border-line bg-white px-3 py-1 text-sm font-semibold text-ink/70">
            Demo data
          </span>
        ) : null}
      </div>

      <div className="grid gap-4">
        {matches.map((match) => (
          <article key={`${match.candidate.id}-${match.job.id}`} className="rounded-lg border border-line bg-white p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-xl font-bold">
                  {match.candidate.full_name} + {match.job.title}
                </h2>
                <p className="mt-1 text-sm text-ink/65">
                  {match.job.company_name} · {match.job.location}
                </p>
              </div>
              <span className="rounded-full bg-fern/15 px-3 py-1 text-sm font-bold text-moss">
                {match.score}%
              </span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {match.reasons.map((reason) => (
                <span key={reason} className="rounded-full border border-line bg-cloud px-3 py-1 text-sm">
                  {reason}
                </span>
              ))}
            </div>
            <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
              <p>
                <span className="font-semibold">Candidate skills:</span>{" "}
                {match.candidate.skills.join(", ")}
              </p>
              <p>
                <span className="font-semibold">Job skills:</span>{" "}
                {match.job.required_skills.join(", ")}
              </p>
              <p>
                <span className="font-semibold">Candidate pay:</span> ${match.candidate.min_pay}-
                ${match.candidate.max_pay}
              </p>
              <p>
                <span className="font-semibold">Job pay:</span> ${match.job.min_pay}-${match.job.max_pay}
              </p>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
