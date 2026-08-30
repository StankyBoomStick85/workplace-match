"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { attemptPreferredContact } from "../lib/contactPreferences";
import { logAdminEvent } from "../lib/adminEvents";
import { logError } from "../lib/logError";
import { scanEmployerFacingText, formatViolations } from "../lib/employerTextGuard";
import { addMatchThreadMessage, refreshMatchThreadMessages, type MatchMessage, type MatchThreadContext } from "../lib/matchMessages";
import { calculateSkillMatch, getApplicantMatchSignals } from "../lib/skillMatch";
import {
  getAllApplicantProfiles,
  getAllJobs,
  getApplicantInterests,
  getCurrentMvpUser,
  getEmployerProfile,
  getMutualMatches,
  removeInterest,
  type MvpApplicantProfile,
  type MvpJobListing,
  type MvpMatch
} from "../lib/supabaseMvpData";
import { RemoveInterestConfirmationModal } from "./RemoveInterestConfirmationModal";

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
// zipCode, topSkills, experienceLevel, a computed match % - fullName and
// candidateEmail are deliberately never read into this record at all, so
// there's nothing to accidentally render.
type PendingInterestRecord = {
  key: string;
  job: MvpJobListing;
  zipCode: string;
  topSkills: string[];
  experienceLevel: string;
  matchPercent: number;
};

export function MyMatches({ role }: { role: Role }) {
  const searchParams = useSearchParams();
  const [userId, setUserId] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [matches, setMatches] = useState<MatchRecord[]>([]);
  const [pendingInterests, setPendingInterests] = useState<PendingInterestRecord[]>([]);
  const [expandedMatchKey, setExpandedMatchKey] = useState("");
  const [expandedPendingKey, setExpandedPendingKey] = useState("");
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
      if (!matchJobId) {
        return;
      }

      const matchedRecord = matches.find(
        (record) => record.job.id === matchJobId && (!candidateIdParam || record.match.candidateId === candidateIdParam)
      );
      if (matchedRecord) {
        setExpandedMatchKey(matchedRecord.key);
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

      const [jobs, mutualMatches, candidateProfiles, applicantInterests] = await Promise.all([
        getAllJobs(),
        getMutualMatches(),
        getAllApplicantProfiles(),
        role === "employer" ? getApplicantInterests() : Promise.resolve([])
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
      setAccountEmail(user.email);
      setMatches(nextMatches);

      // Defense in depth: catches an employer_summary row that was generated
      // before the identity-guard fix and still has PII baked into its
      // stored text (fixing the render path doesn't fix content already in
      // the DB - see the regeneration note in the mutual-match unlock). This
      // is a render-time check, not just a generation-time one, because a
      // tainted row can be read here regardless of when it was written.
      if (role === "employer") {
        for (const record of nextMatches) {
          const violations = scanEmployerFacingText(record.candidateProfile?.employerSummary ?? "");
          if (violations.length > 0) {
            console.error("[MyMatches] employer_summary failed identity guard at render time", {
              candidateId: record.match.candidateId,
              violations
            });
            logError({
              route: "MyMatches",
              errorMessage: `Stored employer_summary failed identity guard: ${formatViolations(violations)}`,
              errorType: "privacy_violation",
              severity: "high",
              userId: record.match.candidateId,
              metadata: { violations }
            });
          }
        }
      }

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

              const matchPercent = calculateSkillMatch(
                job.requiredSkills,
                getApplicantMatchSignals(candidateProfile ?? null),
                job.title
              ).percentage;

              return {
                key: `${interest.employerId}:${interest.jobId}:${interest.candidateId}`,
                job,
                zipCode: candidateProfile?.zipCode || "",
                topSkills: candidateProfile?.topSkills ?? [],
                experienceLevel: candidateProfile?.experienceLevel || "",
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
        senderEmail: accountEmail,
        text: "Let's schedule a time to connect about this match."
      });
      if (message) {
        setThreadMessages((current) => ({ ...current, [record.key]: [...(current[record.key] ?? []), message] }));
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

  async function toggleMessaging(record: MatchRecord) {
    if (openMessageKey === record.key) {
      setOpenMessageKey("");
      return;
    }

    setOpenMessageKey(record.key);
    const messages = await refreshMatchThreadMessages(getThread(record));
    setThreadMessages((current) => ({ ...current, [record.key]: messages }));
  }

  function sendMatchMessage(record: MatchRecord) {
    const text = (messageDrafts[record.key] ?? "").trim();
    if (!text) {
      return;
    }

    const message = addMatchThreadMessage({
      ...getThread(record),
      senderRole: role === "employer" ? "employer" : "applicant",
      senderEmail: accountEmail,
      text
    });

    if (!message) {
      return;
    }

    setThreadMessages((current) => ({ ...current, [record.key]: [...(current[record.key] ?? []), message] }));
    setMessageDrafts((current) => ({ ...current, [record.key]: "" }));
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
                      <span className="rounded-full bg-red-900 px-3 py-1 text-xs font-bold text-white">{record.match.matchPercent}%</span>
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
                                may render - see PendingInterestRecord above for the
                                pre-match field allowlist. */}
                            <div className="rounded-md border border-red-100 bg-red-50 p-3">
                              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-red-800">Mutual match unlocked</p>
                              <p className="mt-1 text-sm font-bold text-zinc-950">Matched candidate</p>
                              {record.candidateProfile?.employerSummary &&
                              scanEmployerFacingText(record.candidateProfile.employerSummary).length === 0 ? (
                                <p className="mt-1 text-sm leading-6 text-zinc-700">{record.candidateProfile.employerSummary}</p>
                              ) : (
                                <p className="mt-1 text-sm text-zinc-500">Capability summary unavailable - pending review.</p>
                              )}
                            </div>
                            <div className="grid gap-3 sm:grid-cols-2">
                              <div className="rounded-md border border-gray-200 bg-white p-3">
                                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Applicant area</p>
                                <p className="mt-1 font-semibold text-zinc-950">{record.candidateProfile?.zipCode || "Generalized ZIP area"}</p>
                              </div>
                              <div className="rounded-md border border-gray-200 bg-white p-3">
                                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Skills</p>
                                {record.candidateProfile?.topSkills?.length ? (
                                  <div className="mt-1 flex flex-wrap gap-1.5">
                                    {record.candidateProfile.topSkills.map((skill) => (
                                      <span key={skill} className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-semibold text-zinc-700">
                                        {skill}
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="mt-1 text-sm text-zinc-600">Not listed</p>
                                )}
                              </div>
                            </div>
                          </div>
                        ) : null}
                        <div className="grid gap-3 text-sm md:grid-cols-3">
                          <Detail label="Job" value={record.job.title} />
                          <Detail label="Location" value={[record.job.locationCity, record.job.locationState, record.job.locationZip].filter(Boolean).join(", ")} />
                          <Detail label="Pay" value={record.job.payRange || "Not listed"} />
                        </div>
                        <p className="text-sm leading-6 text-zinc-700">{record.job.description}</p>
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
                          <button type="button" onClick={() => toggleMessaging(record)} className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700">Message</button>
                          <button type="button" className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700">Schedule Conversation</button>
                          <button type="button" onClick={() => setPendingRemoveInterest(record)} className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">Remove Interest</button>
                        </div>
                        {openMessageKey === record.key ? (
                          <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-3">
                            <div className="max-h-40 space-y-1 overflow-y-auto text-sm text-zinc-700">
                              {(threadMessages[record.key] ?? []).length > 0 ? (
                                (threadMessages[record.key] ?? []).map((message) => (
                                  <p key={message.id} className="rounded bg-white px-2 py-1">
                                    <span className="font-semibold">
                                      {(message.senderRole === "employer") === (role === "employer") ? "You" : "Them"}:
                                    </span>{" "}
                                    {message.text}
                                  </p>
                                ))
                              ) : (
                                <p>No messages yet.</p>
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
                          <span className="rounded-full bg-zinc-800 px-3 py-1 text-xs font-bold text-white">{record.matchPercent}%</span>
                        </span>
                      </button>
                      {isExpanded ? (
                        <div className="space-y-3 p-4">
                          <div className="grid gap-3 text-sm md:grid-cols-2">
                            <Detail label="Applicant area" value={record.zipCode || "Generalized ZIP area"} />
                            <Detail label="Experience level" value={record.experienceLevel || "Not listed"} />
                          </div>
                          {record.topSkills.length > 0 ? (
                            <div>
                              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Skills</p>
                              <div className="mt-2 flex flex-wrap gap-2">
                                {record.topSkills.map((skill) => (
                                  <span key={skill} className="rounded-full border border-gray-200 bg-white px-3 py-1 text-xs font-semibold text-zinc-700">
                                    {skill}
                                  </span>
                                ))}
                              </div>
                            </div>
                          ) : null}
                          <p className="text-xs text-zinc-500">
                            Full profile details (name, exact location, AI summary) unlock once you mark interest
                            back on Find Applicants and it becomes a mutual match.
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
