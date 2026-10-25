// What a candidate sees when their employer summary could not be updated and
// the previous version is still showing - a blocked rebuild must never look
// like a broken button. Stored as candidate_profiles.employer_summary_notice;
// cleared whenever a new summary is stored. Every notice is also logged to
// error_logs by the code that sets it.

import type { SupabaseClient } from "@supabase/supabase-js";

export type SummaryNotice = {
  message: string;
  // Plain-language reason for the candidate, never the raw check text.
  reason: string;
  // Which path set it (route or job), for support.
  source: string;
  at: string;
};

export const SUMMARY_NOT_UPDATED = "Your summary couldn't be updated; showing the previous version.";
export const SUMMARY_NOT_CREATED = "Your summary couldn't be created yet; it will be tried again on your next update.";

export function buildSummaryNotice(
  kind: "blocked" | "failed" | "limited",
  source: string,
  hadPreviousSummary: boolean,
  limit?: number
): SummaryNotice {
  const reason =
    kind === "blocked"
      ? "The new draft didn't pass our quality checks."
      : kind === "limited"
        ? `You've reached today's limit of ${limit ?? "daily"} updates. It will update on your next change after the limit resets.`
        : "Something went wrong while starting the update. We've been notified.";
  return {
    message: hadPreviousSummary ? SUMMARY_NOT_UPDATED : SUMMARY_NOT_CREATED,
    reason,
    source,
    at: new Date().toISOString(),
  };
}

export function readSummaryNotice(raw: unknown): SummaryNotice | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.message !== "string" || !r.message) return null;
  return {
    message: r.message,
    reason: typeof r.reason === "string" ? r.reason : "",
    source: typeof r.source === "string" ? r.source : "",
    at: typeof r.at === "string" ? r.at : "",
  };
}

// Sets (or clears, with null) the notice. Never throws: a notice that cannot
// be written is logged and does not fail the caller.
export async function setSummaryNotice(adminClient: SupabaseClient, userId: string, notice: SummaryNotice | null): Promise<void> {
  const { error } = await adminClient.from("candidate_profiles").update({ employer_summary_notice: notice }).eq("user_id", userId);
  if (error) console.error("[summaryNotice] could not write employer_summary_notice", { userId, error: error.message });
}
