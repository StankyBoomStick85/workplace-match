import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

type AccountRole = "candidate" | "employer";

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

  // Authoritative allowlist gate for brand-new accounts: this route is only ever
  // called for a user who has no public.users row yet (both the OAuth /onboarding
  // flow and the email/password signup flow land here to create that row). Existing
  // users always already have a role and never reach this route, so this check can't
  // affect returning users. The email is taken from the verified session, not from
  // client input, so it can't be spoofed by submitting a different email than the one
  // that was actually authenticated.
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
