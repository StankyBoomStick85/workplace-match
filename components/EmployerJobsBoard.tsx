"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { formatStoredPayRange } from "../lib/payFormatting";
import { supabase } from "../lib/supabase";

type EmployerAccount = {
  id: string;
  email: string;
};

type JobListing = {
  id: string;
  employerEmail: string;
  title: string;
  locationZip?: string;
  payRange: string;
  jobType: string;
  schedule: string;
  requiredSkills: string[];
  preferredSkills: string[];
  description: string;
  status: "Active";
  createdAt: string;
};

export function EmployerJobsBoard() {
  const [account, setAccount] = useState<EmployerAccount | null>(null);
  const [jobs, setJobs] = useState<JobListing[]>([]);
  const [jobIdPendingDeactivate, setJobIdPendingDeactivate] = useState("");
  const [expandedJobId, setExpandedJobId] = useState("");
  // Absent from this map = no stored match data for that job (not zero) - the
  // row shows nothing rather than a "0 matches" that reads as "nobody matches".
  const [matchCounts, setMatchCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    loadJobs();

    async function loadJobs() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        window.location.href = "/employer/login";
        return;
      }

      const userResponse = await fetch("/api/user/me");
      const userRecord = await userResponse.json();
      if (userRecord?.role !== "employer") {
        window.location.href = "/employer/login";
        return;
      }

      setAccount({ id: user.id, email: user.email ?? "" });
      const jobsResponse = await fetch(`/api/mvp/read?resource=employer-jobs&employerId=${encodeURIComponent(user.id)}`);
      const { data } = await jobsResponse.json();
      const mappedJobs = (data ?? []).map((job: any) => mapSupabaseJob(job, user.email ?? ""));
      setJobs(mappedJobs);

      if (mappedJobs.length > 0) {
        const jobIds = mappedJobs.map((job: JobListing) => job.id).join(",");
        const countsResponse = await fetch(`/api/mvp/read?resource=job-match-counts&jobIds=${encodeURIComponent(jobIds)}`);
        const { data: counts } = await countsResponse.json();
        setMatchCounts(counts ?? {});
      }
    }
  }, []);

  async function deactivateJob(jobId: string) {
    if (!account) {
      return;
    }

    await supabase.from("job_posts").update({ active: false }).eq("id", jobId).eq("employer_id", account.id);
    setJobs((current) => current.filter((job) => job.id !== jobId));
    setJobIdPendingDeactivate("");
  }

  if (!account) {
    return (
      <section className="mx-auto max-w-5xl px-4 py-14">
        <p className="text-sm text-zinc-600">Loading job listings...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">
              Job listings
            </p>
            <h1 className="mt-2 text-3xl font-bold text-zinc-950">Employer job board</h1>
            <p className="mt-3 text-sm leading-6 text-zinc-600">
              Manage job listings saved by this employer account.
            </p>
          </div>
          <Link href="/employer/jobs/new" className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950">
            Create new job listing
          </Link>
        </div>

        {jobs.length === 0 ? (
          <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-5">
            <p className="text-sm font-semibold text-zinc-950">No job listings yet</p>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              Create your first listing to start building your employer job board.
            </p>
          </div>
        ) : (
          <div className="mt-6 space-y-3">
            {jobs.map((job) => {
              const isExpanded = expandedJobId === job.id;
              const matchCount = matchCounts[job.id];

              return (
                <div key={job.id} className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                  <button
                    type="button"
                    onClick={() => setExpandedJobId(isExpanded ? "" : job.id)}
                    className="flex w-full items-center justify-between gap-3 bg-gray-50 px-5 py-4 text-left transition hover:bg-gray-100"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span
                        className={`inline-block shrink-0 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                        aria-hidden="true"
                      >
                        ▸
                      </span>
                      <span className="truncate text-lg font-bold text-zinc-950">{job.title}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {matchCount !== undefined ? (
                        <Link
                          href={`/employer/find-applicants?matchJobId=${encodeURIComponent(job.id)}`}
                          onClick={(event) => event.stopPropagation()}
                          className="rounded-full bg-red-900 px-3 py-1 text-xs font-semibold text-white transition hover:bg-red-950"
                        >
                          {matchCount} potential {matchCount === 1 ? "match" : "matches"}
                        </Link>
                      ) : null}
                      <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-green-700">
                        {job.status}
                      </span>
                    </span>
                  </button>

                  {isExpanded ? (
                    <div className="border-t border-gray-200 p-5">
                      <p className="text-sm text-zinc-600">{formatJobLocation(job)}</p>

                      <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
                        <JobDetail label="Pay range" value={job.payRange || "Not listed"} />
                        <JobDetail label="Job type" value={job.jobType || "Not listed"} />
                        <JobDetail label="Schedule" value={job.schedule || "Not listed"} />
                      </div>

                      {job.requiredSkills.length > 0 ? (
                        <div className="mt-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
                            Required capabilities
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {job.requiredSkills.map((skill) => (
                              <span key={skill} className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-700">
                                {skill}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      {job.preferredSkills.length > 0 ? (
                        <div className="mt-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-400">
                            Preferred capabilities
                          </p>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {job.preferredSkills.map((skill) => (
                              <span key={skill} className="rounded-full border border-dashed border-gray-200 bg-transparent px-3 py-1 text-xs font-medium text-zinc-500">
                                {skill}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : null}

                      <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-zinc-700">{job.description}</p>

                      <div className="mt-4 flex gap-2">
                        <Link
                          href={`/employer/jobs/new?edit=${encodeURIComponent(job.id)}`}
                          className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
                        >
                          Edit
                        </Link>
                        <button
                          type="button"
                          onClick={() => setJobIdPendingDeactivate(job.id)}
                          className="inline-flex items-center justify-center rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-100"
                        >
                          Deactivate
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {jobIdPendingDeactivate ? (
        <div className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-soft">
            <p className="text-lg font-bold text-zinc-950">Deactivate this listing?</p>
            <p className="mt-2 text-sm text-zinc-600">
              It will stop appearing to candidates. This can&apos;t be undone from here.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => deactivateJob(jobIdPendingDeactivate)}
                className="rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white"
              >
                Deactivate
              </button>
              <button
                type="button"
                onClick={() => setJobIdPendingDeactivate("")}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function formatJobLocation(job: JobListing) {
  // job_posts has no persisted city/state - only ZIP. Showing a ZIP-dictionary
  // guess here previously produced a plausible-looking but wrong town for any
  // ZIP not in that small table (or a stale one). Show only what's actually
  // stored rather than inferring a city the employer may not have entered.
  return job.locationZip ? `ZIP ${job.locationZip}` : "Location not set";
}

function mapSupabaseJob(job: any, employerEmail: string): JobListing {
  return {
    id: job.id,
    employerEmail,
    title: job.title ?? "",
    locationZip: job.location_zip ?? "",
    payRange: formatStoredPayRange(job.pay_min, job.pay_max, job.pay_type),
    jobType: job.job_type ?? "",
    schedule: job.shift ?? "",
    requiredSkills: job.required_capabilities ?? [],
    preferredSkills: job.preferred_capabilities ?? [],
    description: job.summary ?? "",
    status: "Active",
    createdAt: job.created_at ?? ""
  };
}

function JobDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-1 font-semibold text-zinc-950">{value}</p>
    </div>
  );
}
