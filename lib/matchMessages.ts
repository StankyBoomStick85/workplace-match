export type MatchMessageSender = "applicant" | "employer";

import { logAdminEvent } from "./adminEvents";
import { supabase } from "./supabase";

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
let messageCache: MatchMessage[] = [];

export function readMatchMessages() {
  return messageCache;
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
  supabase.from("match_messages").insert({
    applicant_id: message.applicantId,
    employer_id: message.employerId,
    job_id: message.jobId,
    sender_role: message.senderRole,
    sender_email: message.senderEmail,
    text: trimmedText
  }).then(() => {
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
  const { data } = await supabase
    .from("match_messages")
    .select("*")
    .eq("applicant_id", thread.applicantId)
    .eq("employer_id", thread.employerId)
    .eq("job_id", thread.jobId)
    .order("created_at", { ascending: true });

  const threadMessages = (data ?? []).map((message: any) => ({
    id: message.id,
    applicantId: message.applicant_id,
    employerId: message.employer_id,
    jobId: message.job_id,
    senderRole: message.sender_role,
    senderEmail: message.sender_email ?? "",
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
