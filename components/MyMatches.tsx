"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { attemptPreferredContact } from "../lib/contactPreferences";
import { logAdminEvent } from "../lib/adminEvents";
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
  getAllApplicantProfiles,
  getAllJobs,
  getApplicantInterests,
  getCurrentMvpUser,
  getEmployerMatchScores,
  getEmployerProfile,
  getMutualMatches,
  removeInterest,
  type MvpApplicantProfile,
  type MvpJobListing,
  type MvpMatch
} from "../lib/supabaseMvpData";
import { RemoveInterestConfirmationModal } from "./RemoveInterestConfirmationModal";
import { EmployerFacingSummary } from "./EmployerFacingSummary";

type Role = "candidate" | "employer";
type MatchRecord = {
  key: string;
  job: MvpJobListing;
  match: MvpMatch;
  candidateProfile?: MvpApplicantProfile;
};

// Employer-only: a candidate who has expressed interest in one of this
// employer's jobs, but there's no mutual match yet. Privacy: only fields
// already visible pre-mutual-match on Find Applicants are read here -
// zipCode and a computed match % - fullName and candidateEmail are
// deliberately never read into this record at all, so there's nothing to
// accidentally render. No experienceLevel: a self-selected tier with no
// evidence behind it is not shown to an employer at any stage, matched or not.
// No skill chips or capability entries either: employers see the employer
// summary only, and they see it at every stage including this one - it is
// identity-blind by design (decision 2026-10-22).
type PendingInterestRecord = {
  key: string;
  job: MvpJobListing;
  candidateId: string;
  zipCode: string;
  employerSummary: string;
  matchPercent: number | null;
};

export function MyMatches({ role }: { role: Role }) {
  const searchParams = useSearchParams();
  const [userId, setUserId] = useState("");
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [pendingInterests, setPendingInterests] = useState<PendingInterestRecord[]>([]);
  const [expandedMatchKey, setExpandedMatchKey] = useState("");
  const [expandedPendingKey, setExpandedPendingKey] = useState("");
  // Employer side: the job description in an opened match is collapsed to one
  // line until asked for.
  const [openJobDescriptionKey, setOpenJobDescriptionKey] = useState("");
  const [pendingRemoveInterest, setPendingRemoveInterest] = useState<MatchRecord | null>(null);
  const [privateNotes, setPrivateNotes] = useState<Record<string, string>>({});
  const [openMessageKey, setOpenMessageKey] = useState("");
  const [threadMessages, setThreadMessages] = useState<Record<string, MatchMessage[]>>({});
  const [messageDrafts, setMessageDrafts] = useState<Record<string, string>>({});

  // Notification click-through: land directly on the relevant record rather
  // than a bare list. Checks the mutual list first, then the one-sided
  // pending-interest list, since a matchJobId can be either depending on
  // which notification was clicked.
  useEffect(() => {
    focusFromLocation();
    window.addEventListener("workplace-match-focus-match", focusFromLocation);
    return () => window.removeEventListener("workplace-match-focus-match", focusFromLocation);

    function focusFromLocation() {
      const params = new URLSearchParams(window.location.search);
      const matchJobId = params.get("matchJobId");
      const candidateIdParam = params.get("candidateId");
      const shouldOpenThread = params.get("openThread") === "1";
      if (!matchJobId) {
        return;
      }

      const matchedRecord = matches.find(
        (record) => record.job.id === matchJobId && (!candidateIdParam || record.match.candidateId === candidateIdParam)
      );
      if (matchedRecord) {
        setExpandedMatchKey(matchedRecord.key);
        // A new_message notification deep-links here with openThread=1 so the
        // thread is already open, not just the record expanded.
        if (shouldOpenThread) {
          openMessaging(matchedRecord);
        }
        return;
      }

      const pendingRecord = pendingInterests.find((record) => record.job.id === matchJobId);
      if (pendingRecord) {
        setExpandedPendingKey(pendingRecord.key);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches, pendingInterests, searchParams]);

  useEffect(() => {
    loadMatches();

    async function loadMatches() {
      const user = await getCurrentMvpUser(role);
      if (!user) {
        window.location.href = role === "employer" ? "/employer/login" : "/applicant/login";
        return;
      }

      // Candidate profiles are employer-only data (api/mvp/read refuses them
      // to candidates with a 403) and are only rendered in the employer branch
      // below, so a candidate never requests them.
      const [jobs, mutualMatches, candidateProfiles, applicantInterests, employerScores] = await Promise.all([
        getAllJobs(),
        getMutualMatches(),
        role === "employer" ? getAllApplicantProfiles() : Promise.resolve([]),
        role === "employer" ? getApplicantInterests() : Promise.resolve([]),
        role === "employer"
          ? getEmployerMatchScores().catch((err) => {
              console.error("[MyMatches] stored match scores failed to load", err);
              return {} as Record<string, number>;
            })
          : Promise.resolve({} as Record<string, number>)
      ]);
      const scopedMatches = mutualMatches.filter((match) =>
        role === "employer" ? match.employerId === user.id : match.candidateId === user.id
      );

      const nextMatches = scopedMatches
        .map((match) => {
          const job = jobs.find((storedJob) => storedJob.id === match.jobId);
          if (!job) {
            return null;
          }

          return {
            key: `${match.employerId}:${match.jobId}:${match.candidateId}`,
            job,
            match,
            candidateProfile: candidateProfiles.find((profile) => profile.userId === match.candidateId)
          };
        })
        .filter(Boolean) as MatchRecord[];

      setUserId(user.id);
      setMatches(nextMatches);

      // Eagerly load each thread's message history (not just on open) so the
      // "Message"/"Messages" button label reflects real history from the
      // start, instead of only flipping after the user opens a thread once.
      const threadResults = await Promise.all(
        nextMatches.map(async (record) => ({
          key: record.key,
          messages: await refreshMatchThreadMessages({
            applicantId: record.match.candidateId,
            employerId: record.match.employerId,
            jobId: record.job.id
          })
        }))
      );
      setThreadMessages(
        threadResults.reduce<Record<string, MatchMessage[]>>((acc, result) => {
          acc[result.key] = result.messages;
          return acc;
        }, {})
      );

      // The employer summary's render-time identity check (defense in depth
      // against rows stored before a guard fix) lives in EmployerFacingSummary,
      // which every employer-facing summary on this page renders through.
      if (role === "employer") {
        const mutualPairKeys = new Set(scopedMatches.map((match) => `${match.jobId}:${match.candidateId}`));

        setPendingInterests(
          applicantInterests
            .filter((interest) => interest.employerId === user.id && !mutualPairKeys.has(`${interest.jobId}:${interest.candidateId}`))
            .map((interest) => {
              const job = jobs.find((storedJob) => storedJob.id === interest.jobId);
              const candidateProfile = candidateProfiles.find((profile) => profile.userId === interest.candidateId);
              if (!job) {
                return null;
              }

              // The stored employer-direction AI score; null when this
              // candidate was never scored for this job (shown as "Not yet
              // scored", never 0%).
              const matchPercent = employerScores[`${interest.jobId}:${interest.candidateId}`] ?? null;

              return {
                key: `${interest.employerId}:${interest.jobId}:${interest.candidateId}`,
                job,
                candidateId: interest.candidateId,
                zipCode: candidateProfile?.zipCode || "",
                employerSummary: candidateProfile?.employerSummary ?? "",
                matchPercent
              };
            })
            .filter(Boolean) as PendingInterestRecord[]
        );
      }
    }
  }, [role]);

  function reachOut(record: MatchRecord) {
    if (role === "employer") {
      // Never hand the candidate's actual email to the employer's device (a
      // mailto: navigation would expose it, and email addresses are
      // identifying) - match_messages is the only sanctioned contact channel
      // an employer gets post-match.
      const message = addMatchThreadMessage({
        ...getThread(record),
        senderRole: "employer",
        text: "Let's schedule a time to connect about this match."
      });
      if (message) {
        setThreadMessages((current) => ({ ...current, [record.key]: [...(current[record.key] ?? []), message] }));
        // In-app only: resolved by the candidate's real user id, never by
        // email. candidateId/employerId let the notification's click-through
        // deep-link straight to this exact thread.
        addNotificationByUserId({
          recipientUserId: record.match.candidateId,
          type: "new_message",
          title: "New Message",
          message: `New message about ${record.job.title}.`,
          jobId: record.job.id,
          jobTitle: record.job.title,
          candidateId: record.match.candidateId,
          employerId: record.match.employerId
        });
      }
      setOpenMessageKey(record.key);
    } else {
      // The company side is already public, so handing the employer's
      // contact info to the candidate is fine.
      attemptPreferredContact({
        targetAccount: { email: record.job.employerEmail },
        senderLabel: "A mutual match",
        jobTitle: record.job.title
      });
    }
    logAdminEvent({
      type: "reach_out_clicked",
      userRole: role === "employer" ? "employer" : "candidate",
      jobId: record.job.id,
      applicantId: record.match.candidateId,
      employerId: record.match.employerId
    });
  }

  function getThread(record: MatchRecord): MatchThreadContext {
    return {
      applicantId: record.match.candidateId,
      employerId: record.match.employerId,
      jobId: record.job.id
    };
  }

  const openRecord = matches.find((record) => record.key === openMessageKey) ?? null;

  // Only the currently open thread subscribes - passing null while nothing's
  // open (and on every thread switch) unsubscribes the previous one.
  useMatchThreadRealtime(openRecord ? getThread(openRecord) : null, (message) => {
    if (!openRecord) return;
    setThreadMessages((current) => {
      const existing = current[openRecord.key] ?? [];
      if (existing.some((existingMessage) => existingMessage.id === message.id)) {
        return current;
      }
      return { ...current, [openRecord.key]: [...existing, message] };
    });
  });

  // Trigger changes on open, on send (threadMessages updates immediately via
  // the optimistic append), and on realtime arrival (same state update) - all
  // three funnel through this one dependency.
  const scrollRef = useAutoScrollToBottom(
    `${openMessageKey}:${(threadMessages[openMessageKey] ?? []).length}`
  );

  async function openMessaging(record: MatchRecord) {
    setOpenMessageKey(record.key);
    const messages = await refreshMatchThreadMessages(getThread(record));
    setThreadMessages((current) => ({ ...current, [record.key]: messages }));
  }

  async function toggleMessaging(record: MatchRecord) {
    if (openMessageKey === record.key) {
      setOpenMessageKey("");
      return;
    }

    await openMessaging(record);
  }

  function sendMatchMessage(record: MatchRecord) {
    const text = (messageDrafts[record.key] ?? "").trim();
    if (!text) {
      return;
    }

    const message = addMatchThreadMessage({
      ...getThread(record),
      senderRole: role === "employer" ? "employer" : "applicant",
      text
    });

    if (!message) {
      return;
    }

    setThreadMessages((current) => ({ ...current, [record.key]: [...(current[record.key] ?? []), message] }));
    setMessageDrafts((current) => ({ ...current, [record.key]: "" }));

    // In-app only: resolved by the recipient's real user id, never by email.
    // candidateId/employerId let the notification's click-through deep-link
    // straight to this exact thread.
    addNotificationByUserId({
      recipientUserId: role === "employer" ? record.match.candidateId : record.match.employerId,
      type: "new_message",
      title: "New Message",
      message: `New message about ${record.job.title}.`,
      jobId: record.job.id,
      jobTitle: record.job.title,
      candidateId: record.match.candidateId,
      employerId: record.match.employerId
    });
  }

  async function removeMatchInterest(record: MatchRecord) {
    const toUserId = role === "employer" ? record.match.candidateId : record.match.employerId;
    await removeInterest({ fromUserId: userId, toUserId, jobId: record.job.id });
    logAdminEvent({
      type: "interest_removed",
      userRole: role === "employer" ? "employer" : "candidate",
      jobId: record.job.id,
      applicantId: record.match.candidateId,
      employerId: record.match.employerId
    });
    setMatches((current) => current.filter((storedRecord) => storedRecord.key !== record.key));
    setPendingRemoveInterest(null);
  }

  return (
    <>
      <section className="mx-auto max-w-5xl px-4 py-12">
        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">My Matches</p>
            <h1 className="mt-2 text-3xl font-bold text-zinc-950">
              {role === "employer" ? "Matched applicants" : "Matched jobs"}
            </h1>
          </div>

          <div className="mt-6 space-y-3">
            {matches.length > 0 ? (
              matches.map((record) => {
                const isExpanded = expandedMatchKey === record.key;
                return (
                  <article key={record.key} className="overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
                    <button
                      type="button"
                      onClick={() => setExpandedMatchKey(isExpanded ? "" : record.key)}
                      className="flex w-full items-center justify-between gap-3 bg-white p-4 text-left transition hover:bg-gray-50"
                    >
                      <span className="font-bold text-zinc-950">{record.job.title}</span>
                      {record.match.matchPercent !== null ? (
                        <span className="rounded-full bg-red-900 px-3 py-1 text-xs font-bold text-white">{record.match.matchPercent}%</span>
                      ) : (
                        <span className="text-xs font-semibold text-zinc-400">Not yet scored</span>
                      )}
                    </button>
                    {isExpanded ? (
                      <div className="space-y-4 p-4">
                        {role === "employer" ? (
                          <div className="space-y-3">
                            {/* Mutual match unlocks fuller CAPABILITY detail only - never
                                identity. Workplace Match never discloses name, pronouns,
                                employer names, branch, rank, clearance, dates/year counts,
                                publications, or locations served to an employer, at any
                                tier. employerSummary is the only summary field this block
                                may render, and it is the ONLY capability content an
                                employer sees (no skill chips or capability entries) -
                                see PendingInterestRecord above for the pre-match field
                                allowlist. */}
                            <div className="rounded-md border border-red-100 bg-red-50 p-3">
                              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-red-800">Mutual match unlocked</p>
                              <p className="mt-1 text-sm font-bold text-zinc-950">Matched candidate</p>
                              <div className="mt-1">
                                <EmployerFacingSummary
                                  candidateId={record.match.candidateId}
                                  text={record.candidateProfile?.employerSummary}
                                  route="MyMatches"
                                  collapsible={false}
                                />
                              </div>
                            </div>
                          </div>
                        ) : null}
                        {role === "employer" ? (
                          // Employer side leads with the candidate: the job is
                          // one line, its description on demand.
                          <div className="text-sm">
                            <p className="text-zinc-700">
                              <span className="font-semibold text-zinc-950">{record.job.title}</span>
                              {[
                                [record.job.locationCity, record.job.locationState, record.job.locationZip].filter(Boolean).join(", "),
                                record.job.payRange || "Pay not listed"
                              ]
                                .filter(Boolean)
                                .map((part) => ` · ${part}`)
                                .join("")}
                            </p>
                            {record.job.description ? (
                              <>
                                <button
                                  type="button"
                                  onClick={() => setOpenJobDescriptionKey(openJobDescriptionKey === record.key ? "" : record.key)}
                                  className="mt-1 text-xs font-semibold text-red-800 transition hover:underline"
                                >
                                  {openJobDescriptionKey === record.key ? "Hide job description" : "View job description"}
                                </button>
                                {openJobDescriptionKey === record.key ? (
                                  <p className="mt-2 text-sm leading-6 text-zinc-700">{record.job.description}</p>
                                ) : null}
                              </>
                            ) : null}
                          </div>
                        ) : (
                          <>
                            <div className="grid gap-3 text-sm md:grid-cols-3">
                              <Detail label="Job" value={record.job.title} />
                              <Detail label="Location" value={[record.job.locationCity, record.job.locationState, record.job.locationZip].filter(Boolean).join(", ")} />
                              <Detail label="Pay" value={record.job.payRange || "Not listed"} />
                            </div>
                            <p className="text-sm leading-6 text-zinc-700">{record.job.description}</p>
                          </>
                        )}
                        <div>
                          <label className="label" htmlFor={`note-${record.key}`}>Private notes</label>
                          <textarea
                            id={`note-${record.key}`}
                            value={privateNotes[record.key] ?? ""}
                            onChange={(event) => setPrivateNotes((current) => ({ ...current, [record.key]: event.target.value }))}
                            className="field mt-2"
                            rows={3}
                          />
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button type="button" onClick={() => reachOut(record)} className="rounded-md bg-green-700 px-3 py-2 text-sm font-semibold text-white">Reach Out</button>
                          <button type="button" onClick={() => toggleMessaging(record)} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700">
                            {getMessageButtonLabel((threadMessages[record.key] ?? []).length > 0)}
                          </button>
                          <button type="button" onClick={() => setPendingRemoveInterest(record)} className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">Remove Interest</button>
                        </div>
                        {openMessageKey === record.key ? (
                          <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3">
                            <div ref={scrollRef} className="max-h-40 space-y-1.5 overflow-y-auto text-sm">
                              {(threadMessages[record.key] ?? []).length > 0 ? (
                                (threadMessages[record.key] ?? []).map((message) => {
                                  const isOwn = (message.senderRole === "employer") === (role === "employer");
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
                              value={messageDrafts[record.key] ?? ""}
                              onChange={(event) => setMessageDrafts((current) => ({ ...current, [record.key]: event.target.value }))}
                              rows={2}
                              className="field"
                              placeholder="Write a message..."
                            />
                            <button
                              type="button"
                              onClick={() => sendMatchMessage(record)}
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
              })
            ) : (
              <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-5">
                <p className="text-sm font-semibold text-zinc-950">No matches yet</p>
              </div>
            )}
          </div>
        </div>
      </section>

      {role === "employer" ? (
        <section className="mx-auto max-w-5xl px-4 pb-12">
          <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-soft">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.16em] text-red-800">Worth a look</p>
              <h2 className="mt-2 text-2xl font-bold text-zinc-950">Candidates interested in you</h2>
              <p className="mt-2 text-sm leading-6 text-zinc-600">
                These candidates expressed interest in one of your listings, but it&apos;s not mutual yet - mark
                interest back on Find Applicants to unlock full profile details.
              </p>
            </div>

            <div className="mt-6 space-y-3">
              {pendingInterests.length > 0 ? (
                pendingInterests.map((record) => {
                  const isExpanded = expandedPendingKey === record.key;
                  return (
                    <article key={record.key} className="overflow-hidden rounded-lg border border-gray-200 bg-gray-50">
                      <button
                        type="button"
                        onClick={() => setExpandedPendingKey(isExpanded ? "" : record.key)}
                        className="flex w-full items-center justify-between gap-3 bg-white p-4 text-left transition hover:bg-gray-50"
                      >
                        <span className="font-bold text-zinc-950">{record.job.title}</span>
                        <span className="flex items-center gap-2">
                          <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">&hearts; Interested</span>
                          {record.matchPercent !== null ? (
                            <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs font-bold text-white">{record.matchPercent}%</span>
                          ) : (
                            <span className="text-xs font-semibold text-zinc-400">Not yet scored</span>
                          )}
                        </span>
                      </button>
                      {isExpanded ? (
                        <div className="space-y-3 p-4">
                          <div className="grid gap-3 text-sm">
                            <Detail label="Applicant area" value={record.zipCode || "Generalized ZIP area"} />
                          </div>
                          <EmployerFacingSummary candidateId={record.candidateId} text={record.employerSummary} route="MyMatches" />
                          <p className="text-xs text-zinc-500">
                            Mark interest back on Find Applicants to make this a mutual match and start messaging.
                          </p>
                        </div>
                      ) : null}
                    </article>
                  );
                })
              ) : (
                <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-5">
                  <p className="text-sm font-semibold text-zinc-950">No one-sided interest yet</p>
                </div>
              )}
            </div>
          </div>
        </section>
      ) : null}

      {pendingRemoveInterest ? (
        <RemoveInterestConfirmationModal
          onCancel={() => setPendingRemoveInterest(null)}
          onConfirm={() => {
            removeMatchInterest(pendingRemoveInterest);
          }}
        />
      ) : null}
    </>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-gray-200 bg-white p-3">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className="mt-1 font-semibold text-zinc-950">{value || "Not listed"}</p>
    </div>
  );
}
