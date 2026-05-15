import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function extractSection(text: string, heading: string, nextHeading?: string): string {
  const lower = text.toLowerCase();
  const marker = `## ${heading}`.toLowerCase();
  const start = lower.indexOf(marker);
  if (start === -1) return "";
  const contentStart = start + marker.length;
  const nextMarker = nextHeading ? `## ${nextHeading}`.toLowerCase() : null;
  const end = nextMarker ? lower.indexOf(nextMarker, contentStart) : text.length;
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

  const userPrompt = `An applicant has provided the following profile information:

- Desired role/industry: ${desiredRole}
- Experience level: ${profile.experience_level ?? "Not specified"}
- Work preference: ${profile.work_preference ?? "Not specified"}
- Skills they listed: ${skills}
- Background summary they wrote: ${profile.summary ?? "Not provided"}

Based on this information, generate exactly five sections with these exact headings:

## CAPABILITY_PROFILE
List each distinct capability as a separate item using this exact format. Do not use numbered lists, bullet points, or any other structure — only the bold-title format below:

**[Capability Name]**: [Detailed description of this specific capability grounded in their background — what decisions they made, what systems they managed, what constraints they worked under, what results they produced. Do not use generic traits without specifics.]

List between 4 and 7 capabilities.

## RECOMMENDED_POSITION
State the single best job title this applicant should target right now based on their full background. Use this exact format:

**[Job Title]**: [Two to three sentences explaining specifically why this role is the right fit — what in their background maps to what this role demands day-to-day.]

## ENTRY_POINT
State the single best starting role this applicant should pursue first to build toward their recommended position. This is especially important for candidates with non-traditional or military backgrounds who are highly capable but need civilian sector context first. Use this exact format:

**[Starting Role Title]**: [Two to three sentences explaining why this is the right entry point — what civilian experience it builds, how it bridges their background to their target role, and what makes it realistic to land now.]

## FUTURE_POSITIONS
List each role this applicant is realistically on track for as they build civilian sector experience. Use this exact format. Do not use numbered lists, bullet points, or any other structure — only the bold-title format below:

**[Role Title]**: [Brief explanation of why they are on track for this role and what experience or context positions them for it.]

List only roles that genuinely fit. No minimum or maximum number.

## EMPLOYER_SUMMARY
A plain-language, employer-facing paragraph (200–300 words) that a hiring manager can read in 60 seconds to understand exactly what level of operator they are looking at and what roles align. Write it to close the knowledge gap between non-traditional backgrounds and corporate expectations. Do not use jargon the applicant used — translate it into business impact language the employer already knows.

Respond with only the five sections above. No preamble, no closing remarks.`;

  const anthropic = new Anthropic({ apiKey });

  let text = "";
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system:
        "You are a veteran career counselor and hiring specialist who translates non-traditional, military, and blue-collar backgrounds into civilian corporate language that hiring managers can immediately understand and act on. You are precise, specific, and never use filler language.",
      messages: [{ role: "user", content: userPrompt }]
    });
    text = message.content.find((b) => b.type === "text")?.text ?? "";
  } catch (err) {
    console.error("[generate-capability] Anthropic API error", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `AI generation failed: ${message}` }, { status: 500 });
  }

  const capabilitySummary = extractSection(text, "CAPABILITY_PROFILE", "RECOMMENDED_POSITION");
  const recommendedPosition = extractSection(text, "RECOMMENDED_POSITION", "ENTRY_POINT");
  const entryPoint = extractSection(text, "ENTRY_POINT", "FUTURE_POSITIONS");
  const futurePositions = extractSection(text, "FUTURE_POSITIONS", "EMPLOYER_SUMMARY");
  const employerSummary = extractSection(text, "EMPLOYER_SUMMARY");

  const { error: updateError } = await adminClient
    .from("candidate_profiles")
    .update({
      capability_summary: capabilitySummary,
      recommended_position: recommendedPosition,
      entry_point: entryPoint,
      future_positions: futurePositions,
      employer_summary: employerSummary
    })
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[generate-capability] Failed to save AI output", updateError);
    return NextResponse.json({ error: "Failed to save generated profile." }, { status: 500 });
  }

  return NextResponse.json({ success: true, capabilitySummary, recommendedPosition, entryPoint, futurePositions, employerSummary });
}
