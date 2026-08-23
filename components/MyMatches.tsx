"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { attemptPreferredContact } from "../lib/contactPreferences";
import { logAdminEvent } from "../lib/adminEvents";
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

      setUserId(user.id);
      setAccountEmail(user.email);
      setMatches(
        scopedMatches
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
          .filter(Boolean) as MatchRecord[]
      );

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
    attemptPreferredContact({
      targetAccount: { email: role === "employer" ? record.candidateProfile?.candidateEmail : record.job.employerEmail },
      senderLabel: "A mutual match",
      jobTitle: record.job.title
    });
    logAdminEvent({
      type: "reach_out_clicked",
      userRole: role === "employer" ? "employer" : "candidate",
      jobId: record.job.id,
      applicantId: record.match.candidateId,
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
                      <span className="rounded-full bg-red-900 px-3 py-1 text-xs font-bold text-white">{record.match.matchPercent}%</span>
                    </button>
                    {isExpanded ? (
                      <div className="space-y-4 p-4">
                        {role === "employer" ? (
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
                          <button type="button" className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700">Message</button>
                          <button type="button" className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700">Schedule Conversation</button>
                          <button type="button" onClick={() => setPendingRemoveInterest(record)} className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">Remove Interest</button>
                        </div>
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
