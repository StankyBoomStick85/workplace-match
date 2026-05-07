"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  getAllJobs,
  getCurrentMvpUser,
  getMutualMatches,
  type MvpJobListing,
  type MvpMatch
} from "../lib/supabaseMvpData";

type CandidateProfileState = {
  fullName: string;
  zipCode: string;
  searchRadius: string;
  desiredPayMin: string;
  payType: string;
  jobType: string;
  shiftPreference: string;
  workSetting: string;
  capabilitySummary: string;
  topSkills: string;
  experienceLevel: string;
  industriesOfInterest: string;
  availableStartDate: string;
  willingToRelocate: string;
};

const emptyProfile: CandidateProfileState = {
  fullName: "",
  zipCode: "",
  searchRadius: "",
  desiredPayMin: "",
  payType: "hourly",
  jobType: "",
  shiftPreference: "",
  workSetting: "",
  capabilitySummary: "",
  topSkills: "",
  experienceLevel: "",
  industriesOfInterest: "",
  availableStartDate: "",
  willingToRelocate: ""
};

export function CandidateDashboard() {
  const [profile, setProfile] = useState<CandidateProfileState>(emptyProfile);
  const [draftProfile, setDraftProfile] = useState<CandidateProfileState>(emptyProfile);
  const [matchedJobs, setMatchedJobs] = useState<Array<{ job: MvpJobListing; match: MvpMatch }>>([]);
  const [isReady, setIsReady] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const isEditingRef = useRef(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    loadProfile();

    async function loadProfile() {
      const user = await getCurrentMvpUser("candidate");
      if (!user) {
        window.location.href = "/candidate/login";
        return;
      }

      const [profileResponse, jobs, matches] = await Promise.all([
        fetch(`/api/mvp/read?resource=candidate-profile&userId=${encodeURIComponent(user.id)}`),
        getAllJobs(),
        getMutualMatches()
      ]);
      const { data } = await profileResponse.json();
      const nextProfile = mapProfileData(data);
      setProfile(nextProfile);
      if (!isEditingRef.current) {
        setDraftProfile(nextProfile);
      }
      setMatchedJobs(
        matches
          .filter((match) => match.candidateId === user.id)
          .map((match) => ({ match, job: jobs.find((job) => job.id === match.jobId) }))
          .filter((record): record is { job: MvpJobListing; match: MvpMatch } => Boolean(record.job))
      );
      setIsReady(true);
    }
  }, []);

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setMessage("");

    const response = await fetch("/api/mvp/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resource: "candidate-profile",
        data: {
          ...draftProfile,
          topSkills: splitTags(draftProfile.topSkills)
        }
      })
    });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      setError(typeof payload.error === "string" ? payload.error : "Unable to save profile.");
      return;
    }

    setProfile(draftProfile);
    isEditingRef.current = false;
    setIsEditing(false);
    setMessage("Profile saved.");
  }

  function startEditing() {
    isEditingRef.current = true;
    setDraftProfile(profile);
    setMessage("");
    setError("");
    setIsEditing(true);
  }

  function updateDraft(field: keyof CandidateProfileState, value: string) {
    setDraftProfile((current) => ({ ...current, [field]: value }));
  }

  if (!isReady) {
    return (
      <section className="mx-auto max-w-5xl px-4 py-12">
        <p className="text-sm text-zinc-600">Loading profile...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <form onSubmit={saveProfile}>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="mt-2 text-3xl font-bold text-zinc-950">Welcome</h1>
              <p className="mt-2 text-3xl font-bold text-zinc-950">{profile.fullName || "Applicant"}</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <Link href="/jobs" className="rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950">
                See Jobs
              </Link>
              {isEditing ? (
                <button type="submit" className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-gray-50">
                  Save
                </button>
              ) : (
                <button type="button" onClick={startEditing} className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-gray-50">
                  Edit Profile
                </button>
              )}
            </div>
          </div>

          {message ? <p className="mt-4 text-sm font-semibold text-green-700">{message}</p> : null}
          {error ? <p className="mt-4 text-sm font-semibold text-red-700">{error}</p> : null}

          {isEditing ? (
            <div className="mt-6 space-y-5">
              <ProfileSection title="Personal Info">
                <ProfileField label="Full name" id="fullName">
                  <input id="fullName" value={draftProfile.fullName} onChange={(event) => updateDraft("fullName", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
                <ProfileField label="ZIP code" id="zipCode">
                  <input id="zipCode" value={draftProfile.zipCode} onChange={(event) => updateDraft("zipCode", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
                <ProfileField label="Search radius" id="searchRadius">
                  <input id="searchRadius" type="number" min="0" value={draftProfile.searchRadius} onChange={(event) => updateDraft("searchRadius", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
              </ProfileSection>

              <ProfileSection title="Work Preferences">
                <ProfileField label="Desired pay minimum" id="desiredPayMin">
                  <input id="desiredPayMin" type="number" min="0" value={draftProfile.desiredPayMin} onChange={(event) => updateDraft("desiredPayMin", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
                <ProfileField label="Pay type" id="payType">
                  <select id="payType" value={draftProfile.payType} onChange={(event) => updateDraft("payType", event.target.value)} disabled={!isEditing} className="field">
                    <option value="hourly">Hourly</option>
                    <option value="salary">Salary</option>
                  </select>
                </ProfileField>
                <ProfileField label="Job type" id="jobType">
                  <select id="jobType" value={draftProfile.jobType} onChange={(event) => updateDraft("jobType", event.target.value)} disabled={!isEditing} className="field">
                    <option value="">Select type</option>
                    <option value="full-time">Full-time</option>
                    <option value="part-time">Part-time</option>
                    <option value="contract">Contract</option>
                    <option value="temporary">Temporary</option>
                  </select>
                </ProfileField>
                <ProfileField label="Shift preference" id="shiftPreference">
                  <select id="shiftPreference" value={draftProfile.shiftPreference} onChange={(event) => updateDraft("shiftPreference", event.target.value)} disabled={!isEditing} className="field">
                    <option value="">Select shift</option>
                    <option value="days">Days</option>
                    <option value="nights">Nights</option>
                    <option value="swing">Swing</option>
                    <option value="weekends">Weekends</option>
                    <option value="flexible">Flexible</option>
                  </select>
                </ProfileField>
                <ProfileField label="Work setting" id="workSetting">
                  <select id="workSetting" value={draftProfile.workSetting} onChange={(event) => updateDraft("workSetting", event.target.value)} disabled={!isEditing} className="field">
                    <option value="">Select setting</option>
                    <option value="on-site">On-site</option>
                    <option value="hybrid">Hybrid</option>
                    <option value="remote">Remote</option>
                  </select>
                </ProfileField>
              </ProfileSection>

              <ProfileSection title="Capability Profile">
                <ProfileField label="Capability summary" id="capabilitySummary" fullWidth>
                  <textarea id="capabilitySummary" rows={4} value={draftProfile.capabilitySummary} onChange={(event) => updateDraft("capabilitySummary", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
                <ProfileField label="Top skills" id="topSkills">
                  <input id="topSkills" value={draftProfile.topSkills} onChange={(event) => updateDraft("topSkills", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
                <ProfileField label="Experience level" id="experienceLevel">
                  <select id="experienceLevel" value={draftProfile.experienceLevel} onChange={(event) => updateDraft("experienceLevel", event.target.value)} disabled={!isEditing} className="field">
                    <option value="">Select level</option>
                    <option value="entry">Entry</option>
                    <option value="skilled">Skilled</option>
                    <option value="lead">Lead</option>
                    <option value="lower management">Lower management</option>
                    <option value="management">Management</option>
                  </select>
                </ProfileField>
                <ProfileField label="Industries of interest" id="industriesOfInterest">
                  <input id="industriesOfInterest" value={draftProfile.industriesOfInterest} onChange={(event) => updateDraft("industriesOfInterest", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
              </ProfileSection>

              <ProfileSection title="Additional">
                <ProfileField label="Available start date" id="availableStartDate">
                  <input id="availableStartDate" type="date" value={draftProfile.availableStartDate} onChange={(event) => updateDraft("availableStartDate", event.target.value)} readOnly={!isEditing} className="field" />
                </ProfileField>
                <ProfileField label="Willing to relocate" id="willingToRelocate">
                  <select id="willingToRelocate" value={draftProfile.willingToRelocate} onChange={(event) => updateDraft("willingToRelocate", event.target.value)} disabled={!isEditing} className="field">
                    <option value="">Select option</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                    <option value="maybe">Maybe</option>
                  </select>
                </ProfileField>
              </ProfileSection>
            </div>
          ) : (
            <>
              <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-5">
                <h2 className="text-lg font-bold text-zinc-950">Capability Snapshot</h2>
                <p className="mt-2 text-sm leading-6 text-zinc-700">{profile.capabilitySummary || "No capability summary saved yet."}</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  {splitTags(profile.topSkills).map((skill) => (
                    <span key={skill} className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-700">
                      {skill}
                    </span>
                  ))}
                </div>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <DashboardCard label="Full name" value={profile.fullName || "Not set"} />
                <DashboardCard label="ZIP code" value={profile.zipCode || "Not set"} />
                <DashboardCard label="Search radius" value={profile.searchRadius ? `${profile.searchRadius} miles` : "Not set"} />
                <DashboardCard label="Desired pay" value={formatPay(profile.desiredPayMin, profile.payType)} />
                <DashboardCard label="Job type" value={profile.jobType || "Not set"} />
                <DashboardCard label="Shift preference" value={profile.shiftPreference || "Not set"} />
                <DashboardCard label="Work setting" value={profile.workSetting || "Not set"} />
                <DashboardCard label="Experience Level" value={profile.experienceLevel || "Not set"} />
                <DashboardCard label="Industries of interest" value={profile.industriesOfInterest || "Not set"} />
                <DashboardCard label="Available start date" value={profile.availableStartDate || "Not set"} />
                <DashboardCard label="Willing to relocate" value={profile.willingToRelocate || "Not set"} />
              </div>
            </>
          )}
        </form>

        {matchedJobs.length > 0 && !isEditing ? (
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

function mapProfileData(data: any): CandidateProfileState {
  const extras = parseProfileExtras(data?.visibility);

  return {
    fullName: data?.display_name ?? "",
    zipCode: data?.zip_code ?? "",
    searchRadius: data?.search_radius ? String(data.search_radius) : "",
    desiredPayMin: data?.desired_pay_min ? String(data.desired_pay_min) : "",
    payType: data?.pay_type || "hourly",
    jobType: Array.isArray(data?.job_types) ? data.job_types[0] ?? "" : "",
    shiftPreference: Array.isArray(data?.shifts) ? data.shifts[0] ?? "" : "",
    workSetting: data?.work_preference ?? "",
    capabilitySummary: data?.summary ?? "",
    topSkills: Array.isArray(data?.capability_tags) ? data.capability_tags.join(", ") : "",
    experienceLevel: data?.experience_level ?? "",
    industriesOfInterest: extras.industriesOfInterest,
    availableStartDate: extras.availableStartDate,
    willingToRelocate: extras.willingToRelocate
  };
}

function parseProfileExtras(value?: string) {
  try {
    const parsed = JSON.parse(value ?? "{}");
    return {
      industriesOfInterest: typeof parsed.industriesOfInterest === "string" ? parsed.industriesOfInterest : "",
      availableStartDate: typeof parsed.availableStartDate === "string" ? parsed.availableStartDate : "",
      willingToRelocate: typeof parsed.willingToRelocate === "string" ? parsed.willingToRelocate : ""
    };
  } catch {
    return {
      industriesOfInterest: "",
      availableStartDate: "",
      willingToRelocate: ""
    };
  }
}

function splitTags(value: string) {
  return value
    .split(",")
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function formatPay(value: string, payType: string) {
  if (!value) {
    return "Not set";
  }

  return payType === "salary" ? `$${value}/year` : `$${value}/hr`;
}

function ProfileSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-5">
      <h2 className="text-lg font-bold text-zinc-950">{title}</h2>
      <div className="mt-4 grid gap-4 md:grid-cols-2">{children}</div>
    </div>
  );
}

function ProfileField({
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

function DashboardCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-1 font-semibold text-zinc-950">{value}</p>
    </div>
  );
}
