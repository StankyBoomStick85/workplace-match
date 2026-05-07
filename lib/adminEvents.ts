export type AdminEventType =
  | "signup_created"
  | "job_created"
  | "interest_selected"
  | "mutual_match_created"
  | "notification_clicked"
  | "reach_out_clicked"
  | "message_sent"
  | "schedule_requested"
  | "interest_removed";

export type AdminEventRole = "candidate" | "employer" | "admin";

export type AdminEvent = {
  id: string;
  type: AdminEventType;
  timestamp: string;
  userRole?: AdminEventRole;
  jobId?: string;
  applicantId?: string;
  employerId?: string;
  dedupeKey?: string;
  metadata?: Record<string, string | number | boolean>;
};

export const adminEventsKey = "workplace_match_admin_events";
let adminEventCache: AdminEvent[] = [];

export function readAdminEvents() {
  return adminEventCache;
}

export function logAdminEvent(event: Omit<AdminEvent, "id" | "timestamp">) {
  if (typeof window === "undefined") {
    return null;
  }

  const events = readAdminEvents();
  const nextDedupeKey = event.dedupeKey ? `event_${stableHash(event.dedupeKey)}` : undefined;
  if (nextDedupeKey && events.some((storedEvent) => storedEvent.dedupeKey === nextDedupeKey)) {
    return null;
  }

  const nextEvent: AdminEvent = {
    ...event,
    applicantId: event.applicantId ? safeIdentifier(event.applicantId, "applicant") : undefined,
    employerId: event.employerId ? safeIdentifier(event.employerId, "employer") : undefined,
    dedupeKey: nextDedupeKey,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString()
  };

  adminEventCache = [nextEvent, ...events].slice(0, 500);
  supabase.from("admin_activity_events").insert({
    type: nextEvent.type,
    user_role: nextEvent.userRole,
    job_id: normalizeUuid(nextEvent.jobId),
    applicant_id: normalizeUuid(nextEvent.applicantId),
    employer_id: normalizeUuid(nextEvent.employerId),
    metadata: nextEvent.metadata ?? {},
    dedupe_key: nextEvent.dedupeKey
  }).then(() => {
    window.dispatchEvent(new Event("workplace-match-admin-events-updated"));
  });
  return nextEvent;
}

export async function refreshAdminEvents() {
  const response = await fetch("/api/mvp/read?resource=admin-events");
  const { data } = await response.json();
  adminEventCache = (data ?? []).map((event: any) => ({
    id: event.id,
    type: event.type,
    timestamp: event.created_at,
    userRole: event.user_role,
    jobId: event.job_id,
    applicantId: event.applicant_id,
    employerId: event.employer_id,
    dedupeKey: event.dedupe_key,
    metadata: event.metadata ?? {}
  }));
  return adminEventCache;
}

function safeIdentifier(value: string, prefix: string) {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed.includes("@")) {
    return trimmed;
  }

  return `${prefix}_${stableHash(trimmed)}`;
}

function stableHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(36);
}

function normalizeUuid(value?: string) {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}
import { supabase } from "./supabase";
