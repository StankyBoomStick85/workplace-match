import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { resolveCallerIdentity } from "@/lib/serverRoles";

export const dynamic = "force-dynamic";

// Admin only, from the verified Supabase session (see lib/serverRoles.ts).
// Previously this trusted a workplace_match_admin_session=true cookie that the
// browser set itself, so anyone could forge it, list every access request, and
// approve their own email into approved_emails. Returns a response to send back
// (401/403/500) when the caller is not a verified admin, or null to proceed.
async function rejectUnlessAdmin(): Promise<NextResponse | null> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const adminClient = getAdminClient();
  if (!supabaseUrl || !supabaseAnonKey || !adminClient) {
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
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }
  const caller = await resolveCallerIdentity(adminClient, user);
  if (!caller.isAdmin) {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  return null;
}

function getAdminClient() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseServiceRoleKey) return null;
  return createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export async function GET() {
  const rejection = await rejectUnlessAdmin();
  if (rejection) return rejection;

  const adminClient = getAdminClient();
  if (!adminClient) {
    return NextResponse.json({ error: "Server configuration missing." }, { status: 500 });
  }

  const { data, error } = await adminClient
    .from("access_requests")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[admin/access-requests] Failed to load access requests", error);
    return NextResponse.json({ error: "Failed to load access requests." }, { status: 500 });
  }

  // Pending first, most recent on top within each group. Array.prototype.sort is a
  // stable sort, so the created_at desc order from the query is preserved within
  // each status partition.
  const sorted = [...(data ?? [])].sort((a, b) => {
    if (a.status === "pending" && b.status !== "pending") return -1;
    if (a.status !== "pending" && b.status === "pending") return 1;
    return 0;
  });

  return NextResponse.json({ data: sorted });
}

export async function PATCH(request: Request) {
  const rejection = await rejectUnlessAdmin();
  if (rejection) return rejection;

  const body = await request.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const status = body?.status;

  if (!id || (status !== "approved" && status !== "denied" && status !== "pending")) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const adminClient = getAdminClient();
  if (!adminClient) {
    return NextResponse.json({ error: "Server configuration missing." }, { status: 500 });
  }

  if (status === "approved") {
    const { data: existingRequest, error: fetchError } = await adminClient
      .from("access_requests")
      .select("email, name")
      .eq("id", id)
      .maybeSingle();

    if (fetchError || !existingRequest) {
      return NextResponse.json({ error: "Request not found." }, { status: 404 });
    }

    const normalizedEmail = String(existingRequest.email ?? "").trim().toLowerCase();
    const { error: upsertError } = await adminClient
      .from("approved_emails")
      .upsert(
        { email: normalizedEmail, note: existingRequest.name, source_request_id: id },
        { onConflict: "email" }
      );

    if (upsertError) {
      console.error("[admin/access-requests] Failed to upsert approved_emails", upsertError);
      return NextResponse.json({ error: "Failed to approve email." }, { status: 500 });
    }
  }

  const { error } = await adminClient
    .from("access_requests")
    .update({ status })
    .eq("id", id);

  if (error) {
    console.error("[admin/access-requests] Failed to update status", error);
    return NextResponse.json({ error: "Failed to update request." }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
