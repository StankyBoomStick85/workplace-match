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
  gap: string;
};

function parseAlternatePaths(text: string): AlternatePath[] {
  const blocks = text.split(/\n?## ROLE\n/).filter((s) => s.trim());
  return blocks.flatMap((block): AlternatePath[] => {
    const roleTitle = block.split("\n")[0]?.trim() ?? "";
    const whyMatch = block.match(/## WHY\n([\s\S]+?)(?=\n## ENTRY_POINT|$)/);
    const entryMatch = block.match(/## ENTRY_POINT\n(.+?)(?:\n## GAP|\n|$)/);
    const gapMatch = block.match(/## GAP\n([\s\S]+?)(?:\n## |$)/);
    if (!roleTitle || !whyMatch || !entryMatch) return [];
    return [{
      roleTitle,
      explanation: whyMatch[1].trim(),
      entryPoint: entryMatch[1].trim(),
      gap: gapMatch ? gapMatch[1].trim() : "",
    }];
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

  const systemPrompt = `You are a career intelligence engine. Your job is NOT to find roles similar to what this person has already done. Your job is to read the entire profile — every field, every detail, every implied skill — and ask: what kind of person is capable of all of this?

CRITICAL ANONYMITY RULE: Never use the candidate's name. Refer to them only as "this candidate" or using they/them pronouns. The candidate's identity must remain hidden at all times.

Look beyond job titles and education. Look at what this person has actually managed, survived, juggled, and delivered. A person who raised children alone, managed a household budget, handled medical needs, maintained high credit under financial pressure, and kept everything running — that is an operations and logistics brain. Name what that is. Surface it.

For each alternate path, ask:
- What type of person succeeds in this role?
- Does this candidate's actual demonstrated behavior match that profile — regardless of their job title history?
- Could they walk in with 80% of what is needed and close the gap in 90 days of OJT?

Range the results: include roles they could start next week AND roles that need 60–90 days of preparation. Do not cluster all results in one industry. Think broadly — operations, logistics, sales, project coordination, public sector, trades management, healthcare administration, finance, education, tech-adjacent.

Do not use the words entry level, junior, senior, or any tier label. Do not pigeonhole based on what they have done. Surface what they are capable of becoming.`;

  const prompt = `Here is the candidate's complete profile:

- Desired role/industry: ${desiredRole}
- Experience level: ${profile.experience_level ?? "Not specified"}
- Skills: ${skills}
- Background summary: ${profile.summary ?? "Not provided"}

Return exactly 5 alternate role paths using this exact format for each:

## ROLE
[Specific job title — not generic]

## WHY
[2-3 sentences grounded in specific things from their profile, not generic traits. Explain why they would succeed, not just qualify.]

## ENTRY_POINT
[The exact first job title to apply for to get a foot in the door]

## GAP
[One specific thing — a cert, 90 days OJT, one course — that gets them fully competitive]`;

  const anthropic = new Anthropic({ apiKey });

  let text = "";
  try {
    const message = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: systemPrompt,
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
