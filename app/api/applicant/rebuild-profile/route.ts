import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { requestRebuild, type RebuildKind } from "@/lib/profileRebuilds";

// Candidate-triggered rebuild of their own profile.
//   kind "summary": regenerate the employer summary from stored statements.
//   kind "full":    rebuild statements and niche skills, then the summary.
// Limits (per candidate, rolling 24h): 3 full, 20 summary-only. While a job is
// running the request is queued as the single follow-up. Both run as
// capability statement jobs, so every write passes the same checks.
//
// POST { kind } -> RebuildOutcome
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey || !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "Server configuration missing." }, { status: 500 });
  }

  const cookieStore = cookies();
  const authClient = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) { return cookieStore.get(name)?.value; },
      set(name: string, value: string, options: CookieOptions) { cookieStore.set(name, value, options); },
      remove(name: string, options: CookieOptions) { cookieStore.set(name, "", options); }
    }
  });
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated." }, { status: 401 });

  const body = (await request.json().catch(() => null)) as { kind?: unknown } | null;
  const kind: RebuildKind | null = body?.kind === "summary" || body?.kind === "full" ? body.kind : null;
  if (!kind) return NextResponse.json({ error: 'kind must be "summary" or "full".' }, { status: 400 });

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  try {
    const outcome = await requestRebuild(adminClient, new URL(request.url).origin, user.id, kind, "candidate_request");
    const httpStatus = outcome.status === "limited" ? 429 : outcome.status === "skipped" ? 409 : 202;
    return NextResponse.json(outcome, { status: httpStatus });
  } catch (err) {
    console.error("[applicant/rebuild-profile] failed", err);
    return NextResponse.json({ error: "Could not start the rebuild. Please try again." }, { status: 500 });
  }
}
