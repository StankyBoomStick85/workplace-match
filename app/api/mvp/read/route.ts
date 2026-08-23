import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const resource = requestUrl.searchParams.get("resource") ?? "";

  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      console.error("[api/mvp/read] Missing Supabase env configuration", {
        resource,
        hasUrl: Boolean(supabaseUrl),
        hasAnonKey: Boolean(supabaseAnonKey),
        hasServiceRoleKey: Boolean(supabaseServiceRoleKey)
      });
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
    if (userError) {
      console.error("[api/mvp/read] Auth user lookup failed", { resource, error: userError.message });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });

    if (resource === "current-user") {
      if (!user) return NextResponse.json({ data: null });
      const { data, error } = await adminClient.from("users").select("id,email,role").eq("id", user.id).maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "candidate-profile") {
      const userId = requestUrl.searchParams.get("userId") || user?.id;
      if (!userId) return NextResponse.json({ data: null });
      const { data, error } = await adminClient.from("candidate_profiles").select("*").eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "candidate-profiles") {
      const { data, error } = await adminClient.from("candidate_profiles").select("*");
      if (error) throw error;
      const aiFields = ["capability_summary", "recommended_position", "entry_point", "future_positions", "employer_summary", "alternate_paths"];
      const gated = (data ?? []).map((row: Record<string, unknown>) => {
        if (!row.is_approved) {
          const stripped = { ...row };
          for (const f of aiFields) stripped[f] = null;
          return stripped;
        }
        return row;
      });
      return NextResponse.json({ data: gated });
    }

    if (resource === "employer-profile") {
      const userId = requestUrl.searchParams.get("userId") || user?.id;
      if (!userId) return NextResponse.json({ data: null });
      const { data, error } = await adminClient.from("employer_profiles").select("*").eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "employer-profiles") {
      const { data, error } = await adminClient.from("employer_profiles").select("*");
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "jobs") {
      const { data, error } = await adminClient.from("job_posts").select("*").eq("active", true);
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "employer-jobs") {
      const employerId = requestUrl.searchParams.get("employerId") || user?.id;
      if (!employerId) return NextResponse.json({ data: [] });
      const { data, error } = await adminClient
        .from("job_posts")
        .select("*")
        .eq("employer_id", employerId)
        .eq("active", true)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "job-match-counts") {
      // Reads match_scores as already computed by candidate-side scoring runs -
      // never triggers new scoring. jobIds is a comma-separated list of job_posts
      // ids. A job with zero qualifying rows is simply absent from the response,
      // so the caller can distinguish "no data yet" from "zero matches".
      const jobIdsParam = requestUrl.searchParams.get("jobIds") ?? "";
      const jobIds = jobIdsParam.split(",").map((id) => id.trim()).filter(Boolean);
      if (jobIds.length === 0) return NextResponse.json({ data: {} });

      const { data, error } = await adminClient
        .from("match_scores")
        .select("job_id, candidate_id")
        .eq("job_source", "wpm")
        .in("job_id", jobIds)
        .gte("score", 50)
        .gt("expires_at", new Date().toISOString());
      if (error) throw error;

      const counts: Record<string, number> = {};
      const seenPerJob = new Map<string, Set<string>>();
      for (const row of data ?? []) {
        const jobId = row.job_id as string;
        const candidateId = row.candidate_id as string;
        const seen = seenPerJob.get(jobId) ?? new Set<string>();
        seen.add(candidateId);
        seenPerJob.set(jobId, seen);
      }
      for (const [jobId, candidateSet] of seenPerJob.entries()) {
        counts[jobId] = candidateSet.size;
      }
      return NextResponse.json({ data: counts });
    }

    if (resource === "job") {
      const jobId = requestUrl.searchParams.get("jobId");
      const employerId = requestUrl.searchParams.get("employerId") || user?.id;
      if (!jobId) return NextResponse.json({ data: null });
      let query = adminClient.from("job_posts").select("*").eq("id", jobId);
      if (employerId) query = query.eq("employer_id", employerId);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "candidate-interests" || resource === "employer-interests") {
      const { data, error } = await adminClient
        .from("interests")
        .select("id,from_user_id,to_user_id,job_id,status,created_at")
        .eq("status", "pending");
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "mutual-matches") {
      const { data, error } = await adminClient.from("matches").select("*").eq("status", "mutual_match");
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "match-exists") {
      const candidateId = requestUrl.searchParams.get("candidateId") ?? "";
      const employerId = requestUrl.searchParams.get("employerId") ?? "";
      const jobId = requestUrl.searchParams.get("jobId") ?? "";
      if (!candidateId || !employerId || !jobId) return NextResponse.json({ data: null });
      const { data, error } = await adminClient
        .from("matches")
        .select("id")
        .eq("candidate_id", candidateId)
        .eq("employer_id", employerId)
        .eq("job_id", jobId)
        .maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "notifications") {
      const email = requestUrl.searchParams.get("email") ?? "";
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail) return NextResponse.json({ data: [] });
      const { data: recipient, error: recipientError } = await adminClient.from("users").select("id,email,role").eq("email", normalizedEmail).maybeSingle();
      if (recipientError) throw recipientError;
      if (!recipient) return NextResponse.json({ data: [], recipient: null });
      const { data, error } = await adminClient
        .from("notifications")
        .select("*")
        .eq("user_id", recipient.id)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return NextResponse.json({ data: data ?? [], recipient });
    }

    if (resource === "user-by-email") {
      const email = requestUrl.searchParams.get("email") ?? "";
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail) return NextResponse.json({ data: null });
      const { data, error } = await adminClient.from("users").select("id,email,role").eq("email", normalizedEmail).maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "header-label") {
      const role = requestUrl.searchParams.get("role");
      const userId = requestUrl.searchParams.get("userId") || user?.id;
      if (!userId) return NextResponse.json({ data: null });
      if (role === "candidate") {
        const { data, error } = await adminClient.from("candidate_profiles").select("display_name,profile_picture_url").eq("user_id", userId).maybeSingle();
        if (error) throw error;
        return NextResponse.json({ data });
      }
      const { data, error } = await adminClient.from("employer_profiles").select("company_name").eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "admin-summary") {
      const [messages, notifications] = await Promise.all([
        adminClient.from("match_messages").select("id"),
        adminClient.from("notifications").select("type")
      ]);
      if (messages.error) throw messages.error;
      if (notifications.error) throw notifications.error;
      return NextResponse.json({
        data: {
          messages: messages.data ?? [],
          notifications: notifications.data ?? []
        }
      });
    }

    if (resource === "admin-events") {
      const { data, error } = await adminClient
        .from("admin_activity_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "match-messages") {
      const applicantId = requestUrl.searchParams.get("applicantId") ?? "";
      const employerId = requestUrl.searchParams.get("employerId") ?? "";
      const jobId = requestUrl.searchParams.get("jobId") ?? "";
      if (!applicantId || !employerId || !jobId) return NextResponse.json({ data: [] });
      const { data, error } = await adminClient
        .from("match_messages")
        .select("*")
        .eq("applicant_id", applicantId)
        .eq("employer_id", employerId)
        .eq("job_id", jobId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load data.";
    console.error("[api/mvp/read] Request failed", {
      resource,
      message,
      error
    });
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ error: "Unknown resource." }, { status: 400 });
}
