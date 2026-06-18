import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  const t0 = Date.now();
  console.log("[generate-capability][timing] START t0=" + t0);

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
  const t1 = Date.now();
  console.log("[generate-capability][timing] after getUser() t1=" + t1 + " delta=" + (t1 - t0) + "ms");
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

  const t2 = Date.now();
  console.log("[generate-capability][timing] after profile query t2=" + t2 + " delta=" + (t2 - t1) + "ms docCount=" + (profile.document_metadata?.length ?? "null"));

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

Output capabilities in this exact category order, with no category labels or headers in the output itself:
1. Leadership, management, and people development capabilities first
2. Technical, operational, and domain-specific capabilities second
3. Education, certifications, and formal credentials last

Within each category, group self-reported capabilities alongside verified capabilities covering the same domain rather than separating them. Do not add category headers or labels to the output, just order the entries as described.

**[Capability Name]** [VERIFIED]: [Description]
or
**[Capability Name]** [USER_PROVIDED]: [Description]

Tagging rules:
- Tag [VERIFIED] only when the specific claim is directly supported by an official uploaded document: a diploma, professional certification, DD214, military service record, professional license, copyright registration certificate, or official publisher/rights-holder confirmation (for example, a KDP or publisher page confirming the person as the registered author or rights holder). A resume is NOT an official document and does NOT qualify for [VERIFIED].
- Tag [USER_PROVIDED] for everything else — skills from a resume, information entered on the profile form, or any self-reported detail.
- Provenance grouping rule: When grouping capability content into blocks, group ONLY by shared evidentiary source, never by topical or thematic similarity alone, and this applies even when two pieces of evidence share the same verification status. Two distinct VERIFIED capabilities must not be merged into one block solely because they relate to a similar theme or domain, each gets its own entry unless they describe the exact same underlying capability. Every piece of supporting evidence within a single capability block must derive from the same verification status. If a self-reported claim (no supporting document) is topically related to a verified capability but does not share its document source, it must NOT be merged into that block, it must form its own separate, clearly self-reported block, however minor the claim. A block tagged VERIFIED must be entirely supported by verified evidence with no self-reported content blended in.

List every distinct capability supported by the evidence below, VERIFIED or USER_PROVIDED. Do not limit the count and do not select a subset of what's available — every distinct, demonstrated capability gets its own entry. Do not split one capability into multiple overlapping or near-duplicate entries, and do not list the same capability twice under different names.

Cross-reference the self-reported capability tags provided in this profile against the evidence above. For each tag that describes a capability not already captured by an existing entry, add it as its own entry, applying the same Tagging rules used above: if an official uploaded document, diploma, professional certification, DD214, military service record, professional license, copyright registration certificate, or official publisher/rights-holder confirmation (for example, a KDP or publisher page confirming the person as the registered author or rights holder), directly supports that specific capability, tag it [VERIFIED]; otherwise tag it [USER_PROVIDED]. Do not default a cross-referenced tag to [USER_PROVIDED] without first checking whether supporting documentary evidence exists for it. If a tag is already covered by an existing VERIFIED or USER_PROVIDED entry, do not duplicate it.

Every capability name must be written in plain business language any reader outside that person's specific field, branch, or trade would immediately understand, describing what they can do or deliver, never a duty title, role name, school name, qualification name, or internal jargon specific to their branch, trade, or employer. Examples of jargon to avoid in a capability name: "Master Breacher," "Jumpmaster," "insertion" (as in helicopter or water insertion), "joint fires," "signature reduction," an MOS code, or an internal job title. These are examples of the category to avoid, not an exhaustive list, apply the same standard to any term whose meaning depends on knowing a specific military, trade, or industry context. If a reader with zero background in that field would not understand the capability name on its own, with no other context, rewrite it. The specific role, school, qualification, or internal title belongs in the description as supporting evidence, not in the name itself.

## RECOMMENDED_POSITION
State the single best job title this applicant should target right now based on their full background. 

CRITICAL ANONYMITY RULE: Never use the candidate's name. Refer to them only as "this candidate" or using they/them pronouns. The candidate's identity must remain hidden at all times.

Assessment Mandate: You must first assess the candidate's overall demonstrated capability tier from their FULL background (leadership scope, budget/program/personnel responsibility, safety oversight, scale of operations) BEFORE considering certifications or recent credentials. Certifications and recent training should be treated as supplementary qualifications, not as the primary driver of seniority level. The recommended position's seniority must match the candidate's demonstrated capability tier, not the tier implied by their most recent or most junior credential. 

Do not use the words entry level, junior, senior, or any tier label. Do not pigeonhole based on what they have done. Surface what they are capable of becoming today.

Use this exact format:

**[Job Title]**: [Two to three sentences explaining specifically why this role is the right fit — what in their background maps to what this role demands day-to-day.]

## ENTRY_POINT
State the single best starting role this applicant should pursue first to build toward their recommended position. 

CRITICAL ANONYMITY RULE: Never use the candidate's name. Refer to them only as "this candidate" or using they/them pronouns. The candidate's identity must remain hidden at all times.

Assessment Mandate: Only recommend a bridge or entry role if there is a genuine demonstrated gap between the candidate's overall capability tier and their stated desired role/industry. If the candidate's overall background already supports the seniority level of their recommended position, ENTRY_POINT should reflect an entry point AT that same tier (e.g. "Security Program Manager" or "Assistant Director of Security Operations"), not a generic junior role. Do not assume that candidates with non-traditional or military backgrounds need civilian sector context first.

Use this exact format:

**[Starting Role Title]**: [Two to three sentences explaining why this is the right entry point — what civilian experience it builds, how it bridges their background to their target role, and what makes it realistic to land now.]

## FUTURE_POSITIONS
List each role this applicant is realistically on track for as they build civilian sector experience. Use this exact format. Do not use numbered lists, bullet points, or any other structure — only the bold-title format below:

CRITICAL ANONYMITY RULE: Never use the candidate's name. Refer to them only as "this candidate" or using they/them pronouns. The candidate's identity must remain hidden at all times.

**[Role Title]**: [Brief explanation of why they are on track for this role and what experience or context positions them for it.]

List only roles that genuinely fit. No minimum or maximum number.

## EMPLOYER_SUMMARY
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

  const t3b = Date.now();
  console.log("[generate-capability][timing] before doc loop t3b=" + t3b + " delta=" + (t3b - t2) + "ms storedDocCount=" + storedDocs.length);

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
      console.error("[generate-capability] failed to load document", doc.path, err);
      unreadableDocLabels.push(`"${doc.label}" (could not be read)`);
    }
  }

  const t4 = Date.now();
  console.log("[generate-capability][timing] after doc loop t4=" + t4 + " delta=" + (t4 - t3b) + "ms extractedCount=" + extractedTexts.length + " rawBlocks=" + rawDocBlocks.length + " unreadable=" + unreadableDocLabels.length);

  let t5 = 0;
  let t5b = 0;

  // --- Batch Summarization & Doc Block Assembly ---
  const anthropic = new Anthropic({ apiKey });
  const docBlocks: ContentBlock[] = [];
  const BATCH_THRESHOLD = 60000;
  const totalExtractedLength = extractedTexts.reduce((sum, t) => sum + t.length, 0);

  if (extractedTexts.length > 0) {
    if (totalExtractedLength <= BATCH_THRESHOLD) {
      t5b = t4;
      // Optimization: If everything fits in one batch, skip Haiku and send raw text blocks to synthesis
      for (const text of extractedTexts) {
        docBlocks.push({ type: "text" as const, text });
      }
    } else {
      // Summarize each document individually to preserve provenance
      const extractLabelFromText = (text: string): string => {
        const match = text.match(/--- START DOCUMENT: "(.+?)" \(/);
        return match ? match[1] : "Unknown Document";
      };

      const summarizeSingleDoc = async (docText: string, label: string, idx: number): Promise<{label: string, summary: string}> => {
        const tBatchStart = Date.now();
        console.log("[generate-capability][timing] batch[" + idx + "] START t=" + tBatchStart + " batchLen=" + docText.length);
        try {
          const summaryMsg = await anthropic.messages.create({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 1500,
            system: "You are an expert at extracting capability-relevant signal from professional documents. Extract: specific skills demonstrated, leadership/management scope (personnel, budget, operations), technical proficiencies, certifications, and specific achievements. IMPORTANT: For every piece of information, you MUST clearly note the source document label (e.g. 'Source: [Document Label]') so that the final synthesis can determine verification status. Maintain high density of facts. Do not use filler language. When extracting capability-relevant content, preserve SPECIFIC evidentiary details rather than abstracting into generic competency descriptions. Keep named organizations, bodies, and levels of command (e.g. 'Office Under SECDEF', 'NATO', 'Detachment Commander'); keep specific roles, audiences, and contexts described in the source (who was briefed, advised, or engaged, and at what level); keep near-verbatim phrasing for duty descriptions where the source uses specific language. Do NOT collapse this into vague summary phrases like 'demonstrates strategic thinking' - instead extract something like 'assisted in briefing executive-level officials at the Office of the Under Secretary of Defense (OUSD); provided strategic problem-solving input,' preserving the Source: [Document Label] attribution as required. Keep this specific, but concise: 1-2 sentences per distinct capability or achievement is sufficient. Preserve the specific named detail within that length, rather than expanding into longer narrative prose.",
            messages: [{ role: "user", content: `Summarize the following document batch for a capability profile:\n\n${docText}` }],
          });
          const tBatchEnd = Date.now();
          console.log("[generate-capability][timing] batch[" + idx + "] END t=" + tBatchEnd + " delta=" + (tBatchEnd - tBatchStart) + "ms");
          return { label, summary: summaryMsg.content.find((b) => b.type === "text")?.text ?? "" };
        } catch (err) {
          const tBatchErr = Date.now();
          console.log("[generate-capability][timing] batch[" + idx + "] ERROR t=" + tBatchErr + " delta=" + (tBatchErr - tBatchStart) + "ms err=" + (err instanceof Error ? err.message : String(err)));
          return { label, summary: "" };
        }
      };

      const t5 = Date.now();
      console.log("[generate-capability][timing] before batch summarizeBatch() calls t5=" + t5 + " delta=" + (t5 - t4) + "ms docCount=" + extractedTexts.length);

      const docSummaryResults = await Promise.allSettled(
        extractedTexts.map((text, idx) => summarizeSingleDoc(text, extractLabelFromText(text), idx))
      );
      t5b = Date.now();
      console.log("[generate-capability][timing] after batch summarizeBatch() calls t5b=" + t5b + " delta=" + (t5b - t5) + "ms");

      for (const result of docSummaryResults) {
        if (result.status === "fulfilled" && result.value.summary) {
          docBlocks.push({
            type: "text" as const,
            text: `--- DOCUMENT: "${result.value.label}" ---\n${result.value.summary}\n--- END DOCUMENT ---`
          });
        }
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

  const promptLength = fullPrompt.length + docBlocks.reduce((sum, b) => sum + JSON.stringify(b).length, 0);
  const t6 = Date.now();
  console.log("[generate-capability][timing] before Sonnet synthesis t6=" + t6 + " delta=" + (t6 - t5b) + "ms hasPdfs=" + hasPdfs + " docBlockCount=" + docBlocks.length + " promptLen=" + promptLength + " fullPromptLen=" + fullPrompt.length);

  let text = "";
  try {
    if (hasPdfs) {
      const message = await anthropic.beta.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        betas: ["pdfs-2024-09-25"],
        system:
          "You are a veteran career counselor and hiring specialist who translates non-traditional, military, and blue-collar backgrounds into civilian corporate language that hiring managers can immediately understand and act on. You are precise, specific, and never use filler language.\n\nWhen documents are provided, you must synthesize across ALL submitted documents equally regardless of upload order. Military service documents — DD-214s, NCOERs, OERs, awards, and performance evaluations — carry heavy weight and must be reflected prominently in every output section. Resumes, certificates, and academic transcripts carry equal weight to each other. No single document may dominate the output. The capability profile and all summaries must reflect the full combined picture of every document submitted. If any document reveals military service, that service must appear prominently in the short capability summary.",
        temperature: 0.2,
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
        temperature: 0.2,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: [{ role: "user", content: messageContent as any }],
      });
      text = message.content.find((b) => b.type === "text")?.text ?? "";
    }
  } catch (err) {
    const t7Err = Date.now();
    console.log("[generate-capability][timing] Sonnet FAILED t7=" + t7Err + " delta=" + (t7Err - t6) + "ms");
    console.error("[generate-capability] Anthropic API error", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `AI generation failed: ${message}` }, { status: 500 });
  }

  const t7 = Date.now();
  console.log("[generate-capability][timing] Sonnet complete t7=" + t7 + " delta=" + (t7 - t6) + "ms responseLen=" + text.length);

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
