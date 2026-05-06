import type { LocalAccount } from "./localAccounts";
import {
  addNotification,
  markNotificationsReadForEmail,
  readNotificationsForEmail
} from "./supabaseMvpData";

export type ContactMethod = "email" | "text" | "call";

export type ContactNotification = {
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

export const defaultContactPreference: ContactMethod[] = ["email", "text", "call"];
export const contactNotificationsKey = "workplace_match_contact_notifications";
let notificationCache: ContactNotification[] = [];

export function getPreferredContactMethods(account: Partial<LocalAccount> | null | undefined) {
  const storedPreference = account?.preferredContactMethods;

  if (!Array.isArray(storedPreference)) {
    return defaultContactPreference;
  }

  const validMethods = storedPreference.filter(isContactMethod);
  return mergeContactMethods(validMethods);
}

export function mergeContactMethods(methods: ContactMethod[]) {
  return [...methods, ...defaultContactPreference].filter(
    (method, index, allMethods) => allMethods.indexOf(method) === index
  );
}

export function attemptPreferredContact({
  targetAccount,
  senderLabel,
  jobTitle
}: {
  targetAccount: Partial<LocalAccount> | null | undefined;
  senderLabel: string;
  jobTitle: string;
}) {
  const methods = getPreferredContactMethods(targetAccount);
  const subject = `Workplace Match: ${jobTitle}`;
  const body = `You have a mutual match for ${jobTitle}. ${senderLabel} would like to connect.`;

  for (const method of methods) {
    if (method === "email" && targetAccount?.email) {
      window.location.href = `mailto:${targetAccount.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      return true;
    }

    if (method === "text" && targetAccount?.phone) {
      window.location.href = `sms:${sanitizePhone(targetAccount.phone)}?&body=${encodeURIComponent(body)}`;
      return true;
    }

    if (method === "call" && targetAccount?.phone) {
      window.location.href = `tel:${sanitizePhone(targetAccount.phone)}`;
      return true;
    }
  }

  return false;
}

export function addContactNotification(
  notification: Omit<ContactNotification, "id" | "createdAt" | "status" | "type" | "title"> &
    Partial<Pick<ContactNotification, "type" | "title">>
) {
  const nextNotification: ContactNotification = {
    ...notification,
    type: notification.type ?? "missed_contact",
    title: notification.title ?? "Follow up needed",
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    status: "unread"
  };

  notificationCache = [nextNotification, ...notificationCache];
  addNotification(nextNotification).then(() => {
    window.dispatchEvent(new Event("workplace-match-notifications-updated"));
  });
  return nextNotification;
}

export function addNewMatchNotification(notification: Omit<ContactNotification, "id" | "createdAt" | "status" | "type" | "title" | "message">) {
  return addContactNotification({
    ...notification,
    type: "new_match",
    title: "New Match",
    message: "You have a new mutual match."
  });
}

export function addNewMessageNotification(notification: Omit<ContactNotification, "id" | "createdAt" | "status" | "type" | "title">) {
  return addContactNotification({
    ...notification,
    type: "new_message",
    title: "New Message"
  });
}

export function addScheduleRequestNotification(notification: Omit<ContactNotification, "id" | "createdAt" | "status" | "type" | "title">) {
  return addContactNotification({
    ...notification,
    type: "schedule_request",
    title: "Schedule Request"
  });
}

export function readContactNotifications() {
  return notificationCache;
}

export function getUnreadContactNotifications(recipientEmail: string) {
  const normalizedRecipientEmail = recipientEmail.trim().toLowerCase();
  return readContactNotifications().filter(
    (notification) =>
      notification.status === "unread" &&
      notification.recipientEmail.trim().toLowerCase() === normalizedRecipientEmail
  );
}

export function getNotificationsForRecipient(recipientEmail: string) {
  const normalizedRecipientEmail = recipientEmail.trim().toLowerCase();
  return readContactNotifications().filter(
    (notification) => notification.recipientEmail.trim().toLowerCase() === normalizedRecipientEmail
  );
}

export function markNotificationsRead(recipientEmail: string) {
  const normalizedRecipientEmail = recipientEmail.trim().toLowerCase();
  const updatedNotifications = notificationCache.map((notification) =>
    notification.recipientEmail.trim().toLowerCase() === normalizedRecipientEmail
      ? { ...notification, status: "read" as const }
      : notification
  );

  notificationCache = updatedNotifications;
  markNotificationsReadForEmail(recipientEmail).then((notifications) => {
    notificationCache = notifications;
    window.dispatchEvent(new Event("workplace-match-notifications-updated"));
  });
  return updatedNotifications;
}

export async function refreshContactNotifications(recipientEmail: string) {
  notificationCache = await readNotificationsForEmail(recipientEmail);
  return getNotificationsForRecipient(recipientEmail);
}

function isContactMethod(value: unknown): value is ContactMethod {
  return value === "email" || value === "text" || value === "call";
}

function sanitizePhone(phone: string) {
  return phone.replace(/[^\d+]/g, "");
}
