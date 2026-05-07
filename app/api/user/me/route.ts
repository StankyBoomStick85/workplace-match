import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export async function GET() {
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

  if (userError || !user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });

  const { data: userRecord, error: userRecordError } = await adminClient
    .from("users")
    .select("id,email,role")
    .eq("id", user.id)
    .maybeSingle();

  if (userRecordError) {
    return NextResponse.json({ error: userRecordError.message }, { status: 500 });
  }

  if (!userRecord) {
    return NextResponse.json({ error: "User role not found." }, { status: 404 });
  }

  return NextResponse.json({
    id: userRecord.id,
    email: userRecord.email,
    role: userRecord.role
  });
}
