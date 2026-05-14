"use client";

import L from "leaflet";
import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { Circle, MapContainer, Marker, Polygon, Popup, TileLayer, ZoomControl, useMap } from "react-leaflet";
import {
  addNewMessageNotification,
  addNewMatchNotification,
  addScheduleRequestNotification,
  attemptPreferredContact,
  type ContactMethod
} from "../lib/contactPreferences";
import {
  addMatchThreadMessage,
  getMatchThreadMessages,
  type MatchMessage,
  type MatchThreadContext
} from "../lib/matchMessages";
import { logAdminEvent } from "../lib/adminEvents";
import {
  addInterest as addSupabaseInterest,
  addMutualMatch as addSupabaseMutualMatch,
  getAllApplicantProfiles,
  getApplicantInterests,
  getCurrentMvpUser,
  getEmployerInterests,
  getEmployerJobs,
  getMutualMatches,
  removeInterest as removeSupabaseInterest
} from "../lib/supabaseMvpData";
import { RemoveInterestConfirmationModal } from "./RemoveInterestConfirmationModal";

type EmployerAccount = {
  id?: string;
  email: string;
  companyName?: string;
  displayName?: string;
  phone?: string;
  preferredContactMethods?: ContactMethod[];
  availabilityWindows?: string[];
};

type JobListing = {
  id: string;
  employerEmail: string;
  employerId?: string;
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

type applicantProfile = {
  candidateEmail?: string;
  fullName?: string;
  zipCode?: string;
  desiredJobType?: string;
  workPreference?: string;
  capabilitySummary?: string;
  topSkills?: string[];
  experienceLevel?: string;
  educationLevel?: string;
  updatedAt?: string;
};

type ApplicantAccount = {
  email: string;
  displayName?: string;
  phone?: string;
  preferredContactMethods?: ContactMethod[];
};

type SkillMatch = {
  percentage: number;
  matchedSkills: string[];
  missingSkills: string[];
};

type ApplicantJobMatch = {
  job: JobListing;
  match: SkillMatch;
  interestState: ApplicantInterestState;
};

type ApplicantMatchSummary = {
  id: string;
  profile: applicantProfile;
  position: Coordinates;
  locationLabel: string;
  jobMatches: ApplicantJobMatch[];
  bestMatchPercent: number;
};

type ApplicantLocationGroup = {
  id: string;
  position: Coordinates;
  locationLabel: string;
  applicants: ApplicantMatchSummary[];
  bestMatchPercent: number;
};

type EmployerInterest = {
  employerId: string;
  jobId: string;
  candidateId: string;
  matchPercent: number;
  createdAt: string;
  status: "employer_interested";
};

type ApplicantInterest = {
  employerId?: string;
  jobId: string;
  candidateId: string;
  matchPercent?: number;
  createdAt?: string;
  status?: string;
};

type MutualMatch = {
  employerId: string;
  jobId: string;
  candidateId: string;
  matchPercent: number;
  createdAt: string;
  status: "mutual_match";
  notificationStatus: {
    employerInternal: "pending";
    candidateInternal: "pending";
    employerExternal: "pending";
    candidateExternal: "pending";
  };
};

type ApplicantInterestState = "none" | "employer_interested" | "mutual_match";
type PendingEmployerInterestRemoval = {
  employerId: string;
  jobId: string;
  candidateId: string;
};

const employerAccountKey = "workplace_match_employer";
const applicantAccountKey = "workplace_match_candidate";
const applicantAccountsKey = "workplace_match_candidate_accounts";
const employerJobsKey = "workplace_match_employer_jobs";
const applicantProfileKey = "workplace_match_candidate_profile";
const employerInterestsKey = "workplace_match_employer_interests";
const applicantInterestsKey = "workplace_match_candidate_interests";
const mutualMatchesKey = "workplace_match_mutual_matches";
const activeRoleKey = "workplace_match_active_role";
const stLouisCenter: Coordinates = [38.627, -90.1994];
const stClairCenter: Coordinates = [38.3453, -90.9807];
const headerOffsetClass = "top-[69px] h-[calc(100vh-69px)]";
const warnedJobLocationFallbackIds = new Set<string>();
const warnedJobZipFallbackIds = new Set<string>();
const warnedApplicantZipFallbacks = new Set<string>();
const commuteOptions = [
  { label: "15 min drive", miles: 10 },
  { label: "30 min drive", miles: 20 },
  { label: "45 min drive", miles: 35 },
  { label: "60 min drive", miles: 50 }
];

type Coordinates = [number, number];

L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png"
});

export function EmployerFindApplicants() {
  const [account, setAccount] = useState<EmployerAccount | null>(null);
  const [jobs, setJobs] = useState<JobListing[]>([]);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [applicantProfile, setApplicantProfile] = useState<applicantProfile | null>(null);
  const [searchMiles, setSearchMiles] = useState<number | null>(null);
  const [customMiles, setCustomMiles] = useState("");
  const [isDrawingCustomArea, setIsDrawingCustomArea] = useState(false);
  const [customAreaPoints, setCustomAreaPoints] = useState<Coordinates[]>([]);
  const [interests, setInterests] = useState<EmployerInterest[]>([]);
  const [applicantInterests, setApplicantInterests] = useState<ApplicantInterest[]>([]);
  const [mutualMatches, setMutualMatches] = useState<MutualMatch[]>([]);
  const [showMatchPopup, setShowMatchPopup] = useState(false);
  const [focusedApplicantId, setFocusedApplicantId] = useState("");
  const [pendingRemoveInterest, setPendingRemoveInterest] = useState<PendingEmployerInterestRemoval | null>(null);

  useEffect(() => {
    loadMapData();

    async function loadMapData() {
      const user = await getCurrentMvpUser("employer");
      if (!user) {
        window.location.href = "/employer/login";
        return;
      }

      const [employerJobs, applicantProfiles, employerInterestRows, applicantInterestRows, mutualMatchRows] =
        await Promise.all([
          getEmployerJobs(user.id),
          getAllApplicantProfiles(),
          getEmployerInterests(),
          getApplicantInterests(),
          getMutualMatches()
        ]);

      setAccount({ id: user.id, email: user.email });
      setJobs(employerJobs as JobListing[]);
      setSelectedJobId(employerJobs[0]?.id ?? "");
      setApplicantProfile((applicantProfiles[0] as applicantProfile | undefined) ?? null);
      setInterests(employerInterestRows as EmployerInterest[]);
      setApplicantInterests(applicantInterestRows as ApplicantInterest[]);
      setMutualMatches(mutualMatchRows as MutualMatch[]);
    }
  }, []);

  useEffect(() => {
    focusMatchFromLocation();
    window.addEventListener("workplace-match-focus-match", focusMatchFromLocation);

    return () => {
      window.removeEventListener("workplace-match-focus-match", focusMatchFromLocation);
    };

    function focusMatchFromLocation() {
      const params = new URLSearchParams(window.location.search);
      const matchJobId = params.get("matchJobId");
      const candidateId =
        params.get("candidateId") ??
        mutualMatches.find((match) => match.jobId === matchJobId && (!account || match.employerId === account.email))
          ?.candidateId ??
        "";

      if (matchJobId && jobs.some((job) => job.id === matchJobId)) {
        setSelectedJobId(matchJobId);
      }

      if (candidateId) {
        setSearchMiles(null);
        setCustomAreaPoints([]);
        setIsDrawingCustomArea(false);
        setFocusedApplicantId(candidateId);
      }
    }
  }, [account, jobs, mutualMatches]);

  const selectedJob = jobs.find((job) => job.id === selectedJobId) ?? null;
  const applicantGroups = useMemo(() => {
    if (!account || !applicantProfile) {
      return [];
    }

    const position = getZipMapPosition(applicantProfile.zipCode);
    if (!position) {
      return [];
    }

    const applicantRecordId = getApplicantInterestId(applicantProfile);
    const jobMatches = jobs
      .map((job) => ({
        job,
        match: calculateSkillMatch(job.requiredSkills, getApplicantMatchSignals(applicantProfile), job.title),
        interestState: getApplicantInterestState(applicantRecordId, job.id)
      }))
      .sort((first, second) => second.match.percentage - first.match.percentage);

    if (jobMatches.length === 0) {
      return [];
    }

    const applicant: ApplicantMatchSummary = {
      id: applicantRecordId,
      profile: applicantProfile,
      position,
      locationLabel: formatApplicantLocation(applicantProfile),
      jobMatches,
      bestMatchPercent: jobMatches[0]?.match.percentage ?? 0
    };

    return groupApplicantsByLocation([applicant]);
  }, [account, applicantProfile, jobs, interests, applicantInterests, mutualMatches]);

  function getApplicantInterestState(candidateId: string, jobId: string): ApplicantInterestState {
    if (!account || !candidateId || !jobId) {
      return "none";
    }

    const hasEmployerInterest = interests.some(
      (interest) =>
        interest.employerId === account.email &&
        interest.jobId === jobId &&
        interest.candidateId === candidateId
    );
    const hasCandidateInterest = applicantInterests.some((interest) =>
      isCandidateInterestForPair(interest, account.email, jobId, candidateId)
    );
    if (hasEmployerInterest && hasCandidateInterest) {
      return "mutual_match";
    }

    if (hasEmployerInterest) {
      return "employer_interested";
    }

    return "none";
  }

  function toggleEmployerInterestForJob(job: JobListing, profile: applicantProfile, matchPercent: number) {
    if (!account) {
      return;
    }

    const nextCandidateId = getApplicantInterestId(profile);
    const currentState = getApplicantInterestState(nextCandidateId, job.id);

    if (currentState !== "none") {
      setPendingRemoveInterest({ employerId: account.email, jobId: job.id, candidateId: nextCandidateId });
      return;
    }

    const nextInterest: EmployerInterest = {
      employerId: account.email,
      jobId: job.id,
      candidateId: nextCandidateId,
      matchPercent,
      createdAt: new Date().toISOString(),
      status: "employer_interested"
    };
    const hasCandidateInterest = applicantInterests.some(
      (interest) =>
        isCandidateInterestForPair(
          interest,
          nextInterest.employerId,
          nextInterest.jobId,
          nextInterest.candidateId
        )
    );

    setInterests((current) => {
      const alreadyExists = current.some(
        (interest) =>
          interest.employerId === nextInterest.employerId &&
          interest.jobId === nextInterest.jobId &&
          interest.candidateId === nextInterest.candidateId
      );

      if (alreadyExists) {
        return current;
      }

      const updated = [nextInterest, ...current];
      addSupabaseInterest({
        fromUserId: nextInterest.employerId,
        toUserId: nextInterest.candidateId,
        jobId: nextInterest.jobId
      });
      logAdminEvent({
        type: "interest_selected",
        userRole: "employer",
        jobId: nextInterest.jobId,
        applicantId: nextInterest.candidateId,
        employerId: nextInterest.employerId,
        dedupeKey: `employer-interest:${nextInterest.employerId}:${nextInterest.jobId}:${nextInterest.candidateId}`
      });
      return updated;
    });

    if (hasCandidateInterest) {
      const nextMutualMatch = createMutualMatchRecord(nextInterest);
      setShowMatchPopup(true);

      setMutualMatches((current) => {
        const alreadyExists = current.some(
          (mutualMatch) =>
            mutualMatch.employerId === nextMutualMatch.employerId &&
            mutualMatch.jobId === nextMutualMatch.jobId &&
            mutualMatch.candidateId === nextMutualMatch.candidateId
        );

        if (alreadyExists) {
          return current;
        }

        const updated = [nextMutualMatch, ...current];
        addSupabaseMutualMatch({
          candidateId: nextMutualMatch.candidateId,
          employerId: nextMutualMatch.employerId,
          jobId: nextMutualMatch.jobId,
          matchPercent: nextMutualMatch.matchPercent
        });
        logAdminEvent({
          type: "mutual_match_created",
          userRole: "employer",
          jobId: nextMutualMatch.jobId,
          applicantId: nextMutualMatch.candidateId,
          employerId: nextMutualMatch.employerId,
          dedupeKey: `mutual-match:${nextMutualMatch.employerId}:${nextMutualMatch.jobId}:${nextMutualMatch.candidateId}`
        });
        const matchedCandidateAccount = findCandidateAccount(profile);
        if (matchedCandidateAccount) {
          addNewMatchNotification({
            recipientEmail: matchedCandidateAccount.email,
            senderEmail: nextInterest.employerId,
            jobId: nextMutualMatch.jobId,
            jobTitle: job.title,
            candidateId: nextMutualMatch.candidateId,
            employerId: nextInterest.employerId,
            dedupeKey: `new-match:${matchedCandidateAccount.email}:${nextMutualMatch.jobId}:${nextMutualMatch.candidateId}`
          });
        }
        addNewMatchNotification({
          recipientEmail: nextInterest.employerId,
          senderEmail: matchedCandidateAccount?.email ?? nextInterest.candidateId,
          jobId: nextMutualMatch.jobId,
          jobTitle: job.title,
          candidateId: nextMutualMatch.candidateId,
          employerId: nextInterest.employerId,
          dedupeKey: `new-match:${nextInterest.employerId}:${nextMutualMatch.jobId}:${nextMutualMatch.candidateId}`
        });
        return updated;
      });
    }
  }

  function removeEmployerInterest(employerId: string, jobId: string, candidateId: string) {
    setShowMatchPopup(false);

    setInterests((current) => {
      const updated = current.filter(
        (interest) =>
          !(
            interest.employerId === employerId &&
            interest.jobId === jobId &&
            interest.candidateId === candidateId
          )
      );
      removeSupabaseInterest({ fromUserId: employerId, toUserId: candidateId, jobId });
      if (updated.length !== current.length) {
        logAdminEvent({
          type: "interest_removed",
          userRole: "employer",
          jobId,
          applicantId: candidateId,
          employerId
        });
      }
      return updated;
    });

    setMutualMatches((current) => {
      const updated = current.filter(
        (mutualMatch) =>
          !(
            mutualMatch.employerId === employerId &&
            mutualMatch.jobId === jobId &&
            mutualMatch.candidateId === candidateId
          )
      );
      return updated;
    });
  }

  if (!account) {
    return (
      <div className={`fixed inset-x-0 bottom-0 z-40 flex w-screen items-center justify-center bg-[#eef3ef] ${headerOffsetClass}`}>
        <p className="text-sm text-zinc-600">Loading applicant matches...</p>
      </div>
    );
  }

  return (
    <section className={`fixed inset-x-0 bottom-0 z-40 w-screen overflow-hidden bg-[#eef3ef] ${headerOffsetClass}`}>
      <MapSurface
        job={selectedJob}
        applicantGroups={applicantGroups}
        focusedApplicantId={focusedApplicantId}
        searchMiles={searchMiles}
        isDrawingCustomArea={isDrawingCustomArea}
        customAreaPoints={customAreaPoints}
        onDrawingCustomAreaChange={setIsDrawingCustomArea}
        onCustomAreaPointsChange={setCustomAreaPoints}
        onEmployerInterestForJob={toggleEmployerInterestForJob}
      />

      <div className="absolute left-4 top-4 z-[900] max-h-[calc(100%-2rem)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-lg border border-gray-200 bg-white/95 p-4 shadow-soft">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-800">
          Find applicants
        </p>
        <div className="mt-3 space-y-2">
          <label htmlFor="jobSelector" className="label">
            Job listing
          </label>
          {jobs.length > 0 ? (
            <select
              id="jobSelector"
              value={selectedJobId}
              onChange={(event) => setSelectedJobId(event.target.value)}
              className="field"
            >
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.title} - {formatJobLocation(job)}
                </option>
              ))}
            </select>
          ) : (
            <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-3 text-sm text-zinc-600">
              No job listings yet.
            </p>
          )}
        </div>
        <div className="mt-4 space-y-3 border-t border-gray-200 pt-3">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
            Search area
          </p>
          <div className="grid grid-cols-2 gap-2">
            {commuteOptions.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => {
                  setSearchMiles(option.miles);
                  setCustomMiles("");
                }}
                className={`rounded-md px-3 py-2 text-sm font-semibold transition ${
                  searchMiles === option.miles && !customMiles
                    ? "bg-red-900 text-white hover:bg-red-950"
                    : "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label className="block space-y-2">
            <span className="label">Custom distance in miles</span>
            <input
              type="number"
              min="1"
              value={customMiles}
              onChange={(event) => {
                const value = event.target.value;
                const miles = Number(value);
                setCustomMiles(value);
                setSearchMiles(Number.isFinite(miles) && miles > 0 ? miles : null);
              }}
              className="field"
              placeholder="Example: 25"
            />
          </label>
          {searchMiles ? (
            <button
              type="button"
              onClick={() => {
                setSearchMiles(null);
                setCustomMiles("");
              }}
              className="inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
            >
              Clear search area
            </button>
          ) : null}
          <div className="space-y-2 border-t border-gray-200 pt-3">
            <button
              type="button"
              onClick={() => {
                setCustomAreaPoints([]);
                setIsDrawingCustomArea(true);
              }}
              className={`inline-flex w-full items-center justify-center rounded-md px-3 py-2 text-sm font-semibold transition ${
                isDrawingCustomArea ? "bg-red-900 text-white hover:bg-red-950" : "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50"
              }`}
            >
              {isDrawingCustomArea ? "Drawing custom area..." : "Draw custom area"}
            </button>
            {isDrawingCustomArea ? (
              <button
                type="button"
                onClick={() => setIsDrawingCustomArea(false)}
                className="inline-flex w-full items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
              >
                Finish area
              </button>
            ) : null}
            {customAreaPoints.length > 0 ? (
              <button
                type="button"
                onClick={() => {
                  setCustomAreaPoints([]);
                  setIsDrawingCustomArea(false);
                }}
                className="inline-flex w-full items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
              >
                Clear custom area
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <p className="absolute bottom-4 left-4 z-[900] max-w-sm rounded bg-white/80 px-3 py-2 text-xs font-semibold text-zinc-600 shadow-soft">
        Privacy safe: candidate markers show match percentage only and use generalized ZIP-area placement.
      </p>

      {showMatchPopup ? <MatchPopup onClose={() => setShowMatchPopup(false)} /> : null}
      {pendingRemoveInterest ? (
        <RemoveInterestConfirmationModal
          onConfirm={() => {
            removeEmployerInterest(
              pendingRemoveInterest.employerId,
              pendingRemoveInterest.jobId,
              pendingRemoveInterest.candidateId
            );
            setPendingRemoveInterest(null);
          }}
          onCancel={() => setPendingRemoveInterest(null)}
        />
      ) : null}
    </section>
  );
}

function MatchPopup({ onClose }: { onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-zinc-950/35 px-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 text-center shadow-soft">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-800">Match</p>
        <h2 className="mt-2 text-2xl font-bold text-zinc-950">You have a match</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">Both sides expressed interest</p>
        <div className="mt-5 space-y-2">
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-md bg-green-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-green-800"
          >
            Reach Out
          </button>
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-md border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-200"
          >
            Do Later
          </button>
        </div>
      </div>
    </div>
  );
}

function MapSurface({
  job,
  applicantGroups,
  focusedApplicantId,
  searchMiles,
  isDrawingCustomArea,
  customAreaPoints,
  onDrawingCustomAreaChange,
  onCustomAreaPointsChange,
  onEmployerInterestForJob
}: {
  job: JobListing | null;
  applicantGroups: ApplicantLocationGroup[];
  focusedApplicantId: string;
  searchMiles: number | null;
  isDrawingCustomArea: boolean;
  customAreaPoints: Coordinates[];
  onDrawingCustomAreaChange: (isDrawing: boolean) => void;
  onCustomAreaPointsChange: Dispatch<SetStateAction<Coordinates[]>>;
  onEmployerInterestForJob: (job: JobListing, profile: applicantProfile, matchPercent: number) => void;
}) {
  const jobPosition = job ? getJobMapPosition(job) : stLouisCenter;
  const mapCenter = jobPosition ?? stLouisCenter;
  const hasCustomArea = customAreaPoints.length >= 3;
  const applicantMarkerRefs = useRef<Record<string, L.Marker | null>>({});
  const visibleApplicantGroups = applicantGroups
    .map((group) => {
      const visibleApplicants = group.applicants.filter((applicant) =>
        isApplicantInSearchArea(applicant.position, jobPosition, searchMiles, customAreaPoints)
      );

      return {
        ...group,
        applicants: visibleApplicants,
        bestMatchPercent: Math.max(...visibleApplicants.map((applicant) => applicant.bestMatchPercent), 0)
      };
    })
    .filter((group) => group.applicants.length > 0);

  return (
    <MapContainer center={mapCenter} zoom={10} minZoom={8} zoomControl={false} className="absolute inset-0 z-0 h-full w-full">
      <RecenterMap center={mapCenter} />
      <FocusApplicantMatch
        focusedApplicantId={focusedApplicantId}
        applicantGroups={visibleApplicantGroups}
        markerRefs={applicantMarkerRefs}
      />
      <ZoomControl position="bottomright" />
      <FreehandSearchAreaTool
        enabled={isDrawingCustomArea}
        onDrawingChange={onDrawingCustomAreaChange}
        onPointsChange={onCustomAreaPointsChange}
      />
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {job ? (
        <Marker position={jobPosition} icon={createJobIcon()}>
          <Popup>
            <div className="space-y-2">
              <p>Job location: {formatJobLocation(job)}</p>
              {isApproximateJobLocation(job) ? (
                <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900">
                  Approximate location â€” exact address not mapped
                </p>
              ) : null}
            </div>
          </Popup>
        </Marker>
      ) : null}

      {job && searchMiles && !hasCustomArea ? (
        <Circle
          center={jobPosition}
          radius={searchMiles * 1609.344}
          pathOptions={{ color: "#991b1b", fillColor: "#991b1b", fillOpacity: 0.08, weight: 2 }}
        >
          <Popup>Estimated search area: {searchMiles} miles</Popup>
        </Circle>
      ) : null}

      {hasCustomArea ? (
        <Polygon
          positions={customAreaPoints}
          pathOptions={{ color: "#991b1b", fillColor: "#991b1b", fillOpacity: 0.1, weight: 2 }}
        >
          <Popup>Custom search area</Popup>
        </Polygon>
      ) : null}

      {visibleApplicantGroups.map((group) => (
        <Marker
          key={group.id}
          ref={(marker) => {
            applicantMarkerRefs.current[group.id] = marker;
          }}
          position={group.position}
          icon={
            group.applicants.length > 1
              ? createApplicantCountIcon(group.applicants.length, getApplicantGroupInterestState(group))
              : createMatchIcon(group.bestMatchPercent, getApplicantSummaryInterestState(group.applicants[0]))
          }
        >
          <Popup maxWidth={420}>
            {group.applicants.length > 1 ? (
              <ApplicantLocationGroupPopup
                group={group}
                focusedApplicantId={focusedApplicantId}
                focusedJobId={job?.id ?? ""}
                onEmployerInterestForJob={onEmployerInterestForJob}
              />
            ) : (
              <ApplicantMatchPopup
                applicant={group.applicants[0]}
                focusedJobId={job?.id ?? ""}
                onEmployerInterestForJob={onEmployerInterestForJob}
              />
            )}
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}

function getApplicantSummaryInterestState(applicant: ApplicantMatchSummary): ApplicantInterestState {
  const states = applicant.jobMatches.map((jobMatch) => jobMatch.interestState);

  if (states.includes("mutual_match")) {
    return "mutual_match";
  }

  if (states.includes("employer_interested")) {
    return "employer_interested";
  }

  return "none";
}

function getApplicantGroupInterestState(group: ApplicantLocationGroup): ApplicantInterestState {
  const states = group.applicants.map(getApplicantSummaryInterestState);

  if (states.includes("mutual_match")) {
    return "mutual_match";
  }

  if (states.includes("employer_interested")) {
    return "employer_interested";
  }

  return "none";
}

function FocusApplicantMatch({
  focusedApplicantId,
  applicantGroups,
  markerRefs
}: {
  focusedApplicantId: string;
  applicantGroups: ApplicantLocationGroup[];
  markerRefs: MutableRefObject<Record<string, L.Marker | null>>;
}) {
  const map = useMap();

  useEffect(() => {
    if (!focusedApplicantId) {
      return;
    }

    const focusedGroup = applicantGroups.find((group) =>
      group.applicants.some((applicant) => applicant.id === focusedApplicantId)
    );
    if (!focusedGroup) {
      return;
    }

    map.panTo(focusedGroup.position, { animate: true, duration: 0.55 });
    window.setTimeout(() => markerRefs.current[focusedGroup.id]?.openPopup(), 0);
  }, [applicantGroups, focusedApplicantId, map, markerRefs]);

  return null;
}

function ApplicantLocationGroupPopup({
  group,
  focusedApplicantId,
  focusedJobId,
  onEmployerInterestForJob
}: {
  group: ApplicantLocationGroup;
  focusedApplicantId: string;
  focusedJobId: string;
  onEmployerInterestForJob: (job: JobListing, profile: applicantProfile, matchPercent: number) => void;
}) {
  const [selectedApplicantId, setSelectedApplicantId] = useState<string | null>(focusedApplicantId || null);
  const selectedApplicant = group.applicants.find((applicant) => applicant.id === selectedApplicantId) ?? null;

  useEffect(() => {
    if (focusedApplicantId && group.applicants.some((applicant) => applicant.id === focusedApplicantId)) {
      setSelectedApplicantId(focusedApplicantId);
    }
  }, [focusedApplicantId, group.applicants]);

  if (selectedApplicant) {
    return (
      <div className="w-80 space-y-3">
        <button
          type="button"
          onClick={() => setSelectedApplicantId(null)}
          className="text-xs font-semibold text-red-800 transition hover:text-red-950"
        >
          Back to applicants
        </button>
        <ApplicantMatchPopup
          applicant={selectedApplicant}
          focusedJobId={focusedJobId}
          onEmployerInterestForJob={onEmployerInterestForJob}
        />
      </div>
    );
  }

  return (
    <div className="w-80 space-y-3">
      <div>
        <p className="text-sm font-semibold text-zinc-950">Applicant ZIP-area matches</p>
        <p className="mt-1 text-xs text-zinc-600">{group.locationLabel}</p>
      </div>
      <div className="space-y-2">
        {group.applicants.map((applicant, index) => {
          const interestState = getApplicantSummaryInterestState(applicant);

          return (
            <button
              key={`${applicant.id}-${index}`}
              type="button"
              onClick={() => setSelectedApplicantId(applicant.id)}
              className="flex w-full items-center justify-between gap-3 rounded-md border border-gray-200 bg-white p-3 text-left transition hover:bg-zinc-50"
            >
              <span>
                <span className="block text-sm font-semibold text-zinc-950">Applicant match</span>
                <span className="mt-1 block text-xs text-zinc-600">{applicant.locationLabel}</span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                {interestState === "employer_interested" || interestState === "mutual_match" ? (
                  <span className="rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                    &hearts;
                  </span>
                ) : null}
                {interestState === "mutual_match" ? (
                  <span className="rounded-full bg-red-900 px-2.5 py-0.5 text-xs font-bold text-white">
                    MATCH
                  </span>
                ) : null}
                <span className="rounded-full bg-red-900 px-2.5 py-1 text-sm font-bold text-white">
                  {applicant.bestMatchPercent}%
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ApplicantMatchPopup({
  applicant,
  focusedJobId = "",
  onEmployerInterestForJob
}: {
  applicant: ApplicantMatchSummary;
  focusedJobId?: string;
  onEmployerInterestForJob: (job: JobListing, profile: applicantProfile, matchPercent: number) => void;
}) {
  const [dismissedMutualActionJobIds, setDismissedMutualActionJobIds] = useState<string[]>([]);
  const employerAccount = readEmployerAccount();
  const ApplicantAccount = findCandidateAccount(applicant.profile);
  const orderedJobMatches = focusedJobId
    ? [...applicant.jobMatches].sort((first, second) => {
        if (first.job.id === focusedJobId) {
          return -1;
        }
        if (second.job.id === focusedJobId) {
          return 1;
        }
        return second.match.percentage - first.match.percentage;
      })
    : applicant.jobMatches;

  return (
    <div className="w-80 space-y-3">
      <div>
        <p className="text-sm font-semibold text-zinc-950">Applicant match</p>
        <p className="mt-1 text-xs text-zinc-600">{applicant.locationLabel}</p>
      </div>
      <div className="space-y-2">
        {orderedJobMatches.map(({ job, match, interestState }) => (
          <div key={job.id} className="rounded-md border border-gray-200 bg-white p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-zinc-950">{job.title}</p>
                <p className="mt-1 text-xs leading-5 text-zinc-600">{formatJobLocation(job)}</p>
              </div>
              <span className="shrink-0 rounded-full bg-red-900 px-2.5 py-1 text-sm font-bold text-white">
                {match.percentage}%
              </span>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                {interestState === "employer_interested" ? (
                  <span
                    aria-label="Interested"
                    className="rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-bold text-red-900"
                  >
                    {"\u2665"}
                  </span>
                ) : null}
                {interestState === "mutual_match" ? (
                  <span className="rounded-full bg-red-900 px-2.5 py-0.5 text-xs font-bold text-white">
                    MATCH
                  </span>
                ) : null}
              </div>
              <button
                type="button"
                onClick={() => onEmployerInterestForJob(job, applicant.profile, match.percentage)}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${
                  interestState === "none"
                    ? "bg-red-900 text-white hover:bg-red-950"
                    : "border border-zinc-300 bg-white text-zinc-900 hover:bg-zinc-50"
                }`}
              >
                {interestState === "none" ? "Interested" : "Remove interest"}
              </button>
            </div>
            {interestState === "mutual_match" && !dismissedMutualActionJobIds.includes(job.id) ? (
              <EmployerMutualMatchActions
                job={job}
                applicantId={applicant.id}
                employerAccount={employerAccount}
                ApplicantAccount={ApplicantAccount}
                onDismiss={() =>
                  setDismissedMutualActionJobIds((current) =>
                    current.includes(job.id) ? current : [...current, job.id]
                  )
                }
              />
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function EmployerMutualMatchActions({
  job,
  applicantId,
  employerAccount,
  ApplicantAccount,
  onDismiss
}: {
  job: JobListing;
  applicantId: string;
  employerAccount: EmployerAccount | null;
  ApplicantAccount: ApplicantAccount | null;
  onDismiss: () => void;
}) {
  const [isMessagingOpen, setIsMessagingOpen] = useState(false);
  const [isSchedulingOpen, setIsSchedulingOpen] = useState(false);
  const [messages, setMessages] = useState<MatchMessage[]>([]);
  const [messageText, setMessageText] = useState("");
  const [selectedTime, setSelectedTime] = useState(employerAccount?.availabilityWindows?.[0] ?? "");
  const thread: MatchThreadContext = {
    applicantId,
    employerId: employerAccount?.email ?? job.employerEmail,
    jobId: job.id
  };

  useEffect(() => {
    setMessages(getMatchThreadMessages(thread));
  }, [thread.applicantId, thread.employerId, thread.jobId]);

  function sendEmployerMessage(text: string) {
    if (!employerAccount) {
      return;
    }

    const message = addMatchThreadMessage({
      ...thread,
      senderRole: "employer",
      senderEmail: employerAccount.email,
      text
    });

    if (!message || !ApplicantAccount?.email) {
      return;
    }

    addNewMessageNotification({
      recipientEmail: ApplicantAccount.email,
      senderEmail: employerAccount.email,
      jobId: job.id,
      jobTitle: job.title,
      message: `New message about ${job.title}.`
    });
  }

  function sendScheduleNotifications(message: string, dedupeKey?: string) {
    if (!employerAccount) {
      return;
    }

    if (ApplicantAccount?.email) {
      addScheduleRequestNotification({
        recipientEmail: ApplicantAccount.email,
        senderEmail: employerAccount.email,
        jobId: job.id,
        jobTitle: job.title,
        message,
        dedupeKey: dedupeKey ? `${dedupeKey}:candidate` : undefined
      });
    }
    addScheduleRequestNotification({
      recipientEmail: employerAccount.email,
      senderEmail: ApplicantAccount?.email ?? applicantId,
      jobId: job.id,
      jobTitle: job.title,
      message,
      dedupeKey: dedupeKey ? `${dedupeKey}:employer` : undefined
    });
  }

  function reachOut() {
    if (!employerAccount) {
      return;
    }

    logAdminEvent({
      type: "reach_out_clicked",
      userRole: "employer",
      jobId: job.id,
      applicantId,
      employerId: employerAccount.email
    });
    attemptPreferredContact({
      targetAccount: ApplicantAccount,
      senderLabel: employerAccount.companyName || employerAccount.displayName || employerAccount.email || "A mutual match",
      jobTitle: job.title
    });
    sendEmployerMessage("Let's schedule a time to connect about this match.");
    sendScheduleNotifications(
      "Schedule conversation requested for a mutual match.",
      `schedule-request:${job.id}:${applicantId}`
    );
    onDismiss();
  }

  function sendMessage() {
    if (!messageText.trim()) {
      return;
    }

    sendEmployerMessage(messageText);
    setMessageText("");
    setMessages(getMatchThreadMessages(thread));
  }

  function scheduleConversation() {
    if (!selectedTime.trim()) {
      return;
    }

    logAdminEvent({
      type: "schedule_requested",
      userRole: "employer",
      jobId: job.id,
      applicantId,
      employerId: employerAccount?.email ?? job.employerEmail
    });
    sendEmployerMessage(`Scheduled for ${selectedTime.trim()}`);
    sendScheduleNotifications(`Conversation scheduled for ${selectedTime.trim()}`);
    setMessages(getMatchThreadMessages(thread));
    setIsSchedulingOpen(false);
  }

  return (
    <div className="mt-3 space-y-2 border-t border-gray-100 pt-3">
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={reachOut}
          className="rounded-md bg-green-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-green-800"
        >
          Reach Out
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md border border-zinc-300 bg-zinc-100 px-3 py-2 text-xs font-semibold text-zinc-800 transition hover:bg-zinc-200"
        >
          Do Later
        </button>
        <button
          type="button"
          onClick={() => setIsMessagingOpen((current) => !current)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-zinc-50"
        >
          Message
        </button>
        <button
          type="button"
          onClick={() => setIsSchedulingOpen((current) => !current)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-zinc-50"
        >
          Schedule Conversation
        </button>
      </div>
      {isMessagingOpen ? (
        <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-2">
          <div className="max-h-28 space-y-1 overflow-y-auto text-xs text-zinc-700">
            {messages.length > 0 ? (
              messages.map((message) => (
                <p key={message.id} className="rounded bg-white px-2 py-1">
                  <span className="font-semibold">{message.senderRole === "employer" ? "You" : "Applicant"}:</span>{" "}
                  {message.text}
                </p>
              ))
            ) : (
              <p>No messages yet.</p>
            )}
          </div>
          <textarea
            value={messageText}
            onChange={(event) => setMessageText(event.target.value)}
            rows={2}
            className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
            placeholder="Write a message..."
          />
          <button
            type="button"
            onClick={sendMessage}
            className="w-full rounded-md bg-red-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-red-950"
          >
            Send message
          </button>
        </div>
      ) : null}
      {isSchedulingOpen ? (
        <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-2">
          {employerAccount?.availabilityWindows?.length ? (
            <>
              <select
                value={selectedTime}
                onChange={(event) => setSelectedTime(event.target.value)}
                className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
              >
                {employerAccount.availabilityWindows.map((window) => (
                  <option key={window} value={window}>
                    {window}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={scheduleConversation}
                className="w-full rounded-md bg-red-900 px-3 py-2 text-xs font-semibold text-white transition hover:bg-red-950"
              >
                Confirm time
              </button>
            </>
          ) : (
            <p className="text-xs leading-5 text-zinc-600">Add availability in Account Settings first.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function FreehandSearchAreaTool({
  enabled,
  onDrawingChange,
  onPointsChange
}: {
  enabled: boolean;
  onDrawingChange: (isDrawing: boolean) => void;
  onPointsChange: Dispatch<SetStateAction<Coordinates[]>>;
}) {
  const map = useMap();
  const isPointerDrawing = useRef(false);
  const pointCount = useRef(0);

  useEffect(() => {
    const container = map.getContainer();

    if (!enabled) {
      map.dragging.enable();
      map.doubleClickZoom.enable();
      container.style.cursor = "";
      return;
    }

    map.dragging.disable();
    map.doubleClickZoom.disable();
    container.style.cursor = "crosshair";

    function getLatLng(event: PointerEvent) {
      const rect = container.getBoundingClientRect();
      const point = L.point(event.clientX - rect.left, event.clientY - rect.top);
      const latLng = map.containerPointToLatLng(point);

      return [latLng.lat, latLng.lng] as Coordinates;
    }

    function startDrawing(event: PointerEvent) {
      event.preventDefault();
      container.setPointerCapture?.(event.pointerId);
      isPointerDrawing.current = true;
      pointCount.current = 1;
      onPointsChange([getLatLng(event)]);
    }

    function continueDrawing(event: PointerEvent) {
      if (!isPointerDrawing.current) {
        return;
      }

      event.preventDefault();
      const nextPoint = getLatLng(event);
      pointCount.current += 1;
      onPointsChange((current) => [...current, nextPoint]);
    }

    function finishDrawing(event: PointerEvent) {
      if (!isPointerDrawing.current) {
        return;
      }

      event.preventDefault();
      isPointerDrawing.current = false;
      container.releasePointerCapture?.(event.pointerId);
      if (pointCount.current < 3) {
        onPointsChange([]);
      }
      onDrawingChange(false);
    }

    container.addEventListener("pointerdown", startDrawing);
    container.addEventListener("pointermove", continueDrawing);
    container.addEventListener("pointerup", finishDrawing);
    container.addEventListener("pointercancel", finishDrawing);

    return () => {
      container.removeEventListener("pointerdown", startDrawing);
      container.removeEventListener("pointermove", continueDrawing);
      container.removeEventListener("pointerup", finishDrawing);
      container.removeEventListener("pointercancel", finishDrawing);
      map.dragging.enable();
      map.doubleClickZoom.enable();
      container.style.cursor = "";
    };
  }, [enabled, map, onDrawingChange, onPointsChange]);

  return null;
}

function RecenterMap({ center }: { center: Coordinates }) {
  const map = useMap();

  useEffect(() => {
    map.setView(center, 10);
  }, [center, map]);

  return null;
}

function readEmployerInterests() {
  return [] as EmployerInterest[];
}

function readEmployerAccount() {
  return null;
}

function findCandidateAccount(profile: applicantProfile) {
  return profile.candidateEmail ? { email: profile.candidateEmail } : null;
}

function readCandidateAccounts() {
  return [] as ApplicantAccount[];
}

function readCandidateAccount() {
  return null;
}

function readCandidateInterests() {
  return [] as ApplicantInterest[];
}

function isCandidateInterestForPair(
  interest: ApplicantInterest,
  employerId: string,
  jobId: string,
  candidateId: string
) {
  const employerMatches = !interest.employerId || interest.employerId === employerId;

  return employerMatches && interest.jobId === jobId && interest.candidateId === candidateId;
}

function readMutualMatches() {
  return [] as MutualMatch[];
}

function createMutualMatchRecord(interest: EmployerInterest): MutualMatch {
  return {
    employerId: interest.employerId,
    jobId: interest.jobId,
    candidateId: interest.candidateId,
    matchPercent: interest.matchPercent,
    createdAt: new Date().toISOString(),
    status: "mutual_match",
    notificationStatus: {
      employerInternal: "pending",
      candidateInternal: "pending",
      employerExternal: "pending",
      candidateExternal: "pending"
    }
  };
}

function getApplicantInterestId(profile: applicantProfile) {
  return profile.updatedAt ? `candidate-profile:${profile.updatedAt}` : "candidate-profile:local-mvp";
}

function getZipMapPosition(zipCode?: string): Coordinates | null {
  // Privacy: candidate markers use generalized ZIP-area centroids, not exact locations.
  const normalizedZip = zipCode?.replace(/\D/g, "") ?? "";
  const knownExactZips: Record<string, { coordinates: Coordinates; label: string }> = {
    "63026": { coordinates: [38.5131, -90.4359], label: "Fenton, MO" },
    "63077": { coordinates: stClairCenter, label: "St. Clair, MO" },
    "63088": { coordinates: [38.5548, -90.4926], label: "Valley Park, MO" },
    "63090": { coordinates: [38.5581, -91.0121], label: "Washington, MO" },
    "63101": { coordinates: stLouisCenter, label: "St. Louis, MO" },
    "63102": { coordinates: [38.6257, -90.1848], label: "St. Louis, MO" },
    "63103": { coordinates: [38.6312, -90.2146], label: "St. Louis, MO" },
    "63104": { coordinates: [38.6107, -90.2126], label: "St. Louis, MO" },
    "63105": { coordinates: [38.6426, -90.3237], label: "Clayton, MO" },
    "63110": { coordinates: [38.6207, -90.2557], label: "St. Louis, MO" },
    "63118": { coordinates: [38.5948, -90.2294], label: "St. Louis, MO" },
    "63122": { coordinates: [38.5789, -90.4068], label: "Kirkwood, MO" },
    "63123": { coordinates: [38.5492, -90.3276], label: "Affton, MO" },
    "63129": { coordinates: [38.4567, -90.3237], label: "Oakville, MO" },
    "63301": { coordinates: [38.7881, -90.4974], label: "St. Charles, MO" },
    "63303": { coordinates: [38.7545, -90.5468], label: "St. Charles, MO" },
    "63304": { coordinates: [38.7326, -90.6351], label: "St. Charles, MO" }
  };

  if (knownExactZips[normalizedZip]) {
    return logApplicantZipResolution(normalizedZip, knownExactZips[normalizedZip].coordinates);
  }

  const zipPrefix = zipCode?.slice(0, 3) ?? "";
  const knownZipAreas: Record<string, Coordinates> = {
    "100": [40.7128, -74.006],
    "303": [33.749, -84.388],
    "606": [41.8781, -87.6298],
    "631": [38.627, -90.1994],
    "633": [38.7881, -90.4974],
    "641": [39.0997, -94.5786],
    "752": [32.7767, -96.797],
    "802": [39.7392, -104.9903],
    "900": [34.0522, -118.2437],
    "941": [37.7749, -122.4194],
    "981": [47.6062, -122.3321]
  };

  if (knownZipAreas[zipPrefix]) {
    return logApplicantZipResolution(normalizedZip, knownZipAreas[zipPrefix]);
  }

  if (!warnedApplicantZipFallbacks.has(normalizedZip)) {
    warnedApplicantZipFallbacks.add(normalizedZip);
    console.warn("Workplace Match: applicant ZIP could not be resolved.", {
      applicantZip: normalizedZip,
      resolvedCoordinates: null
    });
  }

  return null;
}

function logApplicantZipResolution(zipCode: string, coordinates: Coordinates) {
  console.warn("Workplace Match: applicant ZIP resolved.", {
    applicantZip: zipCode,
    resolvedCoordinates: coordinates
  });

  return coordinates;
}

function getJobMapPosition(job: JobListing): Coordinates {
  const exactAddressPosition = getJobExactAddressMapPosition(job);

  if (exactAddressPosition) {
    return exactAddressPosition;
  }

  const approximatePosition = getApproximateJobMapPosition(job);

  if (approximatePosition) {
    warnJobApproximateFallback(job);
    return approximatePosition;
  }

  const city = (job.locationCity ?? "").toLowerCase();

  if (city.includes("st. charles") || city.includes("st charles") || city.includes("saint charles")) {
    return [38.7881, -90.4974];
  }

  if (city.includes("st. louis") || city.includes("st louis") || city.includes("saint louis")) {
    return stLouisCenter;
  }

  if (city.includes("st. clair") || city.includes("st clair") || city.includes("saint clair")) {
    return [38.3453, -90.9807];
  }

  if (city.includes("clayton")) {
    return [38.6426, -90.3237];
  }

  if (city.includes("maplewood")) {
    return [38.6126, -90.3246];
  }

  if (city.includes("fenton")) {
    return [38.5131, -90.4359];
  }

  if (city.includes("valley park")) {
    return [38.5548, -90.4926];
  }

  if (city.includes("washington")) {
    return [38.5581, -91.0121];
  }

  if (city.includes("kirkwood")) {
    return [38.5789, -90.4068];
  }

  if (city.includes("affton")) {
    return [38.5492, -90.3276];
  }

  if (city.includes("oakville")) {
    return [38.4567, -90.3237];
  }

  warnJobLocationFallback(job);
  return stLouisCenter;
}

function isApproximateJobLocation(job: JobListing) {
  return !getJobExactAddressMapPosition(job) && Boolean(getApproximateJobMapPosition(job));
}

function getApproximateJobMapPosition(job: JobListing) {
  const basePosition = getJobZipMapPosition(job.locationZip) ?? getJobCityMapPosition(job.locationCity);

  if (!basePosition) {
    return null;
  }

  return offsetCoordinates(basePosition, getJobAddressKey(job) || job.id);
}

function getJobExactAddressMapPosition(job: JobListing) {
  const normalizedAddress = getJobAddressKey(job);
  const knownExactAddresses: Record<string, Coordinates> = {
    "213 main st fenton mo 63026": [38.5137, -90.4374],
    "1 main st valley park mo 63088": [38.5497, -90.4928],
    "1 e main st washington mo 63090": [38.5588, -91.0114]
  };

  return knownExactAddresses[normalizedAddress] ?? null;
}

function getJobAddressKey(job: JobListing) {
  return normalizeAddress(
    [job.locationStreet, job.locationCity, job.locationState, job.locationZip].filter(Boolean).join(" ")
  );
}

function normalizeAddress(value: string) {
  return value
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getJobCityMapPosition(cityValue?: string): Coordinates | null {
  const city = (cityValue ?? "").toLowerCase();

  if (city.includes("st. charles") || city.includes("st charles") || city.includes("saint charles")) {
    return [38.7881, -90.4974];
  }

  if (city.includes("st. louis") || city.includes("st louis") || city.includes("saint louis")) {
    return stLouisCenter;
  }

  if (city.includes("st. clair") || city.includes("st clair") || city.includes("saint clair")) {
    return [38.3453, -90.9807];
  }

  if (city.includes("clayton")) {
    return [38.6426, -90.3237];
  }

  if (city.includes("maplewood")) {
    return [38.6126, -90.3246];
  }

  if (city.includes("fenton")) {
    return [38.5131, -90.4359];
  }

  if (city.includes("valley park")) {
    return [38.5548, -90.4926];
  }

  if (city.includes("washington")) {
    return [38.5581, -91.0121];
  }

  if (city.includes("kirkwood")) {
    return [38.5789, -90.4068];
  }

  if (city.includes("affton")) {
    return [38.5492, -90.3276];
  }

  if (city.includes("oakville")) {
    return [38.4567, -90.3237];
  }

  return null;
}

function offsetCoordinates(origin: Coordinates, seed: string): Coordinates {
  const hash = getDeterministicHash(seed);
  const angle = ((hash % 360) * Math.PI) / 180;
  const distanceMiles = 0.18 + ((hash % 7) * 0.06);
  const latOffset = distanceMiles / 69;
  const lngOffset = distanceMiles / (69 * Math.cos(toRadians(origin[0])));

  return [origin[0] + Math.sin(angle) * latOffset, origin[1] + Math.cos(angle) * lngOffset];
}

function getDeterministicHash(value: string) {
  return value.split("").reduce((hash, character) => {
    return (hash * 31 + character.charCodeAt(0)) >>> 0;
  }, 0);
}

function getJobZipMapPosition(zipCode?: string) {
  const normalizedZip = zipCode?.replace(/\D/g, "") ?? "";
  const knownExactZips: Record<string, Coordinates> = {
    "63026": [38.5131, -90.4359],
    "63077": stClairCenter,
    "63088": [38.5548, -90.4926],
    "63090": [38.5581, -91.0121],
    "63101": stLouisCenter,
    "63102": [38.6257, -90.1848],
    "63103": [38.6312, -90.2146],
    "63104": [38.6107, -90.2126],
    "63105": [38.6426, -90.3237],
    "63110": [38.6207, -90.2557],
    "63118": [38.5948, -90.2294],
    "63122": [38.5789, -90.4068],
    "63123": [38.5492, -90.3276],
    "63129": [38.4567, -90.3237],
    "63143": [38.6126, -90.3246],
    "63301": [38.7881, -90.4974],
    "63303": [38.7545, -90.5468],
    "63304": [38.7326, -90.6351]
  };

  if (knownExactZips[normalizedZip]) {
    return knownExactZips[normalizedZip];
  }

  return null;
}

function warnJobLocationFallback(job: JobListing) {
  if (warnedJobLocationFallbackIds.has(job.id)) {
    return;
  }

  warnedJobLocationFallbackIds.add(job.id);
  console.warn("Workplace Match: using fallback coordinates for job location.", {
    title: job.title,
    locationStreet: job.locationStreet,
    locationCity: job.locationCity,
    locationState: job.locationState,
    locationZip: job.locationZip
  });
}

function warnJobApproximateFallback(job: JobListing) {
  if (warnedJobZipFallbackIds.has(job.id)) {
    return;
  }

  warnedJobZipFallbackIds.add(job.id);
  console.warn("Workplace Match: exact job address not mapped; using approximate offset job location.", {
    title: job.title,
    addressUsed: formatJobLocation(job),
    locationStreet: job.locationStreet,
    locationCity: job.locationCity,
    locationState: job.locationState,
    locationZip: job.locationZip
  });
}

function formatJobLocation(job: JobListing) {
  const cityStateZip = [job.locationCity, [job.locationState, job.locationZip].filter(Boolean).join(" ")]
    .filter(Boolean)
    .join(", ");

  return [job.locationStreet, cityStateZip].filter(Boolean).join(", ");
}

function formatApplicantLocation(profile: applicantProfile) {
  const normalizedZip = profile.zipCode?.replace(/\D/g, "") ?? "";
  const zipAreaLabel = getApplicantZipAreaLabel(normalizedZip);

  if (zipAreaLabel && normalizedZip) {
    return `${zipAreaLabel} ZIP area ${normalizedZip}`;
  }

  if (normalizedZip) {
    return `ZIP area ${normalizedZip}`;
  }

  return "Generalized ZIP area";
}

function getApplicantZipAreaLabel(zipCode: string) {
  const knownZipLabels: Record<string, string> = {
    "63026": "Fenton, MO",
    "63077": "St. Clair, MO",
    "63088": "Valley Park, MO",
    "63090": "Washington, MO",
    "63101": "St. Louis, MO",
    "63102": "St. Louis, MO",
    "63103": "St. Louis, MO",
    "63104": "St. Louis, MO",
    "63105": "Clayton, MO",
    "63110": "St. Louis, MO",
    "63118": "St. Louis, MO",
    "63122": "Kirkwood, MO",
    "63123": "Affton, MO",
    "63129": "Oakville, MO",
    "63301": "St. Charles, MO",
    "63303": "St. Charles, MO",
    "63304": "St. Charles, MO"
  };

  return knownZipLabels[zipCode] ?? "";
}

function groupApplicantsByLocation(applicants: ApplicantMatchSummary[]) {
  const groups = new Map<string, ApplicantLocationGroup>();

  applicants.forEach((applicant) => {
    const locationKey = `${applicant.position[0].toFixed(4)}:${applicant.position[1].toFixed(4)}`;
    const existingGroup = groups.get(locationKey);

    if (existingGroup) {
      existingGroup.applicants.push(applicant);
      existingGroup.bestMatchPercent = Math.max(existingGroup.bestMatchPercent, applicant.bestMatchPercent);
      return;
    }

    groups.set(locationKey, {
      id: locationKey,
      position: applicant.position,
      locationLabel: applicant.locationLabel,
      applicants: [applicant],
      bestMatchPercent: applicant.bestMatchPercent
    });
  });

  return Array.from(groups.values()).map((group) => ({
    ...group,
    applicants: group.applicants.sort((first, second) => second.bestMatchPercent - first.bestMatchPercent)
  }));
}

function isApplicantInSearchArea(
  applicantPosition: Coordinates,
  jobPosition: Coordinates,
  searchMiles: number | null,
  customAreaPoints: Coordinates[]
) {
  if (customAreaPoints.length >= 3) {
    return isPointInPolygon(applicantPosition, customAreaPoints);
  }

  if (!searchMiles) {
    return true;
  }

  return getDistanceMiles(jobPosition, applicantPosition) <= searchMiles;
}

function getDistanceMiles(origin: Coordinates, destination: Coordinates) {
  const earthRadiusMiles = 3958.8;
  const lat1 = toRadians(origin[0]);
  const lat2 = toRadians(destination[0]);
  const deltaLat = toRadians(destination[0] - origin[0]);
  const deltaLng = toRadians(destination[1] - origin[1]);
  const a =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) * Math.sin(deltaLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return earthRadiusMiles * c;
}

function isPointInPolygon(point: Coordinates, polygon: Coordinates[]) {
  const pointLng = point[1];
  const pointLat = point[0];
  let isInside = false;

  for (let current = 0, previous = polygon.length - 1; current < polygon.length; previous = current++) {
    const currentLat = polygon[current][0];
    const currentLng = polygon[current][1];
    const previousLat = polygon[previous][0];
    const previousLng = polygon[previous][1];
    const intersects =
      currentLat > pointLat !== previousLat > pointLat &&
      pointLng < ((previousLng - currentLng) * (pointLat - currentLat)) / (previousLat - currentLat) + currentLng;

    if (intersects) {
      isInside = !isInside;
    }
  }

  return isInside;
}

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function createJobIcon() {
  return L.divIcon({
    className: "",
    html: '<div style="display:flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:9999px;border:3px solid white;background:#dc2626;color:white;font-size:12px;font-weight:800;box-shadow:0 10px 24px rgba(0,0,0,0.25);">Job</div>',
    iconSize: [42, 42],
    iconAnchor: [21, 21],
    popupAnchor: [0, -18]
  });
}

function createApplicantCountIcon(count: number, interestState: ApplicantInterestState) {
  const interestBadge =
    interestState === "employer_interested" || interestState === "mutual_match"
      ? '<span style="position:absolute;top:-9px;right:-9px;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:9999px;border:2px solid white;background:#991b1b;color:white;font-size:14px;font-weight:900;box-shadow:0 6px 14px rgba(0,0,0,0.2);">&hearts;</span>'
      : "";
  const matchBadge =
    interestState === "mutual_match"
      ? '<span style="position:absolute;top:-13px;right:-18px;display:flex;align-items:center;justify-content:center;height:22px;padding:0 8px;border-radius:9999px;border:2px solid white;background:#991b1b;color:white;font-size:10px;font-weight:900;letter-spacing:0.04em;box-shadow:0 6px 14px rgba(0,0,0,0.2);">MATCH</span>'
      : "";

  return L.divIcon({
    className: "",
    html: `<div style="position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:48px;height:44px;padding:0 12px;border-radius:9999px;border:3px solid white;background:#dc2626;color:white;font-size:16px;font-weight:900;box-shadow:0 10px 24px rgba(0,0,0,0.25);">${count}${interestBadge}${matchBadge}</div>`,
    iconSize: [52, 44],
    iconAnchor: [26, 22],
    popupAnchor: [0, -20]
  });
}

function createLegacyMatchIcon(percentage: number, interestState: ApplicantInterestState) {
  if (interestState === "mutual_match") {
    return L.divIcon({
      className: "",
      html: '<div style="display:flex;align-items:center;justify-content:center;min-width:62px;height:44px;padding:0 10px;border-radius:9999px;border:3px solid white;background:#dc2626;color:white;font-size:13px;font-weight:900;box-shadow:0 10px 24px rgba(0,0,0,0.25);">MATCH</div>',
      iconSize: [68, 44],
      iconAnchor: [34, 22],
      popupAnchor: [0, -20]
    });
  }

  if (interestState === "employer_interested") {
    return L.divIcon({
      className: "",
      html: '<div style="display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:9999px;border:3px solid white;background:#be123c;color:white;font-size:22px;font-weight:900;box-shadow:0 10px 24px rgba(0,0,0,0.25);">â™¥</div>',
      iconSize: [48, 48],
      iconAnchor: [24, 24],
      popupAnchor: [0, -20]
    });
  }

  return L.divIcon({
    className: "",
    html: `<div style="display:flex;align-items:center;justify-content:center;min-width:52px;height:44px;padding:0 10px;border-radius:9999px;border:3px solid white;background:${getPinColor(percentage)};color:white;font-size:14px;font-weight:800;box-shadow:0 10px 24px rgba(0,0,0,0.25);">${percentage}%</div>`,
    iconSize: [58, 44],
    iconAnchor: [29, 22],
    popupAnchor: [0, -20]
  });
}

function getPinColor(percentage: number) {
  if (percentage >= 70) {
    return "#16a34a";
  }

  if (percentage >= 40) {
    return "#ca8a04";
  }

  return "#b91c1c";
}

function createMatchIcon(percentage: number, interestState: ApplicantInterestState) {
  const interestBadge =
    interestState === "employer_interested" || interestState === "mutual_match"
      ? '<span style="position:absolute;top:-9px;right:-9px;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:9999px;border:2px solid white;background:#991b1b;color:white;font-size:14px;font-weight:900;box-shadow:0 6px 14px rgba(0,0,0,0.2);">&hearts;</span>'
      : "";
  const matchBadge =
    interestState === "mutual_match"
      ? '<span style="position:absolute;top:-13px;right:-18px;display:flex;align-items:center;justify-content:center;height:22px;padding:0 8px;border-radius:9999px;border:2px solid white;background:#991b1b;color:white;font-size:10px;font-weight:900;letter-spacing:0.04em;box-shadow:0 6px 14px rgba(0,0,0,0.2);">MATCH</span>'
      : "";

  return L.divIcon({
    className: "",
    html: `<div style="position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:56px;height:44px;padding:0 12px;border-radius:9999px;border:3px solid white;background:#dc2626;color:white;font-size:14px;font-weight:900;box-shadow:0 10px 24px rgba(0,0,0,0.25);">${percentage}%${interestBadge}${matchBadge}</div>`,
    iconSize: [58, 44],
    iconAnchor: [29, 22],
    popupAnchor: [0, -20]
  });
}

function calculateSkillMatch(requiredSkillsValue: string[], candidateSkillsValue: string[], jobTitle = "") {
  const requiredSkills = parseFlexibleSkills(requiredSkillsValue);
  const candidateSkills = parseFlexibleSkills(candidateSkillsValue);
  const scoredRequirements = requiredSkills.map((requiredSkill) => ({
    skill: requiredSkill,
    score: getBestRequirementScore(requiredSkill, candidateSkills)
  }));
  const matchedSkills = scoredRequirements.filter((result) => result.score > 0).map((result) => result.skill);
  const missingSkills = scoredRequirements.filter((result) => result.score === 0).map((result) => result.skill);
  const totalScore = scoredRequirements.reduce((sum, result) => sum + result.score, 0);
  const calculatedPercentage =
    requiredSkills.length > 0 ? Math.min(100, Math.round((totalScore / requiredSkills.length) * 100)) : 0;
  const percentage = Math.max(
    calculatedPercentage,
    getLeadershipCrewMatchFloor(candidateSkills, requiredSkills, jobTitle)
  );

  return {
    percentage,
    matchedSkills,
    missingSkills
  };
}

function getApplicantMatchSignals(profile: applicantProfile | null) {
  if (!profile) {
    return [];
  }

  return [
    ...(profile.topSkills ?? []),
    profile.desiredJobType ?? "",
    profile.capabilitySummary ?? "",
    profile.experienceLevel ?? ""
  ].filter(Boolean);
}

function parseFlexibleSkills(value: string[]) {
  return value
    .flatMap((skill) => skill.split(/[,\r\n]+/))
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function normalizeSkill(skill: string) {
  return skill
    .toLowerCase()
    .trim()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/[-\s]+/g, " ")
    .trim();
}

const capabilityTranslationGroups = [
  ["leadership", "supervisor", "team lead", "shift lead", "crew lead", "manager", "management", "assistant manager"],
  ["operational planning", "operations", "logistics", "coordination", "planning", "scheduling"],
  ["process improvement", "lean", "continuous improvement", "efficiency", "workflow improvement"],
  ["risk assessment", "safety", "compliance", "hazard analysis", "risk management"],
  ["team development", "training", "mentoring", "coaching", "onboarding"],
  [
    "decision making under pressure",
    "decision making",
    "fast paced",
    "emergency response",
    "dispatch",
    "production leadership",
    "critical decisions"
  ],
  ["systems thinking", "process mapping", "root cause analysis", "workflow", "operations support"],
  ["adaptability", "changing priorities", "fast paced environment", "flexible", "problem solving"],
  ["execution", "delivery", "follow through", "implementation", "operations"]
].map((group) => group.map(normalizeSkill));

const hierarchyTransferGroups = [
  {
    sources: ["leadership", "team development", "supervisor", "manager", "assistant manager", "shift lead", "team lead", "crew lead"],
    targets: ["crew", "crew member", "team member", "associate", "frontline worker", "frontline", "staff member"],
    score: 0.7
  },
  {
    sources: ["leadership", "team development", "execution", "decision making", "decision making under pressure", "supervisor", "manager", "assistant manager", "shift lead", "team lead"],
    targets: ["shift lead", "team lead", "crew lead", "assistant manager", "supervisor"],
    score: 0.9
  },
  {
    sources: ["operational planning", "operations", "logistics", "process improvement", "execution", "fulfillment", "inventory"],
    targets: ["picker", "warehouse associate", "warehouse", "inventory", "fulfillment", "stocker", "stock associate"],
    score: 0.7
  },
  {
    sources: ["safety", "risk assessment", "compliance", "hazard analysis", "risk management"],
    targets: ["warehouse", "production", "operations support"],
    score: 0.45
  },
  {
    sources: ["safety", "risk assessment", "compliance", "hazard analysis", "risk management"],
    targets: ["forklift", "warehouse", "production", "operations support"],
    score: 0.35
  },
  {
    sources: ["forklift", "equipment operation", "equipment operations", "warehouse machinery", "machinery", "powered industrial truck", "pallet jack"],
    targets: ["forklift", "equipment operation", "warehouse machinery"],
    score: 0.95
  },
  {
    sources: ["adaptability", "execution", "systems thinking", "problem solving", "workflow"],
    targets: ["operations support", "associate", "team member", "fulfillment"],
    score: 0.5
  }
].map((group) => ({
  ...group,
  sources: group.sources.map(normalizeSkill),
  targets: group.targets.map(normalizeSkill)
}));

function getBestRequirementScore(requiredSkill: string, candidateSkills: string[]) {
  return candidateSkills.reduce(
    (bestScore, candidateSkill) => Math.max(bestScore, getSkillMatchScore(requiredSkill, candidateSkill)),
    0
  );
}

function getSkillMatchScore(requiredSkill: string, candidateSkill: string) {
  const requiredForms = getSkillForms(requiredSkill);
  const candidateForms = getSkillForms(candidateSkill);

  // Exact matches get full credit. This catches direct skill overlap after
  // normalizing case, punctuation, whitespace, and simple plurals.
  if (requiredForms.some((requiredForm) => candidateForms.includes(requiredForm))) {
    return 1;
  }

  // Translation matches get strong partial credit when both sides land in the
  // same capability family, such as leadership -> supervisor.
  const requiredConcepts = getCapabilityConcepts(requiredForms);
  const candidateConcepts = getCapabilityConcepts(candidateForms);
  if (requiredConcepts.some((concept) => candidateConcepts.includes(concept))) {
    return 0.85;
  }

  // Hierarchy matches get medium credit when higher-level capability supports a
  // lower-level role in the same work family. This lets shift lead support crew,
  // operations support picker, and safety support forklift without making
  // unrelated kitchen/cook requirements look matched.
  return getHierarchyTransferScore(requiredForms, candidateForms);
}

function getSkillForms(skill: string) {
  const normalized = normalizeSkill(skill);
  const singularized = normalized
    .split(" ")
    .map(singularizeWord)
    .join(" ");
  return Array.from(new Set([normalized, singularized].filter(Boolean)));
}

function singularizeWord(word: string) {
  if (word.endsWith("ies") && word.length > 4) {
    return `${word.slice(0, -3)}y`;
  }

  if (word.endsWith("es") && word.length > 4) {
    return word.slice(0, -2);
  }

  if (word.endsWith("s") && word.length > 3) {
    return word.slice(0, -1);
  }

  return word;
}

function getCapabilityConcepts(skillForms: string[]) {
  return capabilityTranslationGroups
    .map((group, index) =>
      group.some((term) =>
        skillForms.some(
          (skillForm) =>
            skillForm === term ||
            skillForm.includes(term) ||
            (skillForm.length >= 4 && term.includes(skillForm))
        )
      )
        ? index
        : -1
    )
    .filter((index) => index >= 0);
}

function getHierarchyTransferScore(requiredForms: string[], candidateForms: string[]) {
  return hierarchyTransferGroups.reduce((bestScore, group) => {
    const hasSource = group.sources.some((source) => skillFormsContain(candidateForms, source));
    const hasTarget = group.targets.some((target) => skillFormsContain(requiredForms, target));

    return hasSource && hasTarget ? Math.max(bestScore, group.score) : bestScore;
  }, 0);
}

function getLeadershipCrewMatchFloor(candidateSkills: string[], requiredSkills: string[], jobTitle: string) {
  const candidateForms = candidateSkills.flatMap(getSkillForms);
  const roleForms = [...requiredSkills, jobTitle].flatMap(getSkillForms);
  const hasLeadership = leadershipFloorTerms.some((term) => skillFormsContain(candidateForms, term));
  const isCrewRole = crewFloorTerms.some((term) => skillFormsContain(roleForms, term));

  return hasLeadership && isCrewRole ? 30 : 0;
}

const leadershipFloorTerms = [
  "leadership",
  "team development",
  "supervisor",
  "manager",
  "shift lead",
  "crew lead"
].map(normalizeSkill);

const crewFloorTerms = ["crew", "crew member", "team member", "associate", "entry level"].map(normalizeSkill);

function skillFormsContain(skillForms: string[], term: string) {
  return skillForms.some(
    (skillForm) =>
      skillForm === term ||
      skillForm.includes(term) ||
      (skillForm.length >= 4 && term.includes(skillForm))
  );
}


