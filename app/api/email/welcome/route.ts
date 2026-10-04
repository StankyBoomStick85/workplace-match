import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { sendEmail, welcomeEmailTemplate } from "../../../../lib/email";

export const dynamic = "force-dynamic";

// Signed-in only, and only ever to the session's own email address. Previously
// this sent to any address in the request body with no session at all. The
// signup forms call it right after signInWithPassword, so a session exists.
// The role comes from public.users when it is set (the signup trigger writes it
// before this call); the body's role is only a fallback for a not-yet-set row.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);

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
  if (!user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const sessionEmail = (user.email ?? "").trim().toLowerCase();
  if (!sessionEmail) {
    return NextResponse.json({ error: "No email on this account." }, { status: 400 });
  }
  // A different address in the body is refused outright rather than silently
  // replaced, so a misuse is visible instead of looking like it worked.
  const requestedEmail = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (requestedEmail && requestedEmail !== sessionEmail) {
    return NextResponse.json({ error: "Welcome email can only be sent to your own address." }, { status: 403 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: userRecord } = await adminClient.from("users").select("role").eq("id", user.id).maybeSingle();
  const role =
    userRecord?.role === "employer" || userRecord?.role === "candidate"
      ? userRecord.role
      : body?.role === "employer"
        ? "employer"
        : body?.role === "candidate"
          ? "candidate"
          : null;
  if (!role) {
    return NextResponse.json({ error: "Missing role." }, { status: 400 });
  }

  const template = welcomeEmailTemplate(role);
  await sendEmail({
    to: sessionEmail,
    subject: template.subject,
    html: template.html,
    text: template.text
  });

  return NextResponse.json({ ok: true });
}
