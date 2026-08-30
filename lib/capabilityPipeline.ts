import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { getCivilianDocLabel } from "@/lib/documentLabels";

export type EvidenceItem = {
  claim: string;
  sourceDocId: string;
  sourceDocLabel: string;
  sourceDocType: string;
  isOfficialDocument: boolean;
};

export type EvidenceGroup = {
  groupId: string;
  claims: string[];
  verificationStatus: "VERIFIED" | "USER_PROVIDED";
  primarySourceDocId: string;
  corroboratingDocIds: string[];
};

export type StoredDoc = {
  id: string;
  label: string;
  filename: string;
  path: string;
  contentType: string;
  extractedText?: string;
  extractionStatus?: "pending" | "complete" | "failed";
};

export type CapabilityEntry = {
  name: string;
  description: string;
  verificationStatus: "VERIFIED" | "USER_PROVIDED";
  primaryDocLabel: string;
  primaryDocId: string;
  corroboratingDocLabels: string[];
};

// ---------- shared parsing helpers ----------

// Extracts complete top-level {...} objects from a (possibly truncated) JSON array string.
// Tracks brace depth and quoted-string state so nested arrays/objects inside each
// top-level object (e.g. EvidenceGroup's "claims" array) don't throw off matching.
export function extractBalancedJsonObjects(raw: string): string[] {
  const objects: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escapeNext = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === "\\") {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          objects.push(raw.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }

  return objects;
}

// Shared JSON.parse + salvage logic for any Sonnet call expected to return EvidenceGroup[].
export function parseEvidenceGroupsFromRaw(raw: string): {
  groups: EvidenceGroup[];
  wasTruncated: boolean;
  candidateCount: number | null;
  salvagedCount: number | null;
} {
  let groups: EvidenceGroup[] = [];
  let wasTruncated = false;
  let candidateCount: number | null = null;
  let salvagedCount: number | null = null;

  try {
    const parsed = JSON.parse(raw);
    groups = Array.isArray(parsed) ? (parsed as EvidenceGroup[]) : [];
  } catch {
    wasTruncated = true;
    let arrayParsed = false;
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const matchParse = JSON.parse(match[0]);
        groups = Array.isArray(matchParse) ? (matchParse as EvidenceGroup[]) : [];
        arrayParsed = true;
      } catch { /* fall through to object-level salvage */ }
    }
    if (!arrayParsed) {
      const objectMatches = extractBalancedJsonObjects(raw);
      candidateCount = objectMatches.length;
      const salvaged: EvidenceGroup[] = [];
      for (const objStr of objectMatches) {
        try {
          const obj = JSON.parse(objStr);
          if (obj && typeof obj === "object") salvaged.push(obj as EvidenceGroup);
        } catch { /* skip malformed object */ }
      }
      salvagedCount = salvaged.length;
      groups = salvaged;
    }
  }

  return { groups, wasTruncated, candidateCount, salvagedCount };
}

export function extractSection(text: string, heading: string, nextHeading?: string): string {
  const lower = text.toLowerCase();
  const marker = `## ${heading}`.toLowerCase();
  const start = lower.indexOf(marker);
  if (start === -1) return "";
  const contentStart = start + marker.length;
  const nextMarker = nextHeading ? `## ${nextHeading}`.toLowerCase() : null;
  const end = nextMarker ? lower.indexOf(nextMarker, contentStart) : text.length;
  return text.slice(contentStart, end === -1 ? text.length : end).trim();
}

// resolveDocLabel only has each document's label/contentType available (sourceDocType is
// Step 1/Step 2 evidence-extraction metadata that isn't persisted past the evidence groups),
// so matching is done primarily against the document's label text.
export function resolveDocLabel(docId: string, storedDocs: StoredDoc[]): string {
  if (docId === "profile-self-reported") return "Self-Reported by Applicant";
  const doc = storedDocs.find((d) => d.id === docId);
  if (!doc) return "Supporting Document";
  return getCivilianDocLabel({ label: doc.label, contentType: doc.contentType });
}

// ---------- Step 1: per-document evidence extraction ----------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContentBlock = Record<string, any>;

function buildExtractionPrompt(doc: StoredDoc, correctionInstruction?: string): string {
  const correctionSection = correctionInstruction
    ? `\n\nA candidate has requested this correction while their profile is being regenerated: "${correctionInstruction}"\n\nUse it only to decide what evidence to extract or how precisely to describe it. It must NEVER cause you to mark isOfficialDocument true or false based on what the candidate asked for — that flag is determined solely by the document-type rule above.`
    : "";

  return `Extract all capability-relevant evidence from this document as a JSON array.

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
- Do NOT summarize or abstract: keep the specific evidence as stated.${correctionSection}

Return ONLY a valid JSON array. Each object must have exactly these five fields:
claim, sourceDocId, sourceDocLabel, sourceDocType, isOfficialDocument

No markdown fences. No explanation. No text outside the JSON array.`;
}

// The profile's self-reported summary/skill tags are folded in as their own USER_PROVIDED
// evidence items alongside whatever gets extracted from actual documents.
export function buildSelfReportedEvidenceItems(input: {
  summary?: string | null;
  capabilityTags?: string[] | null;
}): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  if (input.summary) {
    items.push({
      claim: input.summary,
      sourceDocId: "profile-self-reported",
      sourceDocLabel: "Applicant Self-Reported Summary",
      sourceDocType: "other",
      isOfficialDocument: false,
    });
  }
  if (Array.isArray(input.capabilityTags)) {
    for (const tag of input.capabilityTags) {
      items.push({
        claim: tag,
        sourceDocId: "profile-self-reported",
        sourceDocLabel: "Applicant Self-Reported Skills",
        sourceDocType: "other",
        isOfficialDocument: false,
      });
    }
  }
  return items;
}

export async function extractEvidenceFromDocuments(
  storedDocs: StoredDoc[],
  adminClient: SupabaseClient,
  anthropic: Anthropic,
  correctionInstruction?: string
): Promise<{ items: EvidenceItem[]; unreadableDocLabels: string[]; evidenceExtractionFailures: string[] }> {
  const allEvidenceItems: EvidenceItem[] = [];
  const unreadableDocLabels: string[] = [];
  const evidenceExtractionFailures: string[] = [];

  const extractEvidenceFromDoc = async (doc: StoredDoc, idx: number): Promise<EvidenceItem[]> => {
    let docContent: ContentBlock[] = [];
    let usesPdfBeta = false;

    if (doc.extractionStatus === "complete" && doc.extractedText) {
      docContent = [{ type: "text", text: `Document: "${doc.label}" (${doc.filename})\n\n${doc.extractedText}` }];
    } else {
      const isImage = doc.contentType.startsWith("image/");
      const isPdf = doc.contentType === "application/pdf";

      if (!isImage && !isPdf) {
        unreadableDocLabels.push(`"${doc.label}" (${doc.filename})`);
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
        console.error("[capabilityPipeline][step1] failed to load doc", doc.path, err);
        unreadableDocLabels.push(`"${doc.label}" (could not be read)`);
        return [];
      }
    }

    const messageContent: ContentBlock[] = [
      ...docContent,
      { type: "text", text: buildExtractionPrompt(doc, correctionInstruction) }
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

      const raw = response.content.find((b) => b.type === "text")?.text ?? "[]";

      let parsed: EvidenceItem[] = [];
      try {
        const directParse = JSON.parse(raw);
        parsed = Array.isArray(directParse) ? (directParse as EvidenceItem[]) : [];
      } catch {
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
          const objectMatches = raw.match(/\{[^{}]*\}/g) ?? [];
          const salvaged: EvidenceItem[] = [];
          for (const objStr of objectMatches) {
            try {
              const obj = JSON.parse(objStr);
              if (obj && typeof obj === "object") salvaged.push(obj as EvidenceItem);
            } catch { /* skip malformed object */ }
          }
          parsed = salvaged;
        }
      }

      if (parsed.length === 0 && doc.extractionStatus === "complete" && !!doc.extractedText) {
        evidenceExtractionFailures.push(`"${doc.label}" (${doc.filename})`);
        console.error("[capabilityPipeline][step1][" + idx + "] EVIDENCE EXTRACTION FAILURE: doc=" + JSON.stringify(doc.label) + " had complete extractedText but yielded zero evidence items");
      }

      return parsed;
    } catch (err) {
      console.error("[capabilityPipeline][step1][" + idx + "] Haiku error", err);
      return [];
    }
  };

  const results = await Promise.allSettled(storedDocs.map((doc, idx) => extractEvidenceFromDoc(doc, idx)));
  for (const result of results) {
    if (result.status === "fulfilled") allEvidenceItems.push(...result.value);
  }

  return { items: allEvidenceItems, unreadableDocLabels, evidenceExtractionFailures };
}

// ---------- Step 2: cross-document grouping + merge ----------

// Chunks evidence into batches so a single Sonnet call never has to hold and group
// hundreds of items at once. Tune here if batches still truncate.
const EVIDENCE_BATCH_SIZE = 150;

export function buildEvidenceGroupingPrompt(items: EvidenceItem[], correctionInstruction?: string): string {
  const correctionSection = correctionInstruction
    ? `\n\nA candidate has requested this correction: "${correctionInstruction}"\n\nApply it only to how you group or interpret these evidence items (e.g. recognizing that two claims describe the same capability, or that one claim was wrongly merged with another). It must NEVER directly set or override a group's verificationStatus — that must still be derived solely from the isOfficialDocument rule below, exactly as it would be without this correction.`
    : "";

  return `You are analyzing evidence items extracted from a job applicant's documents. Group items that describe the same underlying capability.

EVIDENCE ITEMS:
${JSON.stringify(items, null, 2)}

Grouping rules:
- Group items ONLY when they share a common evidentiary basis for the same specific capability — not merely topical or thematic similarity.
- Two distinct VERIFIED capabilities must NOT be merged solely because they relate to a similar theme or domain.
- If sources conflict on a detail (e.g. resume vs NCOER on the same duty), keep the fact from the strongest official source, not whichever was first.
- If ANY item in a group has isOfficialDocument=true, set verificationStatus="VERIFIED" and use that document's sourceDocId as primarySourceDocId.
- Otherwise set verificationStatus="USER_PROVIDED".
- Self-reported items (sourceDocId="profile-self-reported") may be grouped with document evidence ONLY when that document directly supports the exact same capability. Otherwise they form their own USER_PROVIDED group.
- Military service signal (DD214, NCOERs, OERs, award orders) carries heavy weight — preserve these capabilities, do not collapse them into generic groups.
- A block tagged VERIFIED must be entirely supported by verified evidence. Do not blend self-reported content into a VERIFIED block.${correctionSection}

Return ONLY a valid JSON array. Each object must have exactly these fields:
{
  "groupId": "g1",
  "claims": ["claim string 1", "claim string 2"],
  "verificationStatus": "VERIFIED" | "USER_PROVIDED",
  "primarySourceDocId": "sourceDocId of the strongest/most official source",
  "corroboratingDocIds": ["other sourceDocIds that also support this group"]
}

No markdown fences. No explanation. No text outside the JSON array.`;
}

export function buildEvidenceGroupMergePrompt(groups: EvidenceGroup[]): string {
  return `You are merging preliminary capability groups that were produced independently from separate batches of evidence for the same job applicant. Some groups from different batches describe the exact same underlying capability (e.g. the same duty appearing in evidence from two different documents) and must be merged into one. Groups that are already distinct capabilities must NOT be merged.

PRELIMINARY GROUPS:
${JSON.stringify(groups, null, 2)}

Merging rules:
- Merge two or more groups ONLY when they describe the exact same underlying capability — not merely a similar theme or domain.
- When merging, combine their "claims" arrays (deduplicate identical claim strings; keep distinct phrasing that adds evidence).
- When merging, combine their "corroboratingDocIds" (deduplicate), and add the losing group's primarySourceDocId to corroboratingDocIds if it differs from the winning group's.
- Re-resolve verificationStatus and primarySourceDocId using the same priority rules as before: if ANY merged claim traces to an official document, the merged group is VERIFIED and primarySourceDocId must be that official document's sourceDocId. Otherwise USER_PROVIDED.
- A merged VERIFIED group must remain entirely supported by verified evidence — do not blend a self-reported-only group into a VERIFIED group unless it was already grouped with official evidence in its source batch.
- Groups that do not match anything else pass through unchanged, exactly as given.
- Do not invent new claims. Do not drop claims. Every claim from every input group must appear in exactly one output group.

Return ONLY a valid JSON array of the final merged groups. Each object must have exactly these fields:
{
  "groupId": "g1",
  "claims": ["claim string 1", "claim string 2"],
  "verificationStatus": "VERIFIED" | "USER_PROVIDED",
  "primarySourceDocId": "sourceDocId of the strongest/most official source",
  "corroboratingDocIds": ["other sourceDocIds that also support this group"]
}

No markdown fences. No explanation. No text outside the JSON array.`;
}

export type BatchTiming = {
  batchIndex: number;
  itemsIn: number;
  groupsOut: number;
  elapsedMs: number;
};

export type GroupingResult = {
  groups: EvidenceGroup[];
  batchCount: number;
  batchTimings: BatchTiming[];
  mergeRan: boolean;
  mergeElapsedMs: number | null;
  preliminaryGroupCount: number;
};

export async function runEvidenceGrouping(
  evidenceItems: EvidenceItem[],
  anthropic: Anthropic,
  correctionInstruction?: string
): Promise<GroupingResult> {
  if (evidenceItems.length === 0) {
    return { groups: [], batchCount: 0, batchTimings: [], mergeRan: false, mergeElapsedMs: null, preliminaryGroupCount: 0 };
  }

  const evidenceBatches: EvidenceItem[][] = [];
  for (let i = 0; i < evidenceItems.length; i += EVIDENCE_BATCH_SIZE) {
    evidenceBatches.push(evidenceItems.slice(i, i + EVIDENCE_BATCH_SIZE));
  }

  const groupBatch = async (batch: EvidenceItem[], batchIdx: number): Promise<{ groups: EvidenceGroup[]; timing: BatchTiming }> => {
    const start = Date.now();
    try {
      const batchResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        temperature: 0.2,
        messages: [{ role: "user", content: buildEvidenceGroupingPrompt(batch, correctionInstruction) }],
      });

      const rawBatch = batchResponse.content.find((b) => b.type === "text")?.text ?? "[]";
      const { groups } = parseEvidenceGroupsFromRaw(rawBatch);
      const tagged = groups.map((g) => ({ ...g, groupId: "b" + batchIdx + "-" + (g.groupId ?? "g?") }));
      return { groups: tagged, timing: { batchIndex: batchIdx, itemsIn: batch.length, groupsOut: tagged.length, elapsedMs: Date.now() - start } };
    } catch (err) {
      console.error("[capabilityPipeline][step2a][batch" + batchIdx + "] Sonnet error, skipping batch", err);
      return { groups: [], timing: { batchIndex: batchIdx, itemsIn: batch.length, groupsOut: 0, elapsedMs: Date.now() - start } };
    }
  };

  const batchResults = await Promise.allSettled(evidenceBatches.map((batch, idx) => groupBatch(batch, idx)));

  const preliminaryGroups: EvidenceGroup[] = [];
  const batchTimings: BatchTiming[] = [];
  batchResults.forEach((result) => {
    if (result.status === "fulfilled") {
      preliminaryGroups.push(...result.value.groups);
      batchTimings.push(result.value.timing);
    }
  });
  batchTimings.sort((a, b) => a.batchIndex - b.batchIndex);

  if (preliminaryGroups.length > 1) {
    const mergeStart = Date.now();
    try {
      const mergeResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 8192,
        temperature: 0.2,
        messages: [{ role: "user", content: buildEvidenceGroupMergePrompt(preliminaryGroups) }],
      });

      const rawMerge = mergeResponse.content.find((b) => b.type === "text")?.text ?? "[]";
      const { groups: mergedGroups } = parseEvidenceGroupsFromRaw(rawMerge);
      const mergeElapsedMs = Date.now() - mergeStart;

      if (mergedGroups.length === 0) {
        console.error("[capabilityPipeline][step2b] MERGE FAILURE, falling back to unmerged preliminary groups");
        return { groups: preliminaryGroups, batchCount: evidenceBatches.length, batchTimings, mergeRan: true, mergeElapsedMs, preliminaryGroupCount: preliminaryGroups.length };
      }
      return { groups: mergedGroups, batchCount: evidenceBatches.length, batchTimings, mergeRan: true, mergeElapsedMs, preliminaryGroupCount: preliminaryGroups.length };
    } catch (err) {
      console.error("[capabilityPipeline][step2b] Sonnet error, falling back to unmerged preliminary groups", err);
      return { groups: preliminaryGroups, batchCount: evidenceBatches.length, batchTimings, mergeRan: true, mergeElapsedMs: Date.now() - mergeStart, preliminaryGroupCount: preliminaryGroups.length };
    }
  }

  return { groups: preliminaryGroups, batchCount: evidenceBatches.length, batchTimings, mergeRan: false, mergeElapsedMs: null, preliminaryGroupCount: preliminaryGroups.length };
}

// ---------- Step 3: civilian-language naming pass ----------

// Returned verbatim (and only) when Step 3 determines a requested correction can't be
// satisfied by renaming/rewording alone - see buildStep3Prompt's correction section.
export const STEP3_ESCALATE_SENTINEL = "ESCALATE_REQUIRED";

export function buildStep3Prompt(evidenceGroups: EvidenceGroup[], correctionInstruction?: string): string {
  const correctionSection = correctionInstruction
    ? `\n\nA candidate has requested this correction: "${correctionInstruction}"\n\nApply it ONLY if it is a pure naming, wording, or description change to one or more of the entries below, using exactly the groups and verificationStatus values already provided, unchanged.\n\nDo NOT apply it, and do not attempt any workaround, if satisfying it would require: merging or splitting a group, moving a claim between groups, adding or removing a claim, or changing any entry's verificationStatus (VERIFIED vs USER_PROVIDED) — those can only be corrected by re-running extraction and grouping, not by renaming. If the correction requires any of those, respond with EXACTLY this single line and nothing else, no other text: ${STEP3_ESCALATE_SENTINEL}`
    : "";

  return `You are a civilian career specialist. Convert these evidence groups into plain-business-language capability entries for a hiring manager.

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
- Every capability name must describe what the person can DO or DELIVER, not a role title, credential name, or jargon term.${correctionSection}

Output ONLY the capability entries in this exact format (no ## heading, no preamble, no trailing text):

[groupId] **[Capability Name]** [VERIFIED]: [Description]

or

[groupId] **[Capability Name]** [USER_PROVIDED]: [Description]

Use each group's own "groupId" value from the EVIDENCE GROUPS above, exactly as given, in square brackets at the very start of the line.

One entry per line. No numbered lists. No bullets. No category headers in the output.`;
}

export type Step3Result =
  | { kind: "escalate" }
  | { kind: "entries"; capabilitySummary: string; capabilityEntries: CapabilityEntry[] };

// Parses Step 3's line-prefixed output. verificationStatus is ALWAYS taken from the
// stored group's own field, never from the tag text Step 3 echoed back — this is what
// makes it structurally impossible for a hallucination (or a correction message) to
// change a capability's VERIFIED/USER_PROVIDED status through this parse step.
//
// If the response is neither the escalation sentinel nor a complete, one-entry-per-group
// parse, this returns "escalate" rather than writing partial or mismatched output.
export function parseStep3Response(raw: string, evidenceGroups: EvidenceGroup[], storedDocs: StoredDoc[]): Step3Result {
  const trimmed = raw.trim();
  if (trimmed === STEP3_ESCALATE_SENTINEL) {
    return { kind: "escalate" };
  }

  const capabilityEntries: CapabilityEntry[] = [];
  const prosLines: string[] = [];

  for (const line of raw.split("\n")) {
    const prefixMatch = line.match(/^\[([\w-]+)\]\s*(.*)$/);
    if (!prefixMatch) {
      prosLines.push(line);
      continue;
    }
    const [, groupId, rest] = prefixMatch;
    prosLines.push(rest);

    const entryMatch = rest.match(/^\*\*(.+?)\*\*\s*\[(VERIFIED|USER_PROVIDED)\]:\s*(.*)$/);
    if (!entryMatch) continue;
    const [, name, , description] = entryMatch;
    const group = evidenceGroups.find((g) => g.groupId === groupId);
    if (!group) continue;

    capabilityEntries.push({
      name: name.trim(),
      description: description.trim(),
      verificationStatus: group.verificationStatus,
      primaryDocLabel: resolveDocLabel(group.primarySourceDocId, storedDocs),
      primaryDocId: group.primarySourceDocId,
      corroboratingDocLabels: group.corroboratingDocIds.map((id) => resolveDocLabel(id, storedDocs))
    });
  }

  if (capabilityEntries.length !== evidenceGroups.length) {
    // Not every group produced a valid entry - not safely parseable. Escalate rather
    // than save a capability list that silently dropped or garbled some entries.
    return { kind: "escalate" };
  }

  return { kind: "entries", capabilitySummary: prosLines.join("\n"), capabilityEntries };
}

// ---------- Step 4: recommended position / entry point / future positions ----------

export type Step4Input = {
  desiredRole: string;
  experienceLevel: string;
  workPreference: string;
  skills: string;
  summary: string;
  capabilitySummary: string;
};

export function buildStep4Prompt(input: Step4Input): string {
  return `An applicant has provided the following profile information:

- Desired role/industry: ${input.desiredRole}
- Experience level: ${input.experienceLevel}
- Work preference: ${input.workPreference}
- Skills they listed: ${input.skills}
- Background summary they wrote: ${input.summary}

Their verified capability profile is:

${input.capabilitySummary}

Based on this full picture, generate exactly three sections with these exact headings:

## RECOMMENDED_POSITION
State the single best job title this applicant should target right now based on their full background.

CRITICAL ANONYMITY RULE: This platform never discloses candidate identity to an employer, at any tier. Refer to them only as "this candidate" or using they/them/their pronouns - never he/him, she/her, or any gendered term, and never their name or initials. Never name a past employer, unit, command, branch of service, or rank. Never state exact dates, years of service, tenure length, or age. Never name a specific country, region, or named operation/deployment. Never mention a publication or other named authored work. Security clearance is the one exception: if it applies, state it as a capability fact ("holds an active security clearance," or the specific level if given) and never name who granted, sponsored, or investigated it. The candidate's identity must remain fully hidden at all times - describe capability only, never who they are or where/when they did it.

Assessment Mandate: You must first assess the candidate's overall demonstrated capability tier from their FULL background (leadership scope, budget/program/personnel responsibility, safety oversight, scale of operations) BEFORE considering certifications or recent credentials. Certifications and recent training should be treated as supplementary qualifications, not as the primary driver of seniority level. The recommended position's seniority must match the candidate's demonstrated capability tier, not the tier implied by their most recent or most junior credential.

Do not use the words entry level, junior, senior, or any tier label. Do not pigeonhole based on what they have done. Surface what they are capable of becoming today.

Use this exact format:

**[Job Title]**: [Two to three sentences explaining specifically why this role is the right fit — what in their background maps to what this role demands day-to-day.]

## ENTRY_POINT
State the single best starting role this applicant should pursue first to build toward their recommended position.

CRITICAL ANONYMITY RULE: This platform never discloses candidate identity to an employer, at any tier. Refer to them only as "this candidate" or using they/them/their pronouns - never he/him, she/her, or any gendered term, and never their name or initials. Never name a past employer, unit, command, branch of service, or rank. Never state exact dates, years of service, tenure length, or age. Never name a specific country, region, or named operation/deployment. Never mention a publication or other named authored work. Security clearance is the one exception: if it applies, state it as a capability fact ("holds an active security clearance," or the specific level if given) and never name who granted, sponsored, or investigated it. The candidate's identity must remain fully hidden at all times - describe capability only, never who they are or where/when they did it.

Assessment Mandate: Only recommend a bridge or entry role if there is a genuine demonstrated gap between the candidate's overall capability tier and their stated desired role/industry. If the candidate's overall background already supports the seniority level of their recommended position, ENTRY_POINT should reflect an entry point AT that same tier (e.g. "Security Program Manager" or "Assistant Director of Security Operations"), not a generic junior role. Do not assume that candidates with non-traditional or military backgrounds need civilian sector context first.

Use this exact format:

**[Starting Role Title]**: [Two to three sentences explaining why this is the right entry point — what civilian experience it builds, how it bridges their background to their target role, and what makes it realistic to land now.]

## FUTURE_POSITIONS
List each role this applicant is realistically on track for as they build civilian sector experience. Use this exact format. Do not use numbered lists, bullet points, or any other structure — only the bold-title format below:

CRITICAL ANONYMITY RULE: This platform never discloses candidate identity to an employer, at any tier. Refer to them only as "this candidate" or using they/them/their pronouns - never he/him, she/her, or any gendered term, and never their name or initials. Never name a past employer, unit, command, branch of service, or rank. Never state exact dates, years of service, tenure length, or age. Never name a specific country, region, or named operation/deployment. Never mention a publication or other named authored work. Security clearance is the one exception: if it applies, state it as a capability fact ("holds an active security clearance," or the specific level if given) and never name who granted, sponsored, or investigated it. The candidate's identity must remain fully hidden at all times - describe capability only, never who they are or where/when they did it.

**[Role Title]**: [Brief explanation of why they are on track for this role and what experience or context positions them for it.]

List only roles that genuinely fit. No minimum or maximum number.

Respond with only the three sections above. No preamble, no closing remarks.`;
}

// ---------- Employer-facing summary ----------

export const EMPLOYER_SUMMARY_SYSTEM_PROMPT =
  "You are a talent strategist writing employer-facing candidate summaries for a civilian hiring platform. Your audience is a hiring manager or HR director with zero military background. This platform never discloses candidate identity to an employer, at any tier - describe capability only, never identity. If a motivated reader could identify a specific individual from your output, the output is wrong. Write in third person using only they/them/their pronouns - never he/him, she/her, or any gendered term. Never use the candidate's name or initials. Never name a past employer, unit, command, or organization. Never state a military branch of service (Army, Navy, Air Force, Marines, Coast Guard, Space Force) or a specific rank, grade, or title (e.g. Sergeant First Class, Green Beret, Colonel). Never state exact dates, years of service, tenure length, or age (no \"20 years,\" no \"since 2005\" - use relative framing like \"an extended career\" or \"many years\" only if duration matters, otherwise omit it). Never name a specific country, region, or named operation/deployment - use general framing like \"high-risk international environments\" instead of \"50+ countries\" or a named campaign. Never mention a publication, book, article, or other named authored work. Never use military job titles, unit designations, MOS codes, operation names, military acronyms, or any jargon that requires military context to understand. Translate everything into plain business language.\n\nSecurity clearance is the one exception to \"describe capability only\": if the source material states the candidate holds a security clearance, report it as a capability fact - \"holds an active security clearance\" or, if a specific level is given, name that level (e.g. \"holds an active Top Secret clearance\"). Never name who granted, sponsored, or investigated it - no agency, department, or branch may appear anywhere near the clearance mention. Workplace Match does not verify clearances; it reports only what the candidate stated and what their documents corroborate.\n\nWhen the source material indicates a capability was corroborated by more than one document or source, describe it as a corroboration count, never by naming the document type or its issuer - \"documented across multiple supervisor evaluations\" is correct, \"verified by Army NCOERs\" is not, because naming the document type itself identifies the branch.\n\nFocus on what this person can do and the scale at which they have done it (team size, budget, scope of responsibility are fine when phrased generically) and why a civilian employer should be interested. Be specific and factual about capability. No filler language.";

export type EmployerSummaryInput = {
  capabilitySummary: string;
  recommendedPosition: string;
  entryPoint: string;
  isAlternateSummary: boolean;
};

export function buildEmployerSummaryUserPrompt(input: EmployerSummaryInput): string {
  const leadIn = input.isAlternateSummary
    ? `Lead with the transferable skills that make this candidate competitive in roles outside their direct background — name those roles explicitly. Reference their direct experience as supporting context in the second half.\n\nStructure the summary in three parts:\n1. What this person can do right now and what specific role they are best suited for today based on their transferable skills — use a real job title, not a tier label\n2. What small gaps exist and what it would take to close them (a certification, specific experience, etc.)\n3. Where this person can realistically grow within your organization or industry given their trajectory`
    : `Structure the summary in three parts:\n1. What this person can do right now and what specific role they are best suited for today — use a real job title, not a tier label\n2. What small gaps exist and what it would take to close them (a certification, specific experience, etc.)\n3. Where this person can realistically grow within your organization or industry given their trajectory`;

  return `Based on the following candidate profile sections, write a compelling employer-facing paragraph of 200-300 words (up to 1,500 characters) for a civilian hiring manager who has no military background. This platform never discloses candidate identity to an employer, at any tier - describe capability only. If a motivated reader could identify a specific individual from your output, the output is wrong.

Use they/them/their pronouns throughout - never he/him, she/her, or any gendered term. Do not include the candidate's name or initials. Do not name a past employer, unit, command, or organization. Do not state a military branch of service or a specific rank, grade, or title. Do not state exact dates, years of service, tenure length, or age - omit duration entirely unless it is essential, in which case use relative framing ("an extended career") rather than a number. Do not name a specific country, region, or named operation/deployment - describe the type of environment generically instead (e.g. "high-risk international environments"). Do not mention a publication, book, article, or other named authored work.

Security clearance is the one exception: if the source material states the candidate holds a security clearance, report it as a capability fact - "holds an active security clearance," or the specific level if one is given (e.g. "holds an active Top Secret clearance"). Never name who granted, sponsored, or investigated it - no agency, department, or branch may appear near the clearance mention.

If the source material indicates a capability was corroborated by more than one document or source, describe it as a corroboration count, never by naming the document type or issuer - "documented across multiple supervisor evaluations" is correct, "verified by Army NCOERs" is not, because the document type itself identifies the branch.

Do not use generic experience tier labels such as "entry level," "junior," "mid-level," or "senior." Instead, use specific role titles that reflect actual capability.

${leadIn}

Write to close the knowledge gap between non-traditional backgrounds and corporate expectations. Translate experience into business impact language the employer already knows. Do not use jargon the applicant used. Never frame the summary in a way that diminishes what the candidate has built regardless of their experience level. Do not use military titles, unit names, operation names, acronyms, or any term that requires military context.

If any identifying detail (name, employer, branch, rank, clearance sponsor/agency, exact dates, country, publication) appears in the source material below, omit it from your output entirely - describe only what the capability demonstrates, never who held it or where it happened.

CAPABILITY PROFILE:
${input.capabilitySummary}

RECOMMENDED POSITION:
${input.recommendedPosition}

ENTRY POINT:
${input.entryPoint}`;
}
