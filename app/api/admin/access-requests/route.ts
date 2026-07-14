import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { adminSessionKey } from "../../../../lib/adminAuth";

export const dynamic = "force-dynamic";

function isAuthorizedAdmin() {
  const cookieStore = cookies();
  return cookieStore.get(adminSessionKey)?.value === "true";
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
  if (!isAuthorizedAdmin()) {
    return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 401 });
  }

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
  if (!isAuthorizedAdmin()) {
    return NextResponse.json({ error: "Unauthorized. Admin access required." }, { status: 401 });
  }

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
