import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers
    }
  });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: Record<string, unknown>) {
          supabaseResponse.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: Record<string, unknown>) {
          supabaseResponse.cookies.set({ name, value: "", ...options });
        }
      }
    }
  );

  if (code) {
    await supabase.auth.exchangeCodeForSession(code);
  }

  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    return redirectWithSupabaseCookies("/login", requestUrl, supabaseResponse);
  }

  const { data: existingUser } = await supabase
    .from("users")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();
  const role =
    existingUser?.role === "candidate" || existingUser?.role === "employer" ? existingUser.role : null;
  const destination =
    role === "employer" ? "/employer/dashboard" : role === "candidate" ? "/candidate/dashboard" : "/onboarding";

  const response = redirectWithSupabaseCookies(destination, requestUrl, supabaseResponse);
  response.cookies.delete("workplace_match_oauth_role");
  return response;
}

function redirectWithSupabaseCookies(
  pathname: string,
  requestUrl: URL,
  supabaseResponse: NextResponse
) {
  const response = NextResponse.redirect(new URL(pathname, requestUrl.origin));
  supabaseResponse.cookies.getAll().forEach((cookie) => {
    response.cookies.set(cookie);
  });
  return response;
}
