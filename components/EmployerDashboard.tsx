"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  getCurrentMvpUser,
  getEmployerJobs,
  getEmployerProfile,
  type MvpJobListing
} from "../lib/supabaseMvpData";
import { supabase } from "../lib/supabase";

export function EmployerDashboard() {
  const [accountEmail, setAccountEmail] = useState("");
  const [employerId, setEmployerId] = useState("");
  const [companyName, setCompanyName] = useState("Dashboard");
  const [jobs, setJobs] = useState<MvpJobListing[]>([]);
  const [editingJobId, setEditingJobId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Partial<MvpJobListing>>>({});
  const [jobIdPendingDelete, setJobIdPendingDelete] = useState("");

  useEffect(() => {
    loadDashboard();

    async function loadDashboard() {
      const user = await getCurrentMvpUser("employer");
      if (!user) {
        window.location.href = "/employer/login";
        return;
      }

      const [profile, employerJobs] = await Promise.all([getEmployerProfile(user.id), getEmployerJobs(user.id)]);
      setEmployerId(user.id);
      setAccountEmail(user.email);
      setCompanyName(profile?.companyName?.trim() || "Dashboard");
      setJobs(employerJobs);
    }
  }, []);

  function startEditingJob(job: MvpJobListing) {
    setDrafts((current) => ({ ...current, [job.id]: current[job.id] ?? { ...job } }));
    setEditingJobId(job.id);
  }

  async function saveEditingJob(jobId: string) {
    const draft = drafts[jobId];
    if (!draft) {
      return;
    }

    await supabase
      .from("job_posts")
      .update({
        title: draft.title,
        location_zip: draft.locationZip,
        job_type: draft.jobType,
        shift: draft.schedule,
        required_capabilities: draft.requiredSkills,
        summary: draft.description
      })
      .eq("id", jobId)
      .eq("employer_id", employerId);

    setJobs((current) => current.map((job) => (job.id === jobId ? { ...job, ...draft } : job)));
    setEditingJobId("");
  }

  async function deleteJob(jobId: string) {
    await supabase.from("job_posts").update({ active: false }).eq("id", jobId).eq("employer_id", employerId);
    setJobs((current) => current.filter((job) => job.id !== jobId));
    setJobIdPendingDelete("");
    setEditingJobId("");
  }

  if (!accountEmail) {
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
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">Employer Dashboard</p>
            <h1 className="mt-2 text-3xl font-bold text-zinc-950">{companyName}</h1>
            <p className="mt-3 text-sm leading-6 text-zinc-600">Welcome</p>
          </div>
        </div>

        <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <Link href="/employer/jobs/new" className="rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950">
                Create New Job Listing
              </Link>
              <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-green-700">
                {jobs.length} Active
              </span>
            </div>
          </div>

          <div className="mt-5 grid gap-4">
            {jobs.length > 0 ? (
              jobs.map((job) => {
                const isEditing = editingJobId === job.id;
                const draft = drafts[job.id] ?? job;
                return (
                  <article key={job.id} className="rounded-lg border border-gray-200 bg-white p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        {isEditing ? (
                          <input
                            value={draft.title ?? ""}
                            onChange={(event) => setDrafts((current) => ({ ...current, [job.id]: { ...draft, title: event.target.value } }))}
                            className="field"
                          />
                        ) : (
                          <h2 className="text-lg font-bold text-zinc-950">{job.title}</h2>
                        )}
                        <p className="mt-1 text-sm text-zinc-600">{[job.locationCity, job.locationState, job.locationZip].filter(Boolean).join(", ")}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => (isEditing ? saveEditingJob(job.id) : startEditingJob(job))}
                          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
                        >
                          {isEditing ? "Save" : "Edit"}
                        </button>
                        <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-green-700">
                          Active
                        </span>
                      </div>
                    </div>

                    {isEditing ? (
                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        <input
                          value={draft.locationZip ?? ""}
                          onChange={(event) => setDrafts((current) => ({ ...current, [job.id]: { ...draft, locationZip: event.target.value } }))}
                          className="field"
                          placeholder="ZIP"
                        />
                        <input
                          value={draft.jobType ?? ""}
                          onChange={(event) => setDrafts((current) => ({ ...current, [job.id]: { ...draft, jobType: event.target.value } }))}
                          className="field"
                          placeholder="Job type"
                        />
                        <input
                          value={draft.schedule ?? ""}
                          onChange={(event) => setDrafts((current) => ({ ...current, [job.id]: { ...draft, schedule: event.target.value } }))}
                          className="field"
                          placeholder="Schedule"
                        />
                        <textarea
                          value={draft.description ?? ""}
                          onChange={(event) => setDrafts((current) => ({ ...current, [job.id]: { ...draft, description: event.target.value } }))}
                          className="field md:col-span-2"
                          rows={4}
                        />
                        <div className="flex justify-end md:col-span-2">
                          <button
                            type="button"
                            onClick={() => setJobIdPendingDelete(job.id)}
                            className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700"
                          >
                            Delete Listing
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
                          <JobDetail label="Pay range" value={job.payRange || "Not listed"} />
                          <JobDetail label="Job type" value={job.jobType || "Not listed"} />
                          <JobDetail label="Schedule" value={job.schedule || "Not listed"} />
                        </div>
                        <p className="mt-4 text-sm leading-6 text-zinc-700">{job.description}</p>
                      </>
                    )}
                  </article>
                );
              })
            ) : (
              <div className="rounded-lg border border-dashed border-gray-300 bg-white p-5">
                <p className="text-sm font-semibold text-zinc-950">No job listings yet</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {jobIdPendingDelete ? (
        <div className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-soft">
            <p className="text-lg font-bold text-zinc-950">Confirm Delete Listing?</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => deleteJob(jobIdPendingDelete)} className="rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white">
                Delete
              </button>
              <button type="button" onClick={() => setJobIdPendingDelete("")} className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700">
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function JobDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-1 font-semibold text-zinc-950">{value}</p>
    </div>
  );
}
