import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import { resolveCallerIdentity, type CallerIdentity } from "@/lib/serverRoles";

export const dynamic = "force-dynamic";

// VISIBILITY RULES - Workplace Match is not a social network:
//   - Candidate profile data: signed-in EMPLOYERS and admins only. Never other
//     candidates, never logged-out visitors.
//   - Employer profile data (company profile, job listings): signed-in
//     CANDIDATES, admins, and the employer who owns it. Never other employers,
//     never logged-out visitors.
//   - Per-user records (saved jobs, scores, interests, matches, messages,
//     notifications): only the users that record belongs to, plus admins.
// Every branch below enforces one of these explicitly: 401 when there is no
// session, 403 when the session's role or identity is not allowed. The role
// comes from the verified session + public.users (see lib/serverRoles.ts),
// never from a query parameter. Middleware only refreshes sessions; it does
// not block anything, so this route is the only gate.
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

    const notAuthenticated = () => NextResponse.json({ error: "Not authenticated." }, { status: 401 });
    const forbidden = () => NextResponse.json({ error: "Not allowed." }, { status: 403 });

    // Resolved lazily (one users-table read) and only by branches that gate on
    // role - the self-only branches below don't need it.
    let callerPromise: Promise<CallerIdentity> | null = null;
    const getCaller = () => {
      if (!user) throw new Error("getCaller called without a session");
      callerPromise ??= resolveCallerIdentity(adminClient, user);
      return callerPromise;
    };
    // Employer-owned data: candidates, admins, and the owning employer.
    const canSeeEmployerData = (caller: CallerIdentity, ownerEmployerId: string | null) =>
      caller.isAdmin || caller.role === "candidate" || (caller.role === "employer" && ownerEmployerId === caller.id);
    // Candidate-owned profile data: employers and admins.
    const canSeeCandidateProfiles = (caller: CallerIdentity) => caller.isAdmin || caller.role === "employer";

    if (resource === "current-user") {
      if (!user) return NextResponse.json({ data: null });
      const { data, error } = await adminClient.from("users").select("id,email,role").eq("id", user.id).maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "candidate-profile") {
      // Self-view only: this is how a candidate sees their OWN full record,
      // identity fields included - that's correct here, but only for the
      // authenticated owner of that record. A caller-supplied userId is never
      // honored: doing so previously made this an unauthenticated full-profile
      // lookup by UUID (name, phone, street address, everything) for anyone who
      // could guess or obtain a candidate's id. Every call site in this app
      // already either omits userId or passes the caller's own id, so nothing
      // legitimate depended on the query-param override - closing it costs no
      // real functionality.
      if (!user) return NextResponse.json({ data: null });
      const { data, error } = await adminClient.from("candidate_profiles").select("*").eq("user_id", user.id).maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "candidate-profiles") {
      // Employers and admins only. Previously this branch had no session or
      // role check at all, so any logged-out caller could read every approved
      // candidate's capability_entries and employer_summary.
      if (!user) return notAuthenticated();
      if (!canSeeCandidateProfiles(await getCaller())) return forbidden();

      // ALLOWLIST, not denylist: only columns an employer may legitimately
      // receive are named here. A new column added to candidate_profiles is
      // invisible through this endpoint by default - it has to be added here
      // deliberately, not merely left off some other list (that's exactly how
      // display_name and capability_entries both reached an employer's browser
      // raw before this change - select("*") ships everything unless someone
      // remembers to name it on a denylist). is_approved is selected only to
      // decide the gate below; it is never included in the response, because
      // no consumer reads it client-side - the gate has always been enforced
      // server-side only.
      const { data, error } = await adminClient
        .from("candidate_profiles")
        .select("user_id, zip_code, job_types, work_preference, capability_tags, experience_level, employer_summary, capability_entries, is_approved");
      if (error) throw error;
      const gated = (data ?? []).map((row: Record<string, unknown>) => ({
        user_id: row.user_id,
        zip_code: row.zip_code,
        job_types: row.job_types,
        work_preference: row.work_preference,
        capability_tags: row.capability_tags,
        experience_level: row.experience_level,
        // AI-generated content is withheld until a human approves it - same
        // policy this table's other AI fields have always had, just now scoped
        // to the only two AI fields an employer can see here at all, instead of
        // a list that had to be kept in sync with every field that must NOT be.
        employer_summary: row.is_approved ? row.employer_summary : null,
        capability_entries: row.is_approved ? row.capability_entries : null
      }));
      return NextResponse.json({ data: gated });
    }

    if (resource === "employer-profile") {
      // Company page, account/support settings, job form. Candidates, admins,
      // and the owning employer - never another employer, never logged out.
      if (!user) return notAuthenticated();
      const userId = requestUrl.searchParams.get("userId") || user.id;
      if (!canSeeEmployerData(await getCaller(), userId)) return forbidden();
      const { data, error } = await adminClient.from("employer_profiles").select("*").eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "employer-profiles") {
      // Every employer's profile at once: candidates and admins. An employer is
      // never the owner of the whole list, so employers are refused outright.
      if (!user) return notAuthenticated();
      const caller = await getCaller();
      if (!(caller.isAdmin || caller.role === "candidate")) return forbidden();
      const { data, error } = await adminClient.from("employer_profiles").select("*");
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "jobs") {
      // Job listings are employer-owned data. Candidates and admins see every
      // active listing; an employer sees only their own.
      if (!user) return notAuthenticated();
      const caller = await getCaller();
      if (!caller.isAdmin && caller.role === "pending") return forbidden();
      let query = adminClient.from("job_posts").select("*").eq("active", true);
      if (!caller.isAdmin && caller.role === "employer") query = query.eq("employer_id", caller.id);
      const { data, error } = await query;
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "employer-jobs") {
      if (!user) return notAuthenticated();
      const employerId = requestUrl.searchParams.get("employerId") || user.id;
      if (!canSeeEmployerData(await getCaller(), employerId)) return forbidden();
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
      // Employer-only (their own postings) and admins: counts are derived from
      // candidates' match rows, so candidates get nothing here.
      if (!user) return notAuthenticated();
      const caller = await getCaller();
      if (!(caller.isAdmin || caller.role === "employer")) return forbidden();
      const jobIdsParam = requestUrl.searchParams.get("jobIds") ?? "";
      let jobIds = jobIdsParam.split(",").map((id) => id.trim()).filter(Boolean);
      if (jobIds.length === 0) return NextResponse.json({ data: {} });

      if (!caller.isAdmin) {
        const { data: ownedJobs, error: ownedJobsError } = await adminClient
          .from("job_posts")
          .select("id")
          .eq("employer_id", caller.id)
          .in("id", jobIds);
        if (ownedJobsError) throw ownedJobsError;
        const owned = new Set((ownedJobs ?? []).map((job) => job.id as string));
        jobIds = jobIds.filter((id) => owned.has(id));
        if (jobIds.length === 0) return NextResponse.json({ data: {} });
      }

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

    if (resource === "saved-jobs") {
      // Candidate's saved external listings - the other half of "My Jobs"
      // alongside interests/matches (WPM). Stored fields only (job_title,
      // company, location, salary_min, salary_max, url) - never re-resolved
      // against the live listing. The candidate's own list only (or admin).
      if (!user) return notAuthenticated();
      const candidateId = requestUrl.searchParams.get("candidateId") ?? "";
      if (!candidateId) return NextResponse.json({ data: [] });
      if (candidateId !== user.id && !(await getCaller()).isAdmin) return forbidden();
      const { data, error } = await adminClient
        .from("saved_jobs")
        .select("job_id, job_source, job_title, company, location, salary_min, salary_max, url, saved_at")
        .eq("candidate_id", candidateId)
        .order("saved_at", { ascending: false });
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "candidate-match-scores") {
      // Career-mode match_scores for a candidate's own saved jobs (WPM and
      // external alike) - read-only, never triggers scoring. jobIds is a
      // comma-separated list. A jobId with no row is simply absent from the
      // response (not yet scored, or the score expired). Own scores only (or admin).
      if (!user) return notAuthenticated();
      const candidateId = requestUrl.searchParams.get("candidateId") ?? "";
      const jobIdsParam = requestUrl.searchParams.get("jobIds") ?? "";
      const jobIds = jobIdsParam.split(",").map((id) => id.trim()).filter(Boolean);
      if (!candidateId || jobIds.length === 0) return NextResponse.json({ data: [] });
      if (candidateId !== user.id && !(await getCaller()).isAdmin) return forbidden();

      const { data, error } = await adminClient
        .from("match_scores")
        .select("job_id, score")
        .eq("candidate_id", candidateId)
        .eq("scoring_mode", "career")
        .in("job_id", jobIds)
        .gt("expires_at", new Date().toISOString());
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "job") {
      // A single job listing: candidates, admins, and the owning employer.
      if (!user) return notAuthenticated();
      const jobId = requestUrl.searchParams.get("jobId");
      const employerId = requestUrl.searchParams.get("employerId");
      if (!jobId) return NextResponse.json({ data: null });
      const caller = await getCaller();
      if (!caller.isAdmin && caller.role === "pending") return forbidden();
      let query = adminClient.from("job_posts").select("*").eq("id", jobId);
      if (employerId) query = query.eq("employer_id", employerId);
      const { data, error } = await query.maybeSingle();
      if (error) throw error;
      if (data && !canSeeEmployerData(caller, data.employer_id as string)) return forbidden();
      return NextResponse.json({ data });
    }

    if (resource === "candidate-interests" || resource === "employer-interests") {
      // Pending interests the caller is party to (either direction) - every
      // client consumer only ever uses rows involving itself. Admins see all.
      if (!user) return notAuthenticated();
      const caller = await getCaller();
      if (!(caller.isAdmin || caller.role === "candidate" || caller.role === "employer")) return forbidden();
      let query = adminClient
        .from("interests")
        .select("id,from_user_id,to_user_id,job_id,status,created_at")
        .eq("status", "pending");
      if (!caller.isAdmin) query = query.or(`from_user_id.eq.${caller.id},to_user_id.eq.${caller.id}`);
      const { data, error } = await query;
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "mutual-matches") {
      // Matches the caller is part of, as candidate or employer. Admins see all.
      if (!user) return notAuthenticated();
      const caller = await getCaller();
      if (!(caller.isAdmin || caller.role === "candidate" || caller.role === "employer")) return forbidden();
      let query = adminClient.from("matches").select("*").eq("status", "mutual_match");
      if (!caller.isAdmin) query = query.or(`candidate_id.eq.${caller.id},employer_id.eq.${caller.id}`);
      const { data, error } = await query;
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "reciprocal-interest") {
      if (!user) return notAuthenticated();
      const fromUserId = requestUrl.searchParams.get("fromUserId") ?? "";
      const toUserId = requestUrl.searchParams.get("toUserId") ?? "";
      const jobId = requestUrl.searchParams.get("jobId") ?? "";
      if (!fromUserId || !toUserId || !jobId) return NextResponse.json({ data: null });
      if (user.id !== fromUserId && user.id !== toUserId && !(await getCaller()).isAdmin) return forbidden();
      const { data, error } = await adminClient
        .from("interests")
        .select("id,from_user_id,to_user_id,job_id,status")
        .eq("from_user_id", fromUserId)
        .eq("to_user_id", toUserId)
        .eq("job_id", jobId)
        .eq("status", "pending")
        .maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "match-exists") {
      if (!user) return notAuthenticated();
      const candidateId = requestUrl.searchParams.get("candidateId") ?? "";
      const employerId = requestUrl.searchParams.get("employerId") ?? "";
      const jobId = requestUrl.searchParams.get("jobId") ?? "";
      if (!candidateId || !employerId || !jobId) return NextResponse.json({ data: null });
      if (user.id !== candidateId && user.id !== employerId && !(await getCaller()).isAdmin) return forbidden();
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
      // The caller's own notifications only (or admin). The one client path
      // that read another user's notifications (addNotification's dedupe) has
      // no live callers.
      if (!user) return notAuthenticated();
      const email = requestUrl.searchParams.get("email") ?? "";
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail) return NextResponse.json({ data: [] });
      if (normalizedEmail !== (user.email ?? "").trim().toLowerCase() && !(await getCaller()).isAdmin) return forbidden();
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
      // Own record only (or admin). Previously an open lookup of any email's
      // id and role. Live callers (markNotificationsReadForEmail) pass the
      // caller's own email.
      if (!user) return notAuthenticated();
      const email = requestUrl.searchParams.get("email") ?? "";
      const normalizedEmail = email.trim().toLowerCase();
      if (!normalizedEmail) return NextResponse.json({ data: null });
      if (normalizedEmail !== (user.email ?? "").trim().toLowerCase() && !(await getCaller()).isAdmin) return forbidden();
      const { data, error } = await adminClient.from("users").select("id,email,role").eq("email", normalizedEmail).maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "header-label") {
      if (!user) return notAuthenticated();
      const role = requestUrl.searchParams.get("role");
      const userId = requestUrl.searchParams.get("userId") || user.id;
      if (role === "candidate") {
        // A candidate's display name and photo are identity: the candidate
        // themselves (or an admin) only - never an employer, at any tier.
        if (userId !== user.id && !(await getCaller()).isAdmin) return forbidden();
        const { data, error } = await adminClient.from("candidate_profiles").select("display_name,profile_picture_url").eq("user_id", userId).maybeSingle();
        if (error) throw error;
        return NextResponse.json({ data });
      }
      if (!canSeeEmployerData(await getCaller(), userId)) return forbidden();
      const { data, error } = await adminClient.from("employer_profiles").select("company_name").eq("user_id", userId).maybeSingle();
      if (error) throw error;
      return NextResponse.json({ data });
    }

    if (resource === "admin-summary") {
      if (!user) return notAuthenticated();
      if (!(await getCaller()).isAdmin) return forbidden();
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
      if (!user) return notAuthenticated();
      if (!(await getCaller()).isAdmin) return forbidden();
      const { data, error } = await adminClient
        .from("admin_activity_events")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return NextResponse.json({ data: data ?? [] });
    }

    if (resource === "match-messages") {
      if (!user) return notAuthenticated();
      const applicantId = requestUrl.searchParams.get("applicantId") ?? "";
      const employerId = requestUrl.searchParams.get("employerId") ?? "";
      const jobId = requestUrl.searchParams.get("jobId") ?? "";
      if (!applicantId || !employerId || !jobId) return NextResponse.json({ data: [] });
      // Thread participants only (or admin).
      if (user.id !== applicantId && user.id !== employerId && !(await getCaller()).isAdmin) return forbidden();
      // Explicit allowlist, not select("*") - sender_email must never appear in
      // a client payload (see the sender_email removal): a thread is already
      // identifiable from applicant_id/employer_id/job_id + sender_role.
      const { data, error } = await adminClient
        .from("match_messages")
        .select("id, applicant_id, employer_id, job_id, sender_role, text, created_at")
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
