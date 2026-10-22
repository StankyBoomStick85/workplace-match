import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { waitUntil } from "@vercel/functions";
import { createRunContext, runWithGenerationGuard } from "@/lib/generationRunGuard";
import { JOB_ROUTE, runJobStep, triggerStep, verifyStepToken } from "@/lib/capabilityStatementJobs";

// One step of a capability statement job (see lib/capabilityStatementJobs.ts).
// Called server-to-server only - by the admin route for step 1, and by the
// previous step for every step after. Authenticated by an HMAC token, not a
// session. Answers 202 immediately and does the work in the background, so the
// caller never waits on a model call.
//
// POST { jobId: string, seq: number, token: string }
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { jobId?: unknown; seq?: unknown; token?: unknown } | null;
  const jobId = typeof body?.jobId === "string" ? body.jobId : "";
  const seq = typeof body?.seq === "number" && Number.isInteger(body.seq) && body.seq > 0 ? body.seq : 0;
  const token = typeof body?.token === "string" ? body.token : "";
  if (!jobId || !seq || !verifyStepToken(jobId, seq, token)) {
    return NextResponse.json({ error: "Forbidden." }, { status: 403 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) {
    return NextResponse.json({ error: "Server configuration missing." }, { status: 500 });
  }
  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const origin = new URL(request.url).origin;
  const t0 = Date.now();

  // The run guard writes an error_logs row for an exception, a non-ok exit, or
  // a step approaching maxDuration - the same guarantee the other generation
  // routes have. The job row itself is marked failed by the job module, or by
  // the next status check if the platform kills this step.
  const ctx = createRunContext(`${JOB_ROUTE}/step`, t0);
  waitUntil(
    runWithGenerationGuard(ctx, maxDuration, async () => {
      ctx.stage = `step_${seq}`;
      const outcome = await runJobStep(adminClient, jobId, seq);
      if (outcome.kind === "continue") {
        const { data: job } = await adminClient.from("capability_statement_jobs").select("id, user_id").eq("id", jobId).single();
        if (job) await triggerStep(adminClient, origin, job, outcome.nextSeq);
      }
      // A finished-but-failed job has already been reported by runJobStep;
      // the response stays ok so the guard does not log it a second time.
      return NextResponse.json({ jobId, seq, outcome });
    })
  );

  return NextResponse.json({ accepted: true, jobId, seq }, { status: 202 });
}
