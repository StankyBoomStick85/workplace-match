"use client";

import { useEffect, useState } from "react";
import {
  getAllJobs,
  getApplicantInterests,
  getCurrentMvpUser,
  getMutualMatches,
  type MvpJobListing,
  type MvpMatch
} from "../lib/supabaseMvpData";

type JobEntry =
  | { kind: "matched"; job: MvpJobListing; match: MvpMatch }
  | { kind: "interested"; job: MvpJobListing };

export function ApplicantMyJobs() {
  const [entries, setEntries] = useState<JobEntry[]>([]);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    async function load() {
      const user = await getCurrentMvpUser("candidate");
      if (!user) {
        window.location.href = "/applicant/login";
        return;
      }

      const [jobs, matches, interests] = await Promise.all([
        getAllJobs(),
        getMutualMatches(),
        getApplicantInterests()
      ]);

      const userMatches = matches.filter((m) => m.candidateId === user.id);
      const matchedJobIds = new Set(userMatches.map((m) => m.jobId));

      const matchedEntries: JobEntry[] = userMatches
        .map((match) => ({ kind: "matched" as const, match, job: jobs.find((j) => j.id === match.jobId) }))
        .filter((r): r is { kind: "matched"; job: MvpJobListing; match: MvpMatch } => Boolean(r.job));

      const interestedEntries: JobEntry[] = interests
        .filter((i) => i.candidateId === user.id && !matchedJobIds.has(i.jobId))
        .map((i) => ({ kind: "interested" as const, job: jobs.find((j) => j.id === i.jobId) }))
        .filter((r): r is { kind: "interested"; job: MvpJobListing } => Boolean(r.job));

      setEntries([...matchedEntries, ...interestedEntries]);
      setIsReady(true);
    }
    load();
  }, []);

  if (!isReady) {
    return (
      <section className="mx-auto max-w-5xl px-4 py-12">
        <p className="text-sm text-zinc-600">Loading...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <h1 className="text-3xl font-bold text-zinc-950">My Jobs</h1>
        {entries.length === 0 ? (
          <p className="mt-6 text-sm text-zinc-600">
            Nothing here yet. Start exploring the Job Map and click interest on roles that fit.
          </p>
        ) : (
          <div className="mt-6 space-y-4">
            {entries.map((entry) => (
              <article
                key={entry.job.id}
                className="rounded-lg border border-gray-200 bg-white p-5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold text-zinc-950">{entry.job.title}</h3>
                    <p className="mt-1 text-sm text-zinc-600">
                      {[entry.job.locationCity, entry.job.locationState, entry.job.locationZip]
                        .filter(Boolean)
                        .join(", ")}
                    </p>
                  </div>
                  {entry.kind === "matched" ? (
                    <span className="rounded-full bg-red-900 px-3 py-1 text-xs font-bold text-white">
                      {entry.match.matchPercent}%
                    </span>
                  ) : (
                    <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-bold text-zinc-600">
                      Interested
                    </span>
                  )}
                </div>
                <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
                  <InfoCard label="Pay range" value={entry.job.payRange || "Not listed"} />
                  <InfoCard label="Job type" value={entry.job.jobType || "Not listed"} />
                  <InfoCard label="Schedule" value={entry.job.schedule || "Not listed"} />
                </div>
                <p className="mt-4 text-sm leading-6 text-zinc-700">{entry.job.description}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" className="rounded-md bg-green-700 px-3 py-2 text-sm font-semibold text-white">
                    Reach Out
                  </button>
                  <button type="button" className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700">
                    Message
                  </button>
                  <button type="button" className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700">
                    Schedule Conversation
                  </button>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-1 font-semibold text-zinc-950">{value}</p>
    </div>
  );
}
