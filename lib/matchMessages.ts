export type MatchMessageSender = "applicant" | "employer";

import { logAdminEvent } from "./adminEvents";
import { supabase } from "./supabase";

export type MatchMessage = {
  id: string;
  applicantId: string;
  employerId: string;
  jobId: string;
  senderRole: MatchMessageSender;
  text: string;
  createdAt: string;
};

export type MatchThreadContext = {
  applicantId: string;
  employerId: string;
  jobId: string;
};

export const matchMessagesKey = "workplace_match_match_messages";
let messageCache: MatchMessage[] = [];

export function readMatchMessages() {
  return messageCache;
}

export function threadKey(thread: MatchThreadContext) {
  return `${thread.applicantId}:${thread.employerId}:${thread.jobId}`;
}

export function getMessageButtonLabel(hasMessages: boolean) {
  return hasMessages ? "Messages" : "Message";
}

// Recent messages read as relative time ("Just now", "12 min ago") since that's
// what a viewer scanning an active thread actually wants to know; anything
// older than a day falls back to an absolute local date/time, because "3 days
// ago" stops being useful once you're trying to recall which day a message
// landed. Always rendered in the viewer's own timezone (Date/toLocale* read
// the browser's local timezone by default - never UTC/ISO).
export function formatMessageTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) {
    return "Just now";
  }
  if (diffMin < 60) {
    return `${diffMin} min ago`;
  }

  const now = new Date();
  if (isSameCalendarDay(date, now)) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) {
    return `Yesterday at ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function isSameCalendarDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Realtime echo suppression: addMatchThreadMessage() appends an optimistic
// local copy immediately (before the insert round-trip resolves), and the
// Realtime subscription (lib/useMatchThreadRealtime.ts) later receives that
// same row back as an INSERT event. The optimistic copy's id is a
// client-generated UUID, never the DB-assigned one, so id-based dedup can't
// catch it - this records a short-lived fingerprint at send time instead, and
// the Realtime handler consults it to skip re-appending its own echo.
const recentlySentEchoes = new Map<string, number>();
const ECHO_TTL_MS = 15000;

function echoKey(thread: MatchThreadContext, senderRole: MatchMessageSender, text: string) {
  return `${threadKey(thread)}:${senderRole}:${text}`;
}

function pruneEchoes() {
  const cutoff = Date.now() - ECHO_TTL_MS;
  for (const [key, sentAt] of recentlySentEchoes) {
    if (sentAt < cutoff) {
      recentlySentEchoes.delete(key);
    }
  }
}

export function isOwnRecentEcho(thread: MatchThreadContext, senderRole: MatchMessageSender, text: string): boolean {
  const key = echoKey(thread, senderRole, text);
  const sentAt = recentlySentEchoes.get(key);
  if (sentAt === undefined) {
    return false;
  }
  recentlySentEchoes.delete(key);
  return Date.now() - sentAt < ECHO_TTL_MS;
}

export function getMatchThreadMessages(thread: MatchThreadContext) {
  return readMatchMessages()
    .filter((message) => isSameThread(message, thread))
    .sort((first, second) => new Date(first.createdAt).getTime() - new Date(second.createdAt).getTime());
}

export function addMatchThreadMessage(message: Omit<MatchMessage, "id" | "createdAt">) {
  const trimmedText = message.text.trim();
  if (!trimmedText) {
    return null;
  }

  const nextMessage: MatchMessage = {
    ...message,
    text: trimmedText,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString()
  };
  const updatedMessages = [...readMatchMessages(), nextMessage];
  messageCache = updatedMessages;
  pruneEchoes();
  recentlySentEchoes.set(echoKey(message, message.senderRole, trimmedText), Date.now());
  // sender_email deliberately omitted - messaging is entirely internal to the
  // platform; the sender is already identifiable from applicant_id/employer_id
  // (both uuid not null) + sender_role, and no email address is ever written here.
  supabase.from("match_messages").insert({
    applicant_id: message.applicantId,
    employer_id: message.employerId,
    job_id: message.jobId,
    sender_role: message.senderRole,
    text: trimmedText
  }).then(({ error }) => {
    if (error) {
      console.error("[addMatchThreadMessage] Failed to write message", {
        applicantId: message.applicantId,
        employerId: message.employerId,
        jobId: message.jobId,
        error: error.message
      });
      return;
    }
    window.dispatchEvent(new Event("workplace-match-messages-updated"));
  });
  logAdminEvent({
    type: "message_sent",
    userRole: message.senderRole === "applicant" ? "candidate" : "employer",
    jobId: message.jobId,
    applicantId: message.applicantId,
    employerId: message.employerId
  });
  return nextMessage;
}

export async function refreshMatchThreadMessages(thread: MatchThreadContext) {
  const params = new URLSearchParams({
    resource: "match-messages",
    applicantId: thread.applicantId,
    employerId: thread.employerId,
    jobId: thread.jobId
  });
  const response = await fetch(`/api/mvp/read?${params.toString()}`);
  const { data } = await response.json();

  const threadMessages = (data ?? []).map((message: any) => ({
    id: message.id,
    applicantId: message.applicant_id,
    employerId: message.employer_id,
    jobId: message.job_id,
    senderRole: message.sender_role,
    text: message.text ?? "",
    createdAt: message.created_at
  })) as MatchMessage[];
  messageCache = [
    ...messageCache.filter((message) => !isSameThread(message, thread)),
    ...threadMessages
  ];
  return getMatchThreadMessages(thread);
}

function isSameThread(message: MatchThreadContext, thread: MatchThreadContext) {
  return (
    message.applicantId === thread.applicantId &&
    message.employerId === thread.employerId &&
    message.jobId === thread.jobId
  );
}
