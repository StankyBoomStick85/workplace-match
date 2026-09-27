"use client";

import { ChevronDown, ExternalLink, Heart } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  addMatchThreadMessage,
  formatMessageTimestamp,
  getMessageButtonLabel,
  refreshMatchThreadMessages,
  type MatchMessage,
  type MatchThreadContext
} from "../lib/matchMessages";
import { useMatchThreadRealtime } from "../lib/useMatchThreadRealtime";
import { useAutoScrollToBottom } from "../lib/useAutoScrollToBottom";
import {
  addNotificationByUserId,
  deleteSavedExternalJob,
  getAllEmployerProfiles,
  getAllJobs,
  getApplicantInterests,
  getCandidateMatchScores,
  getCurrentMvpUser,
  getEmployerInterests,
  getMutualMatches,
  getSavedExternalJobs,
  removeInterest,
  type MvpInterest,
  type MvpJobListing,
  type MvpMatch,
  type MvpSavedExternalJob
} from "../lib/supabaseMvpData";
import { RemoveInterestConfirmationModal } from "./RemoveInterestConfirmationModal";

type MatchedEntry = { job: MvpJobListing; match: MvpMatch };
type WpmInterestEntry = { job: MvpJobListing; interest: MvpInterest };
type InterestedEntry = { job: MvpJobListing };

// One saved job, one shape, regardless of whether it lives in matches/interests
// (WPM) or saved_jobs (external) - see "THE MODEL" in the task this shipped
// with: hearting is one action with one name (saving), and which table a row
// landed in is an implementation detail the UI never surfaces directly.
type SavedListItem = {
  key: string;
  jobId: string;
  title: string;
  company: string;
  location: string;
  payRange: string;
  jobType: string;
  schedule: string;
  description: string;
  matchPercent: number | null;
  isMutual: boolean;
  isExternal: boolean;
  employerId?: string;
  applyUrl?: string;
  savedAt: string;
  matchedEntry?: MatchedEntry;
};

export function ApplicantMyJobs() {
  const searchParams = useSearchParams();
  const [matchedEntries, setMatchedEntries] = useState<MatchedEntry[]>([]);
  const [interestedEntries, setInterestedEntries] = useState<WpmInterestEntry[]>([]);
  const [employerInterestedEntries, setEmployerInterestedEntries] = useState<InterestedEntry[]>([]);
  const [externalSavedJobs, setExternalSavedJobs] = useState<MvpSavedExternalJob[]>([]);
  const [matchScores, setMatchScores] = useState<Record<string, number>>({});
  const [companyNames, setCompanyNames] = useState<Record<string, string>>({});
  const [isReady, setIsReady] = useState(false);
  const [candidateId, setCandidateId] = useState("");
  const [openMessageJobId, setOpenMessageJobId] = useState("");
  const [threadMessages, setThreadMessages] = useState<Record<string, MatchMessage[]>>({});
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});
  // Independent per-card toggles, not an accordion: someone comparing saved
  // jobs - pay, schedule, description - benefits from having more than one
  // open side by side. Collapsed by default so several fit on screen at once.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set());
  // Only mutual WPM matches get a confirmation step, matching the existing
  // "Remove Interest" precedent on the Matches page - a one-sided WPM
  // interest or an external save has no such precedent (external unheart is
  // already instant everywhere else), so those remove immediately.
  const [pendingRemove, setPendingRemove] = useState<SavedListItem | null>(null);

  useEffect(() => {
    async function load() {
      const user = await getCurrentMvpUser("candidate");
      if (!user) {
        window.location.href = "/applicant/login";
        return;
      }

      const [jobs, matches, interests, employerInterests, employerProfiles, savedExternal] = await Promise.all([
        getAllJobs(),
        getMutualMatches(),
        getApplicantInterests(),
        getEmployerInterests(),
        getAllEmployerProfiles(),
        getSavedExternalJobs(user.id)
      ]);

      const userMatches = matches.filter((m) => m.candidateId === user.id);
      const matchedJobIds = new Set(userMatches.map((m) => m.jobId));

      const nextMatchedEntries: MatchedEntry[] = userMatches
        .map((match) => ({ match, job: jobs.find((j) => j.id === match.jobId) }))
        .filter((r): r is MatchedEntry => Boolean(r.job));

      // One-sided interest only - a job that's already mutual belongs in the
      // mutual-match group above, not duplicated down here.
      const nextInterestedEntries: WpmInterestEntry[] = interests
        .filter((i) => i.candidateId === user.id && !matchedJobIds.has(i.jobId))
        .map((i) => ({ interest: i, job: jobs.find((j) => j.id === i.jobId) }))
        .filter((r): r is WpmInterestEntry => Boolean(r.job));

      // Employer-initiated one-sided interest - an employer marked interest in
      // this candidate for one of their jobs, but the candidate hasn't
      // reciprocated yet. Not a "saved" job (the candidate didn't heart it),
      // so this stays its own section rather than folding into Saved Jobs.
      const nextEmployerInterestedEntries: InterestedEntry[] = employerInterests
        .filter((i) => i.candidateId === user.id && !matchedJobIds.has(i.jobId))
        .map((i) => ({ job: jobs.find((j) => j.id === i.jobId) }))
        .filter((r): r is InterestedEntry => Boolean(r.job));

      setCandidateId(user.id);
      setMatchedEntries(nextMatchedEntries);
      setInterestedEntries(nextInterestedEntries);
      setEmployerInterestedEntries(nextEmployerInterestedEntries);
      setExternalSavedJobs(savedExternal);
      setCompanyNames(
        employerProfiles.reduce<Record<string, string>>((acc, profile) => {
          acc[profile.userId] = profile.companyName || "Employer";
          return acc;
        }, {})
      );
      setIsReady(true);

      // One consistent score source for every saved job regardless of type -
      // the AI match_scores system, career mode (the default Job Map mode).
      // Falls back to the WPM match's own stored percent only for mutual
      // matches (which have always shown a number here), so this never
      // regresses an existing badge into "Not yet scored".
      const allJobIds = [
        ...nextMatchedEntries.map((entry) => entry.job.id),
        ...nextInterestedEntries.map((entry) => entry.job.id),
        ...savedExternal.map((saved) => saved.jobId)
      ];
      getCandidateMatchScores(user.id, allJobIds).then(setMatchScores);

      // Eagerly load each matched thread's message history so the
      // "Message"/"Messages" label reflects real history immediately, not
      // just after opening it once.
      const threadResults = await Promise.all(
        nextMatchedEntries.map(async (entry) => ({
          jobId: entry.job.id,
          messages: await refreshMatchThreadMessages({
            applicantId: user.id,
            employerId: entry.match.employerId,
            jobId: entry.job.id
          })
        }))
      );
      setThreadMessages(
        threadResults.reduce<Record<string, MatchMessage[]>>((acc, result) => {
          acc[result.jobId] = result.messages;
          return acc;
        }, {})
      );
    }
    load();
  }, []);

  function getThread(entry: MatchedEntry): MatchThreadContext {
    return {
      applicantId: candidateId,
      employerId: entry.match.employerId,
      jobId: entry.job.id
    };
  }

  const openEntry = matchedEntries.find((entry) => entry.job.id === openMessageJobId) ?? null;

  useMatchThreadRealtime(openEntry ? getThread(openEntry) : null, (message) => {
    if (!openEntry) return;
    setThreadMessages((current) => {
      const existing = current[openEntry.job.id] ?? [];
      if (existing.some((existingMessage) => existingMessage.id === message.id)) {
        return current;
      }
      return { ...current, [openEntry.job.id]: [...existing, message] };
    });
  });

  function toggleExpanded(key: string) {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  async function openMessaging(entry: MatchedEntry) {
    setOpenMessageJobId(entry.job.id);
    setExpandedKeys((current) => new Set(current).add(entry.job.id));
    const messages = await refreshMatchThreadMessages(getThread(entry));
    setThreadMessages((current) => ({ ...current, [entry.job.id]: messages }));
  }

  async function toggleMessaging(entry: MatchedEntry) {
    if (openMessageJobId === entry.job.id) {
      setOpenMessageJobId("");
      return;
    }

    await openMessaging(entry);
  }

  // Notification click-through: a new_message notification deep-links here
  // with matchJobId + openThread=1 so that job's thread is already open,
  // rather than landing on a bare list the candidate has to search.
  useEffect(() => {
    focusFromLocation();
    window.addEventListener("workplace-match-focus-match", focusFromLocation);
    return () => window.removeEventListener("workplace-match-focus-match", focusFromLocation);

    function focusFromLocation() {
      const params = new URLSearchParams(window.location.search);
      const matchJobId = params.get("matchJobId");
      const shouldOpenThread = params.get("openThread") === "1";
      if (!matchJobId || !shouldOpenThread) {
        return;
      }

      const entry = matchedEntries.find((candidateEntry) => candidateEntry.job.id === matchJobId);
      if (entry) {
        openMessaging(entry);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matchedEntries, searchParams]);

  function sendMessage(entry: MatchedEntry) {
    const text = (messageDrafts[entry.job.id] ?? "").trim();
    if (!text) {
      return;
    }

    const message = addMatchThreadMessage({
      ...getThread(entry),
      senderRole: "applicant",
      text
    });

    if (!message) {
      return;
    }

    setThreadMessages((current) => ({
      ...current,
      [entry.job.id]: [...(current[entry.job.id] ?? []), message]
    }));
    setMessageDrafts((current) => ({ ...current, [entry.job.id]: "" }));

    // In-app only: resolved by the employer's real user id, never by email.
    // candidateId/employerId let the notification's click-through deep-link
    // straight to this exact thread.
    addNotificationByUserId({
      recipientUserId: entry.match.employerId,
      type: "new_message",
      title: "New Message",
      message: `New message about ${entry.job.title}.`,
      jobId: entry.job.id,
      jobTitle: entry.job.title,
      candidateId,
      employerId: entry.match.employerId
    });
  }

  function handleUnheartClick(item: SavedListItem) {
    if (item.isMutual) {
      setPendingRemove(item);
      return;
    }
    performUnheart(item);
  }

  async function performUnheart(item: SavedListItem) {
    if (item.isExternal) {
      await deleteSavedExternalJob(candidateId, item.jobId);
      setExternalSavedJobs((current) => current.filter((saved) => saved.jobId !== item.jobId));
    } else if (item.employerId) {
      // Same removeInterest() the Matches page already uses - deletes the
      // interests row and any matches row for this pair, either direction.
      await removeInterest({ fromUserId: candidateId, toUserId: item.employerId, jobId: item.jobId });
      setMatchedEntries((current) => current.filter((entry) => entry.job.id !== item.jobId));
      setInterestedEntries((current) => current.filter((entry) => entry.job.id !== item.jobId));
    }
    setPendingRemove(null);
  }

  if (!isReady) {
    return (
      <section className="mx-auto max-w-5xl px-4 py-12">
        <p className="text-sm text-zinc-600">Loading...</p>
      </section>
    );
  }

  const mutualItems: SavedListItem[] = matchedEntries.map((entry) => ({
    key: entry.job.id,
    jobId: entry.job.id,
    title: entry.job.title,
    company: companyNames[entry.job.employerId] ?? "Employer",
    location: [entry.job.locationCity, entry.job.locationState, entry.job.locationZip].filter(Boolean).join(", "),
    payRange: entry.job.payRange || "Not listed",
    jobType: entry.job.jobType || "Not listed",
    schedule: entry.job.schedule || "Not listed",
    description: entry.job.description,
    matchPercent: matchScores[entry.job.id] ?? entry.match.matchPercent ?? null,
    isMutual: true,
    isExternal: false,
    employerId: entry.match.employerId,
    savedAt: entry.match.createdAt,
    matchedEntry: entry
  }));

  const otherItems: SavedListItem[] = [
    ...interestedEntries.map((entry): SavedListItem => ({
      key: entry.job.id,
      jobId: entry.job.id,
      title: entry.job.title,
      company: companyNames[entry.job.employerId] ?? "Employer",
      location: [entry.job.locationCity, entry.job.locationState, entry.job.locationZip].filter(Boolean).join(", "),
      payRange: entry.job.payRange || "Not listed",
      jobType: entry.job.jobType || "Not listed",
      schedule: entry.job.schedule || "Not listed",
      description: entry.job.description,
      matchPercent: matchScores[entry.job.id] ?? null,
      isMutual: false,
      isExternal: false,
      employerId: entry.job.employerId,
      savedAt: entry.interest.createdAt ?? ""
    })),
    ...externalSavedJobs.map((saved): SavedListItem => ({
      key: `external:${saved.jobId}`,
      jobId: saved.jobId,
      title: saved.title || "Untitled listing",
      company: saved.company || "Company not listed",
      location: saved.location || "Location not listed",
      payRange: formatSavedExternalPay(saved.salaryMin, saved.salaryMax),
      jobType: "Not listed",
      schedule: "Not listed",
      description: "",
      matchPercent: matchScores[saved.jobId] ?? null,
      isMutual: false,
      isExternal: true,
      applyUrl: saved.url,
      savedAt: saved.savedAt
    }))
  ].sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));

  // Mutual matches first (most actionable - messaging lives there), then
  // everything else most-recently-saved first.
  const savedItems: SavedListItem[] = [...mutualItems, ...otherItems];

  const hasAnyEntries = savedItems.length > 0 || employerInterestedEntries.length > 0;

  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <h1 className="text-3xl font-bold text-zinc-950">My Jobs</h1>
        {!hasAnyEntries ? (
          <p className="mt-6 text-sm text-zinc-600">
            Nothing here yet. Start exploring Find Jobs and heart roles that fit.
          </p>
        ) : (
          <div className="mt-6 space-y-8">
            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.12em] text-red-800">Saved Jobs</h2>
              {savedItems.length > 0 ? (
                <div className="mt-4 space-y-4">
                  {savedItems.map((item) => (
                    <SavedJobCard
                      key={item.key}
                      item={item}
                      isExpanded={expandedKeys.has(item.key)}
                      onToggleExpanded={() => toggleExpanded(item.key)}
                      onUnheart={() => handleUnheartClick(item)}
                      isMessagingOpen={item.isMutual && openMessageJobId === item.jobId}
                      messages={item.isMutual ? threadMessages[item.jobId] ?? [] : []}
                      messageDraft={item.isMutual ? messageDrafts[item.jobId] ?? "" : ""}
                      onToggleMessaging={item.matchedEntry ? () => toggleMessaging(item.matchedEntry!) : undefined}
                      onDraftChange={(value) => setMessageDrafts((current) => ({ ...current, [item.jobId]: value }))}
                      onSendMessage={item.matchedEntry ? () => sendMessage(item.matchedEntry!) : undefined}
                    />
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-zinc-600">
                  Nothing saved yet. Heart a job on Find Jobs to save it here.
                </p>
              )}
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold uppercase tracking-[0.12em] text-zinc-700">An Employer Is Interested In You</h2>
                <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs font-bold text-zinc-600">Reciprocate to unlock</span>
              </div>
              {employerInterestedEntries.length > 0 ? (
                <div className="mt-4 space-y-4">
                  {employerInterestedEntries.map((entry) => (
                    <EmployerInterestCard
                      key={entry.job.id}
                      job={entry.job}
                      companyName={companyNames[entry.job.employerId] ?? "Employer"}
                      isExpanded={expandedKeys.has(`employer-interest:${entry.job.id}`)}
                      onToggleExpanded={() => toggleExpanded(`employer-interest:${entry.job.id}`)}
                    />
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-zinc-600">
                  No employer has marked interest in you yet - this shows up here the moment one does.
                </p>
              )}
            </div>
          </div>
        )}
      </div>

      {pendingRemove ? (
        <RemoveInterestConfirmationModal
          onCancel={() => setPendingRemove(null)}
          onConfirm={() => performUnheart(pendingRemove)}
        />
      ) : null}
    </section>
  );
}

// saved_jobs stores only salary_min/salary_max, no pay_type and no listing
// description to re-derive one from - so this is a simple heuristic
// (< $1000 reads as hourly), not the fuller Adzuna/Muse/USAJobs-aware
// resolution Job Map does. Deliberately not re-resolving the listing here
// (see "use the stored values" in the task this shipped with).
function formatSavedExternalPay(salaryMin: number | null, salaryMax: number | null): string {
  const min = salaryMin ?? salaryMax;
  const max = salaryMax ?? salaryMin;
  if (min === null || min === undefined || !Number.isFinite(min) || min <= 0) {
    return "Not listed";
  }
  const isHourly = min < 1000;
  const format = (value: number) => (isHourly ? `$${Math.round(value)}/hr` : `$${Math.round(value).toLocaleString("en-US")}/yr`);
  if (max && max !== min) {
    return `${format(min)} - ${format(max)}`;
  }
  return format(min);
}

function StatusChip({ label, tone }: { label: string; tone: "red" | "zinc" }) {
  const classes = tone === "red" ? "bg-red-100 text-red-800" : "bg-zinc-100 text-zinc-600";
  return <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${classes}`}>{label}</span>;
}

function SavedJobCard({
  item,
  isExpanded,
  onToggleExpanded,
  onUnheart,
  isMessagingOpen = false,
  messages = [],
  messageDraft = "",
  onToggleMessaging,
  onDraftChange,
  onSendMessage
}: {
  item: SavedListItem;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  onUnheart: () => void;
  isMessagingOpen?: boolean;
  messages?: MatchMessage[];
  messageDraft?: string;
  onToggleMessaging?: () => void;
  onDraftChange?: (value: string) => void;
  onSendMessage?: () => void;
}) {
  const scrollRef = useAutoScrollToBottom(`${isMessagingOpen}:${messages.length}`);

  return (
    <article className={`rounded-lg border ${item.isMutual ? "border-red-200 bg-red-50/40" : "border-gray-200 bg-white"}`}>
      <div className="flex items-start justify-between gap-3 p-5">
        <button type="button" onClick={onToggleExpanded} className="flex min-w-0 flex-1 items-start gap-3 text-left">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-lg font-bold text-zinc-950">{item.title}</h3>
            <p className="mt-1 truncate text-sm text-zinc-600">{item.company}</p>
          </div>
          <ChevronDown
            className={`mt-1 h-5 w-5 shrink-0 text-zinc-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <div className="flex items-center gap-2">
            {item.isMutual ? <StatusChip label="Mutual match" tone="red" /> : null}
            {item.isExternal ? <StatusChip label="External listing" tone="zinc" /> : null}
            <button
              type="button"
              onClick={onUnheart}
              aria-label="Remove from saved jobs"
              className="text-red-700 transition hover:text-red-900"
            >
              <Heart className="h-5 w-5 fill-current" aria-hidden="true" />
            </button>
          </div>
          {item.matchPercent !== null ? (
            <span className="rounded-full bg-red-900 px-3 py-1 text-xs font-bold text-white">{item.matchPercent}% match</span>
          ) : (
            <span className="text-xs font-semibold text-zinc-400">Not yet scored</span>
          )}
        </div>
      </div>
      {isExpanded ? (
        <div className="px-5 pb-5">
          <p className="text-sm text-zinc-600">{item.location}</p>
          <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
            <InfoCard label="Pay range" value={item.payRange} />
            <InfoCard label="Job type" value={item.jobType} />
            <InfoCard label="Schedule" value={item.schedule} />
          </div>
          {item.description ? <p className="mt-4 text-sm leading-6 text-zinc-700">{item.description}</p> : null}

          {item.isExternal ? (
            <div className="mt-4">
              {item.applyUrl ? (
                <a
                  href={item.applyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md bg-red-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
                >
                  Apply externally
                  <ExternalLink className="h-4 w-4" aria-hidden="true" />
                </a>
              ) : (
                <p className="text-sm text-zinc-500">No application link available.</p>
              )}
            </div>
          ) : item.isMutual ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <button type="button" className="rounded-md bg-green-700 px-3 py-2 text-sm font-semibold text-white">
                Reach Out
              </button>
              <button
                type="button"
                onClick={onToggleMessaging}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700"
              >
                {getMessageButtonLabel(messages.length > 0)}
              </button>
            </div>
          ) : null}

          {item.isMutual && isMessagingOpen ? (
            <div className="mt-3 space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3">
              <div ref={scrollRef} className="max-h-40 space-y-1.5 overflow-y-auto text-sm">
                {messages.length > 0 ? (
                  messages.map((message) => {
                    const isOwn = message.senderRole === "applicant";
                    return (
                      <div key={message.id} className={`flex ${isOwn ? "justify-end" : "justify-start"}`}>
                        <div
                          className={`max-w-[80%] rounded-lg px-2.5 py-1.5 ${
                            isOwn ? "bg-red-900 text-white" : "border border-gray-200 bg-white text-zinc-900"
                          }`}
                        >
                          <p className="whitespace-pre-wrap break-words">{message.text}</p>
                          <p className={`mt-0.5 text-[10px] ${isOwn ? "text-red-200" : "text-zinc-400"}`}>
                            {formatMessageTimestamp(message.createdAt)}
                          </p>
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p className="text-zinc-700">No messages yet.</p>
                )}
              </div>
              <textarea
                value={messageDraft}
                onChange={(event) => onDraftChange?.(event.target.value)}
                rows={2}
                className="field"
                placeholder="Write a message..."
              />
              <button
                type="button"
                onClick={onSendMessage}
                className="w-full rounded-md bg-red-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
              >
                Send message
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function EmployerInterestCard({
  job,
  companyName,
  isExpanded,
  onToggleExpanded
}: {
  job: MvpJobListing;
  companyName: string;
  isExpanded: boolean;
  onToggleExpanded: () => void;
}) {
  return (
    <article className="rounded-lg border border-gray-200 bg-white">
      <button type="button" onClick={onToggleExpanded} className="flex w-full items-start justify-between gap-3 p-5 text-left">
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-lg font-bold text-zinc-950">{job.title}</h3>
          <p className="mt-1 truncate text-sm text-zinc-600">{companyName}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-800">&hearts; Employer interested</span>
          <ChevronDown
            className={`h-5 w-5 text-zinc-400 transition-transform ${isExpanded ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </div>
      </button>
      {isExpanded ? (
        <div className="px-5 pb-5">
          <p className="text-sm text-zinc-600">
            {[job.locationCity, job.locationState, job.locationZip].filter(Boolean).join(", ")}
          </p>
          <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
            <InfoCard label="Pay range" value={job.payRange || "Not listed"} />
            <InfoCard label="Job type" value={job.jobType || "Not listed"} />
            <InfoCard label="Schedule" value={job.schedule || "Not listed"} />
          </div>
          <p className="mt-4 text-sm leading-6 text-zinc-700">{job.description}</p>
        </div>
      ) : null}
    </article>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-1 font-semibold text-zinc-950">{value}</p>
    </div>
  );
}
