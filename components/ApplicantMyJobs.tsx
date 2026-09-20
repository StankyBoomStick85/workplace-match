"use client";

import { useEffect, useState } from "react";
import { addMatchThreadMessage, refreshMatchThreadMessages, type MatchMessage, type MatchThreadContext } from "../lib/matchMessages";
import {
  addNotificationByUserId,
  getAllJobs,
  getApplicantInterests,
  getCurrentMvpUser,
  getEmployerInterests,
  getMutualMatches,
  type MvpJobListing,
  type MvpMatch
} from "../lib/supabaseMvpData";

type MatchedEntry = { job: MvpJobListing; match: MvpMatch };
type InterestedEntry = { job: MvpJobListing };

export function ApplicantMyJobs() {
  const [matchedEntries, setMatchedEntries] = useState<MatchedEntry[]>([]);
  const [interestedEntries, setInterestedEntries] = useState<InterestedEntry[]>([]);
  const [employerInterestedEntries, setEmployerInterestedEntries] = useState<InterestedEntry[]>([]);
  const [isReady, setIsReady] = useState(false);
  const [candidateId, setCandidateId] = useState("");
  const [openMessageJobId, setOpenMessageJobId] = useState("");
  const [threadMessages, setThreadMessages] = useState<Record<string, MatchMessage[]>>({});
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    async function load() {
      const user = await getCurrentMvpUser("candidate");
      if (!user) {
        window.location.href = "/applicant/login";
        return;
      }

      const [jobs, matches, interests, employerInterests] = await Promise.all([
        getAllJobs(),
        getMutualMatches(),
        getApplicantInterests(),
        getEmployerInterests()
      ]);

      const userMatches = matches.filter((m) => m.candidateId === user.id);
      const matchedJobIds = new Set(userMatches.map((m) => m.jobId));

      const nextMatchedEntries: MatchedEntry[] = userMatches
        .map((match) => ({ match, job: jobs.find((j) => j.id === match.jobId) }))
        .filter((r): r is MatchedEntry => Boolean(r.job));

      // One-sided interest only - a job that's already mutual belongs in the
      // Mutual Matches section above, not duplicated down here.
      const nextInterestedEntries: InterestedEntry[] = interests
        .filter((i) => i.candidateId === user.id && !matchedJobIds.has(i.jobId))
        .map((i) => ({ job: jobs.find((j) => j.id === i.jobId) }))
        .filter((r): r is InterestedEntry => Boolean(r.job));

      // Employer-initiated one-sided interest - an employer marked interest in
      // this candidate for one of their jobs, but the candidate hasn't
      // reciprocated yet. This is the reciprocal half of the interest loop:
      // without this section a candidate has no way to ever learn about it.
      const nextEmployerInterestedEntries: InterestedEntry[] = employerInterests
        .filter((i) => i.candidateId === user.id && !matchedJobIds.has(i.jobId))
        .map((i) => ({ job: jobs.find((j) => j.id === i.jobId) }))
        .filter((r): r is InterestedEntry => Boolean(r.job));

      setCandidateId(user.id);
      setMatchedEntries(nextMatchedEntries);
      setInterestedEntries(nextInterestedEntries);
      setEmployerInterestedEntries(nextEmployerInterestedEntries);
      setIsReady(true);
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

  async function toggleMessaging(entry: MatchedEntry) {
    if (openMessageJobId === entry.job.id) {
      setOpenMessageJobId("");
      return;
    }

    setOpenMessageJobId(entry.job.id);
    const messages = await refreshMatchThreadMessages(getThread(entry));
    setThreadMessages((current) => ({ ...current, [entry.job.id]: messages }));
  }

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
    addNotificationByUserId({
      recipientUserId: entry.match.employerId,
      type: "new_message",
      title: "New Message",
      message: `New message about ${entry.job.title}.`,
      jobId: entry.job.id,
      jobTitle: entry.job.title
    });
  }

  if (!isReady) {
    return (
      <section className="mx-auto max-w-5xl px-4 py-12">
        <p className="text-sm text-zinc-600">Loading...</p>
      </section>
    );
  }

  const hasAnyEntries =
    matchedEntries.length > 0 || interestedEntries.length > 0 || employerInterestedEntries.length > 0;

  return (
    <section className="mx-auto max-w-5xl px-4 py-12">
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
        <h1 className="text-3xl font-bold text-zinc-950">My Jobs</h1>
        {!hasAnyEntries ? (
          <p className="mt-6 text-sm text-zinc-600">
            Nothing here yet. Start exploring the Job Map and click interest on roles that fit.
          </p>
        ) : (
          <div className="mt-6 space-y-8">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold uppercase tracking-[0.12em] text-red-800">Mutual Matches</h2>
                <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                  Both sides are interested
                </span>
              </div>
              {matchedEntries.length > 0 ? (
                <div className="mt-4 space-y-4">
                  {matchedEntries.map((entry) => (
                    <JobCard
                      key={entry.job.id}
                      job={entry.job}
                      badge={<MatchBadge percent={entry.match.matchPercent} />}
                      isMutual
                      isMessagingOpen={openMessageJobId === entry.job.id}
                      messages={threadMessages[entry.job.id] ?? []}
                      messageDraft={messageDrafts[entry.job.id] ?? ""}
                      onToggleMessaging={() => toggleMessaging(entry)}
                      onDraftChange={(value) => setMessageDrafts((current) => ({ ...current, [entry.job.id]: value }))}
                      onSendMessage={() => sendMessage(entry)}
                    />
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-zinc-600">
                  No mutual matches yet - these appear once an employer you&apos;re interested in is interested back.
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
                    <JobCard key={entry.job.id} job={entry.job} badge={<EmployerInterestedBadge />} />
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-zinc-600">
                  No employer has marked interest in you yet - this shows up here the moment one does.
                </p>
              )}
            </div>

            <div>
              <h2 className="text-sm font-bold uppercase tracking-[0.12em] text-zinc-500">Jobs You&apos;re Interested In</h2>
              {interestedEntries.length > 0 ? (
                <div className="mt-4 space-y-4">
                  {interestedEntries.map((entry) => (
                    <JobCard key={entry.job.id} job={entry.job} badge={<InterestedBadge />} />
                  ))}
                </div>
              ) : (
                <p className="mt-3 text-sm text-zinc-600">
                  Nothing here yet. Jobs you mark interest in show up here until the employer reciprocates.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function MatchBadge({ percent }: { percent: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="rounded-full bg-red-900 px-2.5 py-0.5 text-xs font-bold text-white">MATCH</span>
      <span className="rounded-full bg-red-900 px-3 py-1 text-xs font-bold text-white">{percent}%</span>
    </span>
  );
}

function InterestedBadge() {
  return (
    <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-bold text-zinc-600">Interested</span>
  );
}

function EmployerInterestedBadge() {
  return (
    <span className="rounded-full bg-red-100 px-3 py-1 text-xs font-bold text-red-800">&hearts; Employer interested</span>
  );
}

function JobCard({
  job,
  badge,
  isMutual = false,
  isMessagingOpen = false,
  messages = [],
  messageDraft = "",
  onToggleMessaging,
  onDraftChange,
  onSendMessage
}: {
  job: MvpJobListing;
  badge: React.ReactNode;
  isMutual?: boolean;
  isMessagingOpen?: boolean;
  messages?: MatchMessage[];
  messageDraft?: string;
  onToggleMessaging?: () => void;
  onDraftChange?: (value: string) => void;
  onSendMessage?: () => void;
}) {
  return (
    <article
      className={`rounded-lg border p-5 ${
        isMutual ? "border-red-200 bg-red-50/40" : "border-gray-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-zinc-950">{job.title}</h3>
          <p className="mt-1 text-sm text-zinc-600">
            {[job.locationCity, job.locationState, job.locationZip].filter(Boolean).join(", ")}
          </p>
        </div>
        {badge}
      </div>
      <div className="mt-4 grid gap-3 text-sm md:grid-cols-3">
        <InfoCard label="Pay range" value={job.payRange || "Not listed"} />
        <InfoCard label="Job type" value={job.jobType || "Not listed"} />
        <InfoCard label="Schedule" value={job.schedule || "Not listed"} />
      </div>
      <p className="mt-4 text-sm leading-6 text-zinc-700">{job.description}</p>
      {isMutual ? (
        <div className="mt-4 flex flex-wrap gap-2">
          <button type="button" className="rounded-md bg-green-700 px-3 py-2 text-sm font-semibold text-white">
            Reach Out
          </button>
          <button
            type="button"
            onClick={onToggleMessaging}
            className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700"
          >
            Message
          </button>
        </div>
      ) : null}
      {isMutual && isMessagingOpen ? (
        <div className="mt-3 space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3">
          <div className="max-h-40 space-y-1 overflow-y-auto text-sm text-zinc-700">
            {messages.length > 0 ? (
              messages.map((message) => (
                <p key={message.id} className="rounded bg-white px-2 py-1">
                  <span className="font-semibold">{message.senderRole === "applicant" ? "You" : "Them"}:</span>{" "}
                  {message.text}
                </p>
              ))
            ) : (
              <p>No messages yet.</p>
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
