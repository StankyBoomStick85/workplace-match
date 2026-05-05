"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  addNewMessageNotification,
  addScheduleRequestNotification,
  attemptPreferredContact,
  type ContactMethod
} from "../lib/contactPreferences";
import { addMatchThreadMessage, getMatchThreadMessages, type MatchMessage } from "../lib/matchMessages";
import { logAdminEvent } from "../lib/adminEvents";
import { RemoveInterestConfirmationModal } from "./RemoveInterestConfirmationModal";

type Role = "candidate" | "employer";

type LocalAccount = {
  email: string;
  displayName?: string;
  companyName?: string;
  phone?: string;
  preferredContactMethods?: ContactMethod[];
  availabilityWindows?: string[];
};

type CandidateProfile = {
  candidateEmail?: string;
  fullName?: string;
  zipCode?: string;
  city?: string;
  state?: string;
  desiredJobType?: string;
  workPreference?: string;
  capabilitySummary?: string;
  topSkills?: string[];
  experienceLevel?: string;
  educationLevel?: string;
  updatedAt?: string;
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

type EmployerInterest = {
  employerId: string;
  jobId: string;
  candidateId: string;
  matchPercent?: number;
  createdAt?: string;
  status?: string;
};

type CandidateInterest = {
  employerId: string;
  jobId: string;
  candidateId: string;
  matchPercent?: number;
  createdAt?: string;
  status?: string;
};

type MatchRecord = {
  match: MutualMatch;
  job: JobListing;
  candidateProfile: CandidateProfile | null;
  candidateAccount: LocalAccount | null;
  employerAccount: LocalAccount | null;
};

const activeRoleKey = "workplace_match_active_role";
const activeEmailKey = "workplace_match_active_email";
const candidateAccountKey = "workplace_match_candidate";
const candidateAccountsKey = "workplace_match_candidate_accounts";
const candidateProfileKey = "workplace_match_candidate_profile";
const employerAccountKey = "workplace_match_employer";
const employerAccountsKey = "workplace_match_employer_accounts";
const employerJobsKey = "workplace_match_employer_jobs";
const employerInterestsKey = "workplace_match_employer_interests";
const candidateInterestsKey = "workplace_match_candidate_interests";
const mutualMatchesKey = "workplace_match_mutual_matches";
const privateNotesKey = "workplace_match_private_match_notes";

export function MyMatches({ role }: { role: Role }) {
  const [account, setAccount] = useState<LocalAccount | null>(null);
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [openMessageKey, setOpenMessageKey] = useState("");
  const [openScheduleKey, setOpenScheduleKey] = useState("");
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  const [threadMessages, setThreadMessages] = useState<Record<string, MatchMessage[]>>({});
  const [scheduleSelections, setScheduleSelections] = useState<Record<string, string>>({});
  const [expandedMatchKey, setExpandedMatchKey] = useState("");
  const [privateNotes, setPrivateNotes] = useState<Record<string, string>>({});
  const [pendingRemoveInterest, setPendingRemoveInterest] = useState<MatchRecord | null>(null);

  useEffect(() => {
    const activeRole = localStorage.getItem(activeRoleKey);
    if (activeRole !== role) {
      window.location.href = role === "employer" ? "/employer/login" : "/candidate/login";
      return;
    }

    const currentAccount = getActiveAccount(role);
    if (!currentAccount) {
      window.location.href = role === "employer" ? "/employer/login" : "/candidate/login";
      return;
    }

    setAccount(currentAccount);
    setMatches(role === "employer" ? getEmployerMatches(currentAccount.email) : getApplicantMatches());
    const savedNotes = readPrivateNotesForUser(role, currentAccount.email);
    setPrivateNotes(savedNotes);
  }, [role]);

  if (!account) {
    return (
      <section className="mx-auto max-w-5xl px-4 py-12">
        <p className="text-sm text-zinc-600">Loading matches...</p>
      </section>
    );
  }

  function getThread(record: MatchRecord) {
    return {
      applicantId: record.match.candidateId,
      employerId: record.match.employerId,
      jobId: record.match.jobId
    };
  }

  function getRecordKey(record: MatchRecord) {
    return `${record.match.employerId}:${record.match.jobId}:${record.match.candidateId}`;
  }

  function refreshThread(record: MatchRecord) {
    setThreadMessages((current) => ({
      ...current,
      [getRecordKey(record)]: getMatchThreadMessages(getThread(record))
    }));
  }

  function getOtherAccount(record: MatchRecord) {
    return role === "employer" ? record.candidateAccount : record.employerAccount;
  }

  function getSenderLabel(record: MatchRecord) {
    if (role === "employer") {
      return account?.companyName || account?.displayName || account?.email || "A mutual match";
    }

    return record.candidateProfile?.fullName || account?.displayName || "A mutual match";
  }

  function reachOut(record: MatchRecord) {
    if (!account) {
      return;
    }

    attemptPreferredContact({
      targetAccount: getOtherAccount(record),
      senderLabel: getSenderLabel(record),
      jobTitle: record.job.title
    });
    logAdminEvent({
      type: "reach_out_clicked",
      userRole: role === "employer" ? "employer" : "candidate",
      jobId: record.job.id,
      applicantId: record.match.candidateId,
      employerId: record.match.employerId
    });
    sendMessage(record, "Let's schedule a time to connect about this match.");
    sendScheduleNotifications(
      record,
      "Schedule conversation requested for a mutual match.",
      `my-matches-schedule-request:${getRecordKey(record)}`
    );
  }

  function sendMessage(record: MatchRecord, text?: string) {
    if (!account) {
      return;
    }

    const key = getRecordKey(record);
    const nextText = (text ?? messageDrafts[key] ?? "").trim();
    if (!nextText) {
      return;
    }

    const message = addMatchThreadMessage({
      ...getThread(record),
      senderRole: role === "employer" ? "employer" : "applicant",
      senderEmail: account.email,
      text: nextText
    });

    const receiverEmail = role === "employer" ? record.candidateAccount?.email : record.job.employerEmail;
    if (message && receiverEmail) {
      addNewMessageNotification({
        recipientEmail: receiverEmail,
        senderEmail: account.email,
        jobId: record.job.id,
        jobTitle: record.job.title,
        message: `New message about ${record.job.title}.`
      });
    }

    setMessageDrafts((current) => ({ ...current, [key]: "" }));
    refreshThread(record);
  }

  function sendScheduleNotifications(record: MatchRecord, message: string, dedupeKey?: string) {
    if (!account) {
      return;
    }

    const candidateEmail = record.candidateAccount?.email;
    if (candidateEmail) {
      addScheduleRequestNotification({
        recipientEmail: candidateEmail,
        senderEmail: account.email,
        jobId: record.job.id,
        jobTitle: record.job.title,
        message,
        dedupeKey: dedupeKey ? `${dedupeKey}:candidate` : undefined
      });
    }
    addScheduleRequestNotification({
      recipientEmail: record.match.employerId,
      senderEmail: candidateEmail ?? account.email,
      jobId: record.job.id,
      jobTitle: record.job.title,
      message,
      dedupeKey: dedupeKey ? `${dedupeKey}:employer` : undefined
    });
  }

  function scheduleConversation(record: MatchRecord) {
    const key = getRecordKey(record);
    const selectedTime = scheduleSelections[key]?.trim();
    if (!selectedTime) {
      return;
    }

    sendMessage(record, `Scheduled for ${selectedTime}`);
    logAdminEvent({
      type: "schedule_requested",
      userRole: role === "employer" ? "employer" : "candidate",
      jobId: record.job.id,
      applicantId: record.match.candidateId,
      employerId: record.match.employerId
    });
    sendScheduleNotifications(record, `Conversation scheduled for ${selectedTime}`);
    setOpenScheduleKey("");
  }

  function savePrivateNote(record: MatchRecord, value: string) {
    if (!account) {
      return;
    }

    const key = getRecordKey(record);
    const nextNotes = { ...privateNotes, [key]: value };
    setPrivateNotes(nextNotes);
    savePrivateNotesForUser(role, account.email, nextNotes);
  }

  function removeInterest(record: MatchRecord) {
    if (!account) {
      return;
    }

    if (role === "employer") {
      const employerInterests = readLocalStorageArray<EmployerInterest>(employerInterestsKey).filter(
        (interest) => !isSameMatchTriple(interest, record.match)
      );
      localStorage.setItem(employerInterestsKey, JSON.stringify(employerInterests));
    } else {
      const candidateInterests = readLocalStorageArray<CandidateInterest>(candidateInterestsKey).filter(
        (interest) => !isSameMatchTriple(interest, record.match)
      );
      localStorage.setItem(candidateInterestsKey, JSON.stringify(candidateInterests));
    }

    const mutualMatches = readLocalStorageArray<MutualMatch>(mutualMatchesKey).filter(
      (match) => !isSameMatchTriple(match, record.match)
    );
    localStorage.setItem(mutualMatchesKey, JSON.stringify(mutualMatches));
    logAdminEvent({
      type: "interest_removed",
      userRole: role === "employer" ? "employer" : "candidate",
      jobId: record.job.id,
      applicantId: record.match.candidateId,
      employerId: record.match.employerId
    });
    setMatches((current) => current.filter((storedRecord) => getRecordKey(storedRecord) !== getRecordKey(record)));
    setExpandedMatchKey("");
    setOpenMessageKey("");
    setOpenScheduleKey("");
  }

  return (
    <>
      <section className="mx-auto max-w-5xl px-4 py-12">
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">My Matches</p>
              <h1 className="mt-2 text-3xl font-bold text-zinc-950">
                {role === "employer" ? "Matched applicants" : "Matched jobs"}
              </h1>
            </div>
            <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-semibold text-zinc-600">
              {matches.length} MATCH
            </span>
          </div>

          {matches.length === 0 ? (
            <div className="mt-6 rounded-lg border border-dashed border-gray-300 bg-gray-50 p-5">
              <p className="text-sm font-semibold text-zinc-950">No mutual matches yet</p>
              <p className="mt-2 text-sm leading-6 text-zinc-600">
                Mutual matches will appear here after both sides express interest.
              </p>
            </div>
          ) : (
            <div className="mt-6 grid gap-4">
              {matches.map((record) =>
                role === "employer" ? renderEmployerMatch(record) : renderApplicantMatch(record)
              )}
            </div>
          )}
        </div>
      </section>
      {pendingRemoveInterest ? (
        <RemoveInterestConfirmationModal
          onConfirm={() => {
            removeInterest(pendingRemoveInterest);
            setPendingRemoveInterest(null);
          }}
          onCancel={() => setPendingRemoveInterest(null)}
        />
      ) : null}
    </>
  );

  function renderApplicantMatch(record: MatchRecord) {
    return (
      <MatchCard key={getRecordKey(record)} record={record}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-zinc-950">{record.job.title}</h2>
            <p className="mt-1 text-sm leading-5 text-zinc-600">
              {record.employerAccount?.companyName || record.employerAccount?.displayName || "Employer"}
            </p>
            <p className="mt-1 text-sm leading-5 text-zinc-600">{formatJobLocation(record.job)}</p>
          </div>
          <span className="rounded-full bg-red-900 px-3 py-1 text-xs font-bold text-white">MATCH</span>
        </div>
        <JobDetails job={record.job} matchPercent={record.match.matchPercent} />
        <MatchActions record={record} />
      </MatchCard>
    );
  }

  function renderEmployerMatch(record: MatchRecord) {
    const skillBreakdown = getEmployerSkillBreakdown(record);

    return (
      <MatchCard key={getRecordKey(record)} record={record}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-bold text-zinc-950">Applicant match</h2>
            <p className="mt-1 text-sm leading-5 text-zinc-600">{formatApplicantLocation(record.candidateProfile)}</p>
            <p className="mt-1 text-sm leading-5 text-zinc-600">Matched job: {record.job.title}</p>
          </div>
          <span className="rounded-full bg-red-900 px-3 py-1 text-xs font-bold text-white">MATCH</span>
        </div>
        <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
          <Detail label="Match" value={`${record.match.matchPercent}%`} />
          <Detail label="Location" value={formatApplicantLocation(record.candidateProfile)} />
          <Detail label="Job" value={record.job.title} />
        </div>
        <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
          <Detail label="Skills matched on" value={skillBreakdown.matchedSkills.join(", ")} />
          <Detail label="Additional applicant skills not matching" value={skillBreakdown.additionalSkills.join(", ")} />
        </div>
        <MatchActions record={record} />
      </MatchCard>
    );
  }

  function MatchCard({ record, children }: { record: MatchRecord; children: ReactNode }) {
    const key = getRecordKey(record);
    const messages = threadMessages[key] ?? getMatchThreadMessages(getThread(record));
    const availabilityWindows = record.employerAccount?.availabilityWindows ?? [];
    const isExpanded = expandedMatchKey === key;

    return (
      <article className="overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
        <button
          type="button"
          onClick={() => setExpandedMatchKey((current) => (current === key ? "" : key))}
          className="flex w-full items-center justify-between gap-3 bg-white px-5 py-4 text-left transition hover:bg-gray-50"
        >
          <span className="min-w-0 truncate text-base font-bold text-zinc-950">{record.job.title}</span>
          <span className="shrink-0 rounded-full bg-red-900 px-3 py-1 text-sm font-bold text-white">
            {record.match.matchPercent}%
          </span>
        </button>
        {isExpanded ? (
          <div className="p-5">
            {children}
            <section className="mt-4 rounded-md border border-gray-200 bg-white p-3">
              <label className="space-y-2">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Private notes</span>
                <PrivateNotesTextarea
                  initialValue={privateNotes[key] ?? ""}
                  onSave={(value) => savePrivateNote(record, value)}
                />
              </label>
            </section>
          </div>
        ) : null}
        {isExpanded && openMessageKey === key ? (
          <div className="mx-5 mb-5 space-y-2 rounded-md border border-gray-200 bg-white p-3">
            <div className="max-h-32 space-y-1 overflow-y-auto text-sm text-zinc-700">
              {messages.length > 0 ? (
                messages.map((message) => (
                  <p key={message.id} className="rounded bg-gray-50 px-2 py-1">
                    <span className="font-semibold">
                      {message.senderRole === role ? "You" : role === "employer" ? "Applicant" : "Employer"}:
                    </span>{" "}
                    {message.text}
                  </p>
                ))
              ) : (
                <p className="text-zinc-500">No messages yet.</p>
              )}
            </div>
            <textarea
              value={messageDrafts[key] ?? ""}
              onChange={(event) => setMessageDrafts((current) => ({ ...current, [key]: event.target.value }))}
              rows={2}
              className="field"
              placeholder="Write a message..."
            />
            <button
              type="button"
              onClick={() => sendMessage(record)}
              className="inline-flex items-center justify-center rounded-md bg-red-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
            >
              Send message
            </button>
          </div>
        ) : null}
        {isExpanded && openScheduleKey === key ? (
          <div className="mx-5 mb-5 space-y-2 rounded-md border border-gray-200 bg-white p-3">
            {availabilityWindows.length > 0 ? (
              <>
                <select
                  value={scheduleSelections[key] ?? availabilityWindows[0]}
                  onChange={(event) => setScheduleSelections((current) => ({ ...current, [key]: event.target.value }))}
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
                  onClick={() => scheduleConversation(record)}
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
  }

  function MatchActions({ record }: { record: MatchRecord }) {
    const key = getRecordKey(record);
    const availabilityWindows = record.employerAccount?.availabilityWindows ?? [];

    return (
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => reachOut(record)}
          className="inline-flex items-center justify-center rounded-md bg-green-700 px-3 py-2 text-sm font-semibold text-white transition hover:bg-green-800"
        >
          Reach Out
        </button>
        <button
          type="button"
          onClick={() => {
            setOpenMessageKey((current) => (current === key ? "" : key));
            refreshThread(record);
          }}
          className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
        >
          Message
        </button>
        <button
          type="button"
          onClick={() => {
            setOpenScheduleKey((current) => (current === key ? "" : key));
            setScheduleSelections((current) => ({ ...current, [key]: current[key] ?? availabilityWindows[0] ?? "" }));
          }}
          className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
        >
          Schedule Conversation
        </button>
        <button
          type="button"
          onClick={() => setPendingRemoveInterest(record)}
          className="inline-flex items-center justify-center rounded-md border border-red-200 bg-white px-3 py-2 text-sm font-semibold text-red-800 transition hover:bg-red-50"
        >
          Remove Interest
        </button>
      </div>
    );
  }

}

function JobDetails({ job, matchPercent }: { job: JobListing; matchPercent: number }) {
  return (
    <>
      <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
        <Detail label="Pay range" value={job.payRange} />
        <Detail label="Job type" value={job.jobType} />
        <Detail label="Schedule" value={job.schedule} />
        <Detail label="Match" value={`${matchPercent}%`} />
        <Detail label="Skills" value={job.requiredSkills.join(", ")} />
        <Detail label="Status" value={job.status} />
      </div>
      {job.description ? (
        <div className="mt-4 rounded-md border border-gray-200 bg-white p-3">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Description</p>
          <p className="mt-2 max-h-24 overflow-y-auto text-sm leading-6 text-zinc-700">{job.description}</p>
        </div>
      ) : null}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-2 text-sm font-semibold text-zinc-950">{value || "Not provided"}</p>
    </div>
  );
}

function PrivateNotesTextarea({
  initialValue,
  onSave
}: {
  initialValue: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(initialValue);

  return (
    <textarea
      value={draft}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onSave(draft)}
      rows={3}
      className="field"
      placeholder="Only you can see these notes."
    />
  );
}

function getActiveAccount(role: Role) {
  const activeEmail = localStorage.getItem(activeEmailKey);
  const accountKey = role === "employer" ? employerAccountKey : candidateAccountKey;
  const accountsKey = role === "employer" ? employerAccountsKey : candidateAccountsKey;
  const accounts = [...readLocalStorageArray<LocalAccount>(accountsKey), readLocalStorageObject<LocalAccount>(accountKey)]
    .filter(Boolean) as LocalAccount[];
  const normalizedActiveEmail = activeEmail?.trim().toLowerCase() ?? "";

  if (normalizedActiveEmail) {
    return accounts.find((account) => account.email.trim().toLowerCase() === normalizedActiveEmail) ?? null;
  }

  return accounts[0] ?? null;
}

function getApplicantMatches() {
  const profile = readLocalStorageObject<CandidateProfile>(candidateProfileKey);
  if (!profile) {
    return [];
  }

  const candidateId = getCandidateInterestId(profile);
  return buildMatchRecords(readLocalStorageArray<MutualMatch>(mutualMatchesKey).filter((match) => match.candidateId === candidateId));
}

function getEmployerMatches(employerEmail: string) {
  const normalizedEmail = employerEmail.trim().toLowerCase();
  return buildMatchRecords(
    readLocalStorageArray<MutualMatch>(mutualMatchesKey).filter(
      (match) => match.employerId.trim().toLowerCase() === normalizedEmail
    )
  );
}

function buildMatchRecords(matches: MutualMatch[]) {
  const jobs = readLocalStorageArray<JobListing>(employerJobsKey).filter((job) => !isSeedJob(job));
  const employerInterests = readLocalStorageArray<EmployerInterest>(employerInterestsKey);
  const candidateInterests = readLocalStorageArray<CandidateInterest>(candidateInterestsKey);
  const candidateProfile = readLocalStorageObject<CandidateProfile>(candidateProfileKey);
  const candidateAccount = findCandidateAccount(candidateProfile);

  return matches
    .filter(
      (match) =>
        employerInterests.some((interest) => isSameMatchTriple(interest, match)) &&
        candidateInterests.some((interest) => isSameMatchTriple(interest, match))
    )
    .map((match) => {
      const job = jobs.find((storedJob) => storedJob.id === match.jobId && storedJob.employerEmail === match.employerId);
      if (!job) {
        return null;
      }

      return {
        match,
        job,
        candidateProfile: candidateProfile && getCandidateInterestId(candidateProfile) === match.candidateId ? candidateProfile : null,
        candidateAccount,
        employerAccount: findEmployerAccount(match.employerId)
      };
    })
    .filter(Boolean) as MatchRecord[];
}

function isSeedJob(job: JobListing) {
  return job.id.startsWith("wm-test-") || job.employerEmail === "grouping-test-employer@workplacematch.local";
}

function isSameMatchTriple(
  value: { employerId?: string; jobId?: string; candidateId?: string },
  match: MutualMatch
) {
  return value.employerId === match.employerId && value.jobId === match.jobId && value.candidateId === match.candidateId;
}

function readPrivateNotesForUser(role: Role, email: string) {
  const allNotes = readLocalStorageObject<Record<string, Record<string, string>>>(privateNotesKey) ?? {};
  return allNotes[getPrivateNotesOwnerKey(role, email)] ?? {};
}

function savePrivateNotesForUser(role: Role, email: string, notes: Record<string, string>) {
  const allNotes = readLocalStorageObject<Record<string, Record<string, string>>>(privateNotesKey) ?? {};
  allNotes[getPrivateNotesOwnerKey(role, email)] = notes;
  localStorage.setItem(privateNotesKey, JSON.stringify(allNotes));
}

function getPrivateNotesOwnerKey(role: Role, email: string) {
  return `${role}:${email.trim().toLowerCase()}`;
}

function findEmployerAccount(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  return (
    readLocalStorageArray<LocalAccount>(employerAccountsKey)
      .concat(readLocalStorageObject<LocalAccount>(employerAccountKey) ?? [])
      .find((account) => account.email.trim().toLowerCase() === normalizedEmail) ?? null
  );
}

function findCandidateAccount(profile: CandidateProfile | null) {
  const candidateEmail = profile?.candidateEmail?.trim().toLowerCase() ?? "";
  const accounts = readLocalStorageArray<LocalAccount>(candidateAccountsKey).concat(
    readLocalStorageObject<LocalAccount>(candidateAccountKey) ?? []
  );

  if (candidateEmail) {
    return accounts.find((account) => account.email.trim().toLowerCase() === candidateEmail) ?? null;
  }

  return accounts[0] ?? null;
}

function getCandidateInterestId(profile: CandidateProfile) {
  return profile.updatedAt ? `candidate-profile:${profile.updatedAt}` : "candidate-profile:local-mvp";
}

function formatApplicantLocation(profile: CandidateProfile | null) {
  if (!profile) {
    return "Generalized applicant area";
  }

  const cityStateZip = [profile.city, [profile.state, profile.zipCode].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  return cityStateZip || (profile.zipCode ? `ZIP area ${profile.zipCode}` : "Generalized applicant area");
}

function formatJobLocation(job: JobListing) {
  const cityStateZip = [job.locationCity, [job.locationState, job.locationZip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  return [job.locationStreet, cityStateZip].filter(Boolean).join(", ");
}

function getEmployerSkillBreakdown(record: MatchRecord) {
  const applicantSkills = normalizeSkills(record.candidateProfile?.topSkills ?? []);
  const requiredSkills = normalizeSkills(record.job.requiredSkills);
  const matchedSkills = applicantSkills.filter((applicantSkill) =>
    requiredSkills.some((requiredSkill) => skillsOverlap(applicantSkill, requiredSkill))
  );
  const additionalSkills = applicantSkills.filter(
    (applicantSkill) => !matchedSkills.some((matchedSkill) => normalizeSkill(matchedSkill) === normalizeSkill(applicantSkill))
  );

  return {
    matchedSkills,
    additionalSkills
  };
}

function normalizeSkills(value: string[]) {
  return value
    .flatMap((skill) => skill.split(/[,\r\n]+/))
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function skillsOverlap(firstSkill: string, secondSkill: string) {
  const first = normalizeSkill(firstSkill);
  const second = normalizeSkill(secondSkill);
  return Boolean(first && second && (first === second || first.includes(second) || second.includes(first)));
}

function normalizeSkill(skill: string) {
  return skill.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
