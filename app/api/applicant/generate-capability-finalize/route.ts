import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { getCivilianDocLabel } from "@/lib/documentLabels";

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

type EvidenceGroup = {
  groupId: string;
  claims: string[];
  verificationStatus: "VERIFIED" | "USER_PROVIDED";
  primarySourceDocId: string;
  corroboratingDocIds: string[];
};

type StoredDoc = {
  id: string;
  label: string;
  filename: string;
  path: string;
  contentType: string;
  extractedText?: string;
  extractionStatus?: "pending" | "complete" | "failed";
};

type CapabilityEntry = {
  name: string;
  description: string;
  verificationStatus: "VERIFIED" | "USER_PROVIDED";
  primaryDocLabel: string;
  primaryDocId: string;
  corroboratingDocLabels: string[];
};

function resolveDocLabel(docId: string, storedDocs: StoredDoc[]): string {
  if (docId === "profile-self-reported") return "Self-Reported by Applicant";
  const doc = storedDocs.find(d => d.id === docId);
  if (!doc) return "Supporting Document";
  return getCivilianDocLabel({ label: doc.label, contentType: doc.contentType });
}

export async function POST() {
  const t0 = Date.now();
  console.log("[generate-capability-finalize][timing] START t0=" + t0);

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
  console.log("[generate-capability-finalize][timing] after getUser() t1=" + t1 + " delta=" + (t1 - t0) + "ms");
  if (userError || !user) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const adminClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  const { data: profile, error: profileError } = await adminClient
    .from("candidate_profiles")
    .select("job_types, experience_level, work_preference, capability_tags, summary, summary_priority, pending_evidence_groups, capability_generation_status, document_metadata")
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

  if (profile.capability_generation_status !== "groups_ready" || !profile.pending_evidence_groups) {
    return NextResponse.json(
      { error: "No pending evidence groups found. Please run capability generation from the start." },
      { status: 400 }
    );
  }

  const evidenceGroups: EvidenceGroup[] = Array.isArray(profile.pending_evidence_groups)
    ? (profile.pending_evidence_groups as EvidenceGroup[])
    : [];

  const storedDocs: StoredDoc[] = Array.isArray(profile.document_metadata)
    ? (profile.document_metadata as StoredDoc[])
    : [];

  const t2 = Date.now();
  console.log("[generate-capability-finalize][timing] after profile query t2=" + t2 + " delta=" + (t2 - t1) + "ms groupCount=" + evidenceGroups.length);

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

  const anthropic = new Anthropic({ apiKey });

  // --- Step 3: Civilian-language naming pass ---
  const t6 = Date.now();
  console.log("[generate-capability-finalize][timing] step3 START t6=" + t6 + " delta=" + (t6 - t2) + "ms groupCount=" + evidenceGroups.length);

  let capabilitySummary = "";
  let capabilityEntries: CapabilityEntry[] = [];

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

[groupId] **[Capability Name]** [VERIFIED]: [Description]

or

[groupId] **[Capability Name]** [USER_PROVIDED]: [Description]

Use each group's own "groupId" value from the EVIDENCE GROUPS above, exactly as given, in square brackets at the very start of the line.

One entry per line. No numbered lists. No bullets. No category headers in the output.`;

    try {
      const step3Response = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 4096,
        temperature: 0.2,
        messages: [{ role: "user", content: step3Prompt }],
      });

      const rawStep3Text = step3Response.content.find(b => b.type === "text")?.text ?? "";

      // Sonnet prefixes each line with "[groupId] " so we can deterministically map the
      // civilian name/description it writes back to the group's document provenance
      // (primarySourceDocId/corroboratingDocIds) — that link can't be recovered reliably
      // from the prose alone since Step 3 reorders entries by theme, not group order.
      // We strip the prefix back off before saving, so capability_summary's format/content
      // is unchanged from before this feature (byte-identical to what Sonnet would have
      // produced without the prefix instruction).
      const prosLines: string[] = [];
      for (const line of rawStep3Text.split("\n")) {
        // Restrict the groupId capture to word chars/hyphens (matches actual groupId shapes
        // like "g1" or "b0-g1"). A permissive [^\]]+ here would, on a malformed line missing
        // its closing bracket, greedily consume through to the NEXT "]" in the line (e.g. the
        // one in "[VERIFIED]"), silently dropping the name/tag into the discarded prefix
        // instead of failing safe.
        const prefixMatch = line.match(/^\[([\w-]+)\]\s*(.*)$/);
        if (!prefixMatch) {
          prosLines.push(line);
          continue;
        }
        const [, groupId, rest] = prefixMatch;
        prosLines.push(rest);

        const entryMatch = rest.match(/^\*\*(.+?)\*\*\s*\[(VERIFIED|USER_PROVIDED)\]:\s*(.*)$/);
        if (!entryMatch) continue;
        const [, name, status, description] = entryMatch;
        const group = evidenceGroups.find(g => g.groupId === groupId);
        if (!group) continue;

        capabilityEntries.push({
          name: name.trim(),
          description: description.trim(),
          verificationStatus: status as "VERIFIED" | "USER_PROVIDED",
          primaryDocLabel: resolveDocLabel(group.primarySourceDocId, storedDocs),
          primaryDocId: group.primarySourceDocId,
          corroboratingDocLabels: group.corroboratingDocIds.map(id => resolveDocLabel(id, storedDocs))
        });
      }

      capabilitySummary = prosLines.join("\n");
      const tStep3End = Date.now();
      console.log("[generate-capability-finalize][timing] step3 END t=" + tStep3End + " delta=" + (tStep3End - t6) + "ms capabilityLen=" + capabilitySummary.length + " entryCount=" + capabilityEntries.length);
    } catch (err) {
      console.error("[generate-capability-finalize] step3 Sonnet error", err);
    }
  }

  const t6b = Date.now();
  console.log("[generate-capability-finalize][timing] step3 complete t6b=" + t6b + " delta=" + (t6b - t6) + "ms capabilityLen=" + capabilitySummary.length);

  // --- Step 4: RECOMMENDED_POSITION, ENTRY_POINT, FUTURE_POSITIONS ---
  const t7 = Date.now();
  console.log("[generate-capability-finalize][timing] step4 (positions) START t7=" + t7 + " delta=" + (t7 - t6b) + "ms");

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
    console.log("[generate-capability-finalize][debug] raw response last 1000 chars:", positionsText.slice(-1000));
  } catch (err) {
    const tStep4Err = Date.now();
    console.log("[generate-capability-finalize][timing] step4 FAILED t=" + tStep4Err + " delta=" + (tStep4Err - t7) + "ms");
    console.error("[generate-capability-finalize] step4 Anthropic API error", err);
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `AI generation failed: ${message}` }, { status: 500 });
  }

  const tStep4End = Date.now();
  console.log("[generate-capability-finalize][timing] step4 complete t=" + tStep4End + " delta=" + (tStep4End - t7) + "ms responseLen=" + positionsText.length);

  const recommendedPosition = extractSection(positionsText, "RECOMMENDED_POSITION", "ENTRY_POINT");
  const entryPoint = extractSection(positionsText, "ENTRY_POINT", "FUTURE_POSITIONS");
  const futurePositions = extractSection(positionsText, "FUTURE_POSITIONS");

  console.log("[generate-capability-finalize][debug] section lengths - capability:", capabilitySummary.length, "recommended:", recommendedPosition.length, "entry:", entryPoint.length, "future:", futurePositions.length);

  const t8 = Date.now();
  console.log("[generate-capability-finalize][timing] before employer summary call t8=" + t8 + " delta=" + (t8 - tStep4End) + "ms");

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
    console.error("[generate-capability-finalize] Employer summary API error", err);
    employerSummary = "";
  }

  const t9 = Date.now();
  console.log("[generate-capability-finalize][timing] employer summary complete t9=" + t9 + " delta=" + (t9 - t8) + "ms employerSummaryLen=" + employerSummary.length);

  const { error: updateError } = await adminClient
    .from("candidate_profiles")
    .update({
      capability_summary: capabilitySummary,
      capability_entries: capabilityEntries,
      recommended_position: recommendedPosition,
      entry_point: entryPoint,
      future_positions: futurePositions,
      employer_summary: employerSummary,
      pending_evidence_groups: null,
      capability_generation_status: "complete"
    })
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[generate-capability-finalize] Failed to save AI output", updateError);
    return NextResponse.json({ error: "Failed to save generated profile." }, { status: 500 });
  }

  const tEnd = Date.now();
  console.log("[generate-capability-finalize][timing] phase2 complete tEnd=" + tEnd + " totalDelta=" + (tEnd - t0) + "ms entryCount=" + capabilityEntries.length);

  return NextResponse.json({ success: true, capabilitySummary, capabilityEntries, recommendedPosition, entryPoint, futurePositions, employerSummary });
}
