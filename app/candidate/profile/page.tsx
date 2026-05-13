import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { CandidateProfileForm } from "@/components/CandidateProfileForm";

export const dynamic = "force-dynamic";

export default async function CandidateProfilePage() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

  const cookieStore = cookies();
  const authClient = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name) { return cookieStore.get(name)?.value; },
      set() {},
      remove() {},
    },
  });

  const { data: { user } } = await authClient.auth.getUser();
  if (!user) redirect("/candidate/login");

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userRecord } = await adminClient
    .from("users")
    .select("id,email,role")
    .eq("id", user.id)
    .maybeSingle();

  if (!userRecord || userRecord.role !== "candidate") redirect("/candidate/login");

  const { data: profileData } = await adminClient
    .from("candidate_profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  return (
    <CandidateProfileForm
      userEmail={userRecord.email ?? ""}
      initialProfile={profileData}
    />
  );
}
