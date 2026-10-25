import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { canonicalDirection, directionCompatColumns, normalizeDirection, readStoredDirection } from "@/lib/candidateDirection";
import { requestRebuild } from "@/lib/profileRebuilds";

// Saves the candidate's direction ("Where I'm heading") - the only writer of
// candidate_profiles.direction, and of job_types / work_preference, which are
// kept in step with it for older readers.
//
// When the direction actually changed:
//   - alternate_paths is cleared, so it regenerates from the new direction the
//     next time it is opened;
//   - the candidate's cached career-mode job scores are cleared, so jobs are
//     re-scored against it (the employer-side scorer re-scores on its own:
//     direction is part of its candidate hash);
//   - a summary-only rebuild is requested (lib/profileRebuilds.ts), subject to
//     the daily limit and queued if a job is already running. It publishes
//     immediately; the summary step's checks are the control.
//
// POST { direction } -> { direction, changed, rebuild }
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
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

  const body = (await request.json().catch(() => null)) as { direction?: unknown } | null;
  const normalized = normalizeDirection(body?.direction);
  if ("error" in normalized) return NextResponse.json({ error: normalized.error }, { status: 400 });
  const { direction } = normalized;

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: existing, error: loadError } = await adminClient
    .from("candidate_profiles")
    .select("direction")
    .eq("user_id", user.id)
    .maybeSingle();
  if (loadError) {
    console.error("[applicant/direction] load failed", loadError);
    return NextResponse.json({ error: "Could not load your profile." }, { status: 500 });
  }
  if (!existing) return NextResponse.json({ error: "Save your profile first." }, { status: 400 });

  const changed = canonicalDirection(readStoredDirection(existing.direction)) !== canonicalDirection(direction);

  const { error: saveError } = await adminClient
    .from("candidate_profiles")
    .update({
      direction,
      ...directionCompatColumns(direction),
      ...(changed ? { alternate_paths: null } : {})
    })
    .eq("user_id", user.id);
  if (saveError) {
    console.error("[applicant/direction] save failed", saveError);
    return NextResponse.json({ error: "Could not save your direction." }, { status: 500 });
  }

  if (!changed) return NextResponse.json({ direction, changed: false, rebuild: null });

  const { error: scoreError } = await adminClient
    .from("match_scores")
    .delete()
    .eq("candidate_id", user.id)
    .eq("scoring_mode", "career");
  if (scoreError) console.error("[applicant/direction] could not clear cached career scores", scoreError);

  try {
    const rebuild = await requestRebuild(adminClient, new URL(request.url).origin, user.id, "summary", "direction_change");
    return NextResponse.json({ direction, changed: true, rebuild });
  } catch (err) {
    console.error("[applicant/direction] rebuild request failed", err);
    // The direction is saved either way; the summary catches up on the next rebuild.
    return NextResponse.json({ direction, changed: true, rebuild: { status: "skipped", kind: "summary", reason: "rebuild could not be requested" } });
  }
}
