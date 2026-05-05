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

export function readAdminEvents() {
  if (typeof window === "undefined") {
    return [];
  }

  const savedEvents = localStorage.getItem(adminEventsKey);
  if (!savedEvents) {
    return [];
  }

  try {
    return JSON.parse(savedEvents) as AdminEvent[];
  } catch {
    return [];
  }
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

  localStorage.setItem(adminEventsKey, JSON.stringify([nextEvent, ...events].slice(0, 500)));
  window.dispatchEvent(new Event("workplace-match-admin-events-updated"));
  return nextEvent;
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
