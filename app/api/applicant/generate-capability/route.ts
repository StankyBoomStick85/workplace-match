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
    .select("job_types, experience_level, work_preference, capability_tags, summary, document_metadata, summary_priority")
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

  const employerSummaryInstruction = profile.summary_priority === "alternate"
    ? `## EMPLOYER_SUMMARY
A plain-language, employer-facing paragraph (200-300 words) that a hiring manager can read in 60 seconds. Use they/them/their pronouns throughout. Do not include the candidate's name.

Do not use generic experience tier labels such as "entry level," "junior," "mid-level," or "senior." Instead, use specific role titles that reflect actual capability (e.g. "project coordinator," "field operations lead"). Exception: if the candidate's background genuinely aligns to management or executive level, name that directly as it is directional and useful to the employer.

Lead with the transferable skills that make this candidate competitive in roles outside their direct background — name those roles explicitly. Reference their direct experience as supporting context in the second half of the paragraph.

Structure the summary in three parts:
1. What this person can do right now and what specific role they are best suited for today based on their transferable skills — use a real job title, not a tier label
2. What small gaps exist and what it would take to close them (a certification, specific experience, etc.)
3. Where this person can realistically grow within your organization or industry given their trajectory

Write to close the knowledge gap between non-traditional backgrounds and corporate expectations. Translate experience into business impact language the employer already knows. Do not use jargon the applicant used. Never frame the summary in a way that diminishes what the candidate has built regardless of their experience level.`
    : `## EMPLOYER_SUMMARY
A plain-language, employer-facing paragraph (200-300 words) that a hiring manager can read in 60 seconds. Use they/them/their pronouns throughout. Do not include the candidate's name.

Do not use generic experience tier labels such as "entry level," "junior," "mid-level," or "senior." Instead, use specific role titles that reflect actual capability (e.g. "project coordinator," "field operations lead"). Exception: if the candidate's background genuinely aligns to management or executive level, name that directly as it is directional and useful to the employer.

Structure the summary in three parts:
1. What this person can do right now and what specific role they are best suited for today - use a real job title, not a tier label
2. What small gaps exist and what it would take to close them (a certification, specific experience, etc.)
3. Where this person can realistically grow within your organization or industry given their trajectory

Write to close the knowledge gap between non-traditional backgrounds and corporate expectations. Translate experience into business impact language the employer already knows. Do not use jargon the applicant used. Never frame the summary in a way that diminishes what the candidate has built regardless of their experience level.`;

  // Prompt built from raw profile inputs only - never feed prior AI-generated outputs back into this prompt
  const userPrompt = `An applicant has provided the following profile information:

- Desired role/industry: ${desiredRole}
- Experience level: ${profile.experience_level ?? "Not specified"}
- Work preference: ${profile.work_preference ?? "Not specified"}
- Skills they listed: ${skills}
- Background summary they wrote: ${profile.summary ?? "Not provided"}

Based on this information, generate exactly five sections with these exact headings:

## CAPABILITY_PROFILE
List each distinct capability as a separate item. A verification tag is required on every entry. Use this exact format — no numbered lists, bullets, or other structure:

**[Capability Name]** [VERIFIED]: [Description]
or
**[Capability Name]** [USER_PROVIDED]: [Description]

Tagging rules:
- Tag [VERIFIED] only when the specific claim is directly supported by an official uploaded document: a diploma, professional certification, DD214, military service record, or professional license. A resume is NOT an official document and does NOT qualify for [VERIFIED].
- Tag [USER_PROVIDED] for everything else — skills from a resume, information entered on the profile form, or any self-reported detail.

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

${employerSummaryInstruction}

Respond with only the five sections above. No preamble, no closing remarks.`;

  // --- Build document content blocks ---
  type StoredDoc = {
    id: string;
    label: string;
    filename: string;
    path: string;
    contentType: string;
  };

  const storedDocs: StoredDoc[] = Array.isArray(profile.document_metadata)
    ? (profile.document_metadata as StoredDoc[])
    : [];

  type ContentBlock = Record<string, unknown>;
  const docBlocks: ContentBlock[] = [];
  const unreadableDocLabels: string[] = [];

  for (const doc of storedDocs) {
    const isImage = doc.contentType.startsWith("image/");
    const isPdf = doc.contentType === "application/pdf";
    if (!isImage && !isPdf) {
      unreadableDocLabels.push(`"${doc.label}" (${doc.filename})`);
      continue;
    }
    try {
      const { data: blob, error: dlErr } = await adminClient.storage
        .from("candidate-documents")
        .download(doc.path);
      if (dlErr || !blob) throw dlErr ?? new Error("empty download");
      const bytes = await blob.arrayBuffer();
      if (bytes.byteLength > 4 * 1024 * 1024) {
        unreadableDocLabels.push(`"${doc.label}" (file too large to attach)`);
        continue;
      }
      const b64 = Buffer.from(bytes).toString("base64");
      if (isImage) {
        const mediaType = doc.contentType as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        docBlocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: b64 } });
        docBlocks.push({ type: "text", text: `(Above image: "${doc.label}")` });
      } else {
        docBlocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 }, title: doc.label });
      }
    } catch (err) {
      console.error("[generate-capability] failed to load document", doc.path, err);
      unreadableDocLabels.push(`"${doc.label}" (could not be read)`);
    }
  }

  // Prepend document context to the prompt when docs are present
  let fullPrompt = userPrompt;
  if (storedDocs.length > 0) {
    const lines: string[] = [];
    if (docBlocks.length > 0) {
      lines.push("The applicant has provided source documents attached above. Read every document completely before generating any output. Synthesize across ALL documents with equal weight — do not let any single document dominate. Military service documents (DD-214, NCOERs, OERs, awards, performance evaluations) carry heavy weight and must be prominently reflected in the capability profile and every summary section. Resumes, certificates, and academic transcripts carry equal weight to each other. The final output must reflect the full combined picture of every submitted document. Specific data in these documents takes precedence over the self-reported fields below. If military service appears in any document, it must be prominently reflected in the short capability summary.");
    }
    if (unreadableDocLabels.length > 0) {
      lines.push(`The following documents were uploaded but could not be attached automatically: ${unreadableDocLabels.join(", ")}. Note them as additional context.`);
    }
    fullPrompt = lines.join(" ") + "\n\n" + userPrompt;
  }

  const messageContent = [
    ...docBlocks,
    { type: "text" as const, text: fullPrompt },
  ];

  const hasPdfs = docBlocks.some((b) => b.type === "document");
  const anthropic = new Anthropic({ apiKey });

  let text = "";
  try {
    if (hasPdfs) {
      const message = await anthropic.beta.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        betas: ["pdfs-2024-09-25"],
        system:
          "You are a veteran career counselor and hiring specialist who translates non-traditional, military, and blue-collar backgrounds into civilian corporate language that hiring managers can immediately understand and act on. You are precise, specific, and never use filler language.\n\nWhen documents are provided, you must synthesize across ALL submitted documents equally regardless of upload order. Military service documents — DD-214s, NCOERs, OERs, awards, and performance evaluations — carry heavy weight and must be reflected prominently in every output section. Resumes, certificates, and academic transcripts carry equal weight to each other. No single document may dominate the output. The capability profile and all summaries must reflect the full combined picture of every document submitted. If any document reveals military service, that service must appear prominently in the short capability summary.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [{ role: "user", content: messageContent as any }],
      });
      text = message.content.find((b) => b.type === "text")?.text ?? "";
    } else {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: docBlocks.length > 0 ? 4096 : 2048,
        system:
          "You are a veteran career counselor and hiring specialist who translates non-traditional, military, and blue-collar backgrounds into civilian corporate language that hiring managers can immediately understand and act on. You are precise, specific, and never use filler language.\n\nWhen documents are provided, you must synthesize across ALL submitted documents equally regardless of upload order. Military service documents — DD-214s, NCOERs, OERs, awards, and performance evaluations — carry heavy weight and must be reflected prominently in every output section. Resumes, certificates, and academic transcripts carry equal weight to each other. No single document may dominate the output. The capability profile and all summaries must reflect the full combined picture of every document submitted. If any document reveals military service, that service must appear prominently in the short capability summary.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [{ role: "user", content: messageContent as any }],
      });
      text = message.content.find((b) => b.type === "text")?.text ?? "";
    }
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
