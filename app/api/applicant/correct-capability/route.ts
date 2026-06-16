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

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const correctionMessage = typeof body?.correctionMessage === "string" ? body.correctionMessage.trim() : "";

  if (!correctionMessage) {
    return NextResponse.json({ error: "correctionMessage is required." }, { status: 400 });
  }

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
  const correctionPreamble = `The candidate has provided a correction to apply when generating their capability profile.\n\nCorrection: "${correctionMessage}"\n\nAny claim introduced or changed by this correction must be tagged [USER_PROVIDED].\n\n`;

  const userPrompt = `${correctionPreamble}An applicant has provided the following profile information:

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
State the single best job title this applicant should target right now based on their full background. 

Assessment Mandate: You must first assess the candidate's overall demonstrated capability tier from their FULL background (leadership scope, budget/program/personnel responsibility, safety oversight, scale of operations) BEFORE considering certifications or recent credentials. Certifications and recent training should be treated as supplementary qualifications, not as the primary driver of seniority level. The recommended position's seniority must match the candidate's demonstrated capability tier, not the tier implied by their most recent or most junior credential. 

Do not use the words entry level, junior, senior, or any tier label. Do not pigeonhole based on what they have done. Surface what they are capable of becoming today.

Use this exact format:

**[Job Title]**: [Two to three sentences explaining specifically why this role is the right fit — what in their background maps to what this role demands day-to-day.]

## ENTRY_POINT
State the single best starting role this applicant should pursue first to build toward their recommended position. 

Assessment Mandate: Only recommend a bridge or entry role if there is a genuine demonstrated gap between the candidate's overall capability tier and their stated desired role/industry. If the candidate's overall background already supports the seniority level of their recommended position, ENTRY_POINT should reflect an entry point AT that same tier (e.g. "Security Program Manager" or "Assistant Director of Security Operations"), not a generic junior role. Do not assume that candidates with non-traditional or military backgrounds need civilian sector context first.

Use this exact format:

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
    extractedText?: string;
    extractionStatus?: "pending" | "complete" | "failed";
  };

  const storedDocs: StoredDoc[] = Array.isArray(profile.document_metadata)
    ? (profile.document_metadata as StoredDoc[])
    : [];

  type ContentBlock = Record<string, unknown>;
  const rawDocBlocks: ContentBlock[] = [];
  const extractedTexts: string[] = [];
  const unreadableDocLabels: string[] = [];

  for (const doc of storedDocs) {
    const isImage = doc.contentType.startsWith("image/");
    const isPdf = doc.contentType === "application/pdf";
    const isWord = doc.contentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" || doc.contentType === "application/msword";

    // 1. If we have complete extracted text for ANY document type, collect it for batching.
    if (doc.extractionStatus === "complete" && doc.extractedText) {
      extractedTexts.push(`--- START DOCUMENT: "${doc.label}" (${doc.filename}) ---\n${doc.extractedText}\n--- END DOCUMENT: "${doc.label}" ---`);
      continue;
    }

    // 2. Fallback: If extraction hasn't run or failed, handle based on type.
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
        rawDocBlocks.push({ type: "image", source: { type: "base64", media_type: mediaType, data: b64 } });
        rawDocBlocks.push({ type: "text", text: `(Above image: "${doc.label}")` });
      } else if (isPdf) {
        rawDocBlocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 }, title: doc.label });
      }
    } catch (err) {
      console.error("[correct-capability] failed to load document", doc.path, err);
      unreadableDocLabels.push(`"${doc.label}" (could not be read)`);
    }
  }

  // --- Batch Summarization & Doc Block Assembly ---
  const anthropic = new Anthropic({ apiKey });
  const docBlocks: ContentBlock[] = [];
  const BATCH_THRESHOLD = 22000;
  const totalExtractedLength = extractedTexts.reduce((sum, t) => sum + t.length, 0);

  if (extractedTexts.length > 0) {
    if (totalExtractedLength <= BATCH_THRESHOLD) {
      // Optimization: If everything fits in one batch, skip Haiku and send raw text blocks to synthesis
      for (const text of extractedTexts) {
        docBlocks.push({ type: "text" as const, text });
      }
    } else {
      // Perform chunked batch summarization
      const batchSummaries: string[] = [];

      const summarizeBatch = async (batch: string) => {
        try {
          const summaryMsg = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1500,
            system: "You are an expert at extracting capability-relevant signal from professional documents. Extract: specific skills demonstrated, leadership/management scope (personnel, budget, operations), technical proficiencies, certifications, and specific achievements. IMPORTANT: For every piece of information, you MUST clearly note the source document label (e.g. 'Source: [Document Label]') so that the final synthesis can determine verification status. Maintain high density of facts. Do not use filler language.",
            messages: [{ role: "user", content: `Summarize the following document batch for a capability profile:\n\n${batch}` }],
          });
          return summaryMsg.content.find((b) => b.type === "text")?.text ?? "";
        } catch (err) {
          console.error("[correct-capability] Batch summarization failed", err);
          return "";
        }
      };

      const batches: string[] = [];
      let currentBatch = "";
      for (const text of extractedTexts) {
        if ((currentBatch.length + text.length) > BATCH_THRESHOLD && currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = text;
        } else {
          currentBatch += (currentBatch ? "\n\n" : "") + text;
        }
      }
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }

      const results = await Promise.allSettled(batches.map((batch) => summarizeBatch(batch)));
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          batchSummaries.push(result.value);
        }
      }

      if (batchSummaries.length > 0) {
        docBlocks.push({ 
          type: "text" as const, 
          text: "--- SUMMARIZED DOCUMENT SIGNAL ---\n" + batchSummaries.join("\n\n") + "\n--- END SUMMARIZED SIGNAL ---" 
        });
      }
    }
  }

  // Add raw fallback blocks (images/PDFs)
  docBlocks.push(...rawDocBlocks);

  // Prepend document context to the prompt when docs are present
  let fullPrompt = userPrompt;
  if (storedDocs.length > 0) {
    const lines: string[] = [];
    if (docBlocks.length > 0) {
      lines.push("The applicant has provided source documents (attached below as text, summaries, or raw files). Read all document context completely before generating any output. Synthesize across ALL sources with equal weight — do not let any single document dominate. Military service signal (DD-214, NCOERs, OERs, awards, performance evaluations) carries heavy weight and must be prominently reflected in the capability profile and every summary section. Resumes, certificates, and academic transcripts carry equal weight to each other. The final output must reflect the full combined picture of every submitted source. Specific data in these documents takes precedence over the self-reported fields below. If military service appears in any source, it must be prominently reflected in the short capability summary.");
    }
    if (unreadableDocLabels.length > 0) {
      lines.push(`The following documents were uploaded but could not be processed automatically: ${unreadableDocLabels.join(", ")}. Note them as additional context.`);
    }
    fullPrompt = lines.join(" ") + "\n\n" + userPrompt;
  }

  const messageContent = [
    ...docBlocks,
    { type: "text" as const, text: fullPrompt },
  ];

  const hasPdfs = docBlocks.some((b) => b.type === "document");

  let text = "";
  try {
    if (hasPdfs) {
      const message = await anthropic.beta.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        betas: ["pdfs-2024-09-25"],
        system:
          "You are a veteran career counselor and hiring specialist who translates non-traditional, military, and blue-collar backgrounds into civilian corporate language that hiring managers can immediately understand and act on. You are precise, specific, and never use filler language.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [{ role: "user", content: messageContent as any }],
      });
      text = message.content.find((b) => b.type === "text")?.text ?? "";
    } else {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: docBlocks.length > 0 ? 4096 : 2048,
        system:
          "You are a veteran career counselor and hiring specialist who translates non-traditional, military, and blue-collar backgrounds into civilian corporate language that hiring managers can immediately understand and act on. You are precise, specific, and never use filler language.",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [{ role: "user", content: messageContent as any }],
      });
      text = message.content.find((b) => b.type === "text")?.text ?? "";
    }
  } catch (err) {
    console.error("[correct-capability] Anthropic API error", err);
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
      employer_summary: employerSummary,
      is_approved: false,
      correction_notes: correctionMessage,
    })
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[correct-capability] Failed to save AI output", updateError);
    return NextResponse.json({ error: "Failed to save corrected profile." }, { status: 500 });
  }

  return NextResponse.json({ success: true, capabilitySummary, recommendedPosition, entryPoint, futurePositions, employerSummary });
}
