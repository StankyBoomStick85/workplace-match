import { supabase } from "./supabase";

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

export type MvpNotification = {
  id: string;
  type: "new_match" | "new_message" | "schedule_request" | "missed_contact";
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
}) {
  await supabase.from("interests").upsert(
    {
      from_user_id: fromUserId,
      to_user_id: toUserId,
      job_id: jobId,
      status: "pending"
    },
    { onConflict: "from_user_id,to_user_id,job_id" }
  );
  triggerTransactionalEmail({
    type: "interest_notification",
    recipientUserId: toUserId,
    jobId
  });
}

export async function removeInterest({
  fromUserId,
  toUserId,
  jobId
}: {
  fromUserId: string;
  toUserId: string;
  jobId: string;
}) {
  await supabase
    .from("interests")
    .delete()
    .eq("from_user_id", fromUserId)
    .eq("to_user_id", toUserId)
    .eq("job_id", jobId);
  await supabase.from("matches").delete().eq("candidate_id", toUserId).eq("employer_id", fromUserId).eq("job_id", jobId);
  await supabase.from("matches").delete().eq("candidate_id", fromUserId).eq("employer_id", toUserId).eq("job_id", jobId);
}

export async function getMutualMatches() {
  const data = await fetchMvpData<any[]>("mutual-matches");
  return data.map(mapMatch);
}

export async function addMutualMatch(match: {
  candidateId: string;
  employerId: string;
  jobId: string;
  matchPercent: number;
}) {
  const existingMatch = await fetchMvpData<{ id: string } | null>("match-exists", {
    candidateId: match.candidateId,
    employerId: match.employerId,
    jobId: match.jobId
  });

  await supabase.from("matches").upsert(
    {
      candidate_id: match.candidateId,
      employer_id: match.employerId,
      job_id: match.jobId,
      capability_match: match.matchPercent,
      score: match.matchPercent,
      status: "mutual_match"
    },
    { onConflict: "candidate_id,employer_id,job_id" }
  );

  if (!existingMatch) {
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
}

export async function readNotificationsForEmail(email: string) {
  const result = await fetchMvpPayload<any[]>("notifications", { email });
  const recipient = result.recipient as MvpUser | null | undefined;
  if (!recipient) {
    return [];
  }

  return (result.data ?? []).map((notification: any) => mapNotification(notification, recipient.email));
}

export async function addNotification(notification: Omit<MvpNotification, "id" | "createdAt" | "status"> & { status?: "unread" | "read" }) {
  const recipient = await getUserByEmail(notification.recipientEmail);
  if (!recipient) {
    return null;
  }

  const message = JSON.stringify({
    message: notification.message,
    title: notification.title,
    senderEmail: notification.senderEmail,
    jobId: notification.jobId,
    jobTitle: notification.jobTitle,
    candidateId: notification.candidateId,
    employerId: notification.employerId,
    dedupeKey: notification.dedupeKey
  });

  if (notification.dedupeKey) {
    const existing = (await readNotificationsForEmail(notification.recipientEmail)).find(
      (storedNotification) => storedNotification.dedupeKey === notification.dedupeKey
    );
    if (existing) {
      return existing;
    }
  }

  const nextNotification: MvpNotification = {
    ...notification,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: notification.status ?? "unread"
  };

  await supabase.from("notifications").insert({
    user_id: recipient.id,
    type: notification.type,
    message,
    read: notification.status === "read",
    related_id: notification.dedupeKey ? stableRelatedId(notification.dedupeKey) : null
  });

  return nextNotification;
}

export async function markNotificationsReadForEmail(email: string) {
  const user = await getUserByEmail(email);
  if (!user) {
    return [];
  }
  await supabase.from("notifications").update({ read: true }).eq("user_id", user.id);
  return readNotificationsForEmail(email);
}

export async function getUserByEmail(email: string) {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  const data = await fetchMvpData<MvpUser | null>("user-by-email", { email: normalizedEmail });
  return data as MvpUser | null;
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
    locationCity: "",
    locationState: "",
    locationZip: zip,
    payRange: formatPay(data.pay_min, data.pay_max, data.pay_type),
    jobType: data.job_type ?? "",
    schedule: data.shift ?? "",
    requiredSkills: data.required_capabilities ?? [],
    description: data.summary ?? "",
    status: "Active",
    createdAt: data.created_at ?? ""
  };
}

function mapMatch(data: any): MvpMatch {
  return {
    candidateId: data.candidate_id,
    employerId: data.employer_id,
    jobId: data.job_id,
    matchPercent: Math.round(Number(data.score ?? data.capability_match ?? 0)),
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

function formatPay(payMin?: number | null, payMax?: number | null, payType?: string | null) {
  const suffix = payType === "annual" ? "/year" : "/hr";
  if (payMin && payMax && payMax !== payMin) {
    return `$${payMin}-$${payMax}${suffix}`;
  }
  if (payMin) {
    return `$${payMin}${suffix}`;
  }
  return "";
}

function stableRelatedId(value: string) {
  const text = value.padEnd(32, "0").replace(/[^a-f0-9]/gi, "0").slice(0, 32);
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
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
