import type { SupabaseClient } from "@supabase/supabase-js";

// Server-only notification writer. Every notifications row is now written
// here with the service role - by api/notifications for user-to-user
// notifications (after a relationship check) and directly by server routes for
// system notifications such as capability_ready. Title and message text are
// always built here from the notification type and server-read data; callers
// cannot supply free text, so no one can put arbitrary words in someone else's
// notification bell.
//
// The stored `message` column keeps its existing JSON shape (title, message,
// jobId, jobTitle, candidateId, employerId) - lib/supabaseMvpData.ts
// mapNotification and the bell's click-through deep links read exactly these.

export type UserNotificationType = "interest_received" | "new_match" | "new_message";
export type SystemNotificationType = "capability_ready";

export async function insertNotification(
  adminClient: SupabaseClient,
  row: {
    recipientUserId: string;
    type: UserNotificationType | SystemNotificationType;
    title: string;
    message: string;
    jobId?: string;
    jobTitle?: string;
    candidateId?: string;
    employerId?: string;
  }
): Promise<{ error: string | null }> {
  const payload = JSON.stringify({
    message: row.message,
    title: row.title,
    jobId: row.jobId,
    jobTitle: row.jobTitle,
    candidateId: row.candidateId,
    employerId: row.employerId
  });
  const { error } = await adminClient.from("notifications").insert({
    user_id: row.recipientUserId,
    type: row.type,
    message: payload,
    read: false
  });
  if (error) {
    console.error("[serverNotifications] insert failed", { recipientUserId: row.recipientUserId, type: row.type, error: error.message });
    return { error: error.message };
  }
  return { error: null };
}
