import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Guarantees that a capability-generation request which fails leaves an
// error_logs row - no exceptions. This codebase has a documented history of
// runs that died with nothing but a console line nobody was watching (or not
// even that), each costing a full session to diagnose. Three exit shapes were
// found unrecorded before this existed:
//   1. An early `return NextResponse.json(..., { status: 4xx/5xx })` with no
//      reportGenerationFailure call in front of it (e.g. the finalize route's
//      "groups_ready" gate, the Phase 1 DB-write failure, Step 4's API error).
//   2. An exception thrown out of the route body (Next turns it into a bare
//      500; nothing is written anywhere durable).
//   3. The platform killing the function at maxDuration - no code runs after
//      that, so the only way to leave a record is to write it shortly BEFORE
//      the deadline, which is what the watchdog below does.
// It also puts capability_generation_status back to a truthful, retryable value
// on failure. Previously a failed finalize left the status at "writing_profile"
// forever, and since finalize gates on "groups_ready", every "Retry finishing
// your profile" click after that was rejected with a 400 that was itself never
// logged - the profile could not recover without a full Phase 1 re-run.

type AdminClient = SupabaseClient;

export type GenerationRunContext = {
  route: string;
  t0: number;
  // Free-text marker of what the route is doing right now; recorded on any
  // unlogged exit or watchdog row so the failure is pinned to a stage.
  stage: string;
  userId: string | null;
  // Set to true by the route only after a FATAL failure row has actually been
  // written (reportGenerationFailure returned true). Non-fatal warning rows
  // (step2_truncated etc.) must not set this, or a later unlogged fatal exit
  // would be masked by an earlier warning.
  failureLogged: boolean;
  // When non-null, the status value written back on any failure exit. Set by the
  // route once it has overwritten capability_generation_status with an
  // in-progress value; null means the route never touched the status.
  statusOnFailure: string | null;
  // Set immediately before the final success write, so a watchdog firing during
  // that write does not reset the status underneath it.
  committing: boolean;
  adminClient: AdminClient | null;
};

export function createRunContext(route: string, t0: number): GenerationRunContext {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    route,
    t0,
    stage: "init",
    userId: null,
    failureLogged: false,
    statusOnFailure: null,
    committing: false,
    adminClient: url && key ? createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } }) : null
  };
}

async function insertRow(ctx: GenerationRunContext, row: Record<string, unknown>): Promise<boolean> {
  if (!ctx.adminClient) {
    console.error(`[${ctx.route}][run-guard] no admin client - cannot write error_logs row`, row);
    return false;
  }
  try {
    const { error } = await ctx.adminClient.from("error_logs").insert(row);
    if (error) {
      console.error(`[${ctx.route}][run-guard] error_logs insert rejected`, error);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[${ctx.route}][run-guard] error_logs insert threw`, err);
    return false;
  }
}

async function restoreStatus(ctx: GenerationRunContext, reason: string): Promise<void> {
  if (ctx.statusOnFailure === null || !ctx.userId || !ctx.adminClient) return;
  try {
    const { error } = await ctx.adminClient
      .from("candidate_profiles")
      .update({ capability_generation_status: ctx.statusOnFailure })
      .eq("user_id", ctx.userId);
    if (error) {
      console.error(`[${ctx.route}][run-guard] status restore failed (${reason})`, error);
      await insertRow(ctx, {
        route: ctx.route,
        error_message: `Failed to restore capability_generation_status to "${ctx.statusOnFailure}" after ${reason}`,
        error_type: "generation_status_restore_failed",
        user_id: ctx.userId,
        severity: "high",
        metadata: { stage: ctx.stage, statusOnFailure: ctx.statusOnFailure, error: String(error.message ?? error) }
      });
    } else {
      console.log(`[${ctx.route}][run-guard] status restored to "${ctx.statusOnFailure}" (${reason})`);
    }
  } catch (err) {
    console.error(`[${ctx.route}][run-guard] status restore threw (${reason})`, err);
  }
}

async function recordFailedExit(
  ctx: GenerationRunContext,
  detail: { httpStatus: number | null; responseError: string | null; thrown: unknown }
): Promise<void> {
  const reason = detail.thrown !== null ? "exception" : `http_${detail.httpStatus}`;
  if (!ctx.failureLogged) {
    const thrownMessage = detail.thrown instanceof Error ? detail.thrown.message : detail.thrown === null ? null : String(detail.thrown);
    const ok = await insertRow(ctx, {
      route: ctx.route,
      error_message:
        detail.thrown !== null
          ? `Unhandled exception at stage "${ctx.stage}": ${thrownMessage}`
          : `Route exited with HTTP ${detail.httpStatus} at stage "${ctx.stage}" without a failure row: ${detail.responseError ?? "(no error text)"}`,
      error_type: detail.thrown !== null ? "generation_unhandled_exception" : "generation_exit_unlogged",
      user_id: ctx.userId,
      severity: "high",
      metadata: {
        stage: ctx.stage,
        httpStatus: detail.httpStatus,
        responseError: detail.responseError,
        thrownMessage,
        thrownStack: detail.thrown instanceof Error ? detail.thrown.stack?.slice(0, 2000) ?? null : null,
        elapsedMs: Date.now() - ctx.t0
      }
    });
    if (ok) ctx.failureLogged = true;
  }
  await restoreStatus(ctx, reason);
}

// Wraps a generation route body. `body` should do everything the route did
// before; this adds (a) a guaranteed failure row for any non-2xx or thrown exit,
// (b) status restoration, and (c) a pre-deadline watchdog row.
export async function runWithGenerationGuard(
  ctx: GenerationRunContext,
  maxDurationSeconds: number,
  body: () => Promise<Response>
): Promise<Response> {
  // Fires 20s before the platform limit - enough for one insert and one status
  // update to land before the function is killed. If the route somehow finishes
  // after this fires, its own success write still wins (the watchdog skips the
  // status reset once ctx.committing is set).
  const watchdogMs = Math.max(5000, (maxDurationSeconds - 20) * 1000);
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    void (async () => {
      console.error(`[${ctx.route}][run-guard] WATCHDOG: ${watchdogMs}ms elapsed at stage "${ctx.stage}" - function likely to be killed at maxDuration`);
      const ok = await insertRow(ctx, {
        route: ctx.route,
        error_message: `Run still in progress at stage "${ctx.stage}" after ${Math.round(watchdogMs / 1000)}s - approaching the ${maxDurationSeconds}s maxDuration limit; the platform will kill it with no further logging`,
        error_type: "generation_timeout_imminent",
        user_id: ctx.userId,
        severity: "high",
        metadata: { stage: ctx.stage, elapsedMs: Date.now() - ctx.t0, maxDurationSeconds }
      });
      if (ok) ctx.failureLogged = true;
      if (!ctx.committing) await restoreStatus(ctx, "watchdog");
    })();
  }, watchdogMs);

  try {
    const response = await body();
    if (!response.ok) {
      let responseError: string | null = null;
      try {
        const parsed = await response.clone().json();
        responseError = typeof parsed?.error === "string" ? parsed.error : JSON.stringify(parsed).slice(0, 500);
      } catch {
        responseError = null;
      }
      await recordFailedExit(ctx, { httpStatus: response.status, responseError, thrown: null });
    } else if (watchdogFired) {
      console.log(`[${ctx.route}][run-guard] run completed after the watchdog fired (stage "${ctx.stage}")`);
    }
    return response;
  } catch (err) {
    console.error(`[${ctx.route}][run-guard] unhandled exception at stage "${ctx.stage}"`, err);
    await recordFailedExit(ctx, { httpStatus: null, responseError: null, thrown: err });
    return new Response(JSON.stringify({ error: "Capability generation failed unexpectedly. Please try again." }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  } finally {
    clearTimeout(watchdog);
  }
}
