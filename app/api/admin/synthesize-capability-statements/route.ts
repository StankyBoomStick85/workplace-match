import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { resolveCallerIdentity } from "@/lib/serverRoles";
import { runCapabilityStatementSynthesis, DEFAULT_SYNTHESIS_MODEL } from "@/lib/capabilityStatements";
import type { EvidenceGroup, StoredDoc } from "@/lib/capabilityPipeline";

// Tier 1 capability statements, Phase 1 trigger: admin-only, one user at a
// time, NOT chained into normal generation. Reads the user's saved evidence
// groups (pending_evidence_groups) and runs synthesis.
//
// POST { userId: string, model?: string, write?: boolean }
// - Dry run by default: returns the full synthesis result and writes nothing.
// - write: true saves capability_statements / niche_capabilities /
//   capability_profile_generated_at, and only when synthesis status is "ok".
//   Requires supabase/migrations/20261022_add_capability_statements.sql.
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(request: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey || !apiKey) {
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

  const body = (await request.json().catch(() => null)) as { userId?: unknown; model?: unknown; write?: unknown } | null;
  const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
  if (!userId) {
    return NextResponse.json({ error: "userId is required." }, { status: 400 });
  }
  const model = typeof body?.model === "string" && body.model.trim() ? body.model.trim() : DEFAULT_SYNTHESIS_MODEL;
  const write = body?.write === true;

  const { data: profile, error: profileError } = await adminClient
    .from("candidate_profiles")
    .select("display_name, pending_evidence_groups, document_metadata")
    .eq("user_id", userId)
    .maybeSingle();
  if (profileError) {
    return NextResponse.json({ error: "Failed to load profile.", detail: profileError.message }, { status: 500 });
  }
  if (!profile) {
    return NextResponse.json({ error: "No profile for that userId." }, { status: 404 });
  }
  const groups: EvidenceGroup[] = Array.isArray(profile.pending_evidence_groups) ? (profile.pending_evidence_groups as EvidenceGroup[]) : [];
  if (groups.length === 0) {
    return NextResponse.json({ error: "Profile has no saved evidence groups. Run capability generation first." }, { status: 400 });
  }
  const storedDocs: StoredDoc[] = Array.isArray(profile.document_metadata) ? (profile.document_metadata as StoredDoc[]) : [];

  const result = await runCapabilityStatementSynthesis({
    anthropic: new Anthropic({ apiKey }),
    groups,
    storedDocs,
    knownFullName: profile.display_name ?? null,
    model,
  });

  let written = false;
  let writeError: string | null = null;
  if (write && result.status === "ok") {
    const { error } = await adminClient
      .from("candidate_profiles")
      .update({
        capability_statements: result.core,
        niche_capabilities: result.niche,
        capability_profile_generated_at: result.generatedAt,
      })
      .eq("user_id", userId);
    if (error) {
      writeError = error.message;
      console.error("[synthesize-capability-statements] write failed", { userId, error: error.message });
    } else {
      written = true;
    }
  }

  return NextResponse.json({ userId, write, written, writeError, result });
}
