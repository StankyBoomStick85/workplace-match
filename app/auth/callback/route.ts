import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const cookieStore = cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: Record<string, unknown>) {
          cookieStore.set({ name, value, ...options });
        },
        remove(name: string, options: Record<string, unknown>) {
          cookieStore.set({ name, value: "", ...options });
        }
      }
    }
  );

  if (code) {
    await supabase.auth.exchangeCodeForSession(code);
  }

  const { data: sessionData } = await supabase.auth.getSession();
  const user = sessionData.session?.user ?? null;

  if (!user) {
    return NextResponse.redirect(new URL("/login", requestUrl.origin));
  }

  const { data: existingUser } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const intendedRole = cookieStore.get("workplace_match_oauth_role")?.value;
  const role =
    existingUser?.role === "candidate" || existingUser?.role === "employer"
      ? existingUser.role
      : intendedRole === "candidate" || intendedRole === "employer"
        ? intendedRole
        : null;

  if (role) {
    await supabase.from("users").upsert({
      id: user.id,
      email: user.email ?? "",
      role
    });
  }

  const response = NextResponse.redirect(
    new URL(role === "employer" ? "/employer/dashboard" : role === "candidate" ? "/candidate/dashboard" : "/get-started", requestUrl.origin)
  );
  response.cookies.delete("workplace_match_oauth_role");
  return response;
}
