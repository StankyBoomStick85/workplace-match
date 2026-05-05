export type MatchMessageSender = "applicant" | "employer";

import { logAdminEvent } from "./adminEvents";

export type MatchMessage = {
  id: string;
  applicantId: string;
  employerId: string;
  jobId: string;
  senderRole: MatchMessageSender;
  senderEmail: string;
  text: string;
  createdAt: string;
};

export type MatchThreadContext = {
  applicantId: string;
  employerId: string;
  jobId: string;
};

export const matchMessagesKey = "workplace_match_match_messages";

export function readMatchMessages() {
  const savedMessages = localStorage.getItem(matchMessagesKey);
  if (!savedMessages) {
    return [];
  }

  try {
    return JSON.parse(savedMessages) as MatchMessage[];
  } catch {
    return [];
  }
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
  localStorage.setItem(matchMessagesKey, JSON.stringify(updatedMessages));
  logAdminEvent({
    type: "message_sent",
    userRole: message.senderRole === "applicant" ? "candidate" : "employer",
    jobId: message.jobId,
    applicantId: message.applicantId,
    employerId: message.employerId
  });
  window.dispatchEvent(new Event("workplace-match-messages-updated"));
  return nextMessage;
}

function isSameThread(message: MatchThreadContext, thread: MatchThreadContext) {
  return (
    message.applicantId === thread.applicantId &&
    message.employerId === thread.employerId &&
    message.jobId === thread.jobId
  );
}
