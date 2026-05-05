"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import L from "leaflet";
import { MapContainer, Marker, Popup, TileLayer } from "react-leaflet";
import { adminSessionKey } from "../lib/adminAuth";
import { readAdminEvents, type AdminEvent } from "../lib/adminEvents";
import { zipCityStateLookup } from "../lib/addressHelpers";

type LocalAccount = {
  email: string;
  displayName?: string;
  companyName?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  profileComplete?: boolean;
  companyProfileComplete?: boolean;
};

type CandidateProfile = {
  candidateEmail?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  topSkills?: string[];
  capabilitySummary?: string;
};

type CompanyProfile = {
  employerEmail?: string;
  companyName?: string;
  city?: string;
  state?: string;
  zipCode?: string;
};

type JobListing = {
  id: string;
  employerEmail: string;
  title: string;
  locationCity?: string;
  locationState?: string;
  locationZip?: string;
  status?: string;
};

type InterestRecord = {
  employerId: string;
  jobId: string;
  candidateId: string;
  matchPercent?: number;
};

type NotificationRecord = {
  type?: string;
};

type MessageRecord = {
  jobId: string;
};

type AdminCandidate = {
  id: string;
  city: string;
  state: string;
  zipCode: string;
  skillsCount: number;
  matchCount: number;
  interestCount: number;
  position: LatLng | null;
};

type AdminJob = JobListing & {
  companyName: string;
  matchCount: number;
  interestCount: number;
  position: LatLng | null;
};

type LatLng = {
  lat: number;
  lng: number;
};

const candidateAccountKey = "workplace_match_candidate";
const candidateAccountsKey = "workplace_match_candidate_accounts";
const candidateProfileKey = "workplace_match_candidate_profile";
const employerAccountKey = "workplace_match_employer";
const employerAccountsKey = "workplace_match_employer_accounts";
const companyProfileKey = "workplace_match_employer_company_profile";
const employerJobsKey = "workplace_match_employer_jobs";
const employerInterestsKey = "workplace_match_employer_interests";
const candidateInterestsKey = "workplace_match_candidate_interests";
const mutualMatchesKey = "workplace_match_mutual_matches";
const notificationsKey = "workplace_match_contact_notifications";
const messagesKey = "workplace_match_match_messages";

const zipCoordinateLookup: Record<string, LatLng> = {
  "63026": { lat: 38.5131, lng: -90.4359 },
  "63077": { lat: 38.3453, lng: -90.9807 },
  "63088": { lat: 38.5495, lng: -90.4929 },
  "63090": { lat: 38.5581, lng: -91.0121 },
  "63101": { lat: 38.6312, lng: -90.1922 },
  "63102": { lat: 38.6309, lng: -90.1837 },
  "63103": { lat: 38.6317, lng: -90.2146 },
  "63104": { lat: 38.6103, lng: -90.2129 },
  "63105": { lat: 38.644, lng: -90.3301 },
  "63110": { lat: 38.6205, lng: -90.2551 },
  "63118": { lat: 38.5926, lng: -90.2292 },
  "63122": { lat: 38.5801, lng: -90.4068 },
  "63123": { lat: 38.5506, lng: -90.3265 },
  "63129": { lat: 38.4619, lng: -90.3171 },
  "63301": { lat: 38.8114, lng: -90.4974 },
  "63303": { lat: 38.7565, lng: -90.5581 },
  "63304": { lat: 38.7432, lng: -90.6337 }
};

const applicantIcon = createIcon("A", "bg-blue-700", "Applicant area");
const jobIcon = createIcon("J", "bg-red-800", "Job");
const matchIcon = createIcon("MATCH", "bg-green-700", "Mutual match", 60);

const emptyAdminData = {
  candidates: [] as AdminCandidate[],
  employers: [] as LocalAccount[],
  jobs: [] as AdminJob[],
  employerInterests: [] as InterestRecord[],
  candidateInterests: [] as InterestRecord[],
  totalInterests: 0,
  mutualMatches: [] as InterestRecord[],
  messages: [] as MessageRecord[],
  scheduleRequests: 0,
  reachOutAttempts: 0,
  events: [] as AdminEvent[]
};

export function AdminDashboard() {
  const [isSessionChecked, setIsSessionChecked] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    if (localStorage.getItem(adminSessionKey) !== "true") {
      window.location.href = "/admin/login";
      return;
    }

    setIsSessionChecked(true);

    function refreshAdminData() {
      setRefreshToken((current) => current + 1);
    }

    window.addEventListener("storage", refreshAdminData);
    window.addEventListener("workplace-match-admin-events-updated", refreshAdminData);
    window.addEventListener("workplace-match-notifications-updated", refreshAdminData);
    window.addEventListener("workplace-match-messages-updated", refreshAdminData);

    return () => {
      window.removeEventListener("storage", refreshAdminData);
      window.removeEventListener("workplace-match-admin-events-updated", refreshAdminData);
      window.removeEventListener("workplace-match-notifications-updated", refreshAdminData);
      window.removeEventListener("workplace-match-messages-updated", refreshAdminData);
    };
  }, []);

  const data = useMemo(
    () => (isSessionChecked ? buildAdminData() : emptyAdminData),
    [refreshToken, isSessionChecked]
  );

  if (!isSessionChecked) {
    return (
      <section className="mx-auto max-w-7xl px-4 py-8">
        <p className="text-sm text-zinc-600">Checking admin session...</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-7xl px-4 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.16em] text-red-800">Admin</p>
          <h1 className="mt-2 text-3xl font-bold text-zinc-950">Beta testing dashboard</h1>
          <p className="mt-2 text-sm text-zinc-600">
            LocalStorage-only review tools. Applicant map markers are generalized to ZIP areas.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            localStorage.removeItem(adminSessionKey);
            window.location.href = "/admin/login";
          }}
          className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-gray-50"
        >
          Log out
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-4">
        <Stat label="Applicants" value={data.candidates.length} />
        <Stat label="Employers" value={data.employers.length} />
        <Stat label="Jobs" value={data.jobs.length} />
        <Stat label="Mutual matches" value={data.mutualMatches.length} />
        <Stat label="Interests" value={data.totalInterests} />
        <Stat label="Reach outs" value={data.reachOutAttempts} />
        <Stat label="Messages" value={data.messages.length} />
        <Stat label="Schedule requests" value={data.scheduleRequests} />
      </div>

      <div className="mt-6 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-soft">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 p-4">
          <div>
            <h2 className="text-lg font-bold text-zinc-950">Admin map</h2>
            <p className="text-sm text-zinc-600">Applicants are ZIP-generalized; jobs use listing location ZIPs.</p>
          </div>
          <div className="flex flex-wrap gap-2 text-xs font-semibold text-zinc-600">
            <span className="rounded-full bg-blue-50 px-2 py-1 text-blue-800">Applicants</span>
            <span className="rounded-full bg-red-50 px-2 py-1 text-red-800">Jobs</span>
            <span className="rounded-full bg-green-50 px-2 py-1 text-green-800">Mutual matches</span>
          </div>
        </div>
        <div className="h-[440px]">
          <MapContainer center={[38.627, -90.1994]} zoom={9} scrollWheelZoom className="h-full w-full">
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            {data.candidates.map((candidate) =>
              candidate.position ? (
                <Marker key={`candidate-${candidate.id}`} position={[candidate.position.lat, candidate.position.lng]} icon={applicantIcon}>
                  <Popup>
                    <AdminPopupTitle>Applicant area</AdminPopupTitle>
                    <p>{formatLocation(candidate.city, candidate.state, candidate.zipCode)}</p>
                    <p>{candidate.skillsCount} skills</p>
                  </Popup>
                </Marker>
              ) : null
            )}
            {data.jobs.map((job) =>
              job.position ? (
                <Marker key={`job-${job.id}`} position={[job.position.lat, job.position.lng]} icon={jobIcon}>
                  <Popup>
                    <AdminPopupTitle>{job.title}</AdminPopupTitle>
                    <p>{job.companyName}</p>
                    <p>{formatLocation(job.locationCity, job.locationState, job.locationZip)}</p>
                    <p>{job.interestCount} interests</p>
                  </Popup>
                </Marker>
              ) : null
            )}
            {data.mutualMatches.map((match) => {
              const job = data.jobs.find((storedJob) => storedJob.id === match.jobId);
              const candidate = data.candidates.find((storedCandidate) => storedCandidate.id === match.candidateId);
              if (!job?.position) {
                return null;
              }

              return (
                <Marker key={`match-${match.employerId}-${match.jobId}-${match.candidateId}`} position={[job.position.lat, job.position.lng]} icon={matchIcon}>
                  <Popup>
                    <AdminPopupTitle>Mutual match</AdminPopupTitle>
                    <p>{job.title}</p>
                    <p>Applicant area: {candidate ? formatLocation(candidate.city, candidate.state, candidate.zipCode) : "Unknown"}</p>
                    <p>{typeof match.matchPercent === "number" ? `${match.matchPercent}% match` : "Match percent unavailable"}</p>
                  </Popup>
                </Marker>
              );
            })}
          </MapContainer>
        </div>
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel title="Jobs">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-xs font-bold uppercase tracking-[0.12em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Job</th>
                  <th className="px-3 py-2">Employer</th>
                  <th className="px-3 py-2">Location</th>
                  <th className="px-3 py-2">Matches</th>
                  <th className="px-3 py-2">Interests</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.jobs.length > 0 ? (
                  data.jobs.map((job) => (
                    <tr key={job.id}>
                      <td className="px-3 py-3 font-semibold text-zinc-950">{job.title}</td>
                      <td className="px-3 py-3 text-zinc-600">{job.companyName}</td>
                      <td className="px-3 py-3 text-zinc-600">{formatLocation(job.locationCity, job.locationState, job.locationZip)}</td>
                      <td className="px-3 py-3 text-zinc-600">{job.matchCount}</td>
                      <td className="px-3 py-3 text-zinc-600">{job.interestCount}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">
                      No employer-created jobs yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>

        <Panel title="Applicants">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50 text-left text-xs font-bold uppercase tracking-[0.12em] text-zinc-500">
                <tr>
                  <th className="px-3 py-2">Generalized location</th>
                  <th className="px-3 py-2">Skills</th>
                  <th className="px-3 py-2">Matches</th>
                  <th className="px-3 py-2">Interests</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.candidates.length > 0 ? (
                  data.candidates.map((candidate) => (
                    <tr key={candidate.id}>
                      <td className="px-3 py-3 font-semibold text-zinc-950">{formatLocation(candidate.city, candidate.state, candidate.zipCode)}</td>
                      <td className="px-3 py-3 text-zinc-600">{candidate.skillsCount}</td>
                      <td className="px-3 py-3 text-zinc-600">{candidate.matchCount}</td>
                      <td className="px-3 py-3 text-zinc-600">{candidate.interestCount}</td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-zinc-500">
                      No applicants yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <Panel title="Recent activity" className="mt-6">
        {data.events.length > 0 ? (
          <div className="divide-y divide-gray-100">
            {data.events.slice(0, 12).map((event) => (
              <div key={event.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <p className="font-semibold text-zinc-950">{formatEventType(event.type)}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    {event.userRole ?? "unknown"} {event.jobId ? `- job ${event.jobId}` : ""}
                  </p>
                </div>
                <p className="text-xs font-semibold text-zinc-500">{formatDateTime(event.timestamp)}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-md border border-dashed border-gray-300 bg-gray-50 p-4 text-sm text-zinc-600">
            No beta activity events have been collected yet.
          </p>
        )}
      </Panel>
    </section>
  );
}

function buildAdminData() {
  const candidateAccounts = readAccounts(candidateAccountsKey, candidateAccountKey);
  const employerAccounts = readAccounts(employerAccountsKey, employerAccountKey);
  const candidateProfiles = readCandidateProfiles();
  const companyProfiles = readCompanyProfiles();
  const employerInterests = readArray<InterestRecord>(employerInterestsKey);
  const candidateInterests = readArray<InterestRecord>(candidateInterestsKey);
  const mutualMatches = readArray<InterestRecord>(mutualMatchesKey);
  const messages = readArray<MessageRecord>(messagesKey);
  const notifications = readArray<NotificationRecord>(notificationsKey);
  const events = readAdminEvents().sort((first, second) => new Date(second.timestamp).getTime() - new Date(first.timestamp).getTime());

  const employers = employerAccounts;
  const jobs = readArray<JobListing>(employerJobsKey)
    .filter((job) => job?.id && !isSeedJob(job))
    .map((job) => {
      const employerAccount = employerAccounts.find((account) => normalizeEmail(account.email) === normalizeEmail(job.employerEmail));
      const companyProfile = companyProfiles.find((profile) => normalizeEmail(profile.employerEmail ?? "") === normalizeEmail(job.employerEmail));
      return {
        ...job,
        companyName: getCompanyName(employerAccount, companyProfile),
        matchCount: mutualMatches.filter((match) => match.jobId === job.id).length,
        interestCount: [...employerInterests, ...candidateInterests].filter((interest) => interest.jobId === job.id).length,
        position: getZipPosition(job.locationZip)
      };
    });

  const candidates = candidateAccounts.map((account, index) => {
    const matchingProfile =
      candidateProfiles.find((profile) => normalizeEmail(profile.candidateEmail ?? "") === normalizeEmail(account.email)) ??
      (candidateProfiles.length === 1 ? candidateProfiles[0] : null);
    const zipCode = matchingProfile?.zipCode || account.zipCode || "";
    const cityState = zipCityStateLookup[zipCode] ?? null;
    const city = cityState?.city || matchingProfile?.city || account.city || "";
    const state = cityState?.state || matchingProfile?.state || account.state || "";
    const candidateId = account.email || matchingProfile?.candidateEmail || `candidate-${index}`;
    const skillsCount = Array.isArray(matchingProfile?.topSkills) ? matchingProfile.topSkills.length : 0;

    return {
      id: candidateId,
      city,
      state,
      zipCode,
      skillsCount,
      matchCount: mutualMatches.filter((match) => normalizeEmail(match.candidateId) === normalizeEmail(candidateId)).length,
      interestCount: [...employerInterests, ...candidateInterests].filter(
        (interest) => normalizeEmail(interest.candidateId) === normalizeEmail(candidateId)
      ).length,
      position: getZipPosition(zipCode)
    };
  });

  return {
    candidates,
    employers,
    jobs,
    employerInterests,
    candidateInterests,
    totalInterests: employerInterests.length + candidateInterests.length,
    mutualMatches,
    messages,
    scheduleRequests: notifications.filter((notification) => notification.type === "schedule_request").length,
    reachOutAttempts: events.filter((event) => event.type === "reach_out_clicked").length,
    events
  };
}

function readAccounts(accountsKey: string, legacyKey: string) {
  const accounts = readArray<LocalAccount>(accountsKey);
  const legacy = readObject<LocalAccount>(legacyKey);
  const byEmail = new Map<string, LocalAccount>();
  [...accounts, ...(legacy ? [legacy] : [])].forEach((account) => {
    if (account?.email) {
      byEmail.set(normalizeEmail(account.email), account);
    }
  });
  return Array.from(byEmail.values());
}

function readCandidateProfiles() {
  const profile = readObject<CandidateProfile>(candidateProfileKey);
  return profile ? [profile] : [];
}

function readCompanyProfiles() {
  const profile = readObject<CompanyProfile>(companyProfileKey);
  return profile ? [profile] : [];
}

function readArray<T>(key: string) {
  const saved = localStorage.getItem(key);
  if (!saved) {
    return [] as T[];
  }

  try {
    const parsed = JSON.parse(saved) as T[] | T;
    return Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  } catch {
    return [] as T[];
  }
}

function readObject<T>(key: string) {
  const saved = localStorage.getItem(key);
  if (!saved) {
    return null;
  }

  try {
    const parsed = JSON.parse(saved) as T;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function getZipPosition(zipCode?: string) {
  return zipCode ? zipCoordinateLookup[zipCode] ?? null : null;
}

function getCompanyName(account?: LocalAccount, profile?: CompanyProfile) {
  const companyName = profile?.companyName?.trim() || account?.companyName?.trim() || account?.displayName?.trim();
  return companyName || "Employer";
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function formatLocation(city?: string, state?: string, zipCode?: string) {
  const cityState = [city, state].filter(Boolean).join(", ");
  return [cityState, zipCode].filter(Boolean).join(" ") || "Location unavailable";
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function formatEventType(type: string) {
  return type
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function isSeedJob(job: JobListing) {
  return job.id?.startsWith("wm-test-") || job.employerEmail === "grouping-test-employer@workplacematch.local";
}

function createIcon(label: string, colorClassName: string, title: string, width = 34) {
  return L.divIcon({
    className: "",
    html: `<div title="${title}" class="inline-flex h-8 min-w-8 items-center justify-center rounded-full ${colorClassName} px-2 text-xs font-bold text-white shadow-md">${label}</div>`,
    iconSize: [width, 32],
    iconAnchor: [width / 2, 16],
    popupAnchor: [0, -16]
  });
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-soft">
      <p className="text-sm text-zinc-600">{label}</p>
      <p className="mt-2 text-3xl font-bold text-zinc-950">{value}</p>
    </div>
  );
}

function Panel({
  title,
  children,
  className = ""
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-lg border border-gray-200 bg-white p-5 shadow-soft ${className}`}>
      <h2 className="text-lg font-bold text-zinc-950">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function AdminPopupTitle({ children }: { children: ReactNode }) {
  return <p className="mb-1 font-bold text-zinc-950">{children}</p>;
}
