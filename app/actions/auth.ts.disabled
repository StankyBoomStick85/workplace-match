"use server";

import { redirect } from "next/navigation";
import { hasSupabaseEnv } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import type { UserRole } from "@/lib/types";

export async function signUp(formData: FormData) {
  if (!hasSupabaseEnv()) {
    redirect("/setup-needed");
  }

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "candidate") as UserRole;
  const next = role === "employer" ? "/employer/jobs/new" : "/candidate/profile";
  const supabase = createClient();

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) {
    redirect(`/${role}/signup?error=${encodeURIComponent(error.message)}`);
  }

  if (data.user) {
    await supabase.from("user_profiles").upsert({
      id: data.user.id,
      email,
      role
    });
  }

  redirect(next);
}

export async function login(formData: FormData) {
  if (!hasSupabaseEnv()) {
    redirect("/setup-needed");
  }

  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const role = String(formData.get("role") ?? "candidate") as UserRole;
  const next = role === "employer" ? "/employer/jobs/new" : "/candidate/profile";
  const supabase = createClient();

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    redirect(`/${role}/login?error=${encodeURIComponent(error.message)}`);
  }

  redirect(next);
}

export async function logout() {
  if (hasSupabaseEnv()) {
    const supabase = createClient();
    await supabase.auth.signOut();
  }

  redirect("/");
}
