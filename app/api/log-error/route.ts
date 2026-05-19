import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sendEmail } from "../../../lib/email";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));

    const route         = typeof body.route         === "string" ? body.route         : "unknown";
    const errorMessage  = typeof body.errorMessage  === "string" ? body.errorMessage  : "unknown";
    const errorType     = typeof body.errorType     === "string" ? body.errorType     : "unknown";
    const userId        = typeof body.userId        === "string" ? body.userId        : null;
    const userEmail     = typeof body.userEmail     === "string" ? body.userEmail     : null;
    const severity      = typeof body.severity      === "string" ? body.severity      : "low";
    const metadata      = body.metadata ?? null;

    const supabaseUrl            = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (supabaseUrl && supabaseServiceRoleKey) {
      const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false }
      });

      await adminClient.from("error_logs").insert({
        route,
        error_message: errorMessage,
        error_type: errorType,
        user_id: userId,
        user_email: userEmail,
        severity,
        metadata
      });
    }

    if (severity === "high") {
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
              <tr><td style="padding:6px 12px 6px 0; font-weight:bold; white-space:nowrap;">Severity</td><td style="padding:6px 0;">${escapeHtml(severity)}</td></tr>
              <tr><td style="padding:6px 12px 6px 0; font-weight:bold; white-space:nowrap;">User email</td><td style="padding:6px 0;">${userEmail ? escapeHtml(userEmail) : "—"}</td></tr>
              <tr><td style="padding:6px 12px 6px 0; font-weight:bold; white-space:nowrap;">User ID</td><td style="padding:6px 0;">${userId ? escapeHtml(userId) : "—"}</td></tr>
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
          `Severity:   ${severity}`,
          `User email: ${userEmail ?? "—"}`,
          `User ID:    ${userId ?? "—"}`,
          `Timestamp:  ${timestamp}`,
          "",
          "Error message:",
          errorMessage,
          ...(metadata ? ["", "Metadata:", JSON.stringify(metadata, null, 2)] : [])
        ].join("\n")
      });
    }
  } catch (err) {
    // Intentional: logging must never surface errors to the caller.
    console.error("[log-error] internal failure", err);
  }

  return NextResponse.json({ ok: true });
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
