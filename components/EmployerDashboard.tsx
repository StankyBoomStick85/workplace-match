"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { getCityStateForZip, normalizeStateValue, normalizeZipCode } from "../lib/addressHelpers";
import { getUnreadContactNotifications, type ContactNotification } from "../lib/contactPreferences";
import { StateAbbreviationSelect } from "./StateAbbreviationSelect";

type EmployerAccount = {
  email: string;
  companyName?: string;
  companyProfileComplete?: boolean;
};

type CompanyProfile = {
  employerEmail: string;
  companyName: string;
  industry: string;
  streetAddress?: string;
  city: string;
  state: string;
  zipCode?: string;
  bannerImageDataUrl?: string;
  bannerFit?: "cover" | "contain";
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

type JobListingDraft = {
  title: string;
  locationStreet: string;
  locationCity: string;
  locationState: string;
  locationZip: string;
  payRange: string;
  jobType: string;
  schedule: string;
  requiredSkills: string;
  description: string;
};

const storageKey = "workplace_match_employer";
const employerAccountsKey = "workplace_match_employer_accounts";
const employerJobsKey = "workplace_match_employer_jobs";
const companyProfileKey = "workplace_match_employer_company_profile";
const activeRoleKey = "workplace_match_active_role";
const activeEmailKey = "workplace_match_active_email";

export function EmployerDashboard() {
  const [account, setAccount] = useState<EmployerAccount | null>(null);
  const [jobs, setJobs] = useState<JobListing[]>([]);
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile | null>(null);
  const [editingJobIds, setEditingJobIds] = useState<string[]>([]);
  const [jobDrafts, setJobDrafts] = useState<Record<string, JobListingDraft>>({});
  const [jobIdPendingDelete, setJobIdPendingDelete] = useState("");
  const [contactNotifications, setContactNotifications] = useState<ContactNotification[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    const activeEmail = localStorage.getItem(activeEmailKey);
    const activeRole = localStorage.getItem(activeRoleKey);
    if (!saved || activeRole !== "employer") {
      window.location.href = "/employer/login";
      return;
    }

    const parsedAccount = getActiveEmployerAccount(saved, activeEmail);
    if (!parsedAccount) {
      window.location.href = "/employer/login";
      return;
    }

    setAccount(parsedAccount);
    setContactNotifications(getUnreadContactNotifications(parsedAccount.email));

    const savedJobs = localStorage.getItem(employerJobsKey);
    const parsedJobs = savedJobs ? (JSON.parse(savedJobs) as JobListing[]) : [];
    setJobs(parsedJobs.filter((job) => job.employerEmail === parsedAccount.email));

    const savedCompanyProfile = localStorage.getItem(companyProfileKey);
    if (savedCompanyProfile) {
      const parsedProfile = JSON.parse(savedCompanyProfile) as CompanyProfile;
      if (parsedProfile.employerEmail === parsedAccount.email) {
        setCompanyProfile(parsedProfile);
      }
    }
  }, []);

  function startEditingJob(job: JobListing) {
    setJobDrafts((current) => ({
      ...current,
      [job.id]: current[job.id] ?? createJobDraft(job)
    }));
    setEditingJobIds((current) => (current.includes(job.id) ? current : [...current, job.id]));
  }

  function saveEditingJob(jobId: string) {
    if (!account) {
      return;
    }

    const updatedJobs = saveJobDrafts({ [jobId]: jobDrafts[jobId] });
    setJobs(updatedJobs.filter((job) => job.employerEmail === account.email));
    setEditingJobIds((current) => current.filter((id) => id !== jobId));
  }

  function updateJobDraft(jobId: string, field: keyof JobListingDraft, value: string) {
    setJobDrafts((current) => {
      const currentDraft = current[jobId];
      if (!currentDraft) {
        return current;
      }

      if (field === "locationState") {
        return {
          ...current,
          [jobId]: {
            ...currentDraft,
            locationState: normalizeStateValue(value)
          }
        };
      }

      if (field !== "locationZip") {
        return {
          ...current,
          [jobId]: {
            ...currentDraft,
            [field]: value
          }
        };
      }

      const normalizedZip = normalizeZipCode(value);
      const zipMatch = getCityStateForZip(normalizedZip);

      if (!zipMatch) {
        return {
          ...current,
          [jobId]: {
            ...currentDraft,
            locationZip: normalizedZip
          }
        };
      }

      return {
        ...current,
        [jobId]: {
          ...currentDraft,
          locationZip: normalizedZip,
          locationCity: zipMatch.city,
          locationState: zipMatch.state
        }
      };
    });
  }

  function saveJobDrafts(draftsToSave: Record<string, JobListingDraft | undefined>) {
    const savedJobs = localStorage.getItem(employerJobsKey);
    const allJobs = savedJobs ? (JSON.parse(savedJobs) as JobListing[]) : [];
    const updatedJobs = allJobs.map((job) => {
      const draft = draftsToSave[job.id];

      return draft && job.employerEmail === account?.email ? applyDraftToJob(job, draft) : job;
    });

    localStorage.setItem(employerJobsKey, JSON.stringify(updatedJobs));
    return updatedJobs;
  }

  function confirmDeleteJob() {
    if (!account || !jobIdPendingDelete) {
      return;
    }

    const savedJobs = localStorage.getItem(employerJobsKey);
    const allJobs = savedJobs ? (JSON.parse(savedJobs) as JobListing[]) : [];
    const updatedJobs = allJobs.filter(
      (job) => !(job.id === jobIdPendingDelete && job.employerEmail === account.email)
    );

    localStorage.setItem(employerJobsKey, JSON.stringify(updatedJobs));
    setJobs(updatedJobs.filter((job) => job.employerEmail === account.email));
    setEditingJobIds((current) => current.filter((id) => id !== jobIdPendingDelete));
    setJobDrafts((current) => {
      const nextDrafts = { ...current };
      delete nextDrafts[jobIdPendingDelete];
      return nextDrafts;
    });
    setJobIdPendingDelete("");
  }

  function updateCompanyBanner(file: File | null) {
    if (!file || !account) {
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") {
        saveCompanyProfile({
          ...getWritableCompanyProfile(account, companyProfile),
          bannerImageDataUrl: reader.result
        });
      }
    };
    reader.readAsDataURL(file);
  }

  function updateBannerFit(nextFit: "cover" | "contain") {
    if (!account) {
      return;
    }

    saveCompanyProfile({
      ...getWritableCompanyProfile(account, companyProfile),
      bannerFit: nextFit
    });
  }

  function saveCompanyProfile(nextProfile: CompanyProfile) {
    localStorage.setItem(companyProfileKey, JSON.stringify(nextProfile));
    setCompanyProfile(nextProfile);
  }

  if (!account) {
    return (
      <section className="mx-auto max-w-3xl px-4 py-14">
        <p className="text-sm text-zinc-600">Loading employer dashboard...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <div>
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">
              Employer dashboard
            </p>
            <h1 className="mt-2 text-3xl font-bold text-zinc-950">Welcome</h1>
            <p className="mt-3 text-lg font-semibold text-zinc-950">
              {getCompanyName(account, companyProfile)}
            </p>
          </div>
        </div>

        {contactNotifications.length > 0 ? (
          <section className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-950">Mutual match follow up</p>
            <div className="mt-2 space-y-2">
              {contactNotifications.map((notification) => (
                <p key={notification.id} className="text-sm leading-5 text-amber-900">
                  {notification.message} <span className="font-semibold">{notification.jobTitle}</span>
                </p>
              ))}
            </div>
          </section>
        ) : null}

        <section className="mt-6 overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
          {companyProfile?.bannerImageDataUrl ? (
            <div className="h-44 bg-white">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={companyProfile.bannerImageDataUrl}
                alt=""
                className={`h-full w-full ${companyProfile.bannerFit === "contain" ? "object-contain" : "object-cover"}`}
              />
            </div>
          ) : (
            <div className="flex h-36 items-center justify-center bg-gray-100 px-4 text-center">
              <p className="text-sm font-semibold text-zinc-600">Upload Company Logo / Banner</p>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-white p-3">
            <label className="inline-flex cursor-pointer items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50">
              Upload Company Logo / Banner
              <input
                type="file"
                accept="image/*"
                onChange={(event) => updateCompanyBanner(event.target.files?.[0] ?? null)}
                className="sr-only"
              />
            </label>
            <div className="flex items-center gap-2">
              {(["cover", "contain"] as const).map((fit) => (
                <button
                  key={fit}
                  type="button"
                  onClick={() => updateBannerFit(fit)}
                  className={`rounded-md px-3 py-2 text-xs font-semibold capitalize transition ${
                    (companyProfile?.bannerFit ?? "cover") === fit
                      ? "bg-red-900 text-white hover:bg-red-950"
                      : "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50"
                  }`}
                >
                  {fit}
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="mt-8">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold text-zinc-950">Recent job listings</h2>
              <p className="mt-1 text-sm text-zinc-600">
                Jobs saved by this employer account.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Link href="/employer/jobs/new" className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950">
                Create New Job Listing
              </Link>
              <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-semibold text-zinc-600">
                {jobs.length} Active
              </span>
            </div>
          </div>

          {jobs.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-5">
              <p className="text-sm font-semibold text-zinc-950">No jobs posted yet</p>
              <p className="mt-2 text-sm leading-6 text-zinc-600">
                Create a job listing to start building your available roles list.
              </p>
            </div>
          ) : (
            <div className="mt-4 grid gap-4">
              {jobs.map((job) => {
                const isJobEditing = editingJobIds.includes(job.id);
                const draft = jobDrafts[job.id] ?? createJobDraft(job);

                return (
                <article key={job.id} className="rounded-lg border border-gray-200 bg-gray-50 p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      {isJobEditing ? (
                        <div className="grid gap-3 md:grid-cols-2">
                          <JobEditField label="Job title">
                            <input
                              value={draft.title}
                              onChange={(event) => updateJobDraft(job.id, "title", event.target.value)}
                              className="field"
                            />
                          </JobEditField>
                          <JobEditField label="Pay range">
                            <input
                              value={draft.payRange}
                              onChange={(event) => updateJobDraft(job.id, "payRange", event.target.value)}
                              className="field"
                            />
                          </JobEditField>
                          <JobEditField label="Work street address" fullWidth>
                            <input
                              value={draft.locationStreet}
                              onChange={(event) => updateJobDraft(job.id, "locationStreet", event.target.value)}
                              className="field"
                            />
                          </JobEditField>
                          <JobEditField label="City">
                            <input
                              value={draft.locationCity}
                              onChange={(event) => updateJobDraft(job.id, "locationCity", event.target.value)}
                              className="field"
                            />
                          </JobEditField>
                          <div className="grid gap-3 sm:grid-cols-[5rem_minmax(0,1fr)]">
                            <JobEditField label="State">
                              <StateAbbreviationSelect
                                value={draft.locationState}
                                onChange={(value) => updateJobDraft(job.id, "locationState", value)}
                                className="field uppercase"
                              />
                            </JobEditField>
                            <JobEditField label="ZIP">
                              <input
                                value={draft.locationZip}
                                onChange={(event) => updateJobDraft(job.id, "locationZip", event.target.value)}
                                className="field"
                              />
                            </JobEditField>
                          </div>
                          <JobEditField label="Job type">
                            <input
                              value={draft.jobType}
                              onChange={(event) => updateJobDraft(job.id, "jobType", event.target.value)}
                              className="field"
                            />
                          </JobEditField>
                          <JobEditField label="Schedule">
                            <input
                              value={draft.schedule}
                              onChange={(event) => updateJobDraft(job.id, "schedule", event.target.value)}
                              className="field"
                            />
                          </JobEditField>
                          <JobEditField label="Required skills" fullWidth>
                            <textarea
                              value={draft.requiredSkills}
                              onChange={(event) => updateJobDraft(job.id, "requiredSkills", event.target.value)}
                              rows={3}
                              className="field"
                            />
                          </JobEditField>
                          <JobEditField label="Description" fullWidth>
                            <textarea
                              value={draft.description}
                              onChange={(event) => updateJobDraft(job.id, "description", event.target.value)}
                              rows={4}
                              className="field"
                            />
                          </JobEditField>
                          <div className="flex justify-end md:col-span-2">
                            <button
                              type="button"
                              onClick={() => setJobIdPendingDelete(job.id)}
                              className="inline-flex items-center justify-center rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-800 transition hover:bg-red-50"
                            >
                              Delete Listing
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <h3 className="text-lg font-bold text-zinc-950">{job.title}</h3>
                          <p className="mt-1 text-sm text-zinc-600">{formatJobLocation(job)}</p>
                        </>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => (isJobEditing ? saveEditingJob(job.id) : startEditingJob(job))}
                        className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-xs font-semibold text-zinc-900 transition hover:bg-zinc-50"
                      >
                        {isJobEditing ? "Save" : "Edit"}
                      </button>
                      <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-green-700">
                        {job.status}
                      </span>
                    </div>
                  </div>
                  {!isJobEditing ? (
                    <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
                      <JobDetail label="Pay range" value={job.payRange} />
                      <JobDetail label="Job type" value={job.jobType} />
                      <JobDetail label="Schedule" value={job.schedule} />
                    </div>
                  ) : null}
                </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
      {jobIdPendingDelete ? (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-zinc-950/35 px-4">
          <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 text-center shadow-soft">
            <h2 className="text-xl font-bold text-zinc-950">Confirm Delete Listing?</h2>
            <div className="mt-5 flex justify-center gap-3">
              <button
                type="button"
                onClick={confirmDeleteJob}
                className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
              >
                Delete
              </button>
              <button
                type="button"
                onClick={() => setJobIdPendingDelete("")}
                className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
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

function formatCompanyLocation(profile: CompanyProfile) {
  const cityState = [profile.city, profile.state].filter(Boolean).join(", ");
  const cityStateZip = profile.zipCode ? `${cityState} ${profile.zipCode}` : cityState;

  if (profile.streetAddress && cityStateZip) {
    return `${profile.streetAddress}, ${cityStateZip}`;
  }

  return profile.streetAddress || cityStateZip;
}

function getCompanyName(account: EmployerAccount, profile: CompanyProfile | null) {
  return profile?.companyName?.trim() || account.companyName?.trim() || "Dashboard";
}

function getActiveEmployerAccount(savedAccount: string, activeEmail: string | null) {
  const legacyAccount = parseEmployerAccount(savedAccount);
  const employerAccounts = parseEmployerAccounts(localStorage.getItem(employerAccountsKey));
  const normalizedActiveEmail = activeEmail?.trim().toLowerCase() ?? "";

  if (normalizedActiveEmail) {
    const activeAccount =
      employerAccounts.find((account) => account.email.trim().toLowerCase() === normalizedActiveEmail) ??
      (legacyAccount?.email.trim().toLowerCase() === normalizedActiveEmail ? legacyAccount : null);

    return activeAccount;
  }

  return legacyAccount;
}

function parseEmployerAccounts(value: string | null) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as EmployerAccount[] | EmployerAccount;
    return Array.isArray(parsed) ? parsed.filter(isEmployerAccount) : isEmployerAccount(parsed) ? [parsed] : [];
  } catch {
    return [];
  }
}

function parseEmployerAccount(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as EmployerAccount;
    return isEmployerAccount(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isEmployerAccount(value: unknown): value is EmployerAccount {
  if (!value || typeof value !== "object") {
    return false;
  }

  return typeof (value as { email?: unknown }).email === "string";
}

function getWritableCompanyProfile(account: EmployerAccount, profile: CompanyProfile | null): CompanyProfile {
  return {
    employerEmail: account.email,
    companyName: profile?.companyName ?? account.companyName ?? "",
    industry: profile?.industry ?? "",
    streetAddress: profile?.streetAddress ?? "",
    city: profile?.city ?? "",
    state: profile?.state ?? "",
    zipCode: profile?.zipCode ?? "",
    bannerImageDataUrl: profile?.bannerImageDataUrl,
    bannerFit: profile?.bannerFit ?? "cover"
  };
}

function createJobDraft(job: JobListing): JobListingDraft {
  return {
    title: job.title,
    locationStreet: job.locationStreet ?? "",
    locationCity: job.locationCity,
    locationState: job.locationState,
    locationZip: job.locationZip ?? "",
    payRange: job.payRange,
    jobType: job.jobType,
    schedule: job.schedule,
    requiredSkills: job.requiredSkills.join("\n"),
    description: job.description
  };
}

function applyDraftToJob(job: JobListing, draft: JobListingDraft): JobListing {
  return {
    ...job,
    title: draft.title.trim(),
    locationStreet: draft.locationStreet.trim(),
    locationCity: draft.locationCity.trim(),
    locationState: draft.locationState.trim().toUpperCase(),
    locationZip: draft.locationZip.trim(),
    payRange: draft.payRange.trim(),
    jobType: draft.jobType.trim(),
    schedule: draft.schedule.trim(),
    requiredSkills: splitSkills(draft.requiredSkills),
    description: draft.description.trim()
  };
}

function splitSkills(value: string) {
  return value
    .split(/[,\r\n]+/)
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function JobEditField({
  label,
  fullWidth = false,
  children
}: {
  label: string;
  fullWidth?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`space-y-2 ${fullWidth ? "md:col-span-2" : ""}`}>
      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</span>
      {children}
    </label>
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
