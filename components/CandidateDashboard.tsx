"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  getAllJobs,
  getCandidateProfile,
  getCurrentMvpUser,
  getMutualMatches,
  type MvpJobListing,
  type MvpMatch
} from "../lib/supabaseMvpData";

export function CandidateDashboard() {
  const [profile, setProfile] = useState<Awaited<ReturnType<typeof getCandidateProfile>>>(null);
  const [matchedJobs, setMatchedJobs] = useState<Array<{ job: MvpJobListing; match: MvpMatch }>>([]);
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    loadDashboard();

    async function loadDashboard() {
      const user = await getCurrentMvpUser("candidate");
      if (!user) {
        window.location.href = "/candidate/login";
        return;
      }

      const [candidateProfile, jobs, matches] = await Promise.all([
        getCandidateProfile(user.id),
        getAllJobs(),
        getMutualMatches()
      ]);
      setProfile(candidateProfile);
      setMatchedJobs(
        matches
          .filter((match) => match.candidateId === user.id)
          .map((match) => ({ match, job: jobs.find((job) => job.id === match.jobId) }))
          .filter((record): record is { job: MvpJobListing; match: MvpMatch } => Boolean(record.job))
      );
      setIsReady(true);
    }
  }, []);

  if (!isReady) {
    return (
      <section className="mx-auto max-w-5xl px-4 py-12">
        <p className="text-sm text-zinc-600">Loading dashboard...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">Dashboard</p>
            <h1 className="mt-2 text-3xl font-bold text-zinc-950">Welcome</h1>
            <p className="mt-2 text-3xl font-bold text-zinc-950">{profile?.fullName || "Applicant"}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/jobs" className="rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950">
              See Jobs
            </Link>
            <Link href="/account/settings?role=candidate" className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-gray-50">
              Account Settings
            </Link>
          </div>
        </div>

        <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-5">
          <h2 className="text-lg font-bold text-zinc-950">Capability Snapshot</h2>
          <p className="mt-2 text-sm leading-6 text-zinc-700">{profile?.capabilitySummary || "No capability summary saved yet."}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {(profile?.topSkills ?? []).map((skill) => (
              <span key={skill} className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-700">
                {skill}
              </span>
            ))}
          </div>
        </div>

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <DashboardCard label="Work Preference" value={profile?.workPreference || "Not set"} />
          <DashboardCard label="Experience Level" value={profile?.experienceLevel || "Not set"} />
        </div>

        {matchedJobs.length > 0 ? (
          <div className="mt-6 space-y-4">
            <h2 className="text-lg font-bold text-zinc-950">Matched jobs</h2>
            {matchedJobs.map(({ job, match }) => (
              <article key={`${job.id}-${match.candidateId}`} className="rounded-lg border border-gray-200 bg-white p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-bold text-zinc-950">{job.title}</h3>
                    <p className="mt-1 text-sm text-zinc-600">{[job.locationCity, job.locationState, job.locationZip].filter(Boolean).join(", ")}</p>
                  </div>
                  <span className="rounded-full bg-red-900 px-3 py-1 text-xs font-bold text-white">{match.matchPercent}%</span>
                </div>
                <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
                  <DashboardCard label="Pay range" value={job.payRange || "Not listed"} />
                  <DashboardCard label="Job type" value={job.jobType || "Not listed"} />
                  <DashboardCard label="Schedule" value={job.schedule || "Not listed"} />
                </div>
                <p className="mt-4 text-sm leading-6 text-zinc-700">{job.description}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" className="rounded-md bg-green-700 px-3 py-2 text-sm font-semibold text-white">Reach Out</button>
                  <button type="button" className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700">Message</button>
                  <button type="button" className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700">Schedule Conversation</button>
                </div>
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function DashboardCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-1 font-semibold text-zinc-950">{value}</p>
    </div>
  );
}
