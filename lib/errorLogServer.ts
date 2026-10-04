import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "./email";

// Server-side writer for error_logs, shared by the /api/log-error route (for
// browser callers) and by lib/logError.ts when it runs on the server (trusted
// server code, which used to make an un-authenticated HTTP round trip to that
// same route). Every value is size-capped here so no caller - trusted or not -
// can write an oversized row or alert email.

export type ErrorLogSeverity = "low" | "medium" | "high";

const MAX_ROUTE_CHARS = 200;
const MAX_TYPE_CHARS = 100;
const MAX_MESSAGE_CHARS = 4000;
const MAX_EMAIL_CHARS = 320;
export const MAX_METADATA_BYTES = 8 * 1024;

export function normalizeSeverity(value: unknown): ErrorLogSeverity {
  return value === "medium" || value === "high" ? value : "low";
}

function cap(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) + "…[truncated]" : value;
}

// Metadata over the cap is replaced (not silently dropped) with a marker and a
// preview, so an oversized payload is still visible in the log.
export function capMetadata(metadata: unknown): unknown {
  if (metadata === undefined || metadata === null) return null;
  let serialized: string;
  try {
    serialized = JSON.stringify(metadata);
  } catch {
    return { unserializable: true };
  }
  if (serialized === undefined) return null;
  if (serialized.length <= MAX_METADATA_BYTES) return metadata;
  return {
    truncated: true,
    originalBytes: serialized.length,
    preview: serialized.slice(0, MAX_METADATA_BYTES / 2)
  };
}

export async function writeErrorLog(entry: {
  route: string;
  errorMessage: string;
  errorType: string;
  severity: ErrorLogSeverity;
  userId: string | null;
  userEmail: string | null;
  metadata: unknown;
  // Send the alert email for high severity. False for anything that must never
  // email (e.g. logged-out callers).
  allowEmail: boolean;
}): Promise<void> {
  const route = cap(entry.route || "unknown", MAX_ROUTE_CHARS);
  const errorType = cap(entry.errorType || "unknown", MAX_TYPE_CHARS);
  const errorMessage = cap(entry.errorMessage || "unknown", MAX_MESSAGE_CHARS);
  const userEmail = entry.userEmail ? cap(entry.userEmail, MAX_EMAIL_CHARS) : null;
  const metadata = capMetadata(entry.metadata);

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supabaseUrl && supabaseServiceRoleKey) {
    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const { error } = await adminClient.from("error_logs").insert({
      route,
      error_message: errorMessage,
      error_type: errorType,
      user_id: entry.userId,
      user_email: userEmail,
      severity: entry.severity,
      metadata
    });
    if (error) {
      console.error("[errorLogServer] error_logs insert rejected", error);
    }
  }

  if (entry.severity !== "high" || !entry.allowEmail) return;

  const timestamp = new Date().toISOString();
  await sendEmail({
    to: "joel@workplacematchapp.com",
    subject: `WPM Alert - ${errorType} on ${route}`,
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #18181b;">
        <h2 style="color:#991b1b;">WPM High-Severity Error</h2>
        <table style="border-collapse:collapse; width:100%;">
          <tr><td style="padding:6px 12px 6px 0; font-weight:bold; white-space:nowrap;">Route</td><td style="padding:6px 0;">${escapeHtml(route)}</td></tr>
          <tr><td style="padding:6px 12px 6px 0; font-weight:bold; white-space:nowrap;">Error type</td><td style="padding:6px 0;">${escapeHtml(errorType)}</td></tr>
          <tr><td style="padding:6px 12px 6px 0; font-weight:bold; white-space:nowrap;">Severity</td><td style="padding:6px 0;">${escapeHtml(entry.severity)}</td></tr>
          <tr><td style="padding:6px 12px 6px 0; font-weight:bold; white-space:nowrap;">User email</td><td style="padding:6px 0;">${userEmail ? escapeHtml(userEmail) : "—"}</td></tr>
          <tr><td style="padding:6px 12px 6px 0; font-weight:bold; white-space:nowrap;">User ID</td><td style="padding:6px 0;">${entry.userId ? escapeHtml(entry.userId) : "—"}</td></tr>
          <tr><td style="padding:6px 12px 6px 0; font-weight:bold; white-space:nowrap;">Timestamp</td><td style="padding:6px 0;">${escapeHtml(timestamp)}</td></tr>
        </table>
        <hr style="border:none;border-top:1px solid #e4e4e7;margin:16px 0;" />
        <p style="font-weight:bold;">Error message</p>
        <pre style="background:#f4f4f5;padding:12px;border-radius:4px;white-space:pre-wrap;word-break:break-all;">${escapeHtml(errorMessage)}</pre>
        ${metadata ? `<p style="font-weight:bold;">Metadata</p><pre style="background:#f4f4f5;padding:12px;border-radius:4px;white-space:pre-wrap;word-break:break-all;">${escapeHtml(JSON.stringify(metadata, null, 2))}</pre>` : ""}
      </div>
    `,
    text: [
      "WPM High-Severity Error",
      "",
      `Route:      ${route}`,
      `Error type: ${errorType}`,
      `Severity:   ${entry.severity}`,
      `User email: ${userEmail ?? "—"}`,
      `User ID:    ${entry.userId ?? "—"}`,
      `Timestamp:  ${timestamp}`,
      "",
      "Error message:",
      errorMessage,
      ...(metadata ? ["", "Metadata:", JSON.stringify(metadata, null, 2)] : [])
    ].join("\n")
  });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
