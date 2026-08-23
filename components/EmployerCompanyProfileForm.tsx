"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { formatStoredPayRange } from "../lib/payFormatting";
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
  locationZip?: string;
  payRange: string;
  jobType: string;
  schedule: string;
  requiredSkills: string[];
  preferredSkills: string[];
  description: string;
};

type OwnerSection = "profile" | "dashboard" | "reports" | "market-analysis" | "comparative-data";

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

// Left-menu sections are owner-only workspace views. "profile" also doubles as
// the public slice - everyone else only ever sees that one, regardless of URL.
const ownerSections: { key: OwnerSection; label: string }[] = [
  { key: "profile", label: "Company Profile" },
  { key: "dashboard", label: "Dashboard" },
  { key: "reports", label: "Reports" },
  { key: "market-analysis", label: "Market Analysis" },
  { key: "comparative-data", label: "Comparative Data" }
];
const ownerSectionKeys = ownerSections.map((section) => section.key);

export function EmployerCompanyProfile({ employerId }: { employerId: string }) {
  const searchParams = useSearchParams();
  const [profile, setProfile] = useState<CompanyProfile>(emptyProfile);
  const [jobs, setJobs] = useState<JobListing[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<CompanyProfile>(emptyProfile);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [expandedJobId, setExpandedJobId] = useState("");

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
      <section className="mx-auto max-w-5xl px-4 py-14">
        <p className="text-sm text-zinc-600">Loading company profile...</p>
      </section>
    );
  }

  // Auth gating: a non-owner (including logged-out visitors) can never see the
  // workspace shell or an owner-only section, no matter what ?section= says.
  const requestedSection = searchParams.get("section") ?? "profile";
  const activeSection: OwnerSection =
    isOwner && ownerSectionKeys.includes(requestedSection as OwnerSection)
      ? (requestedSection as OwnerSection)
      : "profile";

  const publicSlice = (
    <>
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
        <div className="mt-4 space-y-3">
          {jobs.length > 0 ? (
            jobs.map((job) => {
              const isJobExpanded = expandedJobId === job.id;

              return (
                <div key={job.id} className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-soft">
                  <button
                    type="button"
                    onClick={() => setExpandedJobId(isJobExpanded ? "" : job.id)}
                    className="flex w-full items-center gap-3 px-5 py-4 text-left transition hover:bg-gray-50"
                  >
                    <span
                      className={`inline-block shrink-0 transition-transform ${isJobExpanded ? "rotate-90" : ""}`}
                      aria-hidden="true"
                    >
                      ▸
                    </span>
                    <span className="truncate text-lg font-bold text-zinc-950">{job.title}</span>
                  </button>

                  {isJobExpanded ? (
                    <div className="border-t border-gray-200 p-5">
                      <p className="text-sm text-zinc-600">{formatJobLocation(job)}</p>
                      <div className="mt-3 grid gap-3 text-sm md:grid-cols-3">
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
                              <span key={skill} className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-semibold text-zinc-700">
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
                    </div>
                  ) : null}
                </div>
              );
            })
          ) : (
            <div className="rounded-lg border border-dashed border-gray-300 bg-white p-5">
              <p className="text-sm font-semibold text-zinc-950">No active job listings.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );

  // Non-owners (including logged-out visitors) get the public slice only, full
  // width, with no workspace chrome and no way to reach an owner section.
  if (!isOwner) {
    return <section className="mx-auto max-w-4xl px-4 py-12">{publicSlice}</section>;
  }

  return (
    <section className="mx-auto max-w-6xl px-4 py-12">
      <div className="grid gap-6 md:grid-cols-[14rem_minmax(0,1fr)]">
        <nav className="h-fit rounded-lg border border-gray-200 bg-white p-2 shadow-soft md:sticky md:top-24">
          {ownerSections.map((section) => (
            <Link
              key={section.key}
              href={
                section.key === "profile"
                  ? `/employer/company/${employerId}`
                  : `/employer/company/${employerId}?section=${section.key}`
              }
              className={`block rounded-md px-3 py-2 text-sm font-semibold transition ${
                activeSection === section.key
                  ? "bg-red-50 text-red-800"
                  : "text-zinc-700 hover:bg-gray-50"
              }`}
            >
              {section.label}
            </Link>
          ))}
        </nav>

        <div>
          {activeSection === "profile" ? (
            publicSlice
          ) : (
            <ScaffoldedSection label={ownerSections.find((section) => section.key === activeSection)?.label ?? ""} />
          )}
        </div>
      </div>
    </section>
  );
}

function ScaffoldedSection({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-white p-8 text-center">
      <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">{label}</p>
      <p className="mt-2 text-sm text-zinc-600">This section is coming soon.</p>
    </div>
  );
}

function mapJobRow(job: any): JobListing {
  return {
    id: job.id,
    title: job.title ?? "",
    locationZip: job.location_zip ?? "",
    payRange: formatStoredPayRange(job.pay_min, job.pay_max, job.pay_type),
    jobType: job.job_type ?? "",
    schedule: job.shift ?? "",
    requiredSkills: job.required_capabilities ?? [],
    preferredSkills: job.preferred_capabilities ?? [],
    description: job.summary ?? ""
  };
}

function formatJobLocation(job: JobListing) {
  // job_posts has no persisted city/state - only ZIP - so show what's actually
  // stored rather than a ZIP-dictionary guess that can name the wrong town.
  return job.locationZip ? `ZIP ${job.locationZip}` : "Location not set";
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
