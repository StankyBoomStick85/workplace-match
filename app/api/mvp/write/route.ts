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
      const upsertData: Record<string, unknown> = { user_id: user.id };

      if ("fullName" in data || "displayName" in data) {
        upsertData.display_name = typeof data.fullName === "string"
          ? data.fullName.trim()
          : typeof data.displayName === "string" ? data.displayName.trim() : "";
      }
      if ("zipCode" in data) {
        upsertData.zip_code = typeof data.zipCode === "string" ? data.zipCode.trim() : "";
      }
      if ("searchRadius" in data) {
        const r = Number(data.searchRadius);
        upsertData.search_radius = Number.isFinite(r) ? r : null;
      }
      if ("desiredPayMin" in data) {
        const p = Number(data.desiredPayMin);
        upsertData.desired_pay_min = Number.isFinite(p) ? p : null;
      }
      if ("payType" in data) {
        upsertData.pay_type = typeof data.payType === "string" ? data.payType : "";
      }
      if ("jobType" in data) {
        upsertData.job_types = typeof data.jobType === "string" && data.jobType.trim()
          ? [data.jobType.trim()] : [];
      }
      if ("shiftPreference" in data) {
        upsertData.shifts = typeof data.shiftPreference === "string" && data.shiftPreference.trim()
          ? [data.shiftPreference.trim()] : [];
      }
      if ("workSetting" in data) {
        upsertData.work_preference = typeof data.workSetting === "string" ? data.workSetting : "";
      }
      if ("topSkills" in data) {
        upsertData.capability_tags = Array.isArray(data.topSkills)
          ? data.topSkills
              .filter((s: unknown): s is string => typeof s === "string")
              .map((s: string) => s.trim())
              .filter(Boolean)
          : [];
      }
      if ("experienceLevel" in data) {
        upsertData.experience_level = typeof data.experienceLevel === "string" ? data.experienceLevel : "";
      }
      if ("educationLevel" in data) {
        upsertData.education_level = typeof data.educationLevel === "string" ? data.educationLevel : "";
      }
      if ("capabilitySummary" in data) {
        upsertData.summary = typeof data.capabilitySummary === "string" ? data.capabilitySummary.trim() : "";
      }
      if ("industriesOfInterest" in data || "willingToRelocate" in data || "availableStartDate" in data) {
        upsertData.visibility = JSON.stringify({
          visibility: "private",
          industriesOfInterest: typeof data.industriesOfInterest === "string" ? data.industriesOfInterest : "",
          availableStartDate: typeof data.availableStartDate === "string" ? data.availableStartDate : "",
          willingToRelocate: typeof data.willingToRelocate === "string" ? data.willingToRelocate : ""
        });
      }
      if ("phone" in data) {
        upsertData.phone = typeof data.phone === "string" ? data.phone.trim() : "";
      }
      if ("streetAddress" in data) {
        upsertData.street_address = typeof data.streetAddress === "string" ? data.streetAddress.trim() : "";
      }
      if ("city" in data) {
        upsertData.city = typeof data.city === "string" ? data.city.trim() : "";
      }
      if ("state" in data) {
        upsertData.state = typeof data.state === "string" ? data.state.trim() : "";
      }
      if ("profilePictureUrl" in data) {
        upsertData.profile_picture_url = typeof data.profilePictureUrl === "string" ? data.profilePictureUrl : "";
      }

      const { error } = await adminClient.from("candidate_profiles").upsert(upsertData, { onConflict: "user_id" });
      if (error) throw error;
      return NextResponse.json({ success: true });
    }

    if (resource === "employer-profile") {
      const email = typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
      const employerData: Record<string, unknown> = {
        user_id: user.id,
        company_name: typeof data.displayName === "string" ? data.displayName.trim() : "",
        contact_email: email,
        location_zip: typeof data.zipCode === "string" ? data.zipCode.trim() : "",
        member_status: "beta"
      };
      if ("phone" in data) {
        employerData.phone = typeof data.phone === "string" ? data.phone.trim() : "";
      }
      if ("streetAddress" in data) {
        employerData.street_address = typeof data.streetAddress === "string" ? data.streetAddress.trim() : "";
      }
      if ("city" in data) {
        employerData.city = typeof data.city === "string" ? data.city.trim() : "";
      }
      if ("state" in data) {
        employerData.state = typeof data.state === "string" ? data.state.trim() : "";
      }
      const { error } = await adminClient.from("employer_profiles").upsert(employerData, { onConflict: "user_id" });
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
