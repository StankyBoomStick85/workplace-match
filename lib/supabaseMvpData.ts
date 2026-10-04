import { formatStoredPayRange } from "./payFormatting";
import { supabase } from "./supabase";
import type { CapabilityEntry } from "./capabilityPipeline";

export type MvpRole = "candidate" | "employer" | "admin";

export type MvpUser = {
  id: string;
  email: string;
  role: MvpRole;
};

export type MvpApplicantProfile = {
  userId: string;
  candidateEmail?: string;
  fullName?: string;
  zipCode?: string;
  desiredJobType?: string;
  workPreference?: string;
  capabilitySummary?: string;
  // Capability-only, pronoun-neutral narrative generated specifically for
  // employer display - the only summary field an employer-facing view may
  // ever render. capabilitySummary above is the candidate's own draft (may
  // contain PII) and must never be shown to an employer.
  employerSummary?: string;
  // Structured per-capability entries - passed through raw here exactly like
  // employerSummary above is. NOT safe to render as-is: every employer-facing
  // consumer must gate it through isCapabilityEntriesSafe/scanCapabilityEntries
  // (lib/employerTextGuard.ts) immediately before display, same as
  // employerSummary already is at each render site. Never render this in an
  // employer-facing view without that check.
  capabilityEntries?: CapabilityEntry[];
  topSkills?: string[];
  experienceLevel?: string;
  updatedAt?: string;
  profilePictureUrl?: string;
};

export type MvpEmployerProfile = {
  userId: string;
  employerEmail: string;
  companyName?: string;
  industry?: string;
  companySize?: string;
  zipCode?: string;
};

export type MvpJobListing = {
  id: string;
  employerEmail: string;
  employerId: string;
  title: string;
  locationStreet?: string;
  locationCity: string;
  locationState: string;
  locationZip?: string;
  latitude?: number | null;
  longitude?: number | null;
  payRange: string;
  payMin: number | null;
  payMax: number | null;
  payType: string | null;
  jobType: string;
  schedule: string;
  requiredSkills: string[];
  preferredSkills: string[];
  description: string;
  status: "Active";
  createdAt: string;
};

export type MvpInterest = {
  id?: string;
  employerId: string;
  jobId: string;
  candidateId: string;
  matchPercent?: number;
  createdAt?: string;
  status?: string;
};

export type MvpMatch = {
  employerId: string;
  jobId: string;
  candidateId: string;
  // null when the row genuinely has no score (both score and capability_match
  // are nullable with no default - see mapMatch()) - never coerced to 0.
  matchPercent: number | null;
  createdAt: string;
  status: "mutual_match";
  notificationStatus: {
    employerInternal: "pending";
    candidateInternal: "pending";
    employerExternal: "pending";
    candidateExternal: "pending";
  };
};

export type MvpNotification = {
  id: string;
  type: "new_match" | "new_message" | "schedule_request" | "missed_contact" | "interest_received" | "capability_ready";
  recipientEmail: string;
  senderEmail: string;
  jobId: string;
  jobTitle: string;
  candidateId?: string;
  employerId?: string;
  title: string;
  message: string;
  dedupeKey?: string;
  createdAt: string;
  status: "unread" | "read";
};

export async function getCurrentMvpUser(requiredRole?: MvpRole) {
  const { data: { user: authUser } } = await supabase.auth.getUser();
  if (!authUser) {
    return null;
  }

  const data = await fetchMvpData<MvpUser | null>("current-user");
  const user = data as MvpUser | null;
  if (!user || (requiredRole && user.role !== requiredRole)) {
    return null;
  }

  return user;
}

export async function getApplicantProfile(userId: string) {
  const data = await fetchMvpData<any | null>("candidate-profile", { userId });
  if (!data) {
    return null;
  }

  return mapCandidateProfile(data);
}

export async function getAllApplicantProfiles() {
  const data = await fetchMvpData<any[]>("candidate-profiles");
  return data.map(mapCandidateProfile);
}

export async function getEmployerProfile(userId: string) {
  const data = await fetchMvpData<any | null>("employer-profile", { userId });
  return data ? mapEmployerProfile(data) : null;
}

export async function getAllEmployerProfiles() {
  const data = await fetchMvpData<any[]>("employer-profiles");
  return data.map(mapEmployerProfile);
}

export type MvpSavedExternalJob = {
  jobId: string;
  jobSource: string;
  title: string;
  company: string;
  location: string;
  salaryMin: number | null;
  salaryMax: number | null;
  url: string;
  savedAt: string;
};

export async function getSavedExternalJobs(candidateId: string) {
  const data = await fetchMvpData<any[]>("saved-jobs", { candidateId });
  return data.map((row) => ({
    jobId: row.job_id,
    jobSource: row.job_source,
    title: row.job_title ?? "",
    company: row.company ?? "",
    location: row.location ?? "",
    salaryMin: row.salary_min ?? null,
    salaryMax: row.salary_max ?? null,
    url: row.url ?? "",
    savedAt: row.saved_at ?? ""
  })) as MvpSavedExternalJob[];
}

// Unheart for an external listing - deletes the saved_jobs row. Same
// operation handleSaveExternalJob() already performs when un-saving from the
// Job Map (components/ApplicantJobsMap.tsx); this just makes it callable from
// My Jobs too, through the same anon-key client + RLS policy, not a new
// write path.
export async function deleteSavedExternalJob(candidateId: string, jobId: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("saved_jobs").delete().eq("candidate_id", candidateId).eq("job_id", jobId);
  if (error) {
    console.error("[deleteSavedExternalJob] Failed to remove saved job", { candidateId, jobId, error: error.message });
    return { error: error.message };
  }
  return { error: null };
}

// Career-mode match_scores for a set of job ids - read-only, never triggers
// scoring. A jobId absent from the response simply hasn't been scored yet
// (or its score expired) - callers should treat that as "not yet scored",
// not "zero".
export async function getCandidateMatchScores(candidateId: string, jobIds: string[]) {
  if (jobIds.length === 0) {
    return {} as Record<string, number>;
  }
  const data = await fetchMvpData<Array<{ job_id: string; score: number }>>("candidate-match-scores", {
    candidateId,
    jobIds: jobIds.join(",")
  });
  return data.reduce<Record<string, number>>((acc, row) => {
    acc[row.job_id] = row.score;
    return acc;
  }, {});
}

export async function getAllJobs() {
  const data = await fetchMvpData<any[]>("jobs");
  return data.map(mapJob);
}

export async function getEmployerJobs(employerId: string) {
  const data = await fetchMvpData<any[]>("employer-jobs", { employerId });
  return data.map(mapJob);
}

export async function getApplicantInterests() {
  const data = await fetchMvpData<any[]>("candidate-interests");
  return data.map((interest: any) => ({
    id: interest.id,
    candidateId: interest.from_user_id,
    employerId: interest.to_user_id,
    jobId: interest.job_id,
    createdAt: interest.created_at,
    status: "candidate_interested"
  })) as MvpInterest[];
}

export async function getEmployerInterests() {
  const data = await fetchMvpData<any[]>("employer-interests");
  return data.map((interest: any) => ({
    id: interest.id,
    employerId: interest.from_user_id,
    candidateId: interest.to_user_id,
    jobId: interest.job_id,
    createdAt: interest.created_at,
    status: "employer_interested"
  })) as MvpInterest[];
}

export async function addInterest({
  fromUserId,
  toUserId,
  jobId
}: {
  fromUserId: string;
  toUserId: string;
  jobId: string;
}): Promise<{ error: string | null; mutual: boolean }> {
  // Written server-side (app/api/interests): the sender is the session user,
  // never fromUserId, which is kept only for logging and call-site symmetry.
  const result = await postJson<{ ok?: boolean; mutual?: boolean; error?: string }>("/api/interests", {
    action: "add",
    toUserId,
    jobId
  });

  if (result.error) {
    console.error("[addInterest] Failed to write interest", { fromUserId, toUserId, jobId, error: result.error });
    return { error: result.error, mutual: false };
  }

  triggerTransactionalEmail({
    type: "interest_notification",
    recipientUserId: toUserId,
    jobId
  });

  // The route checks for the reciprocal interest with a live DB read after
  // writing, rather than relying on the caller's client-side interest arrays
  // (loaded once at page mount) - if the other party's interest was written
  // after this session's page load, a stale in-memory check would silently
  // never detect the pair, and the matches row would never get created.
  return { error: null, mutual: result.mutual === true };
}

export async function checkReciprocalInterest({
  fromUserId,
  toUserId,
  jobId
}: {
  fromUserId: string;
  toUserId: string;
  jobId: string;
}): Promise<boolean> {
  try {
    const existing = await fetchMvpData<{ id: string } | null>("reciprocal-interest", {
      fromUserId,
      toUserId,
      jobId
    });
    console.log("[checkReciprocalInterest] Reciprocal lookup", {
      searchedFor: { fromUserId, toUserId, jobId },
      found: existing ? existing.id : null
    });
    return Boolean(existing);
  } catch (error) {
    // The interest row this check follows has already been written
    // successfully by this point - a failure here must not be thrown back up
    // and treated as the interest write itself failing. It just means we
    // can't confirm mutuality right now; log it so it's visible instead of a
    // swallowed unhandled rejection, and let a later reload/action re-check.
    console.error("[checkReciprocalInterest] Reciprocal lookup failed", {
      searchedFor: { fromUserId, toUserId, jobId },
      error: error instanceof Error ? error.message : String(error)
    });
    return false;
  }
}

export async function removeInterest({
  fromUserId,
  toUserId,
  jobId
}: {
  fromUserId: string;
  toUserId: string;
  jobId: string;
}): Promise<{ error: string | null }> {
  // Server-side (app/api/interests): deletes only the session user's own
  // interest, plus any match between the two on this job.
  const result = await postJson<{ ok?: boolean; error?: string }>("/api/interests", {
    action: "remove",
    toUserId,
    jobId
  });
  if (result.error) {
    console.error("[removeInterest] Failed to remove interest/match", { fromUserId, toUserId, jobId, error: result.error });
    return { error: result.error };
  }
  return { error: null };
}

export async function getMutualMatches() {
  const data = await fetchMvpData<any[]>("mutual-matches");
  return data.map(mapMatch);
}

export async function addMutualMatch(match: {
  candidateId: string;
  employerId: string;
  jobId: string;
}): Promise<{ error: string | null }> {
  // Server-side (app/api/matches): created only when BOTH interests exist,
  // verified there, with the match score read from the stored AI score on the
  // server - no percentage is sent from here. created=false means the match
  // already existed.
  const result = await postJson<{ ok?: boolean; created?: boolean; error?: string }>("/api/matches", {
    candidateId: match.candidateId,
    employerId: match.employerId,
    jobId: match.jobId
  });

  if (result.error) {
    console.error("[addMutualMatch] Failed to write mutual match", { match, error: result.error });
    return { error: result.error };
  }

  if (result.created) {
    triggerTransactionalEmail({
      type: "match_notification",
      recipientUserId: match.candidateId,
      jobId: match.jobId
    });
    triggerTransactionalEmail({
      type: "match_notification",
      recipientUserId: match.employerId,
      jobId: match.jobId
    });
  }
  return { error: null };
}

export async function readNotificationsForEmail(email: string) {
  const result = await fetchMvpPayload<any[]>("notifications", { email });
  const recipient = result.recipient as MvpUser | null | undefined;
  if (!recipient) {
    return [];
  }

  return (result.data ?? []).map((notification: any) => mapNotification(notification, recipient.email));
}

// Notifications are delivered by the recipient's real users.id
// (candidate_profiles.user_id / job_posts.employer_id are both already real
// user ids), never resolved from an email address.
//
// Written server-side by app/api/notifications, which checks the caller's
// relationship with the recipient and builds the title/message text itself -
// the title, message and jobTitle passed here are no longer sent, and are kept
// only so existing call sites don't change shape. For a notification to
// yourself (new_match), the other party is taken from candidateId/employerId.
export async function addNotificationByUserId(notification: {
  recipientUserId: string;
  type: string;
  title: string;
  message: string;
  jobId?: string;
  jobTitle?: string;
  candidateId?: string;
  employerId?: string;
}): Promise<{ error: string | null }> {
  const otherUserId =
    notification.recipientUserId === notification.candidateId ? notification.employerId : notification.candidateId;
  const result = await postJson<{ ok?: boolean; error?: string }>("/api/notifications", {
    type: notification.type,
    recipientUserId: notification.recipientUserId,
    jobId: notification.jobId,
    otherUserId
  });

  if (result.error) {
    console.error("[addNotificationByUserId] Failed to write notification", {
      recipientUserId: notification.recipientUserId,
      type: notification.type,
      error: result.error
    });
    return { error: result.error };
  }
  // So any NotificationBell mounted in this tab refreshes immediately instead
  // of only on next mount/page load.
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("workplace-match-notifications-updated"));
  }
  return { error: null };
}

// Marks the SIGNED-IN user's notifications read (server-side, app/api/notifications
// PATCH). email is only used to re-read the list afterwards; the update itself
// is always scoped to the session user.
export async function markNotificationsReadForEmail(email: string) {
  const result = await patchJson("/api/notifications", { all: true });
  if (result.error) {
    console.error("[markNotificationsReadForEmail] Failed to mark notifications read", { error: result.error });
  }
  return readNotificationsForEmail(email);
}

export async function markNotificationReadById(id: string): Promise<{ error: string | null }> {
  // Server-side (app/api/notifications PATCH): only ever the session user's own row.
  const { error } = await patchJson("/api/notifications", { id });
  if (error) {
    console.error("[markNotificationReadById] Failed to mark notification read", { id, error });
    return { error };
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("workplace-match-notifications-updated"));
  }
  return { error: null };
}

// Dismiss deletes the row rather than adding a "dismissed" flag: the table
// only has a `read` boolean today, so a soft-dismiss would need a schema
// migration for a single explicit user action (as opposed to `read`, which
// the UI already sets automatically as a side effect of viewing). Deleting
// needs no schema change and matches what "clear/dismiss" means to a user -
// this notification is gone, not just acknowledged.
export async function deleteNotificationById(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from("notifications").delete().eq("id", id);
  if (error) {
    console.error("[deleteNotificationById] Failed to delete notification", { id, error: error.message });
    return { error: error.message };
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("workplace-match-notifications-updated"));
  }
  return { error: null };
}

function mapCandidateProfile(data: any): MvpApplicantProfile {
  return {
    userId: data.user_id,
    candidateEmail: data.users?.email,
    fullName: data.display_name ?? "",
    zipCode: data.zip_code ?? "",
    desiredJobType: Array.isArray(data.job_types) ? data.job_types[0] ?? "" : "",
    workPreference: data.work_preference ?? "",
    capabilitySummary: data.summary ?? "",
    employerSummary: data.employer_summary ?? "",
    capabilityEntries: Array.isArray(data.capability_entries) ? data.capability_entries : [],
    topSkills: data.capability_tags ?? [],
    experienceLevel: data.experience_level ?? "",
    updatedAt: data.created_at ?? "",
    profilePictureUrl: data.profile_picture_url ?? ""
  };
}

function mapEmployerProfile(data: any): MvpEmployerProfile {
  return {
    userId: data.user_id,
    employerEmail: data.users?.email ?? "",
    companyName: data.company_name ?? "",
    industry: data.industry ?? "",
    companySize: data.company_size ?? "",
    zipCode: data.location_zip ?? ""
  };
}

function mapJob(data: any): MvpJobListing {
  const zip = data.location_zip ?? "";
  return {
    id: data.id,
    employerId: data.employer_id,
    employerEmail: data.users?.email ?? data.employer_id,
    title: data.title ?? "",
    locationStreet: data.street_address ?? "",
    locationCity: data.city ?? "",
    locationState: data.state ?? "",
    locationZip: zip,
    latitude: data.latitude ?? null,
    longitude: data.longitude ?? null,
    payRange: formatStoredPayRange(data.pay_min, data.pay_max, data.pay_type),
    payMin: data.pay_min ?? null,
    payMax: data.pay_max ?? null,
    payType: data.pay_type ?? null,
    jobType: data.job_type ?? "",
    schedule: data.shift ?? "",
    requiredSkills: data.required_capabilities ?? [],
    preferredSkills: data.preferred_capabilities ?? [],
    description: data.summary ?? "",
    status: "Active",
    createdAt: data.created_at ?? ""
  };
}

function mapMatch(data: any): MvpMatch {
  // Both columns are nullable with no default (lib/schema.sql) - a row that
  // predates consistent dual-writes, or was written by some other path, can
  // genuinely have neither set. That must read as "unscored" (null), not as
  // a computed 0 - `?? 0` here would be indistinguishable from a real zero
  // to every consumer downstream.
  const rawScore = data.score ?? data.capability_match ?? null;
  return {
    candidateId: data.candidate_id,
    employerId: data.employer_id,
    jobId: data.job_id,
    matchPercent: rawScore === null ? null : Math.round(Number(rawScore)),
    createdAt: data.created_at ?? "",
    status: "mutual_match",
    notificationStatus: {
      employerInternal: "pending",
      candidateInternal: "pending",
      employerExternal: "pending",
      candidateExternal: "pending"
    }
  };
}

function mapNotification(data: any, recipientEmail: string): MvpNotification {
  let parsed: any = {};
  try {
    parsed = JSON.parse(data.message ?? "{}");
  } catch {
    parsed = { message: data.message };
  }

  return {
    id: data.id,
    type: data.type,
    recipientEmail,
    senderEmail: parsed.senderEmail ?? "",
    jobId: parsed.jobId ?? "",
    jobTitle: parsed.jobTitle ?? "",
    candidateId: parsed.candidateId,
    employerId: parsed.employerId,
    title: parsed.title ?? data.type,
    message: parsed.message ?? "",
    dedupeKey: parsed.dedupeKey,
    createdAt: data.created_at,
    status: data.read ? "read" : "unread"
  };
}

function triggerTransactionalEmail({
  type,
  recipientUserId,
  jobId
}: {
  type: "match_notification" | "interest_notification";
  recipientUserId: string;
  jobId: string;
}) {
  if (typeof window === "undefined") {
    return;
  }

  fetch("/api/email/notification", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type, recipientUserId, jobId })
  }).catch(() => undefined);
}

// POST helper for the server-side write routes. Never throws: a network or
// HTTP failure comes back as { error } so callers keep their existing
// error-returning contract.
async function patchJson(url: string, body: unknown): Promise<{ error?: string }> {
  return sendJson("PATCH", url, body);
}

async function postJson<T extends { error?: string }>(url: string, body: unknown): Promise<T> {
  return sendJson<T>("POST", url, body);
}

async function sendJson<T extends { error?: string }>(method: "POST" | "PATCH", url: string, body: unknown): Promise<T> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const payload = (await response.json().catch(() => ({}))) as T;
    if (!response.ok) {
      return { ...payload, error: payload.error ?? `Request failed (${response.status}).` };
    }
    return payload;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Network error." } as T;
  }
}

async function fetchMvpData<T>(resource: string, params: Record<string, string> = {}) {
  const payload = await fetchMvpPayload<T>(resource, params);
  return payload.data as T;
}

async function fetchMvpPayload<T>(resource: string, params: Record<string, string> = {}) {
  const searchParams = new URLSearchParams({ resource, ...params });
  const response = await fetch(`/api/mvp/read?${searchParams.toString()}`);
  const payload = (await response.json()) as { data: T; error?: string; [key: string]: unknown };

  if (!response.ok) {
    throw new Error(payload.error ?? "Unable to load data.");
  }

  return payload;
}
