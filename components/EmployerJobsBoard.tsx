"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type EmployerAccount = {
  email: string;
};

type JobListing = {
  id: string;
  employerEmail: string;
  title: string;
  locationStreet?: string;
  locationCity: string;
  locationState: string;
  locationZip?: string;
  payRange: string;
  jobType: string;
  schedule: string;
  requiredSkills: string[];
  description: string;
  status: "Active";
  createdAt: string;
};

const employerAccountKey = "workplace_match_employer";
const employerJobsKey = "workplace_match_employer_jobs";
const activeRoleKey = "workplace_match_active_role";

export function EmployerJobsBoard() {
  const [account, setAccount] = useState<EmployerAccount | null>(null);
  const [jobs, setJobs] = useState<JobListing[]>([]);

  useEffect(() => {
    const savedAccount = localStorage.getItem(employerAccountKey);
    const activeRole = localStorage.getItem(activeRoleKey);
    if (!savedAccount || activeRole !== "employer") {
      window.location.href = "/employer/login";
      return;
    }

    const parsedAccount = JSON.parse(savedAccount) as EmployerAccount;
    setAccount(parsedAccount);

    const savedJobs = localStorage.getItem(employerJobsKey);
    const parsedJobs = savedJobs ? (JSON.parse(savedJobs) as JobListing[]) : [];
    setJobs(parsedJobs.filter((job) => job.employerEmail === parsedAccount.email));
  }, []);

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
          <div className="mt-6 grid gap-4">
            {jobs.map((job) => (
              <article key={job.id} className="rounded-lg border border-gray-200 bg-gray-50 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-bold text-zinc-950">{job.title}</h2>
                    <p className="mt-1 text-sm text-zinc-600">{formatJobLocation(job)}</p>
                  </div>
                  <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-green-700">
                    {job.status}
                  </span>
                </div>

                <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
                  <JobDetail label="Pay range" value={job.payRange} />
                  <JobDetail label="Job type" value={job.jobType} />
                  <JobDetail label="Schedule" value={job.schedule} />
                </div>

                <div className="mt-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
                    Required skills
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {job.requiredSkills.map((skill) => (
                      <span key={skill} className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-700">
                        {skill}
                      </span>
                    ))}
                  </div>
                </div>

                <p className="mt-4 text-sm leading-6 text-zinc-700">{job.description}</p>
                <div className="mt-4">
                  <Link
                    href={`/employer/jobs/new?edit=${encodeURIComponent(job.id)}`}
                    className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
                  >
                    Edit
                  </Link>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function formatJobLocation(job: JobListing) {
  const cityStateZip = [job.locationCity, [job.locationState, job.locationZip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  return [job.locationStreet, cityStateZip].filter(Boolean).join(", ");
}

function JobDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-1 font-semibold text-zinc-950">{value}</p>
    </div>
  );
}
