import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { waitUntil } from "@vercel/functions";
import { resolveCallerIdentity } from "@/lib/serverRoles";
import { createJob, getJobStatus, triggerStep } from "@/lib/capabilityStatementJobs";

// Tier 1 capability statements, Phase 1 trigger: admin-only, one user at a
// time, NOT chained into normal generation. Synthesis runs as a background job
// (lib/capabilityStatementJobs.ts) because a full run takes longer than one
// function invocation.
//
// POST { userId: string, model?: string, write?: boolean }
//   Starts a job and returns 202 { jobId } immediately.
//   Dry run by default: the result is stored on the job row only.
//   write: true also saves capability_statements / niche_capabilities /
//   capability_profile_generated_at when synthesis status is "ok".
//   Requires supabase/migrations/20261022_create_capability_statement_jobs.sql
//   (and 20261022_add_capability_statements.sql for write: true).
//
// GET ?jobId=...
//   Job status, and the full result once finished.
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function requireAdmin(): Promise<{ adminClient: SupabaseClient; userId: string } | NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey || !process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ error: "Server configuration missing." }, { status: 500 });
  }
  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const cookieStore = cookies();
  const authClient = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) { return cookieStore.get(name)?.value; },
      set(name: string, value: string, options: CookieOptions) { cookieStore.set(name, value, options); },
      remove(name: string, options: CookieOptions) { cookieStore.set(name, "", options); }
    }
  });
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  if (!(await resolveCallerIdentity(adminClient, user)).isAdmin) {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  return { adminClient, userId: user.id };
}

export async function POST(request: Request) {
  const auth = await requireAdmin();
  if (auth instanceof NextResponse) return auth;

  const body = (await request.json().catch(() => null)) as { userId?: unknown; model?: unknown; write?: unknown } | null;
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  if (!userId) {
    return NextResponse.json({ error: "userId is required." }, { status: 400 });
  }
  const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : undefined;

  const created = await createJob(auth.adminClient, { userId, requestedBy: auth.userId, model, dryRun: body?.write !== true });
  if ("error" in created) {
    return NextResponse.json({ error: created.error }, { status: created.httpStatus });
  }
  const { job } = created;
  waitUntil(triggerStep(auth.adminClient, new URL(request.url).origin, job, 1));

  return NextResponse.json(
    { jobId: job.id, userId, model: job.model, dryRun: job.dry_run, status: job.status, statusUrl: `/api/admin/synthesize-capability-statements?jobId=${job.id}` },
    { status: 202 }
  );
}

export async function GET(request: Request) {
  const auth = await requireAdmin();
  if (auth instanceof NextResponse) return auth;

  const jobId = new URL(request.url).searchParams.get("jobId") ?? "";
  if (!jobId) {
    return NextResponse.json({ error: "jobId is required." }, { status: 400 });
  }
  const job = await getJobStatus(auth.adminClient, jobId).catch((err: unknown) => {
    console.error("[synthesize-capability-statements] status lookup failed", err);
    return undefined;
  });
  if (job === undefined) return NextResponse.json({ error: "Failed to load job." }, { status: 500 });
  if (job === null) return NextResponse.json({ error: "No such job." }, { status: 404 });

  // The input snapshot (evidence + name) is never returned; the state is
  // summarized rather than dumped.
  return NextResponse.json({
    jobId: job.id,
    userId: job.user_id,
    model: job.model,
    dryRun: job.dry_run,
    status: job.status,
    stepSeq: job.step_seq,
    stepStartedAt: job.step_started_at,
    nextStep: job.state?.next ?? null,
    callsSoFar: job.state?.calls ?? [],
    error: job.error,
    result: job.result,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  });
}
