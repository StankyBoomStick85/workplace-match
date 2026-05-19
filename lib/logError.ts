export type ErrorSeverity = "low" | "medium" | "high";
export type ErrorType =
  | "api_error"
  | "ai_generation"
  | "auth"
  | "database"
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
    // In a browser context the path is relative; in a Node/Edge context we need
    // an absolute URL. Set NEXT_PUBLIC_SITE_URL in .env.local (e.g. http://localhost:3000
    // for dev, https://your-domain.com for production) so server-side calls resolve.
    const base =
      typeof window !== "undefined"
        ? ""
        : (process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");

    await fetch(`${base}/api/log-error`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });
  } catch {
    // Intentional no-op — logging must never throw or affect the caller.
  }
}
