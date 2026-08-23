"use client";

import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

type CompanyProfile = {
  companyName: string;
  industry: string;
  companySize: string;
  about: string;
  websiteUrl: string;
  glassdoorUrl: string;
  linkedinUrl: string;
};

type JobListing = {
  id: string;
  title: string;
  payRange: string;
  jobType: string;
  schedule: string;
  requiredSkills: string[];
  description: string;
};

const emptyProfile: CompanyProfile = {
  companyName: "",
  industry: "",
  companySize: "",
  about: "",
  websiteUrl: "",
  glassdoorUrl: "",
  linkedinUrl: ""
};

const companySizeOptions = [
  "1-10 employees",
  "11-50 employees",
  "51-200 employees",
  "201-500 employees",
  "500+ employees"
];

export function EmployerCompanyProfile({ employerId }: { employerId: string }) {
  const [profile, setProfile] = useState<CompanyProfile>(emptyProfile);
  const [jobs, setJobs] = useState<JobListing[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<CompanyProfile>(emptyProfile);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    loadProfile();

    async function loadProfile() {
      const [
        {
          data: { user }
        },
        profileResponse,
        jobsResponse
      ] = await Promise.all([
        supabase.auth.getUser(),
        fetch(`/api/mvp/read?resource=employer-profile&userId=${encodeURIComponent(employerId)}`),
        fetch(`/api/mvp/read?resource=employer-jobs&employerId=${encodeURIComponent(employerId)}`)
      ]);

      const { data: profileData } = await profileResponse.json();
      const { data: jobsData } = await jobsResponse.json();

      const nextProfile: CompanyProfile = {
        companyName: profileData?.company_name ?? "",
        industry: profileData?.industry ?? "",
        companySize: profileData?.company_size ?? "",
        about: profileData?.about ?? "",
        websiteUrl: profileData?.website_url ?? "",
        glassdoorUrl: profileData?.glassdoor_url ?? "",
        linkedinUrl: profileData?.linkedin_url ?? ""
      };

      setProfile(nextProfile);
      setDraft(nextProfile);
      setJobs((jobsData ?? []).map(mapJobRow));
      setIsOwner(Boolean(user && user.id === employerId));
      setHasLoaded(true);
    }
  }, [employerId]);

  async function saveProfile() {
    setError("");
    setMessage("");

    const { error: upsertError } = await supabase.from("employer_profiles").upsert(
      {
        user_id: employerId,
        company_name: draft.companyName.trim(),
        industry: draft.industry.trim(),
        company_size: draft.companySize.trim(),
        about: draft.about.trim(),
        website_url: draft.websiteUrl.trim(),
        glassdoor_url: draft.glassdoorUrl.trim(),
        linkedin_url: draft.linkedinUrl.trim()
      },
      { onConflict: "user_id" }
    );

    if (upsertError) {
      setError(upsertError.message);
      return;
    }

    setProfile(draft);
    setIsEditing(false);
    setMessage("Company profile saved.");
  }

  if (!hasLoaded) {
    return (
      <section className="mx-auto max-w-4xl px-4 py-14">
        <p className="text-sm text-zinc-600">Loading company profile...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl px-4 py-12">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">Company profile</p>
            <h1 className="mt-2 text-3xl font-bold text-zinc-950">{profile.companyName || "Unnamed company"}</h1>
          </div>
          {isOwner && !isEditing ? (
            <button
              type="button"
              onClick={() => {
                setDraft(profile);
                setIsEditing(true);
                setMessage("");
                setError("");
              }}
              className="rounded-md border border-gray-300 bg-gray-50 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-white"
            >
              Edit
            </button>
          ) : null}
        </div>

        {isEditing ? (
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            <Field label="Company name" id="companyName">
              <input
                id="companyName"
                value={draft.companyName}
                onChange={(event) => setDraft((current) => ({ ...current, companyName: event.target.value }))}
                className="field"
              />
            </Field>
            <Field label="Industry" id="industry">
              <input
                id="industry"
                value={draft.industry}
                onChange={(event) => setDraft((current) => ({ ...current, industry: event.target.value }))}
                className="field"
              />
            </Field>
            <Field label="Company size" id="companySize">
              <select
                id="companySize"
                value={draft.companySize}
                onChange={(event) => setDraft((current) => ({ ...current, companySize: event.target.value }))}
                className="field"
              >
                <option value="">Select size</option>
                {companySizeOptions.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Website URL" id="websiteUrl">
              <input
                id="websiteUrl"
                type="url"
                value={draft.websiteUrl}
                onChange={(event) => setDraft((current) => ({ ...current, websiteUrl: event.target.value }))}
                className="field"
                placeholder="https://example.com"
              />
            </Field>
            <Field label="Glassdoor URL" id="glassdoorUrl">
              <input
                id="glassdoorUrl"
                type="url"
                value={draft.glassdoorUrl}
                onChange={(event) => setDraft((current) => ({ ...current, glassdoorUrl: event.target.value }))}
                className="field"
                placeholder="https://www.glassdoor.com/..."
              />
            </Field>
            <Field label="LinkedIn URL" id="linkedinUrl">
              <input
                id="linkedinUrl"
                type="url"
                value={draft.linkedinUrl}
                onChange={(event) => setDraft((current) => ({ ...current, linkedinUrl: event.target.value }))}
                className="field"
                placeholder="https://www.linkedin.com/company/..."
              />
            </Field>
            <Field label="About / description" id="about" fullWidth>
              <textarea
                id="about"
                rows={5}
                value={draft.about}
                onChange={(event) => setDraft((current) => ({ ...current, about: event.target.value }))}
                className="field"
              />
            </Field>
            <div className="flex gap-2 md:col-span-2">
              <button
                type="button"
                onClick={saveProfile}
                className="rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsEditing(false);
                  setError("");
                }}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-gray-50"
              >
                Cancel
              </button>
            </div>
            {error ? <p className="text-sm font-semibold text-red-700 md:col-span-2">{error}</p> : null}
          </div>
        ) : (
          <div className="mt-6 space-y-5">
            <dl className="grid gap-4 md:grid-cols-3">
              <ViewField label="Industry" value={profile.industry} />
              <ViewField label="Company size" value={profile.companySize} />
              <ViewField label="Website" value={profile.websiteUrl} href={profile.websiteUrl} />
              <ViewField label="Glassdoor" value={profile.glassdoorUrl} href={profile.glassdoorUrl} />
              <ViewField label="LinkedIn" value={profile.linkedinUrl} href={profile.linkedinUrl} />
            </dl>
            {profile.about ? <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-700">{profile.about}</p> : null}
            {message ? <p className="text-sm font-semibold text-green-700">{message}</p> : null}
          </div>
        )}
      </div>

      <div className="mt-8">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">Active job listings</p>
        <div className="mt-4 grid gap-4">
          {jobs.length > 0 ? (
            jobs.map((job) => (
              <article key={job.id} className="rounded-lg border border-gray-200 bg-white p-5 shadow-soft">
                <h2 className="text-lg font-bold text-zinc-950">{job.title}</h2>
                <div className="mt-3 grid gap-3 text-sm md:grid-cols-3">
                  <JobDetail label="Pay range" value={job.payRange || "Not listed"} />
                  <JobDetail label="Job type" value={job.jobType || "Not listed"} />
                  <JobDetail label="Schedule" value={job.schedule || "Not listed"} />
                </div>
                <p className="mt-4 text-sm leading-6 text-zinc-700">{job.description}</p>
              </article>
            ))
          ) : (
            <div className="rounded-lg border border-dashed border-gray-300 bg-white p-5">
              <p className="text-sm font-semibold text-zinc-950">No active job listings.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function mapJobRow(job: any): JobListing {
  return {
    id: job.id,
    title: job.title ?? "",
    payRange: formatStoredPay(job.pay_min, job.pay_max, job.pay_type),
    jobType: job.job_type ?? "",
    schedule: job.shift ?? "",
    requiredSkills: job.required_capabilities ?? [],
    description: job.summary ?? ""
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

function normalizeUrl(url: string) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function Field({
  label,
  id,
  fullWidth = false,
  children
}: {
  label: string;
  id: string;
  fullWidth?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-2 ${fullWidth ? "md:col-span-2" : ""}`}>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children}
    </div>
  );
}

function ViewField({ label, value, href }: { label: string; value: string; href?: string }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</dt>
      <dd className="break-all text-sm text-zinc-900">
        {value ? (
          href ? (
            <a
              href={normalizeUrl(href)}
              target="_blank"
              rel="noopener noreferrer"
              className="text-red-800 hover:underline"
            >
              {value}
            </a>
          ) : (
            value
          )
        ) : (
          "—"
        )}
      </dd>
    </div>
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
