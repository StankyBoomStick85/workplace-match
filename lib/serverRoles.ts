import type { SupabaseClient, User } from "@supabase/supabase-js";

// Server-side caller identity for role-gated reads. Server-only: never import
// this from a client component - the whole point is that the role is resolved
// from the verified Supabase session plus public.users, not from anything the
// browser sends.
//
// Role source: public.users.role ('candidate' | 'employer' | 'admin'), written
// once at signup by api/user/set-role. A signed-in user with no users row yet
// (mid-onboarding) resolves to "pending", which no role-gated read allows.
//
// Admin: public.users.role = 'admin', OR a verified session email in the
// ADMIN_EMAILS environment variable. The email list exists because the one real
// admin today uses a normal candidate account and reaches the admin dashboard
// through SettingsModal's email+PIN gate. Deliberately NOT the
// workplace_match_admin_session cookie (lib/adminAuth.ts): the browser sets that
// cookie itself, so anyone can forge it and it proves nothing server-side.
//
// ADMIN_EMAILS format: one or more addresses separated by commas, semicolons,
// or whitespace, e.g. "a@x.com, b@y.com". Matching is case-insensitive.
//
// If ADMIN_EMAILS is unset or empty, FALLBACK_ADMIN_EMAILS is used and a
// warning is logged - a missing variable must never silently leave the admin
// dashboard with no admin at all.
const FALLBACK_ADMIN_EMAILS = ["jdetoy85@gmail.com"];

let warnedAboutFallback = false;

export function getAdminEmails(): string[] {
  const fromEnv = (process.env.ADMIN_EMAILS ?? "")
    .split(/[\s,;]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  if (fromEnv.length > 0) return fromEnv;

  if (!warnedAboutFallback) {
    warnedAboutFallback = true;
    console.warn(
      "[serverRoles] ADMIN_EMAILS is not set (or is empty) - falling back to the hardcoded admin list. " +
        "Set ADMIN_EMAILS in the deployment environment to control who is an admin."
    );
  }
  return FALLBACK_ADMIN_EMAILS;
}

export type CallerRole = "candidate" | "employer" | "admin" | "pending";

export type CallerIdentity = {
  id: string;
  email: string;
  role: CallerRole;
  isAdmin: boolean;
};

export async function resolveCallerIdentity(adminClient: SupabaseClient, user: User): Promise<CallerIdentity> {
  const email = (user.email ?? "").trim().toLowerCase();
  const { data, error } = await adminClient.from("users").select("role").eq("id", user.id).maybeSingle();
  if (error) {
    // Fail closed: an unreadable role grants nothing beyond what "pending" gets.
    console.error("[serverRoles] users role lookup failed", { userId: user.id, error: error.message });
  }
  const storedRole = data?.role;
  const role: CallerRole =
    storedRole === "candidate" || storedRole === "employer" || storedRole === "admin" ? storedRole : "pending";
  const isAdmin = role === "admin" || (email !== "" && getAdminEmails().includes(email));
  return { id: user.id, email, role, isAdmin };
}
