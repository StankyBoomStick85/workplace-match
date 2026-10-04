import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { resolveCallerIdentity } from "@/lib/serverRoles";

type AccountRole = "candidate" | "employer";

// ROLE LOCK: a role is set once. Role decides what a user may read (candidates
// see employer data, employers see candidate profiles - see api/mvp/read), so
// a self-service switch would let any approved user flip to the other side and
// read it. Previously this route upserted unconditionally.
//
// "Already has a role" must allow the SAME role again: public.users rows are
// created by a database trigger at auth signup (the role copied from the signup
// metadata), so by the time the email/password signup forms call this route the
// row already exists with exactly the role being requested. That call is
// idempotent (200, nothing written). Only a CHANGE to a different role is
// refused (409) - unless the caller is an admin, who may also change another
// user's role by passing { userId }.

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const role = body?.role === "candidate" || body?.role === "employer" ? body.role : null;

  if (!role) {
    return NextResponse.json({ error: "Invalid role." }, { status: 400 });
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return NextResponse.json({ error: "Supabase server configuration is missing." }, { status: 500 });
  }

  const cookieStore = cookies();
  const authClient = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        cookieStore.set(name, value, options);
      },
      remove(name: string, options: CookieOptions) {
        cookieStore.set(name, "", options);
      }
    }
  });

  const {
    data: { user },
    error: userError
  } = await authClient.auth.getUser();

  if (userError || !user || !user.email) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  const caller = await resolveCallerIdentity(adminClient, user);

  // Admin changing ANOTHER user's role. The target must already exist; there is
  // no approval gate here because the target signed up through that gate.
  const requestedUserId = typeof body?.userId === "string" ? body.userId.trim() : "";
  if (requestedUserId && requestedUserId !== user.id) {
    if (!caller.isAdmin) {
      return NextResponse.json({ error: "Admin access required." }, { status: 403 });
    }
    const { data: target, error: targetError } = await adminClient
      .from("users")
      .select("id, role")
      .eq("id", requestedUserId)
      .maybeSingle();
    if (targetError) {
      return NextResponse.json({ error: targetError.message }, { status: 500 });
    }
    if (!target) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }
    const { error: adminUpdateError } = await adminClient
      .from("users")
      .update({ role: role as AccountRole })
      .eq("id", requestedUserId);
    if (adminUpdateError) {
      return NextResponse.json({ error: adminUpdateError.message }, { status: 500 });
    }
    console.log("[user/set-role] admin changed role", { adminId: user.id, targetUserId: requestedUserId, from: target.role, to: role });
    return NextResponse.json({ success: true, changed: target.role !== role });
  }

  // Authoritative allowlist gate for brand-new accounts. The email is taken from
  // the verified session, not from client input, so it can't be spoofed by
  // submitting a different email than the one that was actually authenticated.
  const normalizedEmail = user.email.trim().toLowerCase();
  const { data: approvedRecord, error: approvedLookupError } = await adminClient
    .from("approved_emails")
    .select("email")
    .eq("email", normalizedEmail)
    .maybeSingle();

  if (approvedLookupError) {
    console.error("[user/set-role] Failed to query approved_emails", approvedLookupError);
  }

  if (!approvedRecord) {
    return NextResponse.json(
      { error: "This email hasn't been approved for access yet.", code: "NOT_APPROVED" },
      { status: 403 }
    );
  }

  const { data: existing, error: existingError } = await adminClient
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  if (existingError) {
    return NextResponse.json({ error: existingError.message }, { status: 500 });
  }
  if (existing?.role) {
    if (existing.role === role) {
      // Signup re-confirming the role the trigger already stored: nothing to do.
      return NextResponse.json({ success: true, changed: false });
    }
    if (!caller.isAdmin) {
      return NextResponse.json(
        { error: "Your account type is already set and can't be changed.", code: "ROLE_LOCKED", role: existing.role },
        { status: 409 }
      );
    }
  }

  const { error: saveError } = await adminClient.from("users").upsert({
    id: user.id,
    email: user.email,
    role: role as AccountRole
  });

  if (saveError) {
    return NextResponse.json({ error: saveError.message }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
