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
}): Promise<void> {
  console.error(`[${route}] ${message}`, { errorType, userId, ...metadata });

  try {
    await adminClient.from("error_logs").insert({
      route,
      error_message: message,
      error_type: errorType,
      user_id: userId,
      severity,
      metadata: metadata ?? null
    });
  } catch (err) {
    console.error(`[${route}] Failed to write error_logs row`, err);
  }

  if (severity !== "high") {
    return;
  }

  try {
    await sendEmailFn({
      to: "joel@workplacematchapp.com",
      subject: `WPM Alert - ${errorType} on ${route}`,
      html: `<p><b>Route:</b> ${route}</p><p><b>Error type:</b> ${errorType}</p><p><b>User:</b> ${userId}</p><p><b>Message:</b> ${message}</p>${
        metadata ? `<p><b>Details:</b></p><pre>${JSON.stringify(metadata, null, 2)}</pre>` : ""
      }`,
      text: `Route: ${route}\nError type: ${errorType}\nUser: ${userId}\nMessage: ${message}${
        metadata ? `\n\nDetails:\n${JSON.stringify(metadata, null, 2)}` : ""
      }`
    });
  } catch (err) {
    console.error(`[${route}] Failed to send alert email`, err);
  }
}
