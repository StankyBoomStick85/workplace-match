// Shared "fail loudly" reporting for capability-generation failures that are
// NOT privacy violations (see lib/employerTextGuard.ts for that specific
// case). This covers the other way a generation step can silently produce a
// broken profile: a truncated or otherwise incomplete Anthropic response that
// throws nothing, so nothing catches it. Every call site that detects one of
// these must report it here rather than just console.error-ing and moving on
// - a console line nobody is watching is exactly how the Step 4 truncation
// this module was added for went unnoticed.
//
// Loosely typed on purpose: no Supabase dependency of its own, so this stays
// usable from any server route without coupling to a specific client
// construction.
export async function reportGenerationFailure({
  adminClient,
  sendEmailFn,
  route,
  errorType,
  message,
  userId,
  severity = "high",
  metadata
}: {
  adminClient: { from: (table: string) => { insert: (row: Record<string, unknown>) => PromiseLike<unknown> } };
  sendEmailFn: (args: { to: string; subject: string; html: string; text?: string }) => Promise<unknown>;
  route: string;
  errorType: string;
  message: string;
  userId: string;
  severity?: "high" | "medium";
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  console.error(`[${route}] ${message}`, { errorType, userId, ...metadata });

  // Returns whether the error_logs row actually landed, so a caller that must
  // guarantee a record (see lib/generationRunGuard.ts) can fall back to a
  // second, minimal insert instead of assuming this one worked.
  let logged = false;
  try {
    // supabase-js reports insert failures in the resolved { error }, it does not
    // throw - checking only for a thrown exception let a rejected insert (bad
    // column value, oversized payload, RLS) disappear with no trace at all.
    const result = (await adminClient.from("error_logs").insert({
      route,
      error_message: message,
      error_type: errorType,
      user_id: userId,
      severity,
      metadata: metadata ?? null
    })) as { error?: unknown } | null;
    if (result?.error) {
      console.error(`[${route}] error_logs insert rejected`, result.error);
    } else {
      logged = true;
    }
  } catch (err) {
    console.error(`[${route}] Failed to write error_logs row`, err);
  }

  if (severity !== "high") {
    return logged;
  }

  // The error_logs row above carries the full metadata; the email copy is capped
  // so a large payload (e.g. a guard abort listing every violation) stays readable.
  const EMAIL_DETAILS_LIMIT = 20000;
  const fullDetails = metadata ? JSON.stringify(metadata, null, 2) : "";
  const details = fullDetails.length > EMAIL_DETAILS_LIMIT
    ? fullDetails.slice(0, EMAIL_DETAILS_LIMIT) + "\n... (truncated; full metadata in error_logs)"
    : fullDetails;

  try {
    await sendEmailFn({
      to: "joel@workplacematchapp.com",
      subject: `WPM Alert - ${errorType} on ${route}`,
      html: `<p><b>Route:</b> ${route}</p><p><b>Error type:</b> ${errorType}</p><p><b>User:</b> ${userId}</p><p><b>Message:</b> ${message}</p>${
        details ? `<p><b>Details:</b></p><pre>${details}</pre>` : ""
      }`,
      text: `Route: ${route}\nError type: ${errorType}\nUser: ${userId}\nMessage: ${message}${
        details ? `\n\nDetails:\n${details}` : ""
      }`
    });
  } catch (err) {
    console.error(`[${route}] Failed to send alert email`, err);
  }
  return logged;
}
