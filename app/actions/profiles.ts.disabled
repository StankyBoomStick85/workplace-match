"use server";

import { redirect } from "next/navigation";
import { hasSupabaseEnv } from "@/lib/env";
import { splitCsv } from "@/lib/matching";
import { createClient } from "@/lib/supabase/server";

export async function saveCandidateProfile(formData: FormData) {
  if (!hasSupabaseEnv()) {
    redirect("/setup-needed");
  }

  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/candidate/login");
  }

  const { error } = await supabase.from("candidate_profiles").upsert(
    {
      user_id: user.id,
      full_name: String(formData.get("full_name") ?? ""),
      location: String(formData.get("location") ?? ""),
      desired_role: String(formData.get("desired_role") ?? ""),
      skills: splitCsv(formData.get("skills")),
      min_pay: Number(formData.get("min_pay") ?? 0),
      max_pay: Number(formData.get("max_pay") ?? 0),
      work_preference: String(formData.get("work_preference") ?? "On-site")
    },
    { onConflict: "user_id" }
  );

  if (error) {
    redirect(`/candidate/profile?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/matches");
}

export async function saveEmployerJob(formData: FormData) {
  if (!hasSupabaseEnv()) {
    redirect("/setup-needed");
  }

  const supabase = createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/employer/login");
  }

  const employer = {
    user_id: user.id,
    company_name: String(formData.get("company_name") ?? ""),
    contact_name: String(formData.get("contact_name") ?? ""),
    location: String(formData.get("location") ?? "")
  };

  const { data: savedEmployer, error: employerError } = await supabase
    .from("employers")
    .upsert(employer, { onConflict: "user_id" })
    .select()
    .single();

  if (employerError) {
    redirect(`/employer/jobs/new?error=${encodeURIComponent(employerError.message)}`);
  }

  const { error } = await supabase.from("job_posts").insert({
    employer_id: savedEmployer.id,
    title: String(formData.get("title") ?? ""),
    company_name: employer.company_name,
    location: employer.location,
    required_skills: splitCsv(formData.get("required_skills")),
    min_pay: Number(formData.get("min_pay") ?? 0),
    max_pay: Number(formData.get("max_pay") ?? 0),
    work_preference: String(formData.get("work_preference") ?? "On-site"),
    description: String(formData.get("description") ?? "")
  });

  if (error) {
    redirect(`/employer/jobs/new?error=${encodeURIComponent(error.message)}`);
  }

  redirect("/matches");
}
