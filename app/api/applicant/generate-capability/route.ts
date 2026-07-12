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

type EvidenceItem = {
  claim: string;
  sourceDocId: string;
  sourceDocLabel: string;
  sourceDocType: string;
  isOfficialDocument: boolean;
};

type EvidenceGroup = {
  groupId: string;
  claims: string[];
  verificationStatus: "VERIFIED" | "USER_PROVIDED";
  primarySourceDocId: string;
  corroboratingDocIds: string[];
};

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

  const anthropic = new Anthropic({ apiKey });
  const allEvidenceItems: EvidenceItem[] = [];
  const unreadableDocLabels: string[] = [];
  const evidenceExtractionFailures: string[] = [];

  // --- Step 1: Per-document Haiku evidence extraction ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type ContentBlock = Record<string, any>;

  const extractEvidenceFromDoc = async (doc: StoredDoc, idx: number): Promise<EvidenceItem[]> => {
    const tDocStart = Date.now();
    console.log("[generate-capability][timing] step1[" + idx + "] START docId=" + doc.id + " label=" + doc.label);

    let docContent: ContentBlock[] = [];
    let usesPdfBeta = false;

    if (doc.extractionStatus === "complete" && doc.extractedText) {
      docContent = [{ type: "text", text: `Document: "${doc.label}" (${doc.filename})\n\n${doc.extractedText}` }];
    } else {
      const isImage = doc.contentType.startsWith("image/");
      const isPdf = doc.contentType === "application/pdf";

      if (!isImage && !isPdf) {
        unreadableDocLabels.push(`"${doc.label}" (${doc.filename})`);
        console.log("[generate-capability][timing] step1[" + idx + "] SKIP unreadable");
        return [];
      }

      try {
        const { data: blob, error: dlErr } = await adminClient.storage
          .from("candidate-documents")
          .download(doc.path);
        if (dlErr || !blob) throw dlErr ?? new Error("empty download");
        const bytes = await blob.arrayBuffer();
        if (bytes.byteLength > 4 * 1024 * 1024) {
          unreadableDocLabels.push(`"${doc.label}" (file too large)`);
          console.log("[generate-capability][timing] step1[" + idx + "] SKIP too large");
          return [];
        }
        const b64 = Buffer.from(bytes).toString("base64");

        if (isImage) {
          const mediaType = doc.contentType as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
          docContent = [
            { type: "image", source: { type: "base64", media_type: mediaType, data: b64 } },
            { type: "text", text: `(Above image document: "${doc.label}", filename: "${doc.filename}")` }
          ];
        } else {
          docContent = [{ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64 }, title: doc.label }];
          usesPdfBeta = true;
        }
      } catch (err) {
        console.error("[generate-capability] step1 failed to load doc", doc.path, err);
        unreadableDocLabels.push(`"${doc.label}" (could not be read)`);
        return [];
      }
    }

    const extractionPrompt = `Extract all capability-relevant evidence from this document as a JSON array.

Source document metadata — use these values exactly in every object you return:
- sourceDocId: "${doc.id}"
- sourceDocLabel: "${doc.label}"

Determine sourceDocType from the document content. Choose exactly one of: resume, NCOER, OER, DD214, certification, diploma, professional license, copyright registration, publisher confirmation, award order, military service record, other

Set isOfficialDocument to true ONLY for: diploma, certification, DD214, military service record, professional license, copyright registration, publisher confirmation, award order. Set false for resume and other self-reported sources.

Extraction rules:
- Capture duty descriptions (e.g. troop/equipment movement, communications, sensitive equipment accountability, logistics, training, operations) as distinct claims — not only named skill or cert lines. Duty claims are what allow later matching to find capabilities like "Operations Management."
- Each distinct capability, duty, role responsibility, or achievement gets its own claim object.
- Preserve specific language: named organizations, scope (personnel count, budget, unit level), and specific outcomes. "Supervised 15 soldiers during multi-week field operations" is better than "leadership."
- Include ALL evidence: leadership, technical, operational, administrative, educational, credentialed.
- Do NOT summarize or abstract: keep the specific evidence as stated.

Return ONLY a valid JSON array. Each object must have exactly these five fields:
claim, sourceDocId, sourceDocLabel, sourceDocType, isOfficialDocument

No markdown fences. No explanation. No text outside the JSON array.`;

    const messageContent: ContentBlock[] = [
      ...docContent,
      { type: "text", text: extractionPrompt }
    ];

    try {
      let response;
      if (usesPdfBeta) {
        response = await anthropic.beta.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4096,
          temperature: 0.2,
          betas: ["pdfs-2024-09-25"],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: [{ role: "user", content: messageContent as any }],
        });
      } else {
        response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 4096,
          temperature: 0.2,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: [{ role: "user", content: messageContent as any }],
        });
      }

      const raw = response.content.find(b => b.type === "text")?.text ?? "[]";
      const tDocEnd = Date.now();
      console.log("[generate-capability][timing] step1[" + idx + "] END delta=" + (tDocEnd - tDocStart) + "ms rawLen=" + raw.length);

      let parsed: EvidenceItem[] = [];
      let wasTruncated = false;
      let candidateCount: number | null = null;
      let salvagedCount: number | null = null;

      try {
        const directParse = JSON.parse(raw);
        parsed = Array.isArray(directParse) ? (directParse as EvidenceItem[]) : [];
      } catch {
        wasTruncated = true;
        let arrayParsed = false;
        const match = raw.match(/\[[\s\S]*\]/);
        if (match) {
          try {
            const matchParse = JSON.parse(match[0]);
            parsed = Array.isArray(matchParse) ? (matchParse as EvidenceItem[]) : [];
            arrayParsed = true;
          } catch { /* fall through to object-level salvage */ }
        }
        if (!arrayParsed) {
          // Salvage individual complete {...} objects from the truncated raw output.
          const objectMatches = raw.match(/\{[^{}]*\}/g) ?? [];
          candidateCount = objectMatches.length;
          const salvaged: EvidenceItem[] = [];
          for (const objStr of objectMatches) {
            try {
              const obj = JSON.parse(objStr);
              if (obj && typeof obj === "object") salvaged.push(obj as EvidenceItem);
            } catch { /* skip malformed object */ }
          }
          salvagedCount = salvaged.length;
          console.log("[generate-capability][step1][" + idx + "] salvage attempt: found " + candidateCount + " candidate objects in raw output, parsed " + salvagedCount + " successfully");
          parsed = salvaged;
        }
      }

      const lostCount = candidateCount !== null && salvagedCount !== null ? candidateCount - salvagedCount : 0;
      console.log("[generate-capability][step1][" + idx + "] truncated=" + wasTruncated + " recovered=" + parsed.length + (wasTruncated ? " lost=" + lostCount + " (via fallback)" : ""));

      if (wasTruncated && parsed.length === 0) {
        console.error("[generate-capability] step1[" + idx + "] JSON parse failed raw=" + raw.slice(0, 300));
      }

      if (parsed.length === 0 && doc.extractionStatus === "complete" && !!doc.extractedText) {
        evidenceExtractionFailures.push(`"${doc.label}" (${doc.filename})`);
        console.error("[generate-capability][step1][" + idx + "] EVIDENCE EXTRACTION FAILURE: doc=" + JSON.stringify(doc.label) + " had complete extractedText but yielded zero evidence items after all fallbacks");
      }

      return parsed;
    } catch (err) {
      const tDocErr = Date.now();
      console.log("[generate-capability][timing] step1[" + idx + "] ERROR delta=" + (tDocErr - tDocStart) + "ms err=" + (err instanceof Error ? err.message : String(err)));
      return [];
    }
  };

  const step1Results = await Promise.allSettled(
    storedDocs.map((doc, idx) => extractEvidenceFromDoc(doc, idx))
  );

  const step1PerDocCounts: number[] = [];
  for (const result of step1Results) {
    if (result.status === "fulfilled") {
      allEvidenceItems.push(...result.value);
      step1PerDocCounts.push(result.value.length);
    } else {
      step1PerDocCounts.push(0);
    }
  }

  // --- DEBUG: per-document Step 1 summary ---
  console.log("[generate-capability][debug][step1] per-doc extraction summary:");
  storedDocs.forEach((doc, idx) => {
    console.log("[generate-capability][debug][step1]   doc[" + idx + "] id=" + doc.id + " label=" + JSON.stringify(doc.label) + " contentType=" + doc.contentType + " extractionStatus=" + (doc.extractionStatus ?? "undefined") + " evidenceCount=" + (step1PerDocCounts[idx] ?? 0));
  });
  console.log("[generate-capability][debug][step1] unreadableDocLabels=" + JSON.stringify(unreadableDocLabels));
  console.log("[generate-capability][debug][step1] evidenceExtractionFailures=" + JSON.stringify(evidenceExtractionFailures));

  // Add self-reported profile evidence as USER_PROVIDED items
  if (profile.summary) {
    allEvidenceItems.push({
      claim: profile.summary,
      sourceDocId: "profile-self-reported",
      sourceDocLabel: "Applicant Self-Reported Summary",
      sourceDocType: "other",
      isOfficialDocument: false,
    });
  }
  if (Array.isArray(profile.capability_tags)) {
    for (const tag of profile.capability_tags as string[]) {
      allEvidenceItems.push({
        claim: tag,
        sourceDocId: "profile-self-reported",
        sourceDocLabel: "Applicant Self-Reported Skills",
        sourceDocType: "other",
        isOfficialDocument: false,
      });
    }
  }

  const t4 = Date.now();
  console.log("[generate-capability][timing] step1 complete t4=" + t4 + " delta=" + (t4 - t3b) + "ms totalEvidence=" + allEvidenceItems.length + " unreadable=" + unreadableDocLabels.length);

  // --- DEBUG: non-official evidence items ---
  const nonOfficialItems = allEvidenceItems.filter(e => !e.isOfficialDocument);
  console.log("[generate-capability][debug][step1] non-official evidence items (" + nonOfficialItems.length + " of " + allEvidenceItems.length + " total):");
  nonOfficialItems.forEach((e, i) => {
    console.log("[generate-capability][debug][step1]   nonOfficial[" + i + "] sourceDocLabel=" + JSON.stringify(e.sourceDocLabel) + " sourceDocType=" + JSON.stringify(e.sourceDocType));
  });

  // --- Step 2: Cross-document grouping pass ---
  const t5 = Date.now();
  console.log("[generate-capability][timing] step2 START t5=" + t5 + " delta=" + (t5 - t4) + "ms evidenceCount=" + allEvidenceItems.length);

  let evidenceGroups: EvidenceGroup[] = [];

  if (allEvidenceItems.length > 0) {
    const step2Prompt = `You are analyzing evidence items extracted from a job applicant's documents. Group items that describe the same underlying capability.

EVIDENCE ITEMS:
${JSON.stringify(allEvidenceItems, null, 2)}

Grouping rules:
- Group items ONLY when they share a common evidentiary basis for the same specific capability — not merely topical or thematic similarity.
- Two distinct VERIFIED capabilities must NOT be merged solely because they relate to a similar theme or domain.
- If sources conflict on a detail (e.g. resume vs NCOER on the same duty), keep the fact from the strongest official source, not whichever was first.
- If ANY item in a group has isOfficialDocument=true, set verificationStatus="VERIFIED" and use that document's sourceDocId as primarySourceDocId.
- Otherwise set verificationStatus="USER_PROVIDED".
- Self-reported items (sourceDocId="profile-self-reported") may be grouped with document evidence ONLY when that document directly supports the exact same capability. Otherwise they form their own USER_PROVIDED group.
- Military service signal (DD214, NCOERs, OERs, award orders) carries heavy weight — preserve these capabilities, do not collapse them into generic groups.
- A block tagged VERIFIED must be entirely supported by verified evidence. Do not blend self-reported content into a VERIFIED block.

Return ONLY a valid JSON array. Each object must have exactly these fields:
{
  "groupId": "g1",
  "claims": ["claim string 1", "claim string 2"],
  "verificationStatus": "VERIFIED" | "USER_PROVIDED",
  "primarySourceDocId": "sourceDocId of the strongest/most official source",
  "corroboratingDocIds": ["other sourceDocIds that also support this group"]
}

No markdown fences. No explanation. No text outside the JSON array.`;

    try {
      const step2Response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        temperature: 0.2,
        messages: [{ role: "user", content: step2Prompt }],
      });

      const raw2 = step2Response.content.find(b => b.type === "text")?.text ?? "[]";
      const tStep2End = Date.now();
      console.log("[generate-capability][timing] step2 END t=" + tStep2End + " delta=" + (tStep2End - t5) + "ms rawLen=" + raw2.length + " groupCount=" + (raw2.match(/"groupId"/g) ?? []).length);

      try {
        const parsed = JSON.parse(raw2);
        evidenceGroups = Array.isArray(parsed) ? (parsed as EvidenceGroup[]) : [];
      } catch {
        const match = raw2.match(/\[[\s\S]*\]/);
        if (match) {
          try { evidenceGroups = JSON.parse(match[0]) as EvidenceGroup[]; } catch { /* fall through */ }
        }
        console.error("[generate-capability] step2 JSON parse failed raw=" + raw2.slice(0, 300));
      }
    } catch (err) {
      console.error("[generate-capability] step2 Sonnet error", err);
    }
  }

  const t5b = Date.now();
  console.log("[generate-capability][timing] step2 complete t5b=" + t5b + " delta=" + (t5b - t5) + "ms groupCount=" + evidenceGroups.length);

  // --- Step 3: Civilian-language naming pass ---
  const t6 = Date.now();
  console.log("[generate-capability][timing] step3 START t6=" + t6 + " delta=" + (t6 - t5b) + "ms groupCount=" + evidenceGroups.length);

  let capabilitySummary = "";

  if (evidenceGroups.length > 0) {
    const step3Prompt = `You are a civilian career specialist. Convert these evidence groups into plain-business-language capability entries for a hiring manager.

EVIDENCE GROUPS:
${JSON.stringify(evidenceGroups, null, 2)}

Your ONLY jobs are:
1. Write a plain-business-language capability NAME and DESCRIPTION for each group.
2. Order entries: leadership/management/people-development first, technical/operational/domain-specific second, education/certifications/credentials last.
3. Apply the exact verification tag from each group's verificationStatus field.

Naming rules:
- Names must be immediately understandable to someone with zero military, trade, or specialized background.
- NO duty titles, school names, MOS codes, "Jumpmaster," "insertion," "joint fires," "signature reduction," or any term whose meaning depends on knowing a specific military, trade, or industry context in the NAME. These belong in the description as supporting evidence.
- Descriptions may include specific roles, organizations, schools, and contexts.
- Do NOT re-decide grouping or verification — use exactly the groups and verificationStatus values provided.
- Do NOT limit the count. Every group gets its own entry.
- Do NOT split or merge groups.
- Every capability name must describe what the person can DO or DELIVER, not a role title, credential name, or jargon term.

Output ONLY the capability entries in this exact format (no ## heading, no preamble, no trailing text):

**[Capability Name]** [VERIFIED]: [Description]

or

**[Capability Name]** [USER_PROVIDED]: [Description]

One entry per line. No numbered lists. No bullets. No category headers in the output.`;

    try {
      const step3Response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        temperature: 0.2,
        messages: [{ role: "user", content: step3Prompt }],
      });

      capabilitySummary = step3Response.content.find(b => b.type === "text")?.text ?? "";
      const tStep3End = Date.now();
      console.log("[generate-capability][timing] step3 END t=" + tStep3End + " delta=" + (tStep3End - t6) + "ms capabilityLen=" + capabilitySummary.length);
    } catch (err) {
      console.error("[generate-capability] step3 Sonnet error", err);
    }
  }

  const t6b = Date.now();
  console.log("[generate-capability][timing] step3 complete t6b=" + t6b + " delta=" + (t6b - t6) + "ms capabilityLen=" + capabilitySummary.length);

  // --- Step 4: RECOMMENDED_POSITION, ENTRY_POINT, FUTURE_POSITIONS ---
  const t7 = Date.now();
  console.log("[generate-capability][timing] step4 (positions) START t7=" + t7 + " delta=" + (t7 - t6b) + "ms");

  const step4Prompt = `An applicant has provided the following profile information:

- Desired role/industry: ${desiredRole}
- Experience level: ${profile.experience_level ?? "Not specified"}
- Work preference: ${profile.work_preference ?? "Not specified"}
- Skills they listed: ${skills}
- Background summary they wrote: ${profile.summary ?? "Not provided"}

Their verified capability profile is:

${capabilitySummary}

Based on this full picture, generate exactly three sections with these exact headings:

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

Respond with only the three sections above. No preamble, no closing remarks.`;

  let positionsText = "";
  try {
    const step4Response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 4096,
      temperature: 0.2,
      messages: [{ role: "user", content: step4Prompt }],
    });
    positionsText = step4Response.content.find(b => b.type === "text")?.text ?? "";
    console.log("[generate-capability][debug] raw response last 1000 chars:", positionsText.slice(-1000));
  } catch (err) {
    const tStep4Err = Date.now();
    console.log("[generate-capability][timing] step4 FAILED t=" + tStep4Err + " delta=" + (tStep4Err - t7) + "ms");
    console.error("[generate-capability] step4 Anthropic API error", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `AI generation failed: ${message}` }, { status: 500 });
  }

  const tStep4End = Date.now();
  console.log("[generate-capability][timing] step4 complete t=" + tStep4End + " delta=" + (tStep4End - t7) + "ms responseLen=" + positionsText.length);

  const recommendedPosition = extractSection(positionsText, "RECOMMENDED_POSITION", "ENTRY_POINT");
  const entryPoint = extractSection(positionsText, "ENTRY_POINT", "FUTURE_POSITIONS");
  const futurePositions = extractSection(positionsText, "FUTURE_POSITIONS");

  console.log("[generate-capability][debug] section lengths - capability:", capabilitySummary.length, "recommended:", recommendedPosition.length, "entry:", entryPoint.length, "future:", futurePositions.length);

  const t8 = Date.now();
  console.log("[generate-capability][timing] before employer summary call t8=" + t8 + " delta=" + (t8 - tStep4End) + "ms");

  // --- Employer Summary ---
  const isAlternateSummary = profile.summary_priority === "alternate";
  const employerSystemPrompt = "You are a talent strategist writing employer-facing candidate summaries for a civilian hiring platform. Your audience is a hiring manager or HR director with zero military background. Write in third person using they/them pronouns. Never use the candidate's name. Never use military job titles, unit designations, MOS codes, operation names, military acronyms, or any jargon that requires military context to understand. Translate everything into plain business language. Focus on what this person can do, the scale at which they have done it, and why a civilian employer should be interested. Be specific and factual. No filler language.";

  const employerUserPrompt = isAlternateSummary
    ? `Based on the following candidate profile sections, write a compelling employer-facing paragraph of 200-300 words (up to 1,500 characters) for a civilian hiring manager who has no military background. Use they/them/their pronouns throughout. Do not include the candidate's name. Do not use generic experience tier labels such as "entry level," "junior," "mid-level," or "senior." Instead, use specific role titles that reflect actual capability.

Lead with the transferable skills that make this candidate competitive in roles outside their direct background — name those roles explicitly. Reference their direct experience as supporting context in the second half.

Structure the summary in three parts:
1. What this person can do right now and what specific role they are best suited for today based on their transferable skills — use a real job title, not a tier label
2. What small gaps exist and what it would take to close them (a certification, specific experience, etc.)
3. Where this person can realistically grow within your organization or industry given their trajectory

Write to close the knowledge gap between non-traditional backgrounds and corporate expectations. Translate experience into business impact language the employer already knows. Do not use jargon the applicant used. Never frame the summary in a way that diminishes what the candidate has built regardless of their experience level. Do not use military titles, unit names, operation names, acronyms, or any term that requires military context.

CAPABILITY PROFILE:
${capabilitySummary}

RECOMMENDED POSITION:
${recommendedPosition}

ENTRY POINT:
${entryPoint}`
    : `Based on the following candidate profile sections, write a compelling employer-facing paragraph of 200-300 words (up to 1,500 characters) for a civilian hiring manager who has no military background. Use they/them/their pronouns throughout. Do not include the candidate's name. Do not use generic experience tier labels such as "entry level," "junior," "mid-level," or "senior." Instead, use specific role titles that reflect actual capability.

Structure the summary in three parts:
1. What this person can do right now and what specific role they are best suited for today — use a real job title, not a tier label
2. What small gaps exist and what it would take to close them (a certification, specific experience, etc.)
3. Where this person can realistically grow within your organization or industry given their trajectory

Write to close the knowledge gap between non-traditional backgrounds and corporate expectations. Translate experience into business impact language the employer already knows. Do not use military titles, unit names, operation names, acronyms, or any term that requires military context. Never frame the summary in a way that diminishes what the candidate has built regardless of their experience level.

CAPABILITY PROFILE:
${capabilitySummary}

RECOMMENDED POSITION:
${recommendedPosition}

ENTRY POINT:
${entryPoint}`;

  let employerSummary = "";
  try {
    const employerMessage = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 2048,
      system: employerSystemPrompt,
      temperature: 0.2,
      messages: [{ role: "user", content: employerUserPrompt }],
    });
    employerSummary = employerMessage.content.find(b => b.type === "text")?.text ?? "";
  } catch (err) {
    console.error("[generate-capability] Employer summary API error", err);
    employerSummary = "";
  }

  const t9 = Date.now();
  console.log("[generate-capability][timing] employer summary complete t9=" + t9 + " delta=" + (t9 - t8) + "ms employerSummaryLen=" + employerSummary.length);

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
