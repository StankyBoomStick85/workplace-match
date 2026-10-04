import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { normalizeSeverity, writeErrorLog } from "../../../lib/errorLogServer";

export const dynamic = "force-dynamic";

// Browser error reporting. Identity always comes from the session, never the
// request body: a client-supplied userId/userEmail is ignored, so a caller can
// no longer write rows attributed to someone else. Logged-out callers may still
// log (so login/signup page errors are captured), but their severity is forced
// to "low" and they can never trigger the alert email. Server-side code does
// not come through here - lib/logError.ts writes directly on the server.

// Best-effort per-IP rate limit. In-memory, so it is per serverless instance
// and resets on cold start - it blunts a flood from one client, it is not a
// global quota. Over the limit, requests are accepted but not written.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const hitsByIp = new Map<string, number[]>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hitsByIp.get(ip) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  recent.push(now);
  hitsByIp.set(ip, recent);
  if (hitsByIp.size > 5000) {
    // Keep the map bounded: drop IPs with no hits in the current window.
    for (const [key, times] of hitsByIp) {
      if (times.every((t) => now - t >= RATE_LIMIT_WINDOW_MS)) hitsByIp.delete(key);
    }
  }
  return recent.length > RATE_LIMIT_MAX;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function POST(request: Request) {
  try {
    if (isRateLimited(clientIp(request))) {
      return NextResponse.json({ ok: true, dropped: "rate_limited" }, { status: 429 });
    }

    const body = await request.json().catch(() => ({}));

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    let sessionUser: { id: string; email?: string } | null = null;
    if (supabaseUrl && supabaseAnonKey) {
      const cookieStore = cookies();
      const authClient = createServerClient(supabaseUrl, supabaseAnonKey, {
        cookies: {
          get(name: string) { return cookieStore.get(name)?.value; },
          set(name: string, value: string, options: CookieOptions) { cookieStore.set(name, value, options); },
          remove(name: string, options: CookieOptions) { cookieStore.set(name, "", options); }
        }
      });
      const { data: { user } } = await authClient.auth.getUser();
      sessionUser = user ?? null;
    }

    const isSignedIn = sessionUser !== null;
    await writeErrorLog({
      route: typeof body.route === "string" ? body.route : "unknown",
      errorMessage: typeof body.errorMessage === "string" ? body.errorMessage : "unknown",
      errorType: typeof body.errorType === "string" ? body.errorType : "unknown",
      severity: isSignedIn ? normalizeSeverity(body.severity) : "low",
      userId: sessionUser?.id ?? null,
      userEmail: sessionUser?.email ?? null,
      metadata: body.metadata ?? null,
      allowEmail: isSignedIn
    });
  } catch (err) {
    // Intentional: logging must never surface errors to the caller.
    console.error("[log-error] internal failure", err);
  }

  return NextResponse.json({ ok: true });
}
