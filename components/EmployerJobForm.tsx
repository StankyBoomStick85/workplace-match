"use client";

import { useEffect, useState, type FormEvent } from "react";
import { logAdminEvent } from "../lib/adminEvents";
import { getCityStateForZip, normalizeStateValue, normalizeZipCode } from "../lib/addressHelpers";
import { formatStoredPayRange } from "../lib/payFormatting";
import { supabase } from "../lib/supabase";
import { StateAbbreviationSelect } from "./StateAbbreviationSelect";

type EmployerAccount = {
  email: string;
  id?: string;
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
  preferredSkills: string[];
  description: string;
  status: "Active";
  createdAt: string;
};

type PayRangeDraft = {
  value: string;
  payType: "per-hour" | "annual";
};

const jobFieldClassName =
  "w-full rounded-md border border-line bg-white px-3.5 py-2.5 text-base outline-none transition focus:border-moss focus:ring-2 focus:ring-moss/20";

function splitSkills(value: string) {
  return value
    .split(/[,\r\n]+/)
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function parsePayRange(value?: string): PayRangeDraft {
  const payRange = value ?? "";
  const payType = payRange.toLowerCase().includes("/year") ? "annual" : "per-hour";
  const draftValue = payRange.replace(/\/(hr|hour|year)$/i, "");

  return {
    value: draftValue,
    payType
  };
}

function joinSkills(skills: string[]) {
  return skills.join("\n");
}

// Pulls up to two numbers out of whatever the employer typed, e.g. "$120,000
// - $180,000", "120-180000", "22". Whole-dollar values only - pay ranges don't
// need cents and stripping them keeps the shorthand-expansion rules simple.
function parseRawPayNumbers(value: string) {
  const numbers = value.match(/\d[\d,]*/g)?.map((part) => Number(part.replace(/,/g, ""))) ?? [];
  return {
    min: numbers[0] ?? null,
    max: numbers[1] ?? numbers[0] ?? null
  };
}

// Blur-time shorthand expansion for ANNUAL pay only - "120" or "120-180000"
// almost certainly means thousands, since nobody earns $120/year. Each side is
// expanded independently, which also happens to be exactly what "mixed
// magnitude ranges normalize to the larger" needs: in "120-180000", only the
// 120 is under 1,000 so only it gets scaled, landing on 120000-180000.
function expandAnnualShorthand(value: number) {
  return value < 1000 ? value * 1000 : value;
}

// Rewrites the pay field to the value that will actually be saved, so the
// employer sees the expansion before they submit - never a silent rewrite.
function normalizePayFieldOnBlur(rawValue: string, payType: PayRangeDraft["payType"]) {
  const { min, max } = parseRawPayNumbers(rawValue);
  if (min === null) {
    return rawValue;
  }

  if (payType !== "annual") {
    // Hourly shorthand is left alone entirely - no thousands expansion.
    return rawValue;
  }

  const expandedMin = expandAnnualShorthand(min);
  const expandedMax = max === null ? expandedMin : expandAnnualShorthand(max);

  if (expandedMax === expandedMin) {
    return `$${expandedMin.toLocaleString("en-US")}`;
  }
  return `$${expandedMin.toLocaleString("en-US")}-$${expandedMax.toLocaleString("en-US")}`;
}

// Forward-geocodes the full street address once, at save time - never on
// render or per map view. Mirrors the same Nominatim call already used in
// app/api/scoring/refresh-muse-cache/route.ts. Returns null on any failure
// (no match, network error) so callers fall back to the ZIP centroid.
async function geocodeJobAddress(street: string, city: string, state: string, zip: string) {
  const query = [street, city, state, zip].map((part) => part.trim()).filter(Boolean).join(", ");
  if (!query) {
    return null;
  }

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`,
      { headers: { "Accept-Language": "en", "User-Agent": "WorkplaceMatch/1.0" } }
    );
    if (!response.ok) {
      return null;
    }

    const results: Array<{ lat: string; lon: string }> = await response.json();
    const first = results?.[0];
    if (!first) {
      return null;
    }

    const latitude = Number.parseFloat(first.lat);
    const longitude = Number.parseFloat(first.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }

    return { latitude, longitude };
  } catch {
    return null;
  }
}

function mapSupabaseJob(job: any, employerEmail: string): JobListing {
  return {
    id: job.id,
    employerEmail,
    title: job.title ?? "",
    locationStreet: job.street_address ?? "",
    locationCity: job.city ?? "",
    locationState: job.state ?? "",
    locationZip: job.location_zip ?? "",
    payRange: formatStoredPayRange(job.pay_min, job.pay_max, job.pay_type),
    jobType: job.job_type ?? "",
    schedule: job.shift ?? "",
    requiredSkills: job.required_capabilities ?? [],
    preferredSkills: job.preferred_capabilities ?? [],
    description: job.summary ?? "",
    status: job.active ? "Active" : "Active",
    createdAt: job.created_at ?? ""
  };
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
  const [payRangeValue, setPayRangeValue] = useState("");
  const [title, setTitle] = useState("");
  const [jobType, setJobType] = useState("");
  const [schedule, setSchedule] = useState("");
  const [requiredSkillsText, setRequiredSkillsText] = useState("");
  const [preferredSkillsText, setPreferredSkillsText] = useState("");
  const [description, setDescription] = useState("");
  const [pendingSave, setPendingSave] = useState<{ payload: Record<string, unknown>; message: string } | null>(null);
  const [saveError, setSaveError] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const hasCompanyAddress = Boolean(
    companyProfile?.streetAddress && companyProfile.city && companyProfile.state && companyProfile.zipCode
  );

  useEffect(() => {
    loadJobForm();

    async function loadJobForm() {
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

      const nextAccount = { id: user.id, email: user.email ?? "" };
      setAccount(nextAccount);

      const profileResponse = await fetch(`/api/mvp/read?resource=employer-profile&userId=${encodeURIComponent(user.id)}`);
      const { data: profile } = await profileResponse.json();
      if (profile) {
        setCompanyProfile({
          employerEmail: user.email ?? "",
          streetAddress: profile.street_address ?? "",
          city: profile.city ?? "",
          state: profile.state ?? "",
          zipCode: profile.location_zip ?? ""
        });
      }

      const editJobId = new URLSearchParams(window.location.search).get("edit");
      if (editJobId) {
        const jobResponse = await fetch(`/api/mvp/read?resource=job&jobId=${encodeURIComponent(editJobId)}&employerId=${encodeURIComponent(user.id)}`);
        const { data: jobToEdit } = await jobResponse.json();

        if (jobToEdit) {
          const mappedJob = mapSupabaseJob(jobToEdit, user.email ?? "");
          const parsedPayRange = parsePayRange(mappedJob.payRange);
          setEditingJob(mappedJob);
          setPayType(parsedPayRange.payType);
          setPayRangeValue(parsedPayRange.value);
          setWorkLocation({
            street: mappedJob.locationStreet ?? "",
            city: mappedJob.locationCity,
            state: mappedJob.locationState,
            zip: mappedJob.locationZip ?? ""
          });
          setTitle(mappedJob.title);
          setJobType(mappedJob.jobType);
          setSchedule(mappedJob.schedule);
          setRequiredSkillsText(joinSkills(mappedJob.requiredSkills));
          setPreferredSkillsText(joinSkills(mappedJob.preferredSkills));
          setDescription(mappedJob.description);
        }
      }
    }
  }, []);

  function updateWorkLocation(field: keyof typeof workLocation, value: string) {
    // A manual edit means the fields no longer necessarily match the saved
    // company address, so the checkbox should stop claiming they do.
    setUseCompanyAddress(false);

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

  async function saveJob(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaveError("");

    if (!account || !account.id) {
      return;
    }

    const jobData = {
      title: title.trim(),
      locationStreet: workLocation.street.trim(),
      locationCity: workLocation.city.trim(),
      locationState: workLocation.state.trim(),
      locationZip: workLocation.zip.trim(),
      jobType: jobType.trim(),
      schedule: schedule.trim(),
      requiredSkills: splitSkills(requiredSkillsText),
      preferredSkills: splitSkills(preferredSkillsText),
      description: description.trim()
    };

    // Re-run the same expansion here rather than trusting that blur already
    // normalized payRangeValue - submitting via Enter while still focused in
    // the pay field fires no blur event at all, which previously let a raw,
    // un-expanded shorthand value (e.g. pay_min=120) reach the database.
    const normalizedPayRangeValue = normalizePayFieldOnBlur(payRangeValue, payType);
    if (normalizedPayRangeValue !== payRangeValue) {
      setPayRangeValue(normalizedPayRangeValue);
    }
    const payValues = parseRawPayNumbers(normalizedPayRangeValue);

    if (payValues.min === null) {
      setSaveError("Enter a pay range before saving.");
      return;
    }

    if (payValues.max !== null && payValues.min > payValues.max) {
      setSaveError("Minimum pay is greater than maximum pay - please correct the pay range before saving.");
      return;
    }

    // Geocode once, here, at save time - never at render or per map view.
    // Failure (no match, network error) leaves latitude/longitude null, and
    // the map falls back to the ZIP centroid it already used before this.
    setIsSaving(true);
    const geocoded = await geocodeJobAddress(
      jobData.locationStreet,
      jobData.locationCity,
      jobData.locationState,
      jobData.locationZip
    );
    setIsSaving(false);

    const payload = {
      employer_id: account.id,
      title: jobData.title,
      street_address: jobData.locationStreet,
      city: jobData.locationCity,
      state: jobData.locationState,
      location_zip: jobData.locationZip,
      latitude: geocoded?.latitude ?? null,
      longitude: geocoded?.longitude ?? null,
      pay_min: payValues.min,
      pay_max: payValues.max,
      pay_type: payType === "annual" ? "annual" : "per-hour",
      job_type: jobData.jobType,
      shift: jobData.schedule,
      required_capabilities: jobData.requiredSkills,
      preferred_capabilities: jobData.preferredSkills,
      experience_level: "",
      summary: jobData.description,
      active: true
    };

    // Genuine-mistake confirmation, not shorthand: hourly rates don't get
    // auto-expanded, so a value over $200/hr is far more likely a typo or the
    // wrong pay type than a real wage - confirm instead of silently rewriting.
    if (payType === "per-hour" && payValues.max !== null && payValues.max > 200) {
      const format = (value: number) => `$${value.toLocaleString("en-US")}`;
      const entered =
        payValues.max === payValues.min ? format(payValues.min) : `${format(payValues.min)}-${format(payValues.max)}`;
      const suggested =
        payValues.max === payValues.min
          ? format(Math.round(payValues.min / 1000))
          : `${format(Math.round(payValues.min / 1000))}-${format(Math.round(payValues.max / 1000))}`;
      setPendingSave({
        payload,
        message: `You entered ${entered} per hour. Did you mean ${suggested} per hour, or is the pay type wrong?`
      });
      return;
    }

    await performSave(payload);
  }

  async function performSave(payload: Record<string, unknown>) {
    if (!account || !account.id) {
      return;
    }

    setIsSaving(true);

    if (editingJob) {
      // count: "exact" reports how many rows the UPDATE actually matched and
      // wrote, independent of any SELECT policy - so a zero-row result (e.g.
      // an RLS mismatch that only fails silently) is distinguishable here
      // from a genuine write, instead of failing open like a bare .update().
      const { error, count } = await supabase
        .from("job_posts")
        .update(payload, { count: "exact" })
        .eq("id", editingJob.id)
        .eq("employer_id", account.id);

      setIsSaving(false);

      if (error) {
        setSaveError(`Couldn't save your changes: ${error.message}`);
        return;
      }

      if (!count) {
        setSaveError(
          "Couldn't save your changes: no matching listing was updated. Your edits were not saved - please try again or contact support."
        );
        return;
      }

      window.location.href = "/employer/jobs";
      return;
    }

    const { error, count } = await supabase.from("job_posts").insert(payload, { count: "exact" });

    setIsSaving(false);

    if (error) {
      setSaveError(`Couldn't save this job listing: ${error.message}`);
      return;
    }

    if (!count) {
      setSaveError("Couldn't save this job listing - nothing was created. Please try again.");
      return;
    }

    logAdminEvent({
      type: "job_created",
      userRole: "employer",
      employerId: account.id
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
            <input
              id="title"
              required
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className={jobFieldClassName}
            />
          </Field>
          <div className="space-y-2 md:col-span-2">
            <label
              className={`flex items-center gap-2 text-sm font-semibold ${
                hasCompanyAddress ? "text-zinc-800" : "cursor-not-allowed text-zinc-400"
              }`}
            >
              <input
                type="checkbox"
                checked={useCompanyAddress}
                disabled={!hasCompanyAddress}
                onChange={(event) => toggleUseCompanyAddress(event.target.checked)}
                className="h-4 w-4 rounded border-gray-300 disabled:cursor-not-allowed"
              />
              Work location is same as company address
            </label>
            {!hasCompanyAddress ? (
              <p className="text-sm text-zinc-600">
                No company address on file yet - enter this job&apos;s work location manually below, or add a
                company address to enable autofill here.
              </p>
            ) : null}
          </div>
          <Field label="Work street address" id="locationStreet" fullWidth>
            <input
              id="locationStreet"
              name="locationStreet"
              value={workLocation.street}
              onChange={(event) => updateWorkLocation("street", event.target.value)}
              className={jobFieldClassName}
            />
          </Field>
          <Field label="City" id="locationCity">
            <input
              id="locationCity"
              name="locationCity"
              required
              value={workLocation.city}
              onChange={(event) => updateWorkLocation("city", event.target.value)}
              className={jobFieldClassName}
            />
          </Field>
          <Field label="State" id="locationState">
            <StateAbbreviationSelect
              id="locationState"
              name="locationState"
              required
              value={workLocation.state}
              onChange={(value) => updateWorkLocation("state", value)}
              className={`${jobFieldClassName} uppercase`}
            />
          </Field>
          <Field label="Work ZIP code" id="locationZip">
            <input
              id="locationZip"
              name="locationZip"
              inputMode="numeric"
              value={workLocation.zip}
              onChange={(event) => updateWorkLocation("zip", event.target.value)}
              className={jobFieldClassName}
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
                value={payRangeValue}
                onChange={(event) => setPayRangeValue(event.target.value)}
                onBlur={(event) => setPayRangeValue(normalizePayFieldOnBlur(event.target.value, payType))}
                className="w-36 rounded-md border border-line bg-white px-3.5 py-2.5 text-base outline-none transition focus:border-moss focus:ring-2 focus:ring-moss/20"
              />
              <button
                type="button"
                onClick={() => setPayType("per-hour")}
                className={`rounded-md px-3 py-2.5 text-sm font-semibold transition ${
                  payType === "per-hour"
                    ? "bg-red-900 text-white hover:bg-red-950"
                    : "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50"
                }`}
              >
                Hourly
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
            <select
              id="jobType"
              required
              value={jobType}
              onChange={(event) => setJobType(event.target.value)}
              className={jobFieldClassName}
            >
              <option value="" disabled>Select type</option>
              <option>Full-time</option>
              <option>Part-time</option>
              <option>Contract</option>
              <option>Temporary</option>
            </select>
          </Field>
          <Field label="Schedule" id="schedule">
            <select
              id="schedule"
              required
              value={schedule}
              onChange={(event) => setSchedule(event.target.value)}
              className={jobFieldClassName}
            >
              <option value="" disabled>Select schedule</option>
              <option>Onsite</option>
              <option>Hybrid</option>
              <option>Remote</option>
              <option>Flexible</option>
            </select>
          </Field>
          <Field label="Required capabilities" id="requiredSkills" fullWidth>
            <textarea
              id="requiredSkills"
              rows={4}
              required
              placeholder={`Enter one skill per line:
Kitchen leadership
Food safety
Inventory management`}
              value={requiredSkillsText}
              onChange={(event) => setRequiredSkillsText(event.target.value)}
              className={jobFieldClassName}
            />
          </Field>
          <Field label="Preferred capabilities" id="preferredSkills" fullWidth>
            <textarea
              id="preferredSkills"
              rows={4}
              placeholder={`Optional - enter one skill per line:
Bilingual
Forklift certified
POS system experience`}
              value={preferredSkillsText}
              onChange={(event) => setPreferredSkillsText(event.target.value)}
              className={jobFieldClassName}
            />
          </Field>
          <Field label="Short job description" id="description" fullWidth>
            <textarea
              id="description"
              rows={5}
              required
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              className={jobFieldClassName}
            />
          </Field>

          {saveError ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800 md:col-span-2">
              {saveError}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-3 md:col-span-2">
            <button
              type="submit"
              disabled={isSaving}
              className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSaving ? "Saving..." : editingJob ? "Save changes" : "Save job listing"}
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

      {pendingSave ? (
        <div className="fixed inset-0 z-[1500] flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-lg bg-white p-6 shadow-soft">
            <p className="text-lg font-bold text-zinc-950">Double-check this pay rate</p>
            <p className="mt-2 text-sm text-zinc-600">{pendingSave.message}</p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  const payload = pendingSave.payload;
                  setPendingSave(null);
                  void performSave(payload);
                }}
                className="rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white"
              >
                Save as entered
              </button>
              <button
                type="button"
                onClick={() => setPendingSave(null)}
                className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700"
              >
                Go back and edit
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
