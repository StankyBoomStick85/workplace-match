export type ErrorSeverity = "low" | "medium" | "high";
export type ErrorType =
  | "api_error"
  | "ai_generation"
  | "auth"
  | "database"
  | "privacy_violation"
  | "unknown";

export interface LogErrorParams {
  route: string;
  errorMessage: string;
  errorType: ErrorType | string;
  severity: ErrorSeverity;
  userId?: string | null;
  userEmail?: string | null;
  metadata?: Record<string, unknown> | null;
}

// Severity guide:
//   high   — AI generation down, auth broken, Supabase unreachable
//   medium — single user profile save failed, match not loading
//   low    — minor UI data missing, non-critical background task failed

export async function logError(params: LogErrorParams): Promise<void> {
  try {
    // Server-side callers (API routes) are trusted code: write directly rather
    // than POSTing to /api/log-error. That route now takes identity only from
    // the request's session, and a server-to-server fetch carries no session,
    // so going through it would silently strip userId and force severity to
    // "low". (Next.js compiles typeof window to a constant in client bundles,
    // so this branch and its import never ship to the browser.)
    if (typeof window === "undefined") {
      const { writeErrorLog, normalizeSeverity } = await import("./errorLogServer");
      await writeErrorLog({
        route: params.route,
        errorMessage: params.errorMessage,
        errorType: params.errorType,
        severity: normalizeSeverity(params.severity),
        userId: params.userId ?? null,
        userEmail: params.userEmail ?? null,
        metadata: params.metadata ?? null,
        allowEmail: true
      });
      return;
    }

    // Browser: the route ignores any userId/userEmail in this body and takes
    // identity from the session cookie instead.
    await fetch(`/api/log-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });
  } catch {
    // Intentional no-op — logging must never throw or affect the caller.
  }
}
