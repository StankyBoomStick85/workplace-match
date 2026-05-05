"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import {
  addNewMessageNotification,
  addScheduleRequestNotification,
  attemptPreferredContact,
  getUnreadContactNotifications,
  type ContactMethod,
  type ContactNotification
} from "../lib/contactPreferences";
import { addMatchThreadMessage, getMatchThreadMessages, type MatchMessage } from "../lib/matchMessages";
import { logAdminEvent } from "../lib/adminEvents";

type CandidateAccount = {
  email: string;
  profileComplete: boolean;
  displayName?: string;
  profilePictureDataUrl?: string;
};

type CandidateProfile = {
  candidateEmail?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  manualMapLat?: number;
  manualMapLng?: number;
  profilePictureDataUrl?: string;
  fullName: string;
  zipCode: string;
  desiredJobType: string;
  workPreference: string;
  capabilitySummary: string;
  topSkills: string[];
  experienceLevel: string;
  educationLevel: string;
  updatedAt?: string;
};

type CandidateProfileDraft = Omit<CandidateProfile, "topSkills"> & {
  topSkills: string;
};

type EmployerAccount = {
  email: string;
  displayName?: string;
  companyName?: string;
  phone?: string;
  preferredContactMethods?: ContactMethod[];
  availabilityWindows?: string[];
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

type MutualMatch = {
  employerId: string;
  jobId: string;
  candidateId: string;
  matchPercent: number;
  createdAt: string;
  status: "mutual_match";
};

const storageKey = "workplace_match_candidate";
const employerAccountKey = "workplace_match_employer";
const employerAccountsKey = "workplace_match_employer_accounts";
const profileStorageKey = "workplace_match_candidate_profile";
const employerJobsKey = "workplace_match_employer_jobs";
const mutualMatchesKey = "workplace_match_mutual_matches";
const activeRoleKey = "workplace_match_active_role";

export function CandidateDashboard() {
  const [account, setAccount] = useState<CandidateAccount | null>(null);
  const [profile, setProfile] = useState<CandidateProfile | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState<CandidateProfileDraft | null>(null);
  const [contactNotifications, setContactNotifications] = useState<ContactNotification[]>([]);
  const [matchedJobs, setMatchedJobs] = useState<Array<{ job: JobListing; match: MutualMatch }>>([]);
  const [openMessageJobId, setOpenMessageJobId] = useState("");
  const [openScheduleJobId, setOpenScheduleJobId] = useState("");
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [threadMessages, setThreadMessages] = useState<Record<string, MatchMessage[]>>({});
  const [scheduleSelections, setScheduleSelections] = useState<Record<string, string>>({});

  useEffect(() => {
    const saved = localStorage.getItem(storageKey);
    const activeRole = localStorage.getItem(activeRoleKey);
    if (!saved || activeRole !== "candidate") {
      window.location.href = "/candidate/login";
      return;
    }

    const parsedAccount = JSON.parse(saved) as CandidateAccount;
    setAccount(parsedAccount);
    setContactNotifications(getUnreadContactNotifications(parsedAccount.email));

    const savedProfile = localStorage.getItem(profileStorageKey);
    if (savedProfile) {
      const parsedProfile = JSON.parse(savedProfile) as CandidateProfile;
      setProfile(parsedProfile);
      setMatchedJobs(getMutualMatchedJobs(parsedProfile));
    }
  }, []);

  if (!account) {
    return (
      <section className="mx-auto max-w-3xl px-4 py-14">
        <p className="text-sm text-zinc-600">Loading dashboard...</p>
      </section>
    );
  }

  function startEditing(event?: MouseEvent<HTMLButtonElement>) {
    event?.preventDefault();
    event?.stopPropagation();

    if (!profile) {
      return;
    }

    setDraft({
      ...profile,
      topSkills: formatSkillsForDraft(profile.topSkills)
    });
    setIsEditing(true);
  }

  function cancelEditing() {
    setDraft(null);
    setIsEditing(false);
  }

  function updateDraft(field: keyof CandidateProfileDraft, value: string) {
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  }

  function saveInlineUpdates(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!draft || !profile) {
      return;
    }

    const updatedProfile: CandidateProfile = {
      ...profile,
      candidateEmail: profile.candidateEmail,
      streetAddress: profile.streetAddress,
      city: profile.city,
      state: profile.state,
      fullName: draft.fullName.trim(),
      zipCode: draft.zipCode.trim(),
      desiredJobType: draft.desiredJobType.trim(),
      workPreference: draft.workPreference,
      capabilitySummary: draft.capabilitySummary.trim(),
      topSkills: splitSkills(draft.topSkills),
      experienceLevel: draft.experienceLevel,
      educationLevel: draft.educationLevel,
      updatedAt: new Date().toISOString()
    };

    localStorage.setItem(profileStorageKey, JSON.stringify(updatedProfile));
    setProfile(updatedProfile);
    setMatchedJobs(getMutualMatchedJobs(updatedProfile));
    setDraft(null);
    setIsEditing(false);
  }

  function getThread(job: JobListing) {
    return {
      applicantId: profile ? getCandidateInterestId(profile) : "candidate-profile:local-mvp",
      employerId: job.employerEmail,
      jobId: job.id
    };
  }

  function refreshThread(job: JobListing) {
    setThreadMessages((current) => ({ ...current, [job.id]: getMatchThreadMessages(getThread(job)) }));
  }

  function reachOut(job: JobListing) {
    if (!account || !profile) {
      return;
    }

    const employerAccount = findEmployerAccount(job.employerEmail);
    attemptPreferredContact({
      targetAccount: employerAccount,
      senderLabel: profile.fullName || account.displayName || "A mutual match",
      jobTitle: job.title
    });
    logAdminEvent({
      type: "reach_out_clicked",
      userRole: "candidate",
      jobId: job.id,
      applicantId: getCandidateInterestId(profile),
      employerId: job.employerEmail
    });
    sendMessage(job, "Let's schedule a time to connect about this match.");
    sendScheduleNotifications(
      job,
      "Schedule conversation requested for a mutual match.",
      `dashboard-schedule-request:${job.id}:${getCandidateInterestId(profile)}`
    );
  }

  function sendMessage(job: JobListing, text?: string) {
    if (!account) {
      return;
    }

    const nextText = (text ?? messageDrafts[job.id] ?? "").trim();
    if (!nextText) {
      return;
    }

    const message = addMatchThreadMessage({
      ...getThread(job),
      senderRole: "applicant",
      senderEmail: account.email,
      text: nextText
    });

    if (!message) {
      return;
    }

    addNewMessageNotification({
      recipientEmail: job.employerEmail,
      senderEmail: account.email,
      jobId: job.id,
      jobTitle: job.title,
      message: `New message about ${job.title}.`
    });
    setMessageDrafts((current) => ({ ...current, [job.id]: "" }));
    refreshThread(job);
  }

  function sendScheduleNotifications(job: JobListing, message: string, dedupeKey?: string) {
    if (!account) {
      return;
    }

    addScheduleRequestNotification({
      recipientEmail: job.employerEmail,
      senderEmail: account.email,
      jobId: job.id,
      jobTitle: job.title,
      message,
      dedupeKey: dedupeKey ? `${dedupeKey}:employer` : undefined
    });
    addScheduleRequestNotification({
      recipientEmail: account.email,
      senderEmail: job.employerEmail,
      jobId: job.id,
      jobTitle: job.title,
      message,
      dedupeKey: dedupeKey ? `${dedupeKey}:applicant` : undefined
    });
  }

  function scheduleConversation(job: JobListing) {
    const selectedTime = scheduleSelections[job.id]?.trim();
    if (!selectedTime || !profile) {
      return;
    }

    sendMessage(job, `Scheduled for ${selectedTime}`);
    logAdminEvent({
      type: "schedule_requested",
      userRole: "candidate",
      jobId: job.id,
      applicantId: getCandidateInterestId(profile),
      employerId: job.employerEmail
    });
    sendScheduleNotifications(job, `Conversation scheduled for ${selectedTime}`);
    setOpenScheduleJobId("");
  }

  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">
              Dashboard
            </p>
            <h1 className="mt-2 text-3xl font-bold text-zinc-950">Welcome</h1>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/jobs"
              className="inline-flex items-center justify-center rounded-md bg-red-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
            >
              See jobs
            </Link>
            <Link
              href="/account/settings?role=candidate"
              className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
            >
              Account settings
            </Link>
            {profile ? (
              isEditing ? (
                <button
                  type="submit"
                  form="candidate-inline-profile-form"
                  className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
                >
                  Save Profile
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startEditing}
                  className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
                >
                  Edit Profile
                </button>
              )
            ) : (
              <Link
                href="/candidate/profile"
                className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
              >
                Create profile
              </Link>
            )}
          </div>
        </div>
        {/*
          Profile editing and snapshot sections stay below. The jobs link is intentionally
          only navigation for now.
        */}

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

        {profile && isEditing && draft ? (
          <form
            id="candidate-inline-profile-form"
            onSubmit={saveInlineUpdates}
            className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-4">
              <p className="text-sm font-semibold text-zinc-950">Edit capability snapshot</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={cancelEditing}
                  className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-50"
                >
                  Cancel
                </button>
              </div>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-2">
              <InlineField label="Full name">
                <input
                  value={draft.fullName}
                  onChange={(event) => updateDraft("fullName", event.target.value)}
                  required
                  className="field"
                />
              </InlineField>
              <InlineField label="Target role">
                <input
                  value={draft.desiredJobType}
                  onChange={(event) => updateDraft("desiredJobType", event.target.value)}
                  required
                  className="field"
                />
              </InlineField>
              <InlineField label="Work preference">
                <select
                  value={draft.workPreference}
                  onChange={(event) => updateDraft("workPreference", event.target.value)}
                  required
                  className="field"
                >
                  <option value="onsite">Onsite</option>
                  <option value="hybrid">Hybrid</option>
                  <option value="remote">Remote</option>
                  <option value="open">Open</option>
                </select>
              </InlineField>
              <InlineField label="Experience level">
                <select
                  value={draft.experienceLevel}
                  onChange={(event) => updateDraft("experienceLevel", event.target.value)}
                  required
                  className="field"
                >
                  <option>Entry level</option>
                  <option>Some experience</option>
                  <option>Experienced</option>
                  <option>Lead or senior</option>
                </select>
              </InlineField>
              <InlineField label="Education level">
                <select
                  value={draft.educationLevel}
                  onChange={(event) => updateDraft("educationLevel", event.target.value)}
                  required
                  className="field"
                >
                  <option>High school or GED</option>
                  <option>Some college</option>
                  <option>Associate degree</option>
                  <option>Bachelor's degree</option>
                  <option>Trade or technical program</option>
                  <option>Other</option>
                </select>
              </InlineField>
              <InlineField label="Capability summary" fullWidth>
                <textarea
                  value={draft.capabilitySummary}
                  onChange={(event) => updateDraft("capabilitySummary", event.target.value)}
                  required
                  rows={4}
                  className="field"
                />
              </InlineField>
              <InlineField label="Top skills" fullWidth>
                <input
                  value={draft.topSkills}
                  onChange={(event) => updateDraft("topSkills", event.target.value)}
                  required
                  className="field"
                  placeholder="clear communication, accountability, inventory"
                />
              </InlineField>
            </div>
          </form>
        ) : profile ? (
          <div className="mt-6 rounded-lg border border-gray-200 bg-gray-50 p-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-4">
              <div className="flex items-center gap-3">
                {profile.profilePictureDataUrl || account.profilePictureDataUrl ? (
                  <img
                    src={profile.profilePictureDataUrl || account.profilePictureDataUrl}
                    alt=""
                    className="h-12 w-12 rounded-full object-cover"
                  />
                ) : null}
                <p className="text-3xl font-bold text-zinc-950">{profile.fullName}</p>
              </div>
              <span className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-700">
                Capability snapshot
              </span>
            </div>

            <div className="mt-5 grid gap-5 md:grid-cols-[0.8fr_1.2fr]">
              <section>
                <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
                  Target role
                </h2>
                <p className="mt-2 text-sm font-semibold text-zinc-950">
                  {profile.desiredJobType}
                </p>
              </section>

              <section>
                <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
                  Capability summary
                </h2>
                <p className="mt-2 text-sm leading-6 text-zinc-700">
                  {profile.capabilitySummary}
                </p>
              </section>

              <section>
                <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
                  Skills
                </h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  {normalizeSkills(profile.topSkills).map((skill) => (
                    <span
                      key={skill}
                      className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-700"
                    >
                      {skill}
                    </span>
                  ))}
                </div>
              </section>

              <section>
                <h2 className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
                  Education
                </h2>
                <p className="mt-2 text-sm font-semibold text-zinc-950">
                  {profile.educationLevel}
                </p>
              </section>
            </div>
          </div>
        ) : (
          <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-5">
            <p className="text-sm font-semibold text-zinc-950">No profile yet</p>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              Create a profile to add your target role, capability summary, skills, and education.
            </p>
          </div>
        )}

        <div className="mt-6 grid gap-3 md:grid-cols-2">
          <SummaryCard
            label="Work preference"
            value={profile ? formatPreference(profile.workPreference) : "Not set"}
          />
          <SummaryCard label="Experience level" value={profile ? profile.experienceLevel : "Not set"} />
        </div>

        {profile && matchedJobs.length > 0 ? (
          <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-zinc-950">Matched job listings</h2>
                <p className="mt-1 text-sm text-zinc-600">Mutual matches ready for next steps.</p>
              </div>
              <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-semibold text-zinc-600">
                {matchedJobs.length} MATCH
              </span>
            </div>
            <div className="mt-4 grid gap-4">
              {matchedJobs.map(({ job, match }) => {
                const employerAccount = findEmployerAccount(job.employerEmail);
                const availabilityWindows = employerAccount?.availabilityWindows ?? [];
                const messages = threadMessages[job.id] ?? getMatchThreadMessages(getThread(job));

                return (
                  <article key={`${job.id}-${match.candidateId}`} className="rounded-lg border border-gray-200 bg-gray-50 p-5">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-base font-bold text-zinc-950">{job.title}</h3>
                        <p className="mt-1 text-sm leading-5 text-zinc-600">
                          {employerAccount?.companyName || employerAccount?.displayName || "Employer"}
                        </p>
                        <p className="mt-1 text-sm leading-5 text-zinc-600">{formatJobLocation(job)}</p>
                      </div>
                      <span className="rounded-full bg-red-900 px-3 py-1 text-xs font-bold text-white">MATCH</span>
                    </div>
                    <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
                      <JobDetail label="Pay range" value={job.payRange} />
                      <JobDetail label="Job type" value={job.jobType} />
                      <JobDetail label="Schedule" value={job.schedule} />
                      <JobDetail label="Match" value={`${match.matchPercent}%`} />
                      <JobDetail label="Skills" value={formatSkills(job.requiredSkills)} />
                      <JobDetail label="Status" value={job.status} />
                    </div>
                    {job.description ? (
                      <div className="mt-4 rounded-md border border-gray-200 bg-white p-3">
                        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Description</p>
                        <p className="mt-2 max-h-24 overflow-y-auto text-sm leading-6 text-zinc-700">{job.description}</p>
                      </div>
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => reachOut(job)}
                        className="inline-flex items-center justify-center rounded-md bg-green-700 px-3 py-2 text-sm font-semibold text-white transition hover:bg-green-800"
                      >
                        Reach Out
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenMessageJobId((current) => (current === job.id ? "" : job.id));
                          refreshThread(job);
                        }}
                        className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
                      >
                        Message
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setOpenScheduleJobId((current) => (current === job.id ? "" : job.id));
                          setScheduleSelections((current) => ({ ...current, [job.id]: current[job.id] ?? availabilityWindows[0] ?? "" }));
                        }}
                        className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
                      >
                        Schedule Conversation
                      </button>
                    </div>
                    {openMessageJobId === job.id ? (
                      <div className="mt-3 space-y-2 rounded-md border border-gray-200 bg-white p-3">
                        <div className="max-h-32 space-y-1 overflow-y-auto text-sm text-zinc-700">
                          {messages.length > 0 ? (
                            messages.map((message) => (
                              <p key={message.id} className="rounded bg-gray-50 px-2 py-1">
                                <span className="font-semibold">{message.senderRole === "applicant" ? "You" : "Employer"}:</span>{" "}
                                {message.text}
                              </p>
                            ))
                          ) : (
                            <p className="text-zinc-500">No messages yet.</p>
                          )}
                        </div>
                        <textarea
                          value={messageDrafts[job.id] ?? ""}
                          onChange={(event) => setMessageDrafts((current) => ({ ...current, [job.id]: event.target.value }))}
                          rows={2}
                          className="field"
                          placeholder="Write a message..."
                        />
                        <button
                          type="button"
                          onClick={() => sendMessage(job)}
                          className="inline-flex items-center justify-center rounded-md bg-red-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
                        >
                          Send message
                        </button>
                      </div>
                    ) : null}
                    {openScheduleJobId === job.id ? (
                      <div className="mt-3 space-y-2 rounded-md border border-gray-200 bg-white p-3">
                        {availabilityWindows.length > 0 ? (
                          <>
                            <select
                              value={scheduleSelections[job.id] ?? availabilityWindows[0]}
                              onChange={(event) => setScheduleSelections((current) => ({ ...current, [job.id]: event.target.value }))}
                              className="field"
                            >
                              {availabilityWindows.map((window) => (
                                <option key={window} value={window}>
                                  {window}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => scheduleConversation(job)}
                              className="inline-flex items-center justify-center rounded-md bg-red-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
                            >
                              Confirm time
                            </button>
                          </>
                        ) : (
                          <p className="text-sm text-zinc-600">No employer availability has been added yet.</p>
                        )}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          </section>
        ) : null}

        <section className="mt-6 rounded-lg border border-gray-200 bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-zinc-950">
                Verification & documents
              </h2>
              <p className="mt-1 text-sm text-zinc-600">Visual placeholder for future profile tools.</p>
            </div>
            <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-semibold text-zinc-500">
              Inactive
            </span>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-3">
            <PlaceholderItem label="Resume upload" value="Coming soon" />
            <PlaceholderItem label="Certifications/documents" value="Coming soon" />
            <PlaceholderItem label="Auto-fill from resume" value="Future feature" />
          </div>
        </section>
      </div>
    </section>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-zinc-950">{value}</p>
    </div>
  );
}

function JobDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-zinc-950">{value || "Not provided"}</p>
    </div>
  );
}

function InlineField({
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
      <span className="label">{label}</span>
      {children}
    </label>
  );
}

function splitSkills(value: string) {
  return value
    .split(",")
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function formatSkillsForDraft(value: unknown) {
  return normalizeSkills(value).join(", ");
}

function normalizeSkills(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((skill) => String(skill).trim()).filter(Boolean);
  }

  if (typeof value === "string") {
    return splitSkills(value);
  }

  return [];
}

function formatPreference(value: string) {
  const labels: Record<string, string> = {
    onsite: "Onsite",
    hybrid: "Hybrid",
    remote: "Remote",
    open: "Open"
  };

  return labels[value] ?? value;
}

function PlaceholderItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-gray-50 p-4">
      <p className="text-sm font-semibold text-zinc-950">{label}</p>
      <p className="mt-2 text-sm text-zinc-500">{value}</p>
    </div>
  );
}

function getMutualMatchedJobs(profile: CandidateProfile) {
  const candidateId = getCandidateInterestId(profile);
  const mutualMatches = readLocalStorageArray<MutualMatch>(mutualMatchesKey).filter(
    (match) => match.candidateId === candidateId && match.status === "mutual_match"
  );
  const jobs = readLocalStorageArray<JobListing>(employerJobsKey);

  return mutualMatches
    .map((match) => {
      const job = jobs.find((storedJob) => storedJob.id === match.jobId && storedJob.employerEmail === match.employerId);
      return job ? { job, match } : null;
    })
    .filter(Boolean) as Array<{ job: JobListing; match: MutualMatch }>;
}

function getCandidateInterestId(profile: CandidateProfile) {
  return profile.updatedAt ? `candidate-profile:${profile.updatedAt}` : "candidate-profile:local-mvp";
}

function findEmployerAccount(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  const accounts = [
    ...readLocalStorageArray<EmployerAccount>(employerAccountsKey),
    readLocalStorageObject<EmployerAccount>(employerAccountKey)
  ].filter(Boolean) as EmployerAccount[];

  return accounts.find((employerAccount) => employerAccount.email.trim().toLowerCase() === normalizedEmail) ?? null;
}

function readLocalStorageArray<T>(key: string) {
  const value = localStorage.getItem(key);
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as T[] | T;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function readLocalStorageObject<T>(key: string) {
  const value = localStorage.getItem(key);
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function formatJobLocation(job: JobListing) {
  const cityStateZip = [job.locationCity, [job.locationState, job.locationZip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  return [job.locationStreet, cityStateZip].filter(Boolean).join(", ");
}

function formatSkills(value: string[]) {
  return normalizeSkills(value).join(", ");
}
