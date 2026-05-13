import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function extractSection(text: string, heading: string, nextHeading?: string): string {
  const marker = `## ${heading}`;
  const start = text.indexOf(marker);
  if (start === -1) return "";
  const contentStart = start + marker.length;
  const end = nextHeading ? text.indexOf(`## ${nextHeading}`, contentStart) : text.length;
  return text.slice(contentStart, end === -1 ? text.length : end).trim();
}

export async function POST() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
    return NextResponse.json({ error: "Server configuration missing." }, { status: 500 });
  }

  const cookieStore = cookies();
  const authClient = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      get(name: string) { return cookieStore.get(name)?.value; },
      set(name: string, value: string, options: CookieOptions) { cookieStore.set(name, value, options); },
      remove(name: string, options: CookieOptions) { cookieStore.set(name, "", options); }
    }
  });

  const { data: { user }, error: userError } = await authClient.auth.getUser();
  if (userError || !user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: profile, error: profileError } = await adminClient
    .from("candidate_profiles")
    .select("job_types, experience_level, work_preference, capability_tags, summary")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json({ error: "Failed to load profile." }, { status: 500 });
  }
  if (!profile) {
    return NextResponse.json(
      { error: "No profile found. Please save your profile first." },
      { status: 400 }
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "AI service not configured." }, { status: 500 });
  }

  const desiredRole = Array.isArray(profile.job_types) && profile.job_types.length > 0
    ? profile.job_types.join(", ")
    : "Not specified";
  const skills = Array.isArray(profile.capability_tags) && profile.capability_tags.length > 0
    ? profile.capability_tags.join(", ")
    : "Not specified";

  const userPrompt = `A candidate has provided the following profile information:

- Desired role/industry: ${desiredRole}
- Experience level: ${profile.experience_level ?? "Not specified"}
- Work preference: ${profile.work_preference ?? "Not specified"}
- Skills they listed: ${skills}
- Background summary they wrote: ${profile.summary ?? "Not provided"}

Based on this information, generate exactly three sections with these exact headings:

## CAPABILITY_PROFILE
A full capability profile that interprets the actual skills required to perform the roles implied by their experience and background. Do NOT output generic traits like "leadership" or "communication" without specifics. Instead, describe concrete operational skills: what decisions they made, what systems they managed, what environments they operated in, what constraints they worked under, and what results they produced. This should read like a senior recruiter's internal capability brief—specific, credible, and grounded in what the role actually demands.

## PREDICTED_ALIGNMENT
A clear mapping of their interpreted capabilities to civilian job categories and realistic seniority levels. For each alignment, state: the job category, the appropriate level (entry/mid/senior/director), and why their background qualifies them—including the specific transferable skill. Flag any mismatches to avoid (roles they are over or underqualified for). Write this as actionable guidance for a recruiter building a shortlist.

## EMPLOYER_SUMMARY
A plain-language, employer-facing paragraph (200–300 words) that a hiring manager can read in 60 seconds to understand exactly what level of operator they are looking at and what roles align. Write it to close the knowledge gap between non-traditional backgrounds and corporate expectations. Do not use jargon the candidate used—translate it into business impact language the employer already knows.

Respond with only the three sections above. No preamble, no closing remarks.`;

  const anthropic = new Anthropic({ apiKey });

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 2048,
    system:
      "You are a veteran career counselor and hiring specialist who translates non-traditional, military, and blue-collar backgrounds into civilian corporate language that hiring managers can immediately understand and act on. You are precise, specific, and never use filler language.",
    messages: [{ role: "user", content: userPrompt }]
  });

  const text = message.content.find((b) => b.type === "text")?.text ?? "";

  const capabilitySummary = extractSection(text, "CAPABILITY_PROFILE", "PREDICTED_ALIGNMENT");
  const predictedAlignment = extractSection(text, "PREDICTED_ALIGNMENT", "EMPLOYER_SUMMARY");
  const employerSummary = extractSection(text, "EMPLOYER_SUMMARY");

  const { error: updateError } = await adminClient
    .from("candidate_profiles")
    .update({ capability_summary: capabilitySummary, predicted_alignment: predictedAlignment, employer_summary: employerSummary })
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[generate-capability] Failed to save AI output", updateError);
    return NextResponse.json({ error: "Failed to save generated profile." }, { status: 500 });
  }

  return NextResponse.json({ success: true, capabilitySummary, predictedAlignment, employerSummary });
}
