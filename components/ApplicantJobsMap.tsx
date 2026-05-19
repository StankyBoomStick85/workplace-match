"use client";

import L from "leaflet";
import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
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
import { logError } from "../lib/logError";
import {
  addInterest as addSupabaseInterest,
  addMutualMatch as addSupabaseMutualMatch,
  getAllJobs,
  getApplicantInterests,
  getApplicantProfile,
  getCurrentMvpUser,
  getEmployerInterests,
  getMutualMatches,
  removeInterest as removeSupabaseInterest
} from "../lib/supabaseMvpData";
import { supabase } from "../lib/supabase";
import { RemoveInterestConfirmationModal } from "./RemoveInterestConfirmationModal";

type ApplicantAccount = {
  id?: string;
  email: string;
  displayName?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  manualMapLat?: number;
  manualMapLng?: number;
  profilePictureDataUrl?: string;
  preferredContactMethods?: ContactMethod[];
};

type ApplicantProfile = {
  fullName?: string;
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  manualMapLat?: number;
  manualMapLng?: number;
  profilePictureDataUrl?: string;
  profilePictureUrl?: string;
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

type CompanyProfile = {
  employerEmail: string;
  companyName?: string;
  city?: string;
  state?: string;
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
  candidateId: string;
  employerId: string;
  jobId: string;
  matchPercent: number;
  createdAt: string;
  status: "candidate_interested";
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

type InterestState = "none" | "candidate_interested" | "mutual_match";
type SelectedJobSource = "cluster" | "single" | "results" | null;
type InterestStatusFilter = "all" | "not_marked" | "interested" | "matched";
type JobSortMode = "balanced" | "best_match" | "closest";
type JobFilters = {
  minimumMatchPercent: number;
  commuteMaxMinutes: number | null;
  jobType: string;
  schedule: string;
  minHourlyPay: number | null;
  interestStatus: InterestStatusFilter;
};

type EmployerAccount = {
  email: string;
  password?: string;
  displayName?: string;
  companyName?: string;
  phone?: string;
  preferredContactMethods?: ContactMethod[];
  availabilityWindows?: string[];
};
type Coordinates = [number, number];
type ApplicantMapLocationResolution = {
  position: Coordinates | null;
  source: "manual coordinates" | "exact address" | "ZIP fallback" | "unresolved";
};
type JobGroup = {
  key: string;
  position: Coordinates;
  jobs: JobListing[];
};

type ExternalJob = {
  id: string;
  title: string;
  company: string;
  location: string;
  lat: number;
  lng: number;
  salary_min: number | null;
  salary_max: number | null;
  job_type: string | null;
  url: string;
  description?: string;
  source: "adzuna";
};

const applicantAccountKey = "workplace_match_candidate";
const applicantAccountsKey = "workplace_match_candidate_accounts";
const employerAccountKey = "workplace_match_employer";
const employerAccountsKey = "workplace_match_employer_accounts";
const applicantProfileKey = "workplace_match_candidate_profile";
const employerJobsKey = "workplace_match_employer_jobs";
const employerCompanyProfileKey = "workplace_match_employer_company_profile";
const employerInterestsKey = "workplace_match_employer_interests";
const applicantInterestsKey = "workplace_match_candidate_interests";
const mutualMatchesKey = "workplace_match_mutual_matches";
const activeRoleKey = "workplace_match_active_role";
const activeEmailKey = "workplace_match_active_email";
const jobsMapPrivacyAcknowledgementKey = "workplace_match_jobs_map_privacy_acknowledged";
const savedFiltersKey = "workplace_match_saved_filters";
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
const minimumMatchOptions = [
  { label: "All jobs", value: 0 },
  { label: "25%+", value: 25 },
  { label: "50%+", value: 50 },
  { label: "70%+", value: 70 }
];
const commuteFilterOptions = [
  { label: "All", value: "" },
  { label: "15 min or less", value: "15" },
  { label: "30 min or less", value: "30" },
  { label: "45 min or less", value: "45" },
  { label: "60 min or less", value: "60" }
];
const fallbackJobTypeOptions = ["Full-time", "Part-time", "Contract", "Temporary"];
const fallbackScheduleOptions = ["Day", "Evening", "Night", "Rotating", "Flexible"];
const payFilterOptions = [
  { label: "All", value: "" },
  { label: "$15+/hr", value: "15" },
  { label: "$20+/hr", value: "20" },
  { label: "$25+/hr", value: "25" },
  { label: "$30+/hr", value: "30" }
];
const interestStatusOptions: Array<{ label: string; value: InterestStatusFilter }> = [
  { label: "All", value: "all" },
  { label: "Not marked", value: "not_marked" },
  { label: "Interested", value: "interested" },
  { label: "Matched", value: "matched" }
];
const sortOptions: Array<{ label: string; value: JobSortMode }> = [
  { label: "Balanced", value: "balanced" },
  { label: "Best match", value: "best_match" },
  { label: "Closest", value: "closest" }
];

L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png"
});

export function ApplicantJobsMap() {
  const [account, setAccount] = useState<ApplicantAccount | null>(null);
  const [profile, setProfile] = useState<ApplicantProfile | null>(null);
  const [jobs, setJobs] = useState<JobListing[]>([]);
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile | null>(null);
  const [applicantInterests, setApplicantInterests] = useState<ApplicantInterest[]>([]);
  const [employerInterests, setEmployerInterests] = useState<EmployerInterest[]>([]);
  const [mutualMatches, setMutualMatches] = useState<MutualMatch[]>([]);
  const [searchMiles, setSearchMiles] = useState<number | null>(null);
  const [customMiles, setCustomMiles] = useState("");
  const [isDrawingCustomArea, setIsDrawingCustomArea] = useState(false);
  const [customAreaPoints, setCustomAreaPoints] = useState<Coordinates[]>([]);
  const [showMatchPopup, setShowMatchPopup] = useState(false);
  const [matchPopupJob, setMatchPopupJob] = useState<JobListing | null>(null);
  const [pendingRemoveInterestJob, setPendingRemoveInterestJob] = useState<JobListing | null>(null);
  const [selectedGroupedJobId, setSelectedGroupedJobId] = useState("");
  const [selectedJobSource, setSelectedJobSource] = useState<SelectedJobSource>(null);
  const [clusterToReopenKey, setClusterToReopenKey] = useState("");
  const [mapZoom, setMapZoom] = useState(10);
  const [hasAcknowledgedPrivacyNotice, setHasAcknowledgedPrivacyNotice] = useState(true);
  const [minimumMatchPercent, setMinimumMatchPercent] = useState(0);
  const [isPanelCollapsed, setIsPanelCollapsed] = useState(false);
  const [isFiltersExpanded, setIsFiltersExpanded] = useState(false);
  const [commuteMaxMinutes, setCommuteMaxMinutes] = useState<number | null>(null);
  const [jobTypeFilter, setJobTypeFilter] = useState("");
  const [scheduleFilter, setScheduleFilter] = useState("");
  const [minHourlyPay, setMinHourlyPay] = useState<number | null>(null);
  const [interestStatusFilter, setInterestStatusFilter] = useState<InterestStatusFilter>("all");
  const [filterSaveMessage, setFilterSaveMessage] = useState("");
  const [sortMode, setSortMode] = useState<JobSortMode>("balanced");
  const [hoveredResultJobId, setHoveredResultJobId] = useState("");
  const [selectedResultJobId, setSelectedResultJobId] = useState("");
  const [geocodedZipCenter, setGeocodedZipCenter] = useState<Coordinates | null>(null);
  const [externalJobs, setExternalJobs] = useState<ExternalJob[]>([]);
  const [matchScores, setMatchScores] = useState<Record<string, number>>({});
  const [scoringInProgress, setScoringInProgress] = useState(false);
  const [savedExternalJobIds, setSavedExternalJobIds] = useState<Set<string>>(new Set());
  const pollAttemptsRef = useRef(0);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const clusterMarkerRefs = useRef<Record<string, L.Marker | null>>({});
  const singleJobMarkerRefs = useRef<Record<string, L.Marker | null>>({});
  const detailPanelRef = useRef<HTMLDivElement | null>(null);
  const suppressClusterReopenRef = useRef(false);
  const wasDrawingRef = useRef(false);

  useEffect(() => {
    loadMapData();

    async function loadMapData() {
      const user = await getCurrentMvpUser("candidate");
      if (!user) {
        window.location.href = "/applicant/login";
        return;
      }

      const [savedProfile, savedJobs, savedApplicantInterests, savedEmployerInterests, savedMutualMatches] =
        await Promise.all([
          getApplicantProfile(user.id),
          getAllJobs(),
          getApplicantInterests(),
          getEmployerInterests(),
          getMutualMatches()
        ]);

      const parsedAccount = { id: user.id, email: user.email };
      setAccount(parsedAccount);
      setProfile(savedProfile ?? getApplicantMapProfileFromAccount(parsedAccount));
      setHasAcknowledgedPrivacyNotice(true);

      // Load already-saved external job IDs
      const { data: savedRows } = await supabase
        .from("saved_jobs")
        .select("job_id")
        .eq("candidate_id", user.id);
      if (savedRows) {
        setSavedExternalJobIds(new Set((savedRows as Array<{ job_id: string }>).map((r) => r.job_id)));
      }

      // Load any already-computed scores
      const { data: scoreRows } = await supabase
        .from("match_scores")
        .select("job_id, score")
        .eq("candidate_id", user.id)
        .gt("expires_at", new Date().toISOString());
      if (scoreRows && scoreRows.length > 0) {
        const initial: Record<string, number> = {};
        (scoreRows as Array<{ job_id: string; score: number }>).forEach((r) => { initial[r.job_id] = r.score; });
        setMatchScores(initial);
      }

      setJobs(getEmployerCreatedJobs(savedJobs as JobListing[]));
      setCompanyProfile(null);
      setApplicantInterests(savedApplicantInterests as ApplicantInterest[]);
      setEmployerInterests(savedEmployerInterests as EmployerInterest[]);
      setMutualMatches(savedMutualMatches as MutualMatch[]);
    }
  }, []);

  // Cleanup polling interval on unmount
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  const candidateId = profile ? getApplicantInterestId(profile) : "candidate-profile:local-mvp";
  const applicantLocationResolution = useMemo(
    () => getApplicantSelfMapResolution(account, profile),
    [account, profile]
  );
  const applicantAreaPosition = applicantLocationResolution.position;
  const applicantProfilePicture = profile?.profilePictureUrl ?? "";

  const zipToGeocode =
    applicantLocationResolution.source === "unresolved"
      ? (account?.zipCode ?? profile?.zipCode ?? "")
      : "";

  useEffect(() => {
    if (!zipToGeocode) {
      setGeocodedZipCenter(null);
      return;
    }
    let cancelled = false;
    fetch(
      `https://nominatim.openstreetmap.org/search?postalcode=${encodeURIComponent(zipToGeocode)}&country=US&format=json&limit=1`,
      { headers: { "Accept-Language": "en" } }
    )
      .then((r) => r.json())
      .then((data: Array<{ lat: string; lon: string }>) => {
        if (cancelled || !data?.[0]) return;
        const lat = parseFloat(data[0].lat);
        const lon = parseFloat(data[0].lon);
        if (isFinite(lat) && isFinite(lon)) setGeocodedZipCenter([lat, lon]);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [zipToGeocode]);

  const applicantAreaCenter = useMemo(
    () => applicantAreaPosition ?? geocodedZipCenter ?? stLouisCenter,
    [applicantAreaPosition, geocodedZipCenter]
  );
  const mapCenter = useMemo(() => getInitialMapCenter(applicantAreaCenter), [applicantAreaCenter]);

  useEffect(() => {
    let cancelled = false;
    const [lat, lng] = applicantAreaCenter;
    const radius = searchMiles ?? 25;
    const userId = account?.id;

    async function loadExternalJobs() {
      try {
        await fetch("/api/scoring/refresh-adzuna-cache", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat, lng, radius })
        });
        if (cancelled) return;

        const res = await fetch(`/api/jobs/external?lat=${lat}&lng=${lng}&radius=${radius}`);
        if (cancelled) return;
        const data: { jobs?: ExternalJob[] } = await res.json();
        if (cancelled) return;
        console.log("[jobs/external] cache returned", data.jobs?.length ?? 0, "jobs");
        setExternalJobs(data.jobs ?? []);

        if (userId) startScorePolling(userId);
      } catch (err) {
        if (cancelled) return;
        console.error("[jobs/external] error", err);
        logError({
          route: "/applicant/job-map",
          errorMessage: err instanceof Error ? err.message : String(err),
          errorType: "api_error",
          severity: "medium"
        });
      }
    }

    loadExternalJobs();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applicantAreaCenter[0], applicantAreaCenter[1], searchMiles, account?.id]);

  useEffect(() => {
    const wasDrawing = wasDrawingRef.current;
    wasDrawingRef.current = isDrawingCustomArea;

    if (!wasDrawing || isDrawingCustomArea || customAreaPoints.length < 3) return;

    let cancelled = false;
    const userId = account?.id;
    const centroid = computePolygonCentroid(customAreaPoints);
    const maxRadius = computeMaxDistanceMiles(centroid, customAreaPoints);
    const lat = centroid.lat;
    const lng = centroid.lng;
    const radius = Math.max(10, Math.ceil(maxRadius));

    async function loadCustomAreaJobs() {
      try {
        await fetch("/api/scoring/refresh-adzuna-cache", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat, lng, radius })
        });
        if (cancelled) return;

        const res = await fetch(`/api/jobs/external?lat=${lat}&lng=${lng}&radius=${radius}`);
        if (cancelled) return;
        const data: { jobs?: ExternalJob[] } = await res.json();
        if (cancelled) return;

        const filtered = (data.jobs ?? []).filter((job) =>
          isPointInPolygon([job.lat, job.lng], customAreaPoints)
        );
        console.log("[custom-area] filtered", filtered.length, "of", data.jobs?.length ?? 0, "jobs inside polygon");
        setExternalJobs(filtered);

        if (userId) startScorePolling(userId);
      } catch (err) {
        if (cancelled) return;
        console.error("[custom-area] error", err);
      }
    }

    loadCustomAreaJobs();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDrawingCustomArea, customAreaPoints]);

  const hasCustomArea = customAreaPoints.length >= 3;
  const filters: JobFilters = {
    minimumMatchPercent,
    commuteMaxMinutes,
    jobType: jobTypeFilter,
    schedule: scheduleFilter,
    minHourlyPay,
    interestStatus: interestStatusFilter
  };
  const activeFilterCount = getActiveFilterCount(filters);
  const jobTypeOptions = useMemo(() => getFilterOptions(jobs.map((job) => job.jobType), fallbackJobTypeOptions), [jobs]);
  const scheduleOptions = useMemo(() => getFilterOptions(jobs.map((job) => job.schedule), fallbackScheduleOptions), [jobs]);
  const visibleJobs = useMemo(
    () =>
      sortJobs(
        jobs.filter((job) =>
          shouldShowJob(
            job,
            applicantAreaCenter,
            applicantAreaPosition,
            searchMiles,
            customAreaPoints,
            filters,
            profile,
            getJobInterestState(job)
          )
        ),
        sortMode,
        profile,
        applicantAreaPosition
      ),
    [
      jobs,
      applicantAreaCenter,
      applicantAreaPosition,
      searchMiles,
      customAreaPoints,
      minimumMatchPercent,
      commuteMaxMinutes,
      jobTypeFilter,
      scheduleFilter,
      minHourlyPay,
      interestStatusFilter,
      sortMode,
      profile,
      applicantInterests,
      mutualMatches
    ]
  );
  const visibleJobGroups = useMemo(
    () => groupJobsByLocation(visibleJobs, mapZoom),
    [visibleJobs, mapZoom]
  );
  const selectedResultJob = useMemo(
    () => jobs.find((job) => job.id === selectedResultJobId) ?? null,
    [selectedResultJobId, jobs]
  );
  const selectedResultJobPosition = useMemo(
    () => (selectedResultJob ? getJobMapPosition(selectedResultJob) : null),
    [selectedResultJob]
  );

  useEffect(() => {
    detailPanelRef.current?.scrollTo({ top: 0, behavior: "auto" });
  }, [selectedResultJob?.id]);

  useEffect(() => {
    focusMatchFromLocation();
    window.addEventListener("workplace-match-focus-match", focusMatchFromLocation);

    return () => {
      window.removeEventListener("workplace-match-focus-match", focusMatchFromLocation);
    };

    function focusMatchFromLocation() {
      const params = new URLSearchParams(window.location.search);
      const matchJobId = params.get("matchJobId");
      if (!matchJobId) {
        return;
      }

      const matchedJob = jobs.find((job) => job.id === matchJobId);
      if (!matchedJob) {
        return;
      }

      setMinimumMatchPercent(0);
      setCommuteMaxMinutes(null);
      setJobTypeFilter("");
      setScheduleFilter("");
      setMinHourlyPay(null);
      setInterestStatusFilter("all");
      setSelectedGroupedJobId("");
      setClusterToReopenKey("");
      openJobFromResults(matchedJob);
    }
  }, [jobs]);

  useEffect(() => {
    console.log("Workplace Match: applicant Me marker source.", {
      source: applicantLocationResolution.source,
      coordinates: applicantLocationResolution.position
    });
  }, [applicantLocationResolution.source, applicantLocationResolution.position]);

  useEffect(() => {
    if (!clusterToReopenKey || selectedGroupedJobId) {
      return;
    }

    const marker = clusterMarkerRefs.current[clusterToReopenKey];
    if (!marker) {
      setClusterToReopenKey("");
      return;
    }

    window.setTimeout(() => marker.openPopup(), 0);
    setClusterToReopenKey("");
  }, [clusterToReopenKey, selectedGroupedJobId, visibleJobGroups]);

  function getJobInterestState(job: JobListing): InterestState {
    const hasMutualMatch = mutualMatches.some(
      (match) =>
        match.employerId === job.employerEmail &&
        match.jobId === job.id &&
        match.candidateId === candidateId
    );

    if (hasMutualMatch) {
      return "mutual_match";
    }

    const hasApplicantInterest = applicantInterests.some(
      (interest) =>
        interest.employerId === job.employerEmail &&
        interest.jobId === job.id &&
        interest.candidateId === candidateId
    );

    return hasApplicantInterest ? "candidate_interested" : "none";
  }

  function toggleApplicantInterest(job: JobListing, matchPercent: number) {
    const interestState = getJobInterestState(job);

    if (interestState !== "none") {
      setPendingRemoveInterestJob(job);
      return;
    }

    const nextInterest: ApplicantInterest = {
      candidateId,
      employerId: job.employerEmail,
      jobId: job.id,
      matchPercent,
      createdAt: new Date().toISOString(),
      status: "candidate_interested"
    };
    const hasEmployerInterest = employerInterests.some(
      (interest) =>
        interest.employerId === nextInterest.employerId &&
        interest.jobId === nextInterest.jobId &&
        interest.candidateId === nextInterest.candidateId
    );

    setApplicantInterests((current) => {
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
        fromUserId: nextInterest.candidateId,
        toUserId: job.employerId ?? nextInterest.employerId,
        jobId: nextInterest.jobId
      });
      logAdminEvent({
        type: "interest_selected",
        userRole: "candidate",
        jobId: nextInterest.jobId,
        applicantId: nextInterest.candidateId,
        employerId: nextInterest.employerId,
        dedupeKey: `candidate-interest:${nextInterest.employerId}:${nextInterest.jobId}:${nextInterest.candidateId}`
      });
      return updated;
    });

    if (hasEmployerInterest) {
      const nextMutualMatch = createMutualMatchRecord(nextInterest);
      setShowMatchPopup(true);
      setMatchPopupJob(job);

      setMutualMatches((current) => {
        const alreadyExists = current.some(
          (match) =>
            match.employerId === nextMutualMatch.employerId &&
            match.jobId === nextMutualMatch.jobId &&
            match.candidateId === nextMutualMatch.candidateId
        );

        if (alreadyExists) {
          return current;
        }

        const updated = [nextMutualMatch, ...current];
        addSupabaseMutualMatch({
          candidateId: nextMutualMatch.candidateId,
          employerId: job.employerId ?? nextMutualMatch.employerId,
          jobId: nextMutualMatch.jobId,
          matchPercent: nextMutualMatch.matchPercent
        });
        logAdminEvent({
          type: "mutual_match_created",
          userRole: "candidate",
          jobId: nextMutualMatch.jobId,
          applicantId: nextMutualMatch.candidateId,
          employerId: nextMutualMatch.employerId,
          dedupeKey: `mutual-match:${nextMutualMatch.employerId}:${nextMutualMatch.jobId}:${nextMutualMatch.candidateId}`
        });
        addNewMatchNotification({
          recipientEmail: nextInterest.employerId,
          senderEmail: account?.email ?? "",
          jobId: nextMutualMatch.jobId,
          jobTitle: job.title,
          candidateId: nextMutualMatch.candidateId,
          employerId: nextInterest.employerId,
          dedupeKey: `new-match:${nextInterest.employerId}:${nextMutualMatch.jobId}:${nextMutualMatch.candidateId}`
        });
        if (account?.email) {
          addNewMatchNotification({
            recipientEmail: account.email,
            senderEmail: nextInterest.employerId,
            jobId: nextMutualMatch.jobId,
            jobTitle: job.title,
            candidateId: nextMutualMatch.candidateId,
            employerId: nextInterest.employerId,
            dedupeKey: `new-match:${account.email}:${nextMutualMatch.jobId}:${nextMutualMatch.candidateId}`
          });
        }
        return updated;
      });
    }
  }

  function removeCandidateInterest(job: JobListing) {
    setShowMatchPopup(false);

    setApplicantInterests((current) => {
      const updated = current.filter(
        (interest) =>
          !(
            interest.employerId === job.employerEmail &&
            interest.jobId === job.id &&
            interest.candidateId === candidateId
          )
      );
      removeSupabaseInterest({
        fromUserId: candidateId,
        toUserId: job.employerId ?? job.employerEmail,
        jobId: job.id
      });
      if (updated.length !== current.length) {
        logAdminEvent({
          type: "interest_removed",
          userRole: "candidate",
          jobId: job.id,
          applicantId: candidateId,
          employerId: job.employerEmail
        });
      }
      return updated;
    });

    setMutualMatches((current) => {
      const updated = current.filter(
        (match) =>
          !(
            match.employerId === job.employerEmail &&
            match.jobId === job.id &&
            match.candidateId === candidateId
          )
      );
      return updated;
    });
  }

  function getJobPopupData(job: JobListing) {
    const clientScore = calculateSkillMatch(job.requiredSkills, getApplicantMatchSignals(profile), job.title).percentage;
    const matchPercent = matchScores[job.id] ?? clientScore;
    const interestState = getJobInterestState(job);
    const commuteEstimate = getJobCommuteEstimate(job, applicantAreaPosition);
    const companyName =
      companyProfile?.employerEmail === job.employerEmail ? companyProfile.companyName || "Employer" : "Employer";

    return { matchPercent, interestState, companyName, commuteEstimate };
  }

  function reachOutToEmployer(job: JobListing) {
    const employerAccount = findEmployerAccount(job.employerEmail);
    const senderLabel = profile?.fullName || account?.displayName || "A mutual match";
    return attemptPreferredContact({
      targetAccount: employerAccount,
      senderLabel,
      jobTitle: job.title
    });
  }

  async function handleSaveExternalJob(job: ExternalJob) {
    if (!account?.id) return;
    const isSaved = savedExternalJobIds.has(job.id);
    if (isSaved) {
      await supabase.from("saved_jobs").delete().eq("candidate_id", account.id).eq("job_id", job.id);
      setSavedExternalJobIds((prev) => { const next = new Set(prev); next.delete(job.id); return next; });
    } else {
      await supabase.from("saved_jobs").upsert({
        candidate_id: account.id,
        job_id: job.id,
        job_source: "adzuna",
        job_title: job.title,
        company: job.company,
        location: job.location,
        salary_min: job.salary_min,
        salary_max: job.salary_max,
        url: job.url
      }, { onConflict: "candidate_id,job_id" });
      setSavedExternalJobIds((prev) => new Set(prev).add(job.id));
    }
  }

  function startScorePolling(userId: string) {
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    setScoringInProgress(true);
    fetch("/api/scoring/score-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ candidateId: userId })
    }).catch(() => {});

    pollAttemptsRef.current = 0;
    const interval = setInterval(async () => {
      pollAttemptsRef.current += 1;
      const { data: polledScores, error: pollError } = await supabase
        .from("match_scores")
        .select("job_id, score")
        .eq("candidate_id", userId)
        .gt("expires_at", new Date().toISOString());
      if (pollError) {
        // Stop immediately on auth/permission errors — retrying won't help
        clearInterval(interval);
        pollIntervalRef.current = null;
        setScoringInProgress(false);
        return;
      }
      if (polledScores && polledScores.length > 0) {
        const updated: Record<string, number> = {};
        (polledScores as Array<{ job_id: string; score: number }>).forEach((r) => { updated[r.job_id] = r.score; });
        setMatchScores(updated);
      }
      if (pollAttemptsRef.current >= 5) {
        clearInterval(interval);
        pollIntervalRef.current = null;
        setScoringInProgress(false);
      }
    }, 3000);
    pollIntervalRef.current = interval;
  }

  function getMatchThread(job: JobListing): MatchThreadContext {
    return {
      applicantId: candidateId,
      employerId: job.employerEmail,
      jobId: job.id
    };
  }

  function sendApplicantMessage(job: JobListing, text: string) {
    if (!account) {
      return;
    }

    const message = addMatchThreadMessage({
      ...getMatchThread(job),
      senderRole: "applicant",
      senderEmail: account.email,
      text
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
  }

  function sendScheduleRequestNotifications(job: JobListing, message: string, dedupeKey?: string) {
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

  function handleApplicantReachOut(job: JobListing) {
    logAdminEvent({
      type: "reach_out_clicked",
      userRole: "candidate",
      jobId: job.id,
      applicantId: candidateId,
      employerId: job.employerEmail
    });
    reachOutToEmployer(job);
    sendApplicantMessage(job, "Let's schedule a time to connect about this match.");
    sendScheduleRequestNotifications(
      job,
      "Schedule conversation requested for a mutual match.",
      `schedule-request:${job.id}:${candidateId}`
    );
  }

  function handleApplicantSchedule(job: JobListing, selectedTime: string) {
    if (!selectedTime.trim()) {
      return;
    }

    const message = `Scheduled for ${selectedTime.trim()}`;
    logAdminEvent({
      type: "schedule_requested",
      userRole: "candidate",
      jobId: job.id,
      applicantId: candidateId,
      employerId: job.employerEmail
    });
    sendApplicantMessage(job, message);
    sendScheduleRequestNotifications(job, `Conversation scheduled for ${selectedTime.trim()}`);
  }

  function renderJobDetail(job: JobListing, onClosePanel?: () => void) {
    const { matchPercent, interestState, companyName, commuteEstimate } = getJobPopupData(job);
    const requiredSkills = parseFlexibleSkills(job.requiredSkills);
    const employerAccount = findEmployerAccount(job.employerEmail);
    const thread = getMatchThread(job);
    const actionBlock =
      interestState === "mutual_match" ? (
        onClosePanel ? (
          <CandidateMutualMatchActions
            thread={thread}
            availabilityWindows={employerAccount?.availabilityWindows ?? []}
            onReachOut={() => {
              handleApplicantReachOut(job);
              onClosePanel();
            }}
            onReachOutLater={onClosePanel}
            onSendMessage={(text) => sendApplicantMessage(job, text)}
            onSchedule={(selectedTime) => handleApplicantSchedule(job, selectedTime)}
            onRemoveInterest={() => {
              toggleApplicantInterest(job, matchPercent);
              onClosePanel();
            }}
          />
        ) : (
          <CandidateMutualMatchPopup
            thread={thread}
            availabilityWindows={employerAccount?.availabilityWindows ?? []}
            onReachOut={() => handleApplicantReachOut(job)}
            onSendMessage={(text) => sendApplicantMessage(job, text)}
            onSchedule={(selectedTime) => handleApplicantSchedule(job, selectedTime)}
            onRemoveInterest={() => toggleApplicantInterest(job, matchPercent)}
          />
        )
      ) : (
        <button
          type="button"
          onClick={() => toggleApplicantInterest(job, matchPercent)}
          className="w-full rounded-md bg-red-900 px-3 py-2 text-sm font-semibold text-white transition hover:bg-red-950"
        >
          {interestState === "candidate_interested" ? "Remove interest" : "Interested"}
        </button>
      );
    const detailContent = (
      <>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
            Job opportunity
          </p>
          <h2 className="mt-1 text-base font-bold text-zinc-950">{job.title}</h2>
          <p className="mt-1 text-sm text-zinc-600">{companyName}</p>
          <p className="mt-1 text-sm text-zinc-600">{formatJobLocation(job)}</p>
          <p className="mt-1 text-sm font-semibold text-zinc-700">
            {commuteEstimate
              ? `Estimated commute: ${commuteEstimate.timeLabel} (${commuteEstimate.distanceLabel} straight-line estimate)`
              : "Commute unavailable"}
          </p>
          {isApproximateJobLocation(job) ? (
            <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900">
              Approximate location - exact address not mapped
            </p>
          ) : null}
        </div>

        <div className="grid gap-2 text-sm">
          <PopupDetail label="Pay" value={job.payRange} />
          <PopupDetail label="Type" value={job.jobType} />
          <PopupDetail label="Schedule" value={job.schedule} />
          <PopupDetail label="Match" value={`${matchPercent}%`} />
        </div>

        {requiredSkills.length > 0 ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
              Required skills
            </p>
            <div className="mt-2 flex max-w-xs flex-wrap gap-1.5">
              {requiredSkills.map((skill) => (
                <span
                  key={skill}
                  className="rounded-full border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-semibold text-zinc-700"
                >
                  {skill}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        {job.description ? (
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">Description</p>
            <p className="mt-2 max-h-28 max-w-xs overflow-y-auto rounded-md border border-gray-200 bg-gray-50 p-3 text-sm leading-5 text-zinc-700">
              {job.description}
            </p>
          </div>
        ) : null}
      </>
    );

    if (!onClosePanel) {
      return (
        <div className="flex max-h-[min(34rem,calc(100vh-8rem))] w-[min(20rem,calc(100vw-6rem))] flex-col overflow-hidden">
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">{detailContent}</div>
          <div className="shrink-0 border-t border-gray-100 bg-white pt-3">{actionBlock}</div>
        </div>
      );
    }

    return (
      <div className="space-y-3">
        {detailContent}
        <div className="sticky bottom-0 bg-white/95 pt-2">
          {actionBlock}
        </div>
      </div>
    );
  }

  function getGroupInterestState(groupJobs: JobListing[]) {
    const states = groupJobs.map(getJobInterestState);

    if (states.includes("mutual_match")) {
      return "mutual_match";
    }

    if (states.includes("candidate_interested")) {
      return "candidate_interested";
    }

    return "none";
  }

  function acknowledgePrivacyNotice() {
    if (!account) {
      return;
    }

    savePrivacyNoticeAcknowledgement(account.email);
    setHasAcknowledgedPrivacyNotice(true);
  }

  function clearFilters() {
    setMinimumMatchPercent(0);
    setCommuteMaxMinutes(null);
    setJobTypeFilter("");
    setScheduleFilter("");
    setMinHourlyPay(null);
    setInterestStatusFilter("all");
    setFilterSaveMessage("");
  }

  function openFilters() {
    setIsFiltersExpanded(true);
  }

  function applySavedFilters(savedFilters: JobFilters) {
    const normalizedFilters = normalizeSavedFilters(savedFilters);
    setMinimumMatchPercent(normalizedFilters.minimumMatchPercent);
    setCommuteMaxMinutes(normalizedFilters.commuteMaxMinutes);
    setJobTypeFilter(normalizedFilters.jobType);
    setScheduleFilter(normalizedFilters.schedule);
    setMinHourlyPay(normalizedFilters.minHourlyPay);
    setInterestStatusFilter(normalizedFilters.interestStatus);
  }

  function saveFilters() {
    setIsFiltersExpanded(false);
    setFilterSaveMessage("Filters saved");
  }

  function openJobFromResults(job: JobListing) {
    suppressClusterReopenRef.current = selectedJobSource === "cluster" && Boolean(selectedGroupedJobId);
    setClusterToReopenKey("");
    setSelectedGroupedJobId("");
    setSelectedJobSource("results");
    setSelectedResultJobId(job.id);
    Object.values(clusterMarkerRefs.current).forEach((marker) => marker?.closePopup());
    Object.values(singleJobMarkerRefs.current).forEach((marker) => marker?.closePopup());

    window.setTimeout(() => {
      suppressClusterReopenRef.current = false;
    }, 0);
  }

  if (!account) {
    return (
      <div className={`fixed inset-x-0 bottom-0 z-40 flex w-screen items-center justify-center bg-[#eef3ef] ${headerOffsetClass}`}>
        <p className="text-sm text-zinc-600">Loading jobs map...</p>
      </div>
    );
  }

  return (
    <section className={`fixed inset-x-0 bottom-0 z-40 w-screen overflow-hidden bg-[#eef3ef] ${headerOffsetClass}`}>
      <MapContainer center={mapCenter} zoom={10} minZoom={4} zoomControl={false} className="absolute inset-0 z-0 h-full w-full">
        <RecenterMap center={mapCenter} />
        <PanToSelectedJob position={selectedResultJobPosition} />
        <ZoomLevelTracker onZoomChange={setMapZoom} />
        <ZoomControl position="bottomright" />
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {applicantAreaPosition ? (
          <Marker
            position={applicantAreaPosition}
            icon={createApplicantAreaIcon(applicantProfilePicture)}
            interactive={false}
            zIndexOffset={1000}
          />
        ) : null}
        {searchMiles && !hasCustomArea ? (
          <Circle
            center={applicantAreaCenter}
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
        <FreehandSearchAreaTool
          enabled={isDrawingCustomArea}
          onDrawingChange={setIsDrawingCustomArea}
          onPointsChange={setCustomAreaPoints}
        />
        {visibleJobGroups.map((group) => {
          if (group.jobs.length === 1) {
            const job = group.jobs[0];
            const { matchPercent, interestState } = getJobPopupData(job);
            const isJobHighlighted = hoveredResultJobId === job.id || selectedResultJobId === job.id;

            return (
              <Marker
                key={job.id}
                ref={(marker) => {
                  singleJobMarkerRefs.current[job.id] = marker;
                }}
                position={group.position}
                icon={createUnifiedJobMatchIcon(
                  matchPercent,
                  interestState,
                  getJobCommuteEstimate(job, applicantAreaPosition)?.timeLabel ?? null,
                  isJobHighlighted
                )}
                zIndexOffset={isJobHighlighted ? 500 : 0}
                eventHandlers={{
                  popupopen: () => {
                    setSelectedGroupedJobId("");
                    setClusterToReopenKey("");
                    setSelectedJobSource("single");
                    setSelectedResultJobId("");
                  },
                  popupclose: () => {
                    if (suppressClusterReopenRef.current) {
                      suppressClusterReopenRef.current = false;
                      return;
                    }

                    setSelectedGroupedJobId("");
                    setSelectedJobSource(null);
                  }
                }}
              >
                <Popup maxWidth={420}>{renderJobDetail(job)}</Popup>
              </Marker>
            );
          }

          const selectedJob = group.jobs.find((job) => job.id === selectedGroupedJobId);
          const isGroupHighlighted = group.jobs.some(
            (job) => job.id === hoveredResultJobId || job.id === selectedResultJobId
          );

          return (
            <Marker
              key={group.key}
              ref={(marker) => {
                clusterMarkerRefs.current[group.key] = marker;
              }}
              position={group.position}
              icon={createGroupedJobIcon(
                group.jobs.length,
                getGroupInterestState(group.jobs),
                isGroupHighlighted
              )}
              zIndexOffset={isGroupHighlighted ? 500 : 0}
              eventHandlers={{
                popupopen: () => {
                  if (!selectedGroupedJobId) {
                    setSelectedJobSource(null);
                  }
                },
                popupclose: () => {
                  if (suppressClusterReopenRef.current) {
                    suppressClusterReopenRef.current = false;
                    return;
                  }

                  if (selectedJobSource === "cluster" && selectedGroupedJobId) {
                    setSelectedGroupedJobId("");
                    setSelectedJobSource(null);
                    setClusterToReopenKey(group.key);
                    return;
                  }

                  setSelectedGroupedJobId("");
                  setSelectedJobSource(null);
                }
              }}
            >
              <Popup maxWidth={420}>
                {selectedJob ? (
                  <div className="box-border w-[min(22rem,calc(100vw-6rem))] max-w-full space-y-3 px-1">
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedGroupedJobId("");
                        setSelectedJobSource(null);
                      }}
                      className="text-sm font-semibold text-red-800 transition hover:text-red-950"
                    >
                      Back to jobs at this location
                    </button>
                    {renderJobDetail(selectedJob)}
                  </div>
                ) : (
                  <div className="box-border w-[min(22rem,calc(100vw-6rem))] max-w-full space-y-3 px-1">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
                        Jobs at this location
                      </p>
                      <h2 className="mt-1 text-base font-bold text-zinc-950">
                        {group.jobs.length} available jobs
                      </h2>
                    </div>
                    <div className="box-border w-full space-y-2">
                      {group.jobs.map((job) => {
                        const { matchPercent, interestState, commuteEstimate } = getJobPopupData(job);

                        return (
                          <button
                            key={job.id}
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              setSelectedGroupedJobId(job.id);
                              setSelectedJobSource("cluster");
                              setSelectedResultJobId("");
                            }}
                            aria-label={`Open details for ${job.title}`}
                            className="box-border flex w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-gray-200 bg-white px-3 py-3 text-left transition hover:border-red-200 hover:bg-red-50 focus:outline-none focus:ring-2 focus:ring-red-900/20"
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block text-base font-semibold text-zinc-950">{job.title}</span>
                              <span className="mt-1 block text-xs font-semibold text-zinc-500">
                                {commuteEstimate?.timeLabel ?? "Commute unavailable"}
                              </span>
                            </span>
                            <span className="flex min-w-fit shrink-0 items-center justify-center gap-1 px-1">
                              {interestState === "candidate_interested" || interestState === "mutual_match" ? (
                                <span className="inline-flex min-w-7 items-center justify-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-bold text-red-800">
                                  &hearts;
                                </span>
                              ) : null}
                              {interestState === "mutual_match" ? (
                                <span className="inline-flex items-center justify-center rounded-full bg-red-800 px-3 py-1 text-xs font-bold text-white">
                                  MATCH
                                </span>
                              ) : null}
                              <span className="inline-flex min-w-12 items-center justify-center px-2 text-base font-extrabold text-red-800">
                                {matchPercent}%
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </Popup>
            </Marker>
          );
        })}

        {externalJobs.map((job) => {
          const extScore = matchScores[job.id];
          const isSaved = savedExternalJobIds.has(job.id);
          return (
            <Marker
              key={job.id}
              position={[job.lat, job.lng]}
              icon={createExternalJobIcon(false, extScore, scoringInProgress)}
            >
              <Popup maxWidth={340}>
                <div className="box-border w-[min(20rem,calc(100vw-6rem))] max-w-full space-y-2 px-1 py-1">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">{job.company}</p>
                      <h2 className="text-base font-bold text-zinc-950">{job.title}</h2>
                    </div>
                    {extScore !== undefined ? (
                      <span className="shrink-0 rounded-full bg-slate-700 px-2.5 py-1 text-xs font-bold text-white">
                        {extScore}%
                      </span>
                    ) : scoringInProgress ? (
                      <span className="shrink-0 rounded-full bg-slate-200 px-2.5 py-1 text-xs font-semibold text-slate-500">
                        Scoring...
                      </span>
                    ) : null}
                  </div>
                  {job.location ? <p className="text-xs text-zinc-500">{job.location}</p> : null}
                  {job.salary_min || job.salary_max ? (
                    <p className="text-xs font-semibold text-zinc-700">{formatExternalSalary(job.salary_min, job.salary_max)}</p>
                  ) : null}
                  {job.job_type ? <p className="text-xs text-zinc-500">{job.job_type}</p> : null}
                  {job.description ? (
                    <p className="max-h-20 overflow-y-auto rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-xs leading-5 text-zinc-600">
                      {job.description}
                    </p>
                  ) : null}
                  <div className="flex items-center gap-2 pt-1">
                    <a
                      href={job.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex flex-1 items-center justify-center rounded-md bg-slate-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-slate-800"
                    >
                      View Job ↗
                    </a>
                    <button
                      type="button"
                      onClick={() => handleSaveExternalJob(job)}
                      className={`inline-flex items-center justify-center rounded-md border px-3 py-2 text-xs font-semibold transition ${
                        isSaved
                          ? "border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200"
                          : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                      }`}
                      aria-label={isSaved ? "Unsave job" : "Save job"}
                    >
                      {isSaved ? "♥ Saved" : "♡ Save"}
                    </button>
                  </div>
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>

      <div className="absolute bottom-8 left-1/2 z-[900] -translate-x-1/2 pointer-events-none">
        <div className="flex items-center gap-4 rounded-full border border-gray-200 bg-white/95 px-4 py-2 shadow-soft">
          <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700">
            <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: "9999px", background: "#dc2626" }} />
            WPM Match
          </span>
          <span className="flex items-center gap-1.5 text-xs font-semibold text-zinc-700">
            <span style={{ display: "inline-block", width: 12, height: 12, borderRadius: "9999px", background: "#334155" }} />
            External Listing
          </span>
        </div>
      </div>

      <div
        className={`absolute left-4 top-4 z-[900] w-[14rem] transition-transform ${
          isPanelCollapsed ? "-translate-x-[calc(100%+1rem)]" : "translate-x-0"
        }`}
      >
        <div className="relative max-h-[calc(100vh-7rem)] overflow-visible">
          <button
            type="button"
            onClick={() => setIsPanelCollapsed((current) => !current)}
            aria-label={isPanelCollapsed ? "Expand jobs controls" : "Collapse jobs controls"}
            className="absolute right-0 top-1/2 z-10 translate-x-full -translate-y-1/2 cursor-pointer rounded-r-xl bg-white/95 px-2 py-4 text-sm font-bold text-zinc-700 shadow-[4px_4px_12px_rgba(0,0,0,0.08)] transition hover:bg-zinc-50 hover:shadow-[5px_5px_14px_rgba(0,0,0,0.1)]"
          >
            {isPanelCollapsed ? ">>" : "<<"}
          </button>
          <div className="max-h-[calc(100vh-7rem)] overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 bg-white/95 p-4 shadow-soft">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-800">Jobs</p>
          <h1 className="mt-2 text-xl font-bold text-zinc-950">Available jobs</h1>
          <p className="mt-2 text-sm leading-5 text-zinc-600">
            Browse active job pins and mark roles you are interested in.
          </p>
          {profile ? null : (
            <p className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3 text-xs font-semibold text-zinc-600">
              Complete your profile to see more meaningful match percentages.
            </p>
          )}
          {jobs.length === 0 ? (
            <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3">
              <p className="text-sm font-semibold text-zinc-950">No jobs have been posted yet.</p>
              <p className="mt-1 text-xs leading-5 text-zinc-600">
                Jobs will appear here once employers create listings.
              </p>
            </div>
          ) : null}
          {jobs.length > 0 && visibleJobGroups.length === 0 ? (
            <div className="mt-3 rounded-md border border-gray-200 bg-gray-50 p-3">
              <p className="text-sm font-semibold text-zinc-950">No jobs match these filters.</p>
            </div>
          ) : null}
          {!hasAcknowledgedPrivacyNotice ? (
            <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3">
              <p className="text-xs leading-5 text-zinc-600">
                Your exact map placement is only shown to you. Employers see your generalized ZIP area.
              </p>
              <button
                type="button"
                onClick={acknowledgePrivacyNotice}
                className="mt-3 inline-flex items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-xs font-semibold text-zinc-900 transition hover:bg-zinc-50"
              >
                Got it
              </button>
            </div>
          ) : null}
          <label className="mt-4 block space-y-2 border-t border-gray-200 pt-3">
            <span className="text-xs font-semibold uppercase tracking-[0.12em] text-zinc-500">
              Sort by
            </span>
            <select
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as JobSortMode)}
              className="field"
            >
              {sortOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <div className="mt-4 border-t border-gray-200 pt-3">
            <button
              type="button"
              onClick={openFilters}
              className="flex w-full items-center justify-between rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
            >
              <span>{activeFilterCount > 0 ? `Filters (${activeFilterCount})` : "Filters ▾"}</span>
            </button>
            {filterSaveMessage ? (
              <p className="mt-2 text-xs font-semibold text-zinc-500">{filterSaveMessage}</p>
            ) : null}
            {isFiltersExpanded ? (
              <div className="mt-3 space-y-3">
                <label className="block space-y-2">
                  <span className="label">Match percentage</span>
                  <select
                    value={minimumMatchPercent}
                    onChange={(event) => setMinimumMatchPercent(Number(event.target.value))}
                    className="field"
                  >
                    {minimumMatchOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-2">
                  <span className="label">Estimated commute</span>
                  <select
                    value={commuteMaxMinutes ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setCommuteMaxMinutes(value ? Number(value) : null);
                    }}
                    className="field"
                  >
                    {commuteFilterOptions.map((option) => (
                      <option key={option.value || "all"} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-2">
                  <span className="label">Job type</span>
                  <select
                    value={jobTypeFilter}
                    onChange={(event) => setJobTypeFilter(event.target.value)}
                    className="field"
                  >
                    <option value="">All</option>
                    {jobTypeOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-2">
                  <span className="label">Schedule</span>
                  <select
                    value={scheduleFilter}
                    onChange={(event) => setScheduleFilter(event.target.value)}
                    className="field"
                  >
                    <option value="">All</option>
                    {scheduleOptions.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-2">
                  <span className="label">Pay range</span>
                  <select
                    value={minHourlyPay ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setMinHourlyPay(value ? Number(value) : null);
                    }}
                    className="field"
                  >
                    {payFilterOptions.map((option) => (
                      <option key={option.value || "all"} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block space-y-2">
                  <span className="label">Interest status</span>
                  <select
                    value={interestStatusFilter}
                    onChange={(event) => setInterestStatusFilter(event.target.value as InterestStatusFilter)}
                    className="field"
                  >
                    {interestStatusOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={saveFilters}
                  className="inline-flex w-full items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
                >
                  Save filters
                </button>
                <button
                  type="button"
                  onClick={clearFilters}
                  className="inline-flex w-full items-center justify-center rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
                >
                  Clear filters
                </button>
              </div>
            ) : null}
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
      </div>
      </div>

      <div className="absolute bottom-4 right-4 top-4 z-[900] flex w-80 flex-col gap-3">
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 bg-white/95 p-4 shadow-soft">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-800">Ranked results</p>
          <h2 className="mt-2 text-lg font-bold text-zinc-950">{visibleJobs.length} visible jobs</h2>
          <p className="mt-1 text-xs leading-5 text-zinc-600">Ordered by {getSortLabel(sortMode).toLowerCase()}.</p>
          <div className="mt-3 space-y-2">
            {visibleJobs.length === 0 ? (
              <div className="rounded-md border border-gray-200 bg-gray-50 p-3">
                <p className="text-sm font-semibold text-zinc-950">No jobs match these filters.</p>
              </div>
            ) : (
              visibleJobs.map((job) => {
                const { matchPercent, interestState, companyName, commuteEstimate } = getJobPopupData(job);
                const isHighlighted = hoveredResultJobId === job.id || selectedResultJobId === job.id;

                return (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => openJobFromResults(job)}
                    onMouseEnter={() => setHoveredResultJobId(job.id)}
                    onMouseLeave={() => setHoveredResultJobId("")}
                    onFocus={() => setHoveredResultJobId(job.id)}
                    onBlur={() => setHoveredResultJobId("")}
                    className={`w-full rounded-md border bg-white p-3 text-left transition ${
                      isHighlighted ? "border-red-300 shadow-md" : "border-gray-200 hover:border-red-200 hover:bg-red-50"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-bold text-zinc-950">{job.title}</span>
                        <span className="mt-1 block truncate text-xs font-semibold text-zinc-500">{companyName}</span>
                      </span>
                      <span className="shrink-0 rounded-full bg-red-900 px-2.5 py-1 text-xs font-bold text-white">
                        {matchPercent}%
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-semibold text-zinc-700">
                        {commuteEstimate?.timeLabel ?? "Commute unavailable"}
                      </span>
                      {job.payRange ? (
                        <span className="rounded-full bg-gray-100 px-2 py-1 text-xs font-semibold text-zinc-700">
                          {job.payRange}
                        </span>
                      ) : null}
                      {interestState === "candidate_interested" || interestState === "mutual_match" ? (
                        <span className="rounded-full bg-red-100 px-2 py-1 text-xs font-bold text-red-800">
                          &hearts;
                        </span>
                      ) : null}
                      {interestState === "mutual_match" ? (
                        <span className="rounded-full bg-red-800 px-2.5 py-1 text-xs font-bold text-white">
                          MATCH
                        </span>
                      ) : null}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
        {selectedResultJob ? (
          <div
            ref={detailPanelRef}
            className="max-h-[42vh] shrink-0 overflow-y-auto overflow-x-hidden rounded-lg border border-gray-200 bg-white/95 p-4 shadow-soft"
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-800">Selected job</p>
                <p className="mt-1 text-xs leading-5 text-zinc-600">Opened from ranked results</p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setSelectedResultJobId("");
                  setSelectedJobSource(null);
                }}
                aria-label="Close selected job detail"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-zinc-300 bg-white text-sm font-bold text-zinc-700 transition hover:bg-zinc-50"
              >
                X
              </button>
            </div>
            {renderJobDetail(selectedResultJob, () => {
              setSelectedResultJobId("");
              setSelectedJobSource(null);
            })}
          </div>
        ) : null}
      </div>

      {showMatchPopup ? (
        <MatchPopup
          onClose={() => setShowMatchPopup(false)}
          onReachOut={
            matchPopupJob
              ? () => {
                  handleApplicantReachOut(matchPopupJob);
                  setShowMatchPopup(false);
                }
              : undefined
          }
        />
      ) : null}
      {pendingRemoveInterestJob ? (
        <RemoveInterestConfirmationModal
          onConfirm={() => {
            removeCandidateInterest(pendingRemoveInterestJob);
            setPendingRemoveInterestJob(null);
          }}
          onCancel={() => setPendingRemoveInterestJob(null)}
        />
      ) : null}
    </section>
  );
}

function MatchPopup({ onClose, onReachOut }: { onClose: () => void; onReachOut?: () => void }) {
  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-zinc-950/35 px-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-6 text-center shadow-soft">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-red-800">Match</p>
        <h2 className="mt-2 text-2xl font-bold text-zinc-950">You have a match</h2>
        <p className="mt-2 text-sm leading-6 text-zinc-600">Both sides expressed interest</p>
        <div className="mt-5 space-y-2">
          <button
            type="button"
            onClick={onReachOut ?? onClose}
            className="w-full rounded-md bg-green-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-green-800"
          >
            Reach out
          </button>
          <button
            type="button"
            onClick={onClose}
            className="w-full rounded-md border border-zinc-300 bg-zinc-100 px-4 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-200"
          >
            Reach out later
          </button>
        </div>
      </div>
    </div>
  );
}

function CandidateMutualMatchPopup({
  thread,
  availabilityWindows,
  onReachOut,
  onSendMessage,
  onSchedule,
  onRemoveInterest
}: {
  thread: MatchThreadContext;
  availabilityWindows: string[];
  onReachOut: () => void;
  onSendMessage: (text: string) => void;
  onSchedule: (selectedTime: string) => void;
  onRemoveInterest: () => void;
}) {
  const map = useMap();

  return (
    <CandidateMutualMatchActions
      thread={thread}
      availabilityWindows={availabilityWindows}
      onReachOut={() => {
        onReachOut();
        map.closePopup();
      }}
      onReachOutLater={() => map.closePopup()}
      onSendMessage={onSendMessage}
      onSchedule={onSchedule}
      onRemoveInterest={() => {
        onRemoveInterest();
        map.closePopup();
      }}
    />
  );
}

function CandidateMutualMatchActions({
  thread,
  availabilityWindows,
  onReachOut,
  onReachOutLater,
  onSendMessage,
  onSchedule,
  onRemoveInterest
}: {
  thread: MatchThreadContext;
  availabilityWindows: string[];
  onReachOut: () => void;
  onReachOutLater: () => void;
  onSendMessage: (text: string) => void;
  onSchedule: (selectedTime: string) => void;
  onRemoveInterest: () => void;
}) {
  const [isMessagingOpen, setIsMessagingOpen] = useState(false);
  const [isSchedulingOpen, setIsSchedulingOpen] = useState(false);
  const [messages, setMessages] = useState<MatchMessage[]>([]);
  const [messageText, setMessageText] = useState("");
  const [selectedTime, setSelectedTime] = useState(availabilityWindows[0] ?? "");

  useEffect(() => {
    setMessages(getMatchThreadMessages(thread));
  }, [thread.applicantId, thread.employerId, thread.jobId]);

  function sendMessage() {
    if (!messageText.trim()) {
      return;
    }

    onSendMessage(messageText);
    setMessageText("");
    setMessages(getMatchThreadMessages(thread));
  }

  function scheduleConversation() {
    if (!selectedTime.trim()) {
      return;
    }

    onSchedule(selectedTime);
    setMessages(getMatchThreadMessages(thread));
    setIsSchedulingOpen(false);
  }

  return (
    <div className="space-y-3">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-red-800">Match</p>
        <h2 className="mt-1 text-base font-bold text-zinc-950">You have a match</h2>
        <p className="mt-1 text-sm text-zinc-600">Both sides expressed interest</p>
      </div>
      <button
        type="button"
        onClick={onReachOut}
        className="w-full rounded-md bg-green-700 px-3 py-2 text-sm font-semibold text-white transition hover:bg-green-800"
      >
        Reach out
      </button>
      <button
        type="button"
        onClick={onReachOutLater}
        className="w-full rounded-md border border-zinc-300 bg-zinc-100 px-3 py-2 text-sm font-semibold text-zinc-800 transition hover:bg-zinc-200"
      >
        Reach out later
      </button>
      <button
        type="button"
        onClick={() => setIsMessagingOpen((current) => !current)}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
      >
        Message
      </button>
      {isMessagingOpen ? (
        <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-2">
          <div className="max-h-28 space-y-1 overflow-y-auto text-xs text-zinc-700">
            {messages.length > 0 ? (
              messages.map((message) => (
                <p key={message.id} className="rounded bg-white px-2 py-1">
                  <span className="font-semibold">{message.senderRole === "applicant" ? "You" : "Employer"}:</span>{" "}
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
      <button
        type="button"
        onClick={() => setIsSchedulingOpen((current) => !current)}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
      >
        Schedule Conversation
      </button>
      {isSchedulingOpen ? (
        <div className="space-y-2 rounded-md border border-gray-200 bg-gray-50 p-2">
          {availabilityWindows.length > 0 ? (
            <>
              <select
                value={selectedTime}
                onChange={(event) => setSelectedTime(event.target.value)}
                className="w-full rounded-md border border-gray-300 px-2 py-2 text-sm"
              >
                {availabilityWindows.map((window) => (
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
            <p className="text-xs leading-5 text-zinc-600">No employer availability has been added yet.</p>
          )}
        </div>
      ) : null}
      <button
        type="button"
        onClick={onRemoveInterest}
        className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-900 transition hover:bg-zinc-50"
      >
        Remove interest
      </button>
    </div>
  );
}

function PopupDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded border border-gray-200 bg-gray-50 px-2 py-1">
      <span className="font-semibold text-zinc-500">{label}</span>
      <span className="font-semibold text-zinc-950">{value || "Not provided"}</span>
    </div>
  );
}

function RecenterMap({ center }: { center: Coordinates }) {
  const map = useMap();

  useEffect(() => {
    map.setView(center, 10);
  }, [center, map]);

  return null;
}

function PanToSelectedJob({ position }: { position: Coordinates | null }) {
  const map = useMap();

  useEffect(() => {
    if (!position) {
      return;
    }

    map.panTo(position, { animate: true, duration: 0.55 });
  }, [map, position]);

  return null;
}

function ZoomLevelTracker({ onZoomChange }: { onZoomChange: (zoom: number) => void }) {
  const map = useMap();

  useEffect(() => {
    onZoomChange(map.getZoom());

    function updateZoom() {
      onZoomChange(map.getZoom());
    }

    map.on("zoomend", updateZoom);

    return () => {
      map.off("zoomend", updateZoom);
    };
  }, [map, onZoomChange]);

  return null;
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
      pointCount.current += 1;
      onPointsChange((current) => [...current, getLatLng(event)]);
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

function findEmployerAccount(email: string) {
  return { email, availabilityWindows: [] };
}

function getEmployerCreatedJobs(jobs: JobListing[]) {
  return jobs.filter((job) => job.id && job.employerEmail && !isSeedJob(job));
}

function isSeedJob(job: JobListing) {
  return job.id.startsWith("wm-test-") || job.employerEmail === "grouping-test-employer@workplacematch.local";
}

function getApplicantInterestId(profile: ApplicantProfile) {
  return profile.updatedAt ? `candidate-profile:${profile.updatedAt}` : "candidate-profile:local-mvp";
}

function getApplicantMapProfileFromAccount(account: ApplicantAccount): ApplicantProfile | null {
  if (!account.zipCode && !account.streetAddress && !account.city) {
    return null;
  }

  return {
    fullName: account.displayName,
    streetAddress: account.streetAddress,
    city: account.city,
    state: account.state,
    zipCode: account.zipCode,
    topSkills: []
  };
}

function getZipMapPosition(zipCode?: string): Coordinates | null {
  // Privacy: applicant search radius uses generalized ZIP-area centroids, not exact candidate locations.
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
    "63301": [38.7881, -90.4974],
    "63303": [38.7545, -90.5468],
    "63304": [38.7326, -90.6351]
  };

  if (knownExactZips[normalizedZip]) {
    return logApplicantZipResolution(normalizedZip, knownExactZips[normalizedZip]);
  }

  const zipPrefix = zipCode?.slice(0, 3) ?? "";
  const knownZipAreas: Record<string, Coordinates> = {
    "631": stLouisCenter,
    "633": [38.7881, -90.4974],
    "641": [39.0997, -94.5786],
    "606": [41.8781, -87.6298]
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

function getApplicantSelfMapResolution(
  account: ApplicantAccount | null,
  profile: ApplicantProfile | null
): ApplicantMapLocationResolution {
  const manualPosition = getManualMapPosition(account) ?? getManualMapPosition(profile);

  if (manualPosition) {
    return { position: manualPosition, source: "manual coordinates" };
  }

  const exactAddressPosition =
    (account ? getApplicantExactAddressMapPosition(account) : null) ??
    (profile ? getApplicantExactAddressMapPosition(profile) : null);

  if (exactAddressPosition) {
    return { position: exactAddressPosition, source: "exact address" };
  }

  const zipPosition = getZipMapPosition(account?.zipCode ?? profile?.zipCode);

  if (zipPosition) {
    return { position: zipPosition, source: "ZIP fallback" };
  }

  return { position: null, source: "unresolved" };
}

function getManualMapPosition(value: ApplicantAccount | ApplicantProfile | null) {
  if (typeof value?.manualMapLat !== "number" || typeof value.manualMapLng !== "number") {
    return null;
  }

  return [value.manualMapLat, value.manualMapLng] as Coordinates;
}

function getApplicantExactAddressMapPosition(profile: ApplicantProfile | ApplicantAccount) {
  const normalizedAddress = normalizeAddress(
    [profile.streetAddress, profile.city, profile.state, profile.zipCode].filter(Boolean).join(" ")
  );
  const knownExactAddresses: Record<string, Coordinates> = {
    "213 main st fenton mo 63026": [38.5137, -90.4374],
    "1 main st valley park mo 63088": [38.5497, -90.4928],
    "1 e main st washington mo 63090": [38.5588, -91.0114]
  };

  return knownExactAddresses[normalizedAddress] ?? null;
}

function updateCandidateAccountInAccountsArray(updatedAccount: ApplicantAccount) {
  void updatedAccount;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function hasPrivacyNoticeAcknowledgement(email: string) {
  return true;
}

function savePrivacyNoticeAcknowledgement(email: string) {
  void email;
}

function normalizeSavedFilters(filters: JobFilters) {
  return {
    minimumMatchPercent: Number(filters.minimumMatchPercent) || 0,
    commuteMaxMinutes: typeof filters.commuteMaxMinutes === "number" ? filters.commuteMaxMinutes : null,
    jobType: filters.jobType || "",
    schedule: filters.schedule || "",
    minHourlyPay: typeof filters.minHourlyPay === "number" ? filters.minHourlyPay : null,
    interestStatus: isInterestStatusFilter(filters.interestStatus) ? filters.interestStatus : "all"
  };
}

function isInterestStatusFilter(value: unknown): value is InterestStatusFilter {
  return value === "all" || value === "not_marked" || value === "interested" || value === "matched";
}

function createMutualMatchRecord(interest: ApplicantInterest): MutualMatch {
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

function getInitialMapCenter(applicantAreaCenter: Coordinates) {
  return applicantAreaCenter;
}

function shouldShowJob(
  job: JobListing,
  applicantAreaCenter: Coordinates,
  applicantPosition: Coordinates | null,
  searchMiles: number | null,
  customAreaPoints: Coordinates[],
  filters: JobFilters,
  profile: ApplicantProfile | null,
  interestState: InterestState
) {
  if (
    filters.minimumMatchPercent > 0 &&
    calculateSkillMatch(job.requiredSkills, getApplicantMatchSignals(profile), job.title).percentage <
      filters.minimumMatchPercent
  ) {
    return false;
  }

  const jobPosition = getJobMapPosition(job);
  const hasCustomArea = customAreaPoints.length >= 3;
  const commuteEstimate = getJobCommuteEstimate(job, applicantPosition);

  if (filters.commuteMaxMinutes !== null && (!commuteEstimate || commuteEstimate.minutes > filters.commuteMaxMinutes)) {
    return false;
  }

  if (filters.jobType && normalizeSkill(job.jobType) !== normalizeSkill(filters.jobType)) {
    return false;
  }

  if (filters.schedule && normalizeSkill(job.schedule) !== normalizeSkill(filters.schedule)) {
    return false;
  }

  if (filters.minHourlyPay !== null && !jobMeetsHourlyPayFilter(job.payRange, filters.minHourlyPay)) {
    return false;
  }

  if (!jobMeetsInterestStatusFilter(interestState, filters.interestStatus)) {
    return false;
  }

  if (hasCustomArea) {
    return isPointInPolygon(jobPosition, customAreaPoints);
  }

  if (searchMiles) {
    return getDistanceMiles(applicantAreaCenter, jobPosition) <= searchMiles;
  }

  return true;
}

function getActiveFilterCount(filters: JobFilters) {
  return [
    filters.minimumMatchPercent > 0,
    filters.commuteMaxMinutes !== null,
    Boolean(filters.jobType),
    Boolean(filters.schedule),
    filters.minHourlyPay !== null,
    filters.interestStatus !== "all"
  ].filter(Boolean).length;
}

function getFilterOptions(values: string[], fallbackOptions: string[]) {
  const options: string[] = [];

  [...values, ...fallbackOptions].forEach((value) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return;
    }

    if (!options.some((option) => normalizeSkill(option) === normalizeSkill(trimmed))) {
      options.push(trimmed);
    }
  });

  return options;
}

function jobMeetsHourlyPayFilter(payRange: string, minHourlyPay: number) {
  const hourlyPay = getHourlyPayCeiling(payRange);
  return hourlyPay === null ? true : hourlyPay >= minHourlyPay;
}

function getHourlyPayCeiling(payRange: string) {
  const normalized = payRange.toLowerCase();
  if (!normalized.includes("hr") && !normalized.includes("hour")) {
    return null;
  }

  const values = normalized.match(/\d+(?:,\d{3})*(?:\.\d+)?/g)?.map((value) => Number(value.replace(/,/g, ""))) ?? [];
  return values.length > 0 ? Math.max(...values) : null;
}

function jobMeetsInterestStatusFilter(interestState: InterestState, filter: InterestStatusFilter) {
  if (filter === "all") {
    return true;
  }

  if (filter === "not_marked") {
    return interestState === "none";
  }

  if (filter === "interested") {
    return interestState === "candidate_interested";
  }

  return interestState === "mutual_match";
}

function sortJobs(
  jobs: JobListing[],
  sortMode: JobSortMode,
  profile: ApplicantProfile | null,
  applicantPosition: Coordinates | null
) {
  return [...jobs].sort((first, second) => {
    const firstMetrics = getJobSortMetrics(first, profile, applicantPosition);
    const secondMetrics = getJobSortMetrics(second, profile, applicantPosition);

    if (sortMode === "best_match") {
      return secondMetrics.matchPercent - firstMetrics.matchPercent;
    }

    if (sortMode === "closest") {
      return firstMetrics.commuteMinutes - secondMetrics.commuteMinutes;
    }

    return secondMetrics.balancedScore - firstMetrics.balancedScore;
  });
}

function getJobSortMetrics(job: JobListing, profile: ApplicantProfile | null, applicantPosition: Coordinates | null) {
  const matchPercent = calculateSkillMatch(job.requiredSkills, getApplicantMatchSignals(profile), job.title).percentage;
  const commuteMinutes = getJobCommuteEstimate(job, applicantPosition)?.minutes ?? Number.POSITIVE_INFINITY;
  const commuteScore = Number.isFinite(commuteMinutes) ? Math.max(0, 100 - Math.min(commuteMinutes, 100)) : 0;

  return {
    matchPercent,
    commuteMinutes,
    balancedScore: matchPercent * 0.7 + commuteScore * 0.3
  };
}

function getSortLabel(sortMode: JobSortMode) {
  return sortOptions.find((option) => option.value === sortMode)?.label ?? "Balanced";
}

function groupJobsByLocation(jobs: JobListing[], zoom: number) {
  const groupingDistanceMiles = getJobGroupingDistanceMiles(zoom);
  const groups: JobGroup[] = [];

  jobs.forEach((job) => {
    const position = getJobMapPosition(job);
    const exactLocationKey = getExactJobLocationGroupKey(job);
    const exactLocationGroup = groups.find((group) => group.key === exactLocationKey);

    if (exactLocationGroup) {
      exactLocationGroup.jobs.push(job);
      return;
    }

    const nearbyGroup =
      groupingDistanceMiles > 0
        ? groups.find((group) => getDistanceMiles(group.position, position) <= groupingDistanceMiles)
        : null;

    if (nearbyGroup) {
      nearbyGroup.jobs.push(job);
      nearbyGroup.position = getAveragePosition([...nearbyGroup.jobs.map(getJobMapPosition)]);
      nearbyGroup.key = `nearby:${nearbyGroup.position[0].toFixed(4)},${nearbyGroup.position[1].toFixed(4)}`;
      return;
    }

    groups.push({
      key: exactLocationKey,
      position,
      jobs: [job]
    });
  });

  return groups;
}

function getExactJobLocationGroupKey(job: JobListing) {
  if (hasEnteredStreetAddress(job)) {
    const exactAddressKey = getJobAddressKey(job);
    return `exact:${exactAddressKey}`;
  }

  return `job:${job.id}`;
}

function getJobGroupingDistanceMiles(zoom: number) {
  if (zoom <= 9) {
    return 8;
  }

  if (zoom === 10) {
    return 4;
  }

  if (zoom === 11) {
    return 1.5;
  }

  if (zoom === 12) {
    return 0.6;
  }

  if (zoom === 13) {
    return 0.12;
  }

  return 0;
}

function getAveragePosition(positions: Coordinates[]): Coordinates {
  const totals = positions.reduce(
    (current, position) => ({
      lat: current.lat + position[0],
      lng: current.lng + position[1]
    }),
    { lat: 0, lng: 0 }
  );

  return [totals.lat / positions.length, totals.lng / positions.length];
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
    "63304": [38.7326, -90.6351],
  };

  if (knownExactZips[normalizedZip]) {
    return knownExactZips[normalizedZip];
  }

  return null;
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

  return offsetCoordinates(basePosition, getApproximateJobPlacementSeed(job));
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

function getApproximateJobPlacementSeed(job: JobListing) {
  const locationKey = getJobAddressKey(job);
  return hasEnteredStreetAddress(job) ? locationKey : `${locationKey}:${job.id}`;
}

function hasEnteredStreetAddress(job: JobListing) {
  return Boolean(job.locationStreet?.trim());
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
  const distanceMiles = 0.25 + ((hash % 9) * 0.07);
  const latOffset = distanceMiles / 69;
  const lngOffset = distanceMiles / (69 * Math.cos(toRadians(origin[0])));

  return [origin[0] + Math.sin(angle) * latOffset, origin[1] + Math.cos(angle) * lngOffset];
}

function getDeterministicHash(value: string) {
  return value.split("").reduce((hash, character) => {
    return (hash * 31 + character.charCodeAt(0)) >>> 0;
  }, 0);
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

function computePolygonCentroid(points: Coordinates[]): { lat: number; lng: number } {
  const lat = points.reduce((sum, p) => sum + p[0], 0) / points.length;
  const lng = points.reduce((sum, p) => sum + p[1], 0) / points.length;
  return { lat, lng };
}

function computeMaxDistanceMiles(centroid: { lat: number; lng: number }, points: Coordinates[]): number {
  return points.reduce((max, p) => {
    const d = getDistanceMiles([centroid.lat, centroid.lng], p);
    return d > max ? d : max;
  }, 0);
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

function getJobCommuteEstimate(job: JobListing, applicantPosition: Coordinates | null) {
  if (!applicantPosition) {
    return null;
  }

  const jobPosition = getJobMapPosition(job);
  if (!jobPosition) {
    return null;
  }

  const distanceMiles = getDistanceMiles(applicantPosition, jobPosition);
  const minutes = getEstimatedCommuteMinutes(distanceMiles);

  return {
    distanceLabel: formatDistanceMiles(distanceMiles),
    timeLabel: formatCommuteMinutes(minutes),
    minutes
  };
}

function formatDistanceMiles(distanceMiles: number) {
  return distanceMiles < 10 ? `${distanceMiles.toFixed(1)} mi` : `${Math.round(distanceMiles)} mi`;
}

function getEstimatedCommuteMinutes(distanceMiles: number) {
  // MVP straight-line commute estimate. It intentionally inflates
  // distance-based time by 1.5x until route-based commute timing is added.
  return Math.max(1, Math.round(distanceMiles * 1.5));
}

function formatCommuteMinutes(minutes: number) {
  if (minutes < 60) {
    return `~${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `~${hours} hr ${remainingMinutes} min` : `~${hours} hr`;
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

function createApplicantAreaIcon(profilePictureUrl = "") {
  const markerHtml = profilePictureUrl
    ? `<img src="${profilePictureUrl}" alt="" onerror="this.style.display='none'" style="display:block;width:28px;height:28px;border-radius:9999px;object-fit:cover;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);" />`
    : '<div style="font-size:22px;line-height:28px;text-align:center;width:28px;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.4));cursor:grab;pointer-events:auto;">&#x1F642;</div>';

  return L.divIcon({
    className: "me-marker",
    html: markerHtml,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    popupAnchor: [0, -14]
  });
}

function createUnifiedJobMatchIcon(
  percentage: number,
  interestState: InterestState,
  distanceLabel: string | null,
  isHighlighted = false
) {
  const interestBadge =
    interestState === "candidate_interested"
      ? '<span style="position:absolute;top:-9px;right:-9px;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:9999px;border:2px solid white;background:#991b1b;color:white;font-size:14px;font-weight:900;box-shadow:0 6px 14px rgba(0,0,0,0.2);">&hearts;</span>'
      : "";
  const matchBadge =
    interestState === "mutual_match"
      ? '<span style="position:absolute;top:-13px;right:-18px;display:flex;align-items:center;justify-content:center;height:22px;padding:0 8px;border-radius:9999px;border:2px solid white;background:#991b1b;color:white;font-size:10px;font-weight:900;letter-spacing:0.04em;box-shadow:0 6px 14px rgba(0,0,0,0.2);">MATCH</span>'
      : "";
  const glow =
    isHighlighted
      ? "0 0 0 6px rgba(220,38,38,0.22), 0 14px 30px rgba(0,0,0,0.32)"
      : interestState === "mutual_match"
      ? "0 0 0 4px rgba(220,38,38,0.18), 0 10px 24px rgba(0,0,0,0.25)"
      : "0 10px 24px rgba(0,0,0,0.25)";
  const scale = isHighlighted ? "scale(1.08)" : "scale(1)";

  return L.divIcon({
    className: "",
    html: `<div style="position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;min-width:60px;height:52px;padding:4px 12px;border-radius:9999px;border:3px solid white;background:#dc2626;color:white;box-shadow:${glow};transform:${scale};transition:transform 150ms ease, box-shadow 150ms ease;"><span style="font-size:14px;font-weight:900;line-height:16px;">${percentage}%</span><span style="margin-top:2px;font-size:10px;font-weight:800;line-height:12px;">${distanceLabel ?? ""}</span>${interestBadge}${matchBadge}</div>`,
    iconSize: [78, 64],
    iconAnchor: [39, 32],
    popupAnchor: [0, -24]
  });
}

function createGroupedJobIcon(count: number, interestState: InterestState, isHighlighted = false) {
  const interestBadge =
    interestState === "candidate_interested" || interestState === "mutual_match"
      ? '<span style="position:absolute;top:-9px;right:-9px;display:flex;align-items:center;justify-content:center;width:24px;height:24px;border-radius:9999px;border:2px solid white;background:#991b1b;color:white;font-size:14px;font-weight:900;box-shadow:0 6px 14px rgba(0,0,0,0.2);">&hearts;</span>'
      : "";
  const matchBadge =
    interestState === "mutual_match"
      ? '<span style="position:absolute;top:-13px;right:-18px;display:flex;align-items:center;justify-content:center;height:22px;padding:0 8px;border-radius:9999px;border:2px solid white;background:#991b1b;color:white;font-size:10px;font-weight:900;letter-spacing:0.04em;box-shadow:0 6px 14px rgba(0,0,0,0.2);">MATCH</span>'
      : "";
  const glow =
    isHighlighted
      ? "0 0 0 6px rgba(220,38,38,0.22), 0 14px 30px rgba(0,0,0,0.32)"
      : interestState === "mutual_match"
      ? "0 0 0 4px rgba(220,38,38,0.18), 0 10px 24px rgba(0,0,0,0.25)"
      : "0 10px 24px rgba(0,0,0,0.25)";
  const scale = isHighlighted ? "scale(1.08)" : "scale(1)";

  return L.divIcon({
    className: "",
    html: `<div style="position:relative;display:inline-flex;align-items:center;justify-content:center;min-width:52px;height:44px;padding:0 12px;border-radius:9999px;border:3px solid white;background:#dc2626;color:white;font-size:16px;font-weight:900;box-shadow:${glow};transform:${scale};transition:transform 150ms ease, box-shadow 150ms ease;">${count}${interestBadge}${matchBadge}</div>`,
    iconSize: [72, 56],
    iconAnchor: [36, 28],
    popupAnchor: [0, -20]
  });
}

function createExternalJobIcon(isHighlighted = false, score?: number, scoringInProgress = false) {
  const glow = isHighlighted
    ? "0 0 0 4px rgba(51,65,85,0.28), 0 8px 20px rgba(0,0,0,0.25)"
    : "0 4px 12px rgba(0,0,0,0.22)";
  const scale = isHighlighted ? "scale(1.12)" : "scale(1)";
  const label =
    score !== undefined
      ? `${score}%`
      : scoringInProgress
      ? "···"
      : "EXT";
  const fontSize = score !== undefined ? "11px" : "10px";
  return L.divIcon({
    className: "",
    html: `<div style="display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:9999px;border:2.5px solid white;background:#334155;color:white;font-size:${fontSize};font-weight:800;letter-spacing:0.04em;box-shadow:${glow};transform:${scale};transition:transform 150ms ease,box-shadow 150ms ease;">${label}</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -18]
  });
}

function formatExternalSalary(min: number | null, max: number | null): string {
  const fmt = (n: number) => n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`;
  if (min && max) return `${fmt(min)} – ${fmt(max)}/yr`;
  if (min) return `${fmt(min)}+/yr`;
  if (max) return `Up to ${fmt(max)}/yr`;
  return "";
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

  return { percentage, matchedSkills, missingSkills };
}

function getApplicantMatchSignals(profile: ApplicantProfile | null) {
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



