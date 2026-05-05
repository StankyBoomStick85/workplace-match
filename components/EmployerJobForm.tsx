"use client";

import { useEffect, useState, type FormEvent } from "react";
import { logAdminEvent } from "../lib/adminEvents";
import { getCityStateForZip, normalizeStateValue, normalizeZipCode } from "../lib/addressHelpers";
import { StateAbbreviationSelect } from "./StateAbbreviationSelect";

type EmployerAccount = {
  email: string;
};

type CompanyProfile = {
  employerEmail: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
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

type PayRangeDraft = {
  value: string;
  payType: "per-hour" | "annual";
};

const employerAccountKey = "workplace_match_employer";
const employerJobsKey = "workplace_match_employer_jobs";
const activeRoleKey = "workplace_match_active_role";
const companyProfileKey = "workplace_match_employer_company_profile";
const jobFieldClassName =
  "w-full rounded-md border border-line bg-white px-3.5 py-2.5 text-base outline-none transition focus:border-moss focus:ring-2 focus:ring-moss/20";
const lockedJobFieldClassName = `${jobFieldClassName} disabled:bg-gray-100 disabled:text-zinc-600`;

function splitSkills(value: string) {
  return value
    .split(/[,\r\n]+/)
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function formatPayRange(value: string, payType: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const withoutUnit = trimmed
    .replace(/\s*(\/\s*(hr|hour|year)|per hour|per year|annual|annually)\s*$/i, "")
    .trim();
  const payWithDollarSigns = withoutUnit
    .split("-")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => (part.startsWith("$") ? part : `$${part}`))
    .join("-");

  return payType === "annual" ? `${payWithDollarSigns}/year` : `${payWithDollarSigns}/hr`;
}

function parsePayRange(value?: string): PayRangeDraft {
  const payRange = value ?? "";
  const payType = payRange.toLowerCase().includes("/year") ? "annual" : "per-hour";
  const draftValue = payRange.replace(/\/(hr|year)$/i, "");

  return {
    value: draftValue,
    payType
  };
}

function joinSkills(skills: string[]) {
  return skills.join("\n");
}

export function EmployerJobForm() {
  const [account, setAccount] = useState<EmployerAccount | null>(null);
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile | null>(null);
  const [editingJob, setEditingJob] = useState<JobListing | null>(null);
  const [useCompanyAddress, setUseCompanyAddress] = useState(false);
  const [workLocation, setWorkLocation] = useState({
    street: "",
    city: "",
    state: "",
    zip: ""
  });
  const [payType, setPayType] = useState<PayRangeDraft["payType"]>("per-hour");
  const hasCompanyAddress = Boolean(
    companyProfile?.streetAddress && companyProfile.city && companyProfile.state && companyProfile.zipCode
  );

  useEffect(() => {
    const saved = localStorage.getItem(employerAccountKey);
    const activeRole = localStorage.getItem(activeRoleKey);
    if (!saved || activeRole !== "employer") {
      window.location.href = "/employer/login";
      return;
    }

    const parsedAccount = JSON.parse(saved) as EmployerAccount;
    setAccount(parsedAccount);

    const savedCompanyProfile = localStorage.getItem(companyProfileKey);
    if (savedCompanyProfile) {
      const parsedCompanyProfile = JSON.parse(savedCompanyProfile) as CompanyProfile;
      if (parsedCompanyProfile.employerEmail === parsedAccount.email) {
        setCompanyProfile(parsedCompanyProfile);
      }
    }

    const editJobId = new URLSearchParams(window.location.search).get("edit");
    if (editJobId) {
      const savedJobs = localStorage.getItem(employerJobsKey);
      const jobs = savedJobs ? (JSON.parse(savedJobs) as JobListing[]) : [];
      const jobToEdit = jobs.find((job) => job.id === editJobId && job.employerEmail === parsedAccount.email) ?? null;

      if (jobToEdit) {
        const parsedPayRange = parsePayRange(jobToEdit.payRange);
        setEditingJob(jobToEdit);
        setPayType(parsedPayRange.payType);
        setWorkLocation({
          street: jobToEdit.locationStreet ?? "",
          city: jobToEdit.locationCity,
          state: jobToEdit.locationState,
          zip: jobToEdit.locationZip ?? ""
        });
      }
    }
  }, []);

  function updateWorkLocation(field: keyof typeof workLocation, value: string) {
    setWorkLocation((current) => {
      if (field !== "zip") {
        return { ...current, [field]: field === "state" ? normalizeStateValue(value) : value };
      }

      const normalizedZip = normalizeZipCode(value);
      const zipMatch = getCityStateForZip(normalizedZip);

      if (!zipMatch) {
        return { ...current, zip: normalizedZip };
      }

      return {
        ...current,
        zip: normalizedZip,
        city: zipMatch.city,
        state: zipMatch.state
      };
    });
  }

  function toggleUseCompanyAddress(checked: boolean) {
    setUseCompanyAddress(checked);

    if (checked && hasCompanyAddress && companyProfile) {
      setWorkLocation({
        street: companyProfile.streetAddress ?? "",
        city: companyProfile.city ?? "",
        state: companyProfile.state ?? "",
        zip: companyProfile.zipCode ?? ""
      });
    }
  }

  function saveJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!account) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const savedJobs = localStorage.getItem(employerJobsKey);
    const jobs = savedJobs ? (JSON.parse(savedJobs) as JobListing[]) : [];
    const jobData = {
      title: String(formData.get("title") ?? "").trim(),
      locationStreet: workLocation.street.trim(),
      locationCity: workLocation.city.trim(),
      locationState: workLocation.state.trim(),
      locationZip: workLocation.zip.trim(),
      payRange: formatPayRange(
        String(formData.get("payRange") ?? ""),
        String(formData.get("payType") ?? "per-hour")
      ),
      jobType: String(formData.get("jobType") ?? "").trim(),
      schedule: String(formData.get("schedule") ?? "").trim(),
      requiredSkills: splitSkills(String(formData.get("requiredSkills") ?? "")),
      description: String(formData.get("description") ?? "").trim()
    };

    if (editingJob) {
      const updatedJobs = jobs.map((job) =>
        job.id === editingJob.id && job.employerEmail === account.email
          ? {
              ...job,
              ...jobData,
              id: job.id,
              employerEmail: job.employerEmail,
              createdAt: job.createdAt,
              status: job.status
            }
          : job
      );

      localStorage.setItem(employerJobsKey, JSON.stringify(updatedJobs));
      window.location.href = "/employer/jobs";
      return;
    }

    const nextJob: JobListing = {
      id: crypto.randomUUID(),
      employerEmail: account.email,
      ...jobData,
      status: "Active",
      createdAt: new Date().toISOString()
    };

    localStorage.setItem(employerJobsKey, JSON.stringify([nextJob, ...jobs]));
    logAdminEvent({
      type: "job_created",
      userRole: "employer",
      jobId: nextJob.id,
      employerId: account.email
    });
    window.location.href = "/employer/jobs";
  }

  if (!account) {
    return (
      <section className="mx-auto max-w-3xl px-4 py-14">
        <p className="text-sm text-zinc-600">Loading job form...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl px-4 py-14">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">
          Job listing
        </p>
        <h1 className="mt-2 text-3xl font-bold text-zinc-950">
          {editingJob ? "Edit job listing" : "Create job listing"}
        </h1>
        <p className="mt-3 text-sm leading-6 text-zinc-600">
          Add the basic job details for this employer listing.
        </p>

        <form onSubmit={saveJob} className="mt-6 grid gap-5 md:grid-cols-2">
          <Field label="Job title" id="title">
            <input id="title" name="title" required defaultValue={editingJob?.title ?? ""} className={jobFieldClassName} />
          </Field>
          <div className="space-y-2 md:col-span-2">
            <label className="flex items-center gap-2 text-sm font-semibold text-zinc-800">
              <input
                type="checkbox"
                checked={useCompanyAddress}
                onChange={(event) => toggleUseCompanyAddress(event.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              Work location is same as company address
            </label>
            {!hasCompanyAddress ? (
              <p className="text-sm text-zinc-600">
                Add a company address first, or enter a work location manually.
              </p>
            ) : null}
          </div>
          <Field label="Work street address" id="locationStreet" fullWidth>
            <input
              id="locationStreet"
              name="locationStreet"
              value={workLocation.street}
              onChange={(event) => updateWorkLocation("street", event.target.value)}
              disabled={useCompanyAddress}
              className={lockedJobFieldClassName}
            />
          </Field>
          <Field label="City" id="locationCity">
            <input
              id="locationCity"
              name="locationCity"
              required
              value={workLocation.city}
              onChange={(event) => updateWorkLocation("city", event.target.value)}
              disabled={useCompanyAddress}
              className={lockedJobFieldClassName}
            />
          </Field>
          <Field label="State" id="locationState">
            <StateAbbreviationSelect
              id="locationState"
              name="locationState"
              required
              value={workLocation.state}
              onChange={(value) => updateWorkLocation("state", value)}
              disabled={useCompanyAddress}
              className={`${lockedJobFieldClassName} uppercase`}
            />
          </Field>
          <Field label="Work ZIP code" id="locationZip">
            <input
              id="locationZip"
              name="locationZip"
              inputMode="numeric"
              value={workLocation.zip}
              onChange={(event) => updateWorkLocation("zip", event.target.value)}
              disabled={useCompanyAddress}
              className={lockedJobFieldClassName}
            />
          </Field>
          <div className="space-y-2">
            <label htmlFor="payRange" className="text-base font-medium text-ink">
              Pay range
            </label>
            <div className="flex items-center gap-2">
              <input
                id="payRange"
                name="payRange"
                placeholder="$22-$28"
                required
                defaultValue={parsePayRange(editingJob?.payRange).value}
                className="w-36 rounded-md border border-line bg-white px-3.5 py-2.5 text-base outline-none transition focus:border-moss focus:ring-2 focus:ring-moss/20"
              />
              <input type="hidden" name="payType" value={payType} />
              <button
                type="button"
                onClick={() => setPayType("per-hour")}
                className={`rounded-md px-3 py-2.5 text-sm font-semibold transition ${
                  payType === "per-hour"
                    ? "bg-red-900 text-white hover:bg-red-950"
                    : "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50"
                }`}
              >
                HR
              </button>
              <button
                type="button"
                onClick={() => setPayType("annual")}
                className={`rounded-md px-3 py-2.5 text-sm font-semibold transition ${
                  payType === "annual"
                    ? "bg-red-900 text-white hover:bg-red-950"
                    : "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50"
                }`}
              >
                Annual
              </button>
            </div>
          </div>
          <Field label="Job type" id="jobType">
            <select id="jobType" name="jobType" required defaultValue={editingJob?.jobType ?? ""} className={jobFieldClassName}>
              <option value="" disabled>Select type</option>
              <option>Full-time</option>
              <option>Part-time</option>
              <option>Contract</option>
              <option>Temporary</option>
            </select>
          </Field>
          <Field label="Schedule" id="schedule">
            <select id="schedule" name="schedule" required defaultValue={editingJob?.schedule ?? ""} className={jobFieldClassName}>
              <option value="" disabled>Select schedule</option>
              <option>Onsite</option>
              <option>Hybrid</option>
              <option>Remote</option>
              <option>Flexible</option>
            </select>
          </Field>
          <Field label="Required skills" id="requiredSkills" fullWidth>
            <textarea
              id="requiredSkills"
              name="requiredSkills"
              rows={4}
              required
              placeholder={`Enter one skill per line:
Kitchen leadership
Food safety
Inventory management`}
              defaultValue={editingJob ? joinSkills(editingJob.requiredSkills) : ""}
              className={jobFieldClassName}
            />
          </Field>
          <Field label="Short job description" id="description" fullWidth>
            <textarea
              id="description"
              name="description"
              rows={5}
              required
              defaultValue={editingJob?.description ?? ""}
              className={jobFieldClassName}
            />
          </Field>

          <div className="flex flex-wrap gap-3 md:col-span-2">
            <button type="submit" className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950">
              {editingJob ? "Save changes" : "Save job listing"}
            </button>
            <button
              type="button"
              onClick={() => {
                window.location.href = "/employer/jobs";
              }}
              className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </section>
  );
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
      <label htmlFor={id} className="text-base font-medium text-ink">
        {label}
      </label>
      {children}
    </div>
  );
}
