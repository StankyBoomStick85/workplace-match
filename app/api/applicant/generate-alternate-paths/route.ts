import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type AlternatePath = {
  roleTitle: string;
  explanation: string;
  entryPoint: string;
};

function parseAlternatePaths(text: string): AlternatePath[] {
  const blocks = text.split(/\n?## ROLE\n/).filter((s) => s.trim());
  return blocks.flatMap((block): AlternatePath[] => {
    const roleTitle = block.split("\n")[0]?.trim() ?? "";
    const whyMatch = block.match(/## WHY\n([\s\S]+?)(?=\n## ENTRY_POINT|$)/);
    const entryMatch = block.match(/## ENTRY_POINT\n(.+?)(?:\n|$)/);
    if (!roleTitle || !whyMatch || !entryMatch) return [];
    return [{ roleTitle, explanation: whyMatch[1].trim(), entryPoint: entryMatch[1].trim() }];
  });
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
    .select("job_types, experience_level, capability_tags, summary, alternate_paths")
    .eq("user_id", user.id)
    .maybeSingle();

  if (profileError) {
    return NextResponse.json({ error: "Failed to load profile." }, { status: 500 });
  }
  if (!profile) {
    return NextResponse.json({ error: "No profile found. Please save your profile first." }, { status: 400 });
  }

  // Return cached result if already generated
  if (Array.isArray(profile.alternate_paths) && profile.alternate_paths.length > 0) {
    return NextResponse.json({ alternatePaths: profile.alternate_paths });
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

  const prompt = `An applicant has this background:

- Desired role/industry: ${desiredRole}
- Experience level: ${profile.experience_level ?? "Not specified"}
- Skills: ${skills}
- Background summary: ${profile.summary ?? "Not provided"}

Identify 3 to 5 roles OUTSIDE this person's direct education or experience path where their transferable skills would make them genuinely competitive. Do not suggest variations of their current path.

For each role, respond using exactly this format:

## ROLE
[Job Title]

## WHY
[2-3 sentences explaining which specific skills transfer and why this person would be competitive, not just passable.]

## ENTRY_POINT
[The specific first job title to apply for to break into this field — not a description, just the title.]

List only roles that represent a genuine lateral move based on real skill overlap. No filler roles.`;

  const anthropic = new Anthropic({ apiKey });

  let text = "";
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: "You are a veteran career counselor and hiring specialist who translates non-traditional, military, and blue-collar backgrounds into civilian corporate language that hiring managers can immediately understand and act on. You are precise, specific, and never use filler language.",
      messages: [{ role: "user", content: prompt }],
    });
    text = message.content.find((b) => b.type === "text")?.text ?? "";
  } catch (err) {
    console.error("[generate-alternate-paths] Anthropic API error", err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `AI generation failed: ${msg}` }, { status: 500 });
  }

  const alternatePaths = parseAlternatePaths(text);

  const { error: updateError } = await adminClient
    .from("candidate_profiles")
    .update({ alternate_paths: alternatePaths })
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[generate-alternate-paths] Failed to save", updateError);
  }

  return NextResponse.json({ alternatePaths });
}
