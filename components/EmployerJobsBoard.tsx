"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getCityStateForZip } from "../lib/addressHelpers";
import { supabase } from "../lib/supabase";

type EmployerAccount = {
  id: string;
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

export function EmployerJobsBoard() {
  const [account, setAccount] = useState<EmployerAccount | null>(null);
  const [jobs, setJobs] = useState<JobListing[]>([]);
  const [jobIdPendingDeactivate, setJobIdPendingDeactivate] = useState("");

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
      setJobs((data ?? []).map((job: any) => mapSupabaseJob(job, user.email ?? "")));
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
              </article>
            ))}
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
  const cityStateZip = [job.locationCity, [job.locationState, job.locationZip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  return [job.locationStreet, cityStateZip].filter(Boolean).join(", ");
}

function mapSupabaseJob(job: any, employerEmail: string): JobListing {
  const zipMatch = getCityStateForZip(job.location_zip ?? "");
  return {
    id: job.id,
    employerEmail,
    title: job.title ?? "",
    locationCity: zipMatch?.city ?? "",
    locationState: zipMatch?.state ?? "",
    locationZip: job.location_zip ?? "",
    payRange: formatStoredPay(job.pay_min, job.pay_max, job.pay_type),
    jobType: job.job_type ?? "",
    schedule: job.shift ?? "",
    requiredSkills: job.required_capabilities ?? [],
    description: job.summary ?? "",
    status: "Active",
    createdAt: job.created_at ?? ""
  };
}

function formatStoredPay(payMin?: number | null, payMax?: number | null, payType?: string | null) {
  const suffix = payType === "annual" ? "/year" : "/hr";
  if (payMin && payMax && payMax !== payMin) {
    return `$${payMin}-$${payMax}${suffix}`;
  }
  if (payMin) {
    return `$${payMin}${suffix}`;
  }
  return "";
}

function JobDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-1 font-semibold text-zinc-950">{value}</p>
    </div>
  );
}
