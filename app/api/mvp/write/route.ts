import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const resource = typeof body?.resource === "string" ? body.resource : "";
  const data = body?.data && typeof body.data === "object" ? body.data : {};
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

  try {
    if (resource === "account-settings") {
      const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
      if (!email) {
        return NextResponse.json({ error: "Email is required." }, { status: 400 });
      }

      const { error } = await adminClient.from("users").update({ email }).eq("id", user.id);
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    if (resource === "candidate-profile") {
      const topSkills = Array.isArray(data.topSkills)
        ? data.topSkills
            .filter((skill: unknown): skill is string => typeof skill === "string")
            .map((skill: string) => skill.trim())
            .filter(Boolean)
        : [];
      const jobTypes = typeof data.jobType === "string" && data.jobType.trim() ? [data.jobType.trim()] : [];
      const shifts = typeof data.shiftPreference === "string" && data.shiftPreference.trim() ? [data.shiftPreference.trim()] : [];
      const searchRadius = typeof data.searchRadius === "number" ? data.searchRadius : Number(data.searchRadius);
      const desiredPayMin = typeof data.desiredPayMin === "number" ? data.desiredPayMin : Number(data.desiredPayMin);
      const { error } = await adminClient.from("candidate_profiles").upsert(
        {
          user_id: user.id,
          display_name: typeof data.fullName === "string" ? data.fullName.trim() : typeof data.displayName === "string" ? data.displayName.trim() : "",
          zip_code: typeof data.zipCode === "string" ? data.zipCode.trim() : "",
          search_radius: Number.isFinite(searchRadius) ? searchRadius : null,
          desired_pay_min: Number.isFinite(desiredPayMin) ? desiredPayMin : null,
          pay_type: typeof data.payType === "string" ? data.payType : "",
          job_types: jobTypes,
          shifts,
          work_preference: typeof data.workSetting === "string" ? data.workSetting : "",
          capability_tags: topSkills,
          experience_level: typeof data.experienceLevel === "string" ? data.experienceLevel : "",
          summary: typeof data.capabilitySummary === "string" ? data.capabilitySummary.trim() : "",
          visibility: JSON.stringify({
            visibility: "private",
            industriesOfInterest: typeof data.industriesOfInterest === "string" ? data.industriesOfInterest : "",
            availableStartDate: typeof data.availableStartDate === "string" ? data.availableStartDate : "",
            willingToRelocate: typeof data.willingToRelocate === "string" ? data.willingToRelocate : ""
          })
        },
        { onConflict: "user_id" }
      );
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    if (resource === "employer-profile") {
      const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
      const { error } = await adminClient.from("employer_profiles").upsert(
        {
          user_id: user.id,
          company_name: typeof data.displayName === "string" ? data.displayName.trim() : "",
          contact_email: email,
          location_zip: typeof data.zipCode === "string" ? data.zipCode.trim() : "",
          member_status: "beta"
        },
        { onConflict: "user_id" }
      );
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Unknown resource." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save data.";
    console.error("[api/mvp/write] Request failed", { resource, message, error });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
