import type { SupabaseClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";
import { getCivilianDocLabel } from "@/lib/documentLabels";
import {
  SHARED_ATTRIBUTION_WORDING,
  SHARED_RESULT_MARKER,
  allNumbersFrom,
  extractNumbers,
  findScaleInflation,
  findUnsourcedNumbers,
  relabelsRecruitingAsSales,
} from "@/lib/capabilityStatementChecks";
import {
  THRIVES_IN_MAX_FAMILIES,
  familiesNamedIn,
  findTitleWords,
  formatDirectionForPrompt,
  roleFamilyLabels,
  settingClause,
  type CandidateDirection,
} from "@/lib/candidateDirection";
import { CIVILIAN_LANGUAGE_RULES, GUIDING_PRINCIPLE, describeSettingLanguage, findSettingLanguage } from "@/lib/civilianLanguage";
import { findGapContradictions } from "@/lib/candidateTools";

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
  // Per-document evidence cache, populated once at upload time (see
  // process-document/route.ts) so generate-capability never has to re-run
  // extraction for a document it's already extracted. Never used when a
  // correction is in progress - extraction behavior itself changes during a
  // correction (see buildExtractionPrompt), so cached evidence is invalid by
  // definition in that path and must always be bypassed.
  evidenceItems?: EvidenceItem[];
  evidenceStatus?: "pending" | "complete" | "failed";
  evidenceExtractedAt?: string;
  // Named tools and platforms in this document (lib/candidateTools.ts) -
  // extracted separately from claims, since a tool needs no number.
  tools?: string[];
  toolsStatus?: "complete" | "failed";
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
- Do NOT summarize or abstract: keep the specific evidence as stated.
- Keep attribution with each result. When the document says results are shared, team-level, or contract-level (e.g. "these are contract-level team results", "not his alone", "one of two account managers"), carry that qualifier into EVERY claim it applies to, e.g. "Team's monthly bid rate ran 33% to 35% (contract-level team result)". Never let a team result read as the person's alone.${correctionSection}

Return ONLY a valid JSON array. Each object must have exactly these five fields:
claim, sourceDocId, sourceDocLabel, sourceDocType, isOfficialDocument

No markdown fences. No explanation. No text outside the JSON array.`;
}

// The profile's self-reported skill tags are folded in as their own USER_PROVIDED
// evidence items alongside whatever gets extracted from actual documents. A tag
// that a document also proves is absorbed into that document's group at the
// merge step (see applyMergePlan); only an unsupported tag stands on its own.
//
// The self-written summary is deliberately NOT evidence: it is context about who
// the person is (Step 4 and the employer summary read it from the profile
// directly). As a single claim it used to become its own capability entry,
// restating name, rank, and tenure.
export function buildSelfReportedEvidenceItems(input: {
  capabilityTags?: string[] | null;
}): EvidenceItem[] {
  const items: EvidenceItem[] = [];
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

// Runs a worker pool of exactly `limit` concurrent workers pulling from a shared
// index, rather than fixed-size chunking - a slow item never stalls the other
// (limit - 1) workers the way waiting for a whole chunk to finish would. Used to
// cap Anthropic call concurrency so a large document backlog degrades to a
// controlled queue instead of an unthrottled fan-out that collides with account
// rate limits and the SDK's own retry/backoff (which produces the same wall-clock
// cost as running sequentially, just with extra failed attempts along the way).
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const current = nextIndex++;
      if (current >= items.length) return;
      try {
        const value = await fn(items[current], current);
        results[current] = { status: "fulfilled", value };
      } catch (reason) {
        results[current] = { status: "rejected", reason };
      }
    }
  }

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

// Extraction concurrency ceiling shared by every caller (single-document upload-time
// extraction always runs at concurrency 1 in practice since it's one document; this
// applies when generate-capability backfills multiple cache misses or re-extracts
// everything for a correction). Chosen to stay well under typical account rate
// limits rather than firing every document at once.
export const EXTRACTION_CONCURRENCY_LIMIT = 5;

export type SingleDocEvidenceResult = {
  items: EvidenceItem[];
  unreadable: boolean;
  extractionFailed: boolean;
};

// Extracts evidence from exactly one document. Pulled out of extractEvidenceFromDocuments
// so it can be called standalone at upload time (one document, one invocation) as well as
// in bulk (below) for cache misses and correction-driven full re-extraction.
export async function extractEvidenceFromOneDocument(
  doc: StoredDoc,
  adminClient: SupabaseClient,
  anthropic: Anthropic,
  correctionInstruction?: string,
  idx = 0
): Promise<SingleDocEvidenceResult> {
  let docContent: ContentBlock[] = [];
  let usesPdfBeta = false;

  if (doc.extractionStatus === "complete" && doc.extractedText) {
    docContent = [{ type: "text", text: `Document: "${doc.label}" (${doc.filename})\n\n${doc.extractedText}` }];
  } else {
    const isImage = doc.contentType.startsWith("image/");
    const isPdf = doc.contentType === "application/pdf";

    if (!isImage && !isPdf) {
      return { items: [], unreadable: true, extractionFailed: false };
    }

    try {
      const { data: blob, error: dlErr } = await adminClient.storage
        .from("candidate-documents")
        .download(doc.path);
      if (dlErr || !blob) throw dlErr ?? new Error("empty download");
      const bytes = await blob.arrayBuffer();
      if (bytes.byteLength > 4 * 1024 * 1024) {
        return { items: [], unreadable: true, extractionFailed: false };
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
      return { items: [], unreadable: true, extractionFailed: false };
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

    const extractionFailed = parsed.length === 0 && doc.extractionStatus === "complete" && !!doc.extractedText;
    if (extractionFailed) {
      console.error("[capabilityPipeline][step1][" + idx + "] EVIDENCE EXTRACTION FAILURE: doc=" + JSON.stringify(doc.label) + " had complete extractedText but yielded zero evidence items");
    }

    return { items: parsed, unreadable: false, extractionFailed };
  } catch (err) {
    console.error("[capabilityPipeline][step1][" + idx + "] Haiku error", err);
    return { items: [], unreadable: false, extractionFailed: false };
  }
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

  const results = await mapWithConcurrency(storedDocs, EXTRACTION_CONCURRENCY_LIMIT, (doc, idx) =>
    extractEvidenceFromOneDocument(doc, adminClient, anthropic, correctionInstruction, idx)
  );

  storedDocs.forEach((doc, idx) => {
    const result = results[idx];
    if (result.status !== "fulfilled") return;
    allEvidenceItems.push(...result.value.items);
    if (result.value.unreadable) unreadableDocLabels.push(`"${doc.label}" (${doc.filename})`);
    if (result.value.extractionFailed) evidenceExtractionFailures.push(`"${doc.label}" (${doc.filename})`);
  });

  return { items: allEvidenceItems, unreadableDocLabels, evidenceExtractionFailures };
}

// ---------- Step 2: cross-document grouping + merge ----------

// Chunks evidence into batches so a single Sonnet grouping call never has to hold
// and group hundreds of items at once. 150 was still too large: batches of dense
// documents (an NCOER yields 25-40 evidence items) produced 38-40 distinct groups,
// and one group's JSON with its claim strings runs ~200-270 output tokens, so the
// response hit the 8192 ceiling and salvaged a truncated tail. 100 items caps the
// worst case near ~40 groups (~10K tokens), comfortably under the raised
// per-batch max_tokens of 16000 (see groupBatch).
const EVIDENCE_BATCH_SIZE = 100;
const GROUPING_BATCH_MAX_TOKENS = 16000;

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
- Evidence from ANY official document type — service records, certifications, licenses, degrees, transcripts, performance evaluations, award orders — is preserved: a distinct capability it supports must not be collapsed into a generic group. No document category gets preferential protection over another.
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

// The merge call decides WHICH preliminary groups describe the same capability
// and should be combined; it does NOT re-emit group content. Re-serializing every
// group's claims under an 8192-token cap was physically impossible for a
// multi-document profile (~140 preliminary groups x ~260 tokens each ≈ 36K
// tokens) and silently truncated - the run that motivated this returned 20 of
// ~140 groups with the rest discarded. A merge PLAN is O(number of merges), not
// O(total evidence): ~1-3K tokens even at 350 preliminary groups. The mechanical
// parts (unioning claims / corroborating ids, re-resolving verificationStatus and
// primarySourceDocId, the VERIFIED-purity rule) move verbatim into applyMergePlan
// below - same semantics, applied deterministically in code so they cannot be cut
// off.
//
// Consolidation scope, not a new pass: grouping (step 2a) runs independently per
// 100-item batch with no cross-batch context, so the same broader capability
// routinely comes back as several differently-worded preliminary groups - one per
// batch whose evidence happened to touch it - not just as literal duplicates of
// one restated claim. The original criterion here ("exact same underlying
// capability") only caught the latter, so a real profile's preliminary group
// count (a function of batch count, not of how many distinct things the person
// can do) passed straight through to Step 3 ungrouped. Broadened below to also
// combine those same-broader-capability restatements, in this same pass rather
// than a separate one: it already sees every preliminary group at once, already
// produces a plan applied deterministically in code, and a second LLM pass over
// the same input would just be this rule running twice.
export function buildEvidenceGroupMergePrompt(groups: EvidenceGroup[]): string {
  return `You are reconciling preliminary capability groups produced independently from separate batches of evidence for the same job applicant. Because each batch was grouped without seeing the others, the same broader capability often comes back as several separate groups - not just as one duty restated twice, but as different specific incidents, roles, or documents that all demonstrate the same underlying capability. Your job is to identify which groups should be combined into one.

PRELIMINARY GROUPS:
${JSON.stringify(groups, null, 2)}

Rules for deciding what combines:
- Combine two or more groups when they describe the SAME BROADER CAPABILITY, even if the specific incidents, roles, timeframes, or source documents differ. Test: would a hiring manager describe these as "the same skill, shown more than once" rather than as two different things this person can do? If yes, combine them.
- Do NOT combine groups that describe genuinely different skills or deliverables just because they sit in a similar theme or domain. Example: leading a team and training/mentoring people are related, leadership-adjacent skills, but they are different things a hiring manager would list separately - do not combine them. The same applies to e.g. asset accountability vs. budget management, or technical execution vs. advising others on it.
- A self-reported group (verificationStatus USER_PROVIDED, e.g. a skill tag the applicant typed in) that restates a capability a document group (VERIFIED) proves MUST be listed in that document group's merge set. The documented group then stands as the capability; the self-reported restatement is not kept as a separate one.
- When it is genuinely unclear whether two groups are the same skill or two related-but-different skills, leave them separate. Under-combining loses nothing (Step 3 still produces a usable entry for each); over-combining destroys specific, evidence-backed strengths by folding them into a vague catch-all.
- A group that does not clearly match another is left alone.
- For calibration only, not a target to hit: most single-person profiles, however many preliminary groups batching produced, describe on the order of a dozen to a few dozen genuinely distinct broad capabilities - not hundreds (a sign this pass under-combined restatements of the same thing) and not just a handful (a sign genuinely different skills got folded together). Use this only to sanity-check your own output; the two rules above decide the actual count, not this number.

Return ONLY a JSON object of exactly this shape, and nothing else:

{ "merges": [ ["groupId", "groupId"], ["groupId", "groupId", "groupId"] ] }

- Each inner array is one set of groupIds to combine into a single group.
- Use each group's own "groupId" value exactly as given above.
- List a groupId in at most one inner array.
- Any groupId not listed is kept unchanged — do NOT list groups that stand alone.
- If nothing should be combined, return { "merges": [] }.
- Do NOT return group contents, claims, verification tags, or any other field. Only the merge sets.

No markdown fences. No explanation. No text outside the JSON object.`;
}

export type MergePlan = { merges: string[][] };

export type MergePlanApplication = {
  groups: EvidenceGroup[];
  mergeInstructionsApplied: number;
  invalidGroupIdRefs: string[]; // referenced by the plan but not a real preliminary groupId
  duplicateGroupIdRefs: string[]; // referenced in more than one merge set
  unaccountedGroupIds: string[]; // preliminary groups that ended up neither merged nor passed through (invariant: empty)
  splitForVerifiedSafety: string[][]; // merge sets that mixed VERIFIED and USER_PROVIDED members
  // USER_PROVIDED groups dropped because a VERIFIED group in the same merge set
  // proves the same capability (see applyMergePlan). Kept whole for logging and
  // so coverage can count their evidence as represented.
  droppedUserProvidedGroups: EvidenceGroup[];
};

// Tolerant parse of the merge plan. On any failure returns an empty plan
// (parseOk=false) - applyMergePlan with an empty plan passes every preliminary
// group through unchanged, which is exactly the old "MERGE FAILURE -> fall back to
// unmerged" behaviour.
export function parseMergePlan(raw: string): { plan: MergePlan; parseOk: boolean } {
  const coerce = (s: string): MergePlan | null => {
    try {
      const obj = JSON.parse(s);
      if (obj && typeof obj === "object" && Array.isArray((obj as { merges?: unknown }).merges)) {
        const merges = ((obj as { merges: unknown[] }).merges)
          .filter((m): m is unknown[] => Array.isArray(m))
          .map((m) => m.filter((x): x is string => typeof x === "string"))
          .filter((m) => m.length > 0);
        return { merges };
      }
    } catch {
      /* fall through */
    }
    return null;
  };
  const direct = coerce(raw.trim());
  if (direct) return { plan: direct, parseOk: true };
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    const salvaged = coerce(match[0]);
    if (salvaged) return { plan: salvaged, parseOk: true };
  }
  return { plan: { merges: [] }, parseOk: false };
}

// Combines one set of preliminary groups into a single group, applying verbatim
// the rules the merge prompt used to ask the model to apply:
// - claims: union across all members, exact-string dedup, winner's claims first
// - corroboratingDocIds: union across all members, plus each non-winner member's
//   primarySourceDocId when it differs from the winner's, deduped
// - verificationStatus: VERIFIED if ANY member is VERIFIED, else USER_PROVIDED
// - primarySourceDocId: the winner's - winner = the first VERIFIED member, or the
//   first member if none is VERIFIED (so a VERIFIED merged group's primary is
//   always an official document's id)
// Claim/corroborating ORDER was never specified for the model's output, so the
// winner-first ordering here is a deterministic-but-equivalent choice.
function mergeGroupSet(members: EvidenceGroup[]): EvidenceGroup {
  const winner = members.find((g) => g.verificationStatus === "VERIFIED") ?? members[0];
  const anyVerified = members.some((g) => g.verificationStatus === "VERIFIED");

  const seenClaims = new Set<string>();
  const claims: string[] = [];
  for (const g of [winner, ...members.filter((g) => g !== winner)]) {
    for (const c of g.claims ?? []) {
      if (!seenClaims.has(c)) {
        seenClaims.add(c);
        claims.push(c);
      }
    }
  }

  const seenDoc = new Set<string>();
  const corroboratingDocIds: string[] = [];
  const addDoc = (id: string | null | undefined) => {
    if (id && id !== winner.primarySourceDocId && !seenDoc.has(id)) {
      seenDoc.add(id);
      corroboratingDocIds.push(id);
    }
  };
  for (const g of members) {
    for (const id of g.corroboratingDocIds ?? []) addDoc(id);
    if (g !== winner) addDoc(g.primarySourceDocId);
  }

  return {
    groupId: winner.groupId,
    claims,
    verificationStatus: anyVerified ? "VERIFIED" : "USER_PROVIDED",
    primarySourceDocId: winner.primarySourceDocId,
    corroboratingDocIds,
  };
}

// Applies a validated merge plan to the preliminary groups. Every preliminary
// group is folded into a merge, passed through verbatim, or - only when it is a
// USER_PROVIDED restatement of a capability a VERIFIED group in the same merge
// set proves - dropped and reported in droppedUserProvidedGroups. Nothing else
// is ever dropped (see unaccountedGroupIds, an invariant that must stay empty).
export function applyMergePlan(preliminaryGroups: EvidenceGroup[], plan: MergePlan): MergePlanApplication {
  const byId = new Map(preliminaryGroups.map((g) => [g.groupId, g] as const));
  const invalidGroupIdRefs: string[] = [];
  const duplicateGroupIdRefs: string[] = [];
  const splitForVerifiedSafety: string[][] = [];
  const droppedUserProvidedGroups: EvidenceGroup[] = [];
  const consumed = new Set<string>();
  const mergedGroups: EvidenceGroup[] = [];
  let mergeInstructionsApplied = 0;

  for (const rawIds of plan.merges) {
    const ids: string[] = [];
    for (const id of rawIds) {
      if (!byId.has(id)) {
        invalidGroupIdRefs.push(id);
        continue;
      }
      if (consumed.has(id) || ids.includes(id)) {
        duplicateGroupIdRefs.push(id);
        continue;
      }
      ids.push(id);
    }
    if (ids.length < 2) continue; // nothing left to combine; any single valid id falls through to pass-through

    let members = ids.map((id) => byId.get(id)!);

    // A document proves this capability, so it is document-backed: the
    // USER_PROVIDED members are dropped, not blended in (their claims would make
    // the VERIFIED group impure) and not passed through (that is how a skill
    // tag like "Budget & Asset Accountability" used to survive as its own
    // self-reported entry next to the evaluations that prove it). A lone
    // VERIFIED member left after the drop simply passes through unchanged.
    const verifiedMembers = members.filter((g) => g.verificationStatus === "VERIFIED");
    if (verifiedMembers.length > 0 && verifiedMembers.length < members.length) {
      splitForVerifiedSafety.push(ids);
      for (const g of members) {
        if (g.verificationStatus !== "VERIFIED") {
          consumed.add(g.groupId);
          droppedUserProvidedGroups.push(g);
        }
      }
      members = verifiedMembers;
    }
    if (members.length < 2) continue;

    for (const g of members) consumed.add(g.groupId);
    mergedGroups.push(mergeGroupSet(members));
    mergeInstructionsApplied++;
  }

  const passThrough = preliminaryGroups.filter((g) => !consumed.has(g.groupId));
  const groups = [...mergedGroups, ...passThrough];

  const accounted = new Set<string>([...consumed, ...passThrough.map((g) => g.groupId)]);
  const unaccountedGroupIds = preliminaryGroups.map((g) => g.groupId).filter((id) => !accounted.has(id));

  return {
    groups,
    mergeInstructionsApplied,
    invalidGroupIdRefs,
    duplicateGroupIdRefs,
    unaccountedGroupIds,
    splitForVerifiedSafety,
    droppedUserProvidedGroups,
  };
}

export type BatchTiming = {
  batchIndex: number;
  itemsIn: number;
  groupsOut: number;
  elapsedMs: number;
  // Observability: was this batch's response cut off, salvaged, or lost entirely?
  stopReason: string | null;
  wasTruncated: boolean;
  salvagedCount: number | null;
  candidateCount: number | null;
  error: string | null; // non-null => the whole batch threw; its itemsIn produced zero groups
};

// Per-sourceDocId accounting of whether Step 2's output actually represents its
// input. "Represented" = the docId appears as a group's primarySourceDocId or in
// its corroboratingDocIds. claimCountDelta is a SOFT signal only (the grouping
// model returns representative claim strings, not an exhaustive list), logged for
// visibility but never used as a pass/fail gate — missingDocIds is the reliable
// signal, and missingOfficialDocIds (a verified document with zero footprint) is
// the hard-failure trigger.
export type GroupingCoverage = {
  inputItemCount: number;
  inputDocIds: string[];
  officialInputDocIds: string[];
  representedClaimCount: number;
  representedDocIds: string[];
  unknownOutputDocIds: string[]; // cited by a group but not present in the input (model error)
  missingDocIds: string[];
  missingOfficialDocIds: string[];
  missingItemCountByDocId: Record<string, number>;
  claimCountDelta: number;
};

export function computeGroupingCoverage(
  evidenceItems: EvidenceItem[],
  groups: EvidenceGroup[]
): GroupingCoverage {
  const itemCountByDocId = new Map<string, number>();
  const officialDocIds = new Set<string>();
  for (const item of evidenceItems) {
    itemCountByDocId.set(item.sourceDocId, (itemCountByDocId.get(item.sourceDocId) ?? 0) + 1);
    if (item.isOfficialDocument) officialDocIds.add(item.sourceDocId);
  }
  const inputDocIds = [...itemCountByDocId.keys()];
  const inputDocIdSet = new Set(inputDocIds);

  const representedDocIdSet = new Set<string>();
  let representedClaimCount = 0;
  for (const g of groups) {
    if (Array.isArray(g?.claims)) representedClaimCount += g.claims.length;
    if (g?.primarySourceDocId) representedDocIdSet.add(g.primarySourceDocId);
    if (Array.isArray(g?.corroboratingDocIds)) {
      for (const id of g.corroboratingDocIds) if (id) representedDocIdSet.add(id);
    }
  }

  const missingDocIds = inputDocIds.filter((id) => !representedDocIdSet.has(id));
  const missingOfficialDocIds = missingDocIds.filter((id) => officialDocIds.has(id));
  const missingItemCountByDocId: Record<string, number> = {};
  for (const id of missingDocIds) missingItemCountByDocId[id] = itemCountByDocId.get(id) ?? 0;

  return {
    inputItemCount: evidenceItems.length,
    inputDocIds,
    officialInputDocIds: [...officialDocIds],
    representedClaimCount,
    representedDocIds: [...representedDocIdSet].filter((id) => inputDocIdSet.has(id)),
    unknownOutputDocIds: [...representedDocIdSet].filter((id) => !inputDocIdSet.has(id)),
    missingDocIds,
    missingOfficialDocIds,
    missingItemCountByDocId,
    claimCountDelta: representedClaimCount - evidenceItems.length,
  };
}

export type GroupingResult = {
  groups: EvidenceGroup[];
  batchCount: number;
  batchTimings: BatchTiming[];
  mergeRan: boolean;
  mergeElapsedMs: number | null;
  preliminaryGroupCount: number;
  mergeStopReason: string | null;
  // true only if the merge PLAN itself failed to parse or hit max_tokens - with
  // the plan being O(merges) not O(evidence) this should never happen; kept as a
  // tripwire. On a true here the merge is skipped and preliminary groups pass through.
  mergeWasTruncated: boolean;
  mergePlanParseOk: boolean;
  mergeInstructionsApplied: number;
  mergePlanInvalidGroupIdRefs: string[];
  mergePlanDuplicateGroupIdRefs: string[];
  mergePlanUnaccountedGroupIds: string[];
  mergePlanSplitForVerifiedSafety: string[][];
  // Self-reported groups dropped because a document group proves the same capability.
  mergePlanDroppedUserProvidedGroupIds: string[];
  failedBatchIndexes: number[];
  truncatedBatchIndexes: number[];
  coverageAfterGrouping: GroupingCoverage;
  coverageAfterMerge: GroupingCoverage | null;
};

export async function runEvidenceGrouping(
  evidenceItems: EvidenceItem[],
  anthropic: Anthropic,
  correctionInstruction?: string
): Promise<GroupingResult> {
  if (evidenceItems.length === 0) {
    return {
      groups: [], batchCount: 0, batchTimings: [], mergeRan: false, mergeElapsedMs: null,
      preliminaryGroupCount: 0, mergeStopReason: null, mergeWasTruncated: false,
      mergePlanParseOk: true, mergeInstructionsApplied: 0, mergePlanInvalidGroupIdRefs: [],
      mergePlanDuplicateGroupIdRefs: [], mergePlanUnaccountedGroupIds: [], mergePlanSplitForVerifiedSafety: [], mergePlanDroppedUserProvidedGroupIds: [],
      failedBatchIndexes: [], truncatedBatchIndexes: [],
      coverageAfterGrouping: computeGroupingCoverage(evidenceItems, []), coverageAfterMerge: null,
    };
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
        max_tokens: GROUPING_BATCH_MAX_TOKENS,
        temperature: 0.2,
        messages: [{ role: "user", content: buildEvidenceGroupingPrompt(batch, correctionInstruction) }],
      });

      const stopReason = batchResponse.stop_reason ?? null;
      const rawBatch = batchResponse.content.find((b) => b.type === "text")?.text ?? "[]";
      const { groups, wasTruncated, salvagedCount, candidateCount } = parseEvidenceGroupsFromRaw(rawBatch);
      const tagged = groups.map((g) => ({ ...g, groupId: "b" + batchIdx + "-" + (g.groupId ?? "g?") }));
      if (stopReason === "max_tokens" || wasTruncated) {
        console.error(
          "[capabilityPipeline][step2a][batch" + batchIdx + "] TRUNCATED/SALVAGED - trailing groups may be lost." +
          " stopReason=" + stopReason + " wasTruncated=" + wasTruncated +
          " candidateObjects=" + candidateCount + " salvagedGroups=" + salvagedCount +
          " keptGroups=" + tagged.length + " itemsIn=" + batch.length
        );
      }
      return {
        groups: tagged,
        timing: { batchIndex: batchIdx, itemsIn: batch.length, groupsOut: tagged.length, elapsedMs: Date.now() - start, stopReason, wasTruncated, salvagedCount, candidateCount, error: null },
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[capabilityPipeline][step2a][batch" + batchIdx + "] Sonnet error - " + batch.length + " evidence items from this batch produced ZERO groups", err);
      return {
        groups: [],
        timing: { batchIndex: batchIdx, itemsIn: batch.length, groupsOut: 0, elapsedMs: Date.now() - start, stopReason: null, wasTruncated: false, salvagedCount: null, candidateCount: null, error: message },
      };
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

  const failedBatchIndexes = batchTimings.filter((t) => t.error !== null).map((t) => t.batchIndex);
  const truncatedBatchIndexes = batchTimings.filter((t) => t.stopReason === "max_tokens" || t.wasTruncated).map((t) => t.batchIndex);
  if (failedBatchIndexes.length > 0) {
    console.error("[capabilityPipeline][step2a] " + failedBatchIndexes.length + " batch(es) failed entirely: " + JSON.stringify(failedBatchIndexes));
  }

  const coverageAfterGrouping = computeGroupingCoverage(evidenceItems, preliminaryGroups);
  if (coverageAfterGrouping.missingDocIds.length > 0) {
    console.error(
      "[capabilityPipeline][step2a] COVERAGE GAP after grouping " +
      JSON.stringify({
        missingDocIds: coverageAfterGrouping.missingDocIds,
        missingOfficialDocIds: coverageAfterGrouping.missingOfficialDocIds,
        missingItemCountByDocId: coverageAfterGrouping.missingItemCountByDocId,
        claimCountDelta: coverageAfterGrouping.claimCountDelta,
      })
    );
  }

  let finalGroups: EvidenceGroup[] = preliminaryGroups;
  let mergeRan = false;
  let mergeElapsedMs: number | null = null;
  let mergeStopReason: string | null = null;
  let mergeWasTruncated = false;
  let mergePlanParseOk = true;
  let mergeInstructionsApplied = 0;
  let mergePlanInvalidGroupIdRefs: string[] = [];
  let mergePlanDuplicateGroupIdRefs: string[] = [];
  let mergePlanUnaccountedGroupIds: string[] = [];
  let mergePlanSplitForVerifiedSafety: string[][] = [];
  let mergePlanDroppedUserProvidedGroups: EvidenceGroup[] = [];

  if (preliminaryGroups.length > 1) {
    mergeRan = true;
    const mergeStart = Date.now();
    try {
      const mergeResponse = await anthropic.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 16000,
        temperature: 0.2,
        messages: [{ role: "user", content: buildEvidenceGroupMergePrompt(preliminaryGroups) }],
      });

      mergeStopReason = mergeResponse.stop_reason ?? null;
      const rawMerge = mergeResponse.content.find((b) => b.type === "text")?.text ?? "";
      const { plan, parseOk } = parseMergePlan(rawMerge);
      mergePlanParseOk = parseOk;
      mergeWasTruncated = !parseOk || mergeStopReason === "max_tokens";

      if (mergeStopReason === "max_tokens" || !parseOk) {
        console.error(
          "[capabilityPipeline][step2b] MERGE PLAN unparseable or truncated - no merges applied, preliminary groups pass through." +
          " stopReason=" + mergeStopReason + " parseOk=" + parseOk +
          " rawLength=" + rawMerge.length + " preliminaryGroups=" + preliminaryGroups.length
        );
      }

      // Apply the plan in code - deterministic, cannot truncate.
      const applied = applyMergePlan(preliminaryGroups, plan);
      finalGroups = applied.groups;
      mergeInstructionsApplied = applied.mergeInstructionsApplied;
      mergePlanInvalidGroupIdRefs = applied.invalidGroupIdRefs;
      mergePlanDuplicateGroupIdRefs = applied.duplicateGroupIdRefs;
      mergePlanUnaccountedGroupIds = applied.unaccountedGroupIds;
      mergePlanSplitForVerifiedSafety = applied.splitForVerifiedSafety;
      mergePlanDroppedUserProvidedGroups = applied.droppedUserProvidedGroups;
      mergeElapsedMs = Date.now() - mergeStart;

      if (applied.invalidGroupIdRefs.length > 0 || applied.duplicateGroupIdRefs.length > 0) {
        console.error(
          "[capabilityPipeline][step2b] MERGE PLAN issues (instruction(s) partially skipped, no evidence lost) " +
          JSON.stringify({
            invalidGroupIdRefs: applied.invalidGroupIdRefs,
            duplicateGroupIdRefs: applied.duplicateGroupIdRefs,
          })
        );
      }
      if (applied.droppedUserProvidedGroups.length > 0) {
        console.log(
          "[capabilityPipeline][step2b] self-reported groups absorbed by document-backed groups (dropped): " +
          JSON.stringify(
            applied.droppedUserProvidedGroups.map((g) => ({
              groupId: g.groupId,
              claims: g.claims,
              mergeSet: applied.splitForVerifiedSafety.find((set) => set.includes(g.groupId)) ?? null,
            }))
          )
        );
      }
      if (applied.unaccountedGroupIds.length > 0) {
        console.error(
          "[capabilityPipeline][step2b] INVARIANT VIOLATION - preliminary groups neither merged nor passed through: " +
          JSON.stringify(applied.unaccountedGroupIds)
        );
      }
      console.log(
        "[capabilityPipeline][step2b] merge plan applied" +
        " preliminaryGroups=" + preliminaryGroups.length +
        " mergeInstructionsApplied=" + mergeInstructionsApplied +
        " finalGroups=" + finalGroups.length
      );
    } catch (err) {
      mergeElapsedMs = Date.now() - mergeStart;
      console.error("[capabilityPipeline][step2b] Sonnet error, falling back to unmerged preliminary groups", err);
      finalGroups = preliminaryGroups;
    }
  }

  // A dropped self-reported group's evidence is represented by the document
  // group that proves the same capability, so it counts as covered - otherwise
  // every absorbed skill tag would read as lost evidence.
  const coverageAfterMerge = mergeRan
    ? computeGroupingCoverage(evidenceItems, [...finalGroups, ...mergePlanDroppedUserProvidedGroups])
    : null;
  if (coverageAfterMerge && coverageAfterMerge.missingDocIds.length > coverageAfterGrouping.missingDocIds.length) {
    console.error(
      "[capabilityPipeline][step2b] MERGE INTRODUCED A COVERAGE GAP " +
      JSON.stringify({ before: coverageAfterGrouping.missingDocIds, after: coverageAfterMerge.missingDocIds })
    );
  }

  return {
    groups: finalGroups,
    batchCount: evidenceBatches.length,
    batchTimings,
    mergeRan,
    mergeElapsedMs,
    preliminaryGroupCount: preliminaryGroups.length,
    mergeStopReason,
    mergeWasTruncated,
    mergePlanParseOk,
    mergeInstructionsApplied,
    mergePlanInvalidGroupIdRefs,
    mergePlanDuplicateGroupIdRefs,
    mergePlanUnaccountedGroupIds,
    mergePlanSplitForVerifiedSafety,
    mergePlanDroppedUserProvidedGroupIds: mergePlanDroppedUserProvidedGroups.map((g) => g.groupId),
    failedBatchIndexes,
    truncatedBatchIndexes,
    coverageAfterGrouping,
    coverageAfterMerge,
  };
}

// ---------- Step 3: plain-language naming pass ----------

// Returned verbatim (and only) when Step 3 determines a requested correction can't be
// satisfied by renaming/rewording alone - see buildStep3Prompt's correction section.
export const STEP3_ESCALATE_SENTINEL = "ESCALATE_REQUIRED";

export function buildStep3Prompt(evidenceGroups: EvidenceGroup[], correctionInstruction?: string): string {
  const correctionSection = correctionInstruction
    ? `\n\nA candidate has requested this correction: "${correctionInstruction}"\n\nApply it ONLY if it is a pure naming, wording, or description change to one or more of the entries below, using exactly the groups and verificationStatus values already provided, unchanged.\n\nDo NOT apply it, and do not attempt any workaround, if satisfying it would require: merging or splitting a group, moving a claim between groups, adding or removing a claim, or changing any entry's verificationStatus (VERIFIED vs USER_PROVIDED) — those can only be corrected by re-running extraction and grouping, not by renaming. If the correction requires any of those, respond with EXACTLY this single line and nothing else, no other text: ${STEP3_ESCALATE_SENTINEL}`
    : "";

  return `You are a career specialist. Convert these evidence groups into plain-business-language capability entries for a hiring manager.

EVIDENCE GROUPS:
${JSON.stringify(evidenceGroups, null, 2)}

CRITICAL ANONYMITY RULE: This platform never discloses candidate identity to an employer, at any tier. Refer to them only as "this candidate" or using they/them/their pronouns - never he/him, she/her, or any gendered term, and never their name or initials. Never name a past employer, unit, command, branch of service, or rank. Never state exact dates, years of service, tenure length, or age. Never name a specific country, region, or named operation/deployment. Never mention a publication or other named authored work. Security clearance is the one exception: if it applies, state it as a capability fact ("holds an active security clearance," or the specific level if given) and never name who granted, sponsored, or investigated it. The candidate's identity must remain fully hidden at all times - describe capability only, never who they are or where/when they did it. This applies to BOTH the capability name and the description of every single entry - the evidence groups above may themselves contain identifying detail (organization names, dates, locations, rank); your output must not, no matter how specific the source material is.

Do not frame the candidate as coming from outside ordinary work, or as entering a new sector, transitioning, adjusting, acclimating, or bridging into anything, and do not describe their experience as needing translation or conversion - it is simply their experience. Do not use the words "civilian" or "military" anywhere in your output, and do not use any wording that implies the candidate must earn their way into normal employment or prove they can do work they have already done.

Your ONLY jobs are:
1. Write a plain-business-language capability NAME and DESCRIPTION for each group.
2. Order entries: leadership/management/people-development first, technical/operational/domain-specific second, education/certifications/credentials last.
3. Apply the exact verification tag from each group's verificationStatus field.

Naming rules:
- Names must be immediately understandable to a general business audience with no specialized background.
- NO duty titles, school names, coded specialty designators, "Jumpmaster," "insertion," "joint fires," "signature reduction," or any term whose meaning depends on knowing a specific occupational, trade, or industry context in the NAME. These belong in the description as supporting evidence, described generically per the rules above - not named.
- Descriptions carry the SCALE and NATURE of what was done - team size, budget, scope of responsibility, complexity, outcome - never who did it, where, or when. Do not name a specific organization, school, unit, command, country, region, or operation, and do not state a rank, branch, or date/tenure figure, even as supporting context for the name.
- Do NOT re-decide grouping or verification — use exactly the groups and verificationStatus values provided.
- Do NOT limit the count. Every group gets its own entry.
- Do NOT split or merge groups.
- Every capability name must describe what the person can DO or DELIVER, not a role title, credential name, or jargon term.${correctionSection}

Output ONLY the capability entries in this exact format (no ## heading, no preamble, no trailing text):

[groupId] (CATEGORY) **[Capability Name]** [VERIFIED]: [Description]

or

[groupId] (CATEGORY) **[Capability Name]** [USER_PROVIDED]: [Description]

Use each group's own "groupId" value from the EVIDENCE GROUPS above, exactly as given, in square brackets at the very start of the line.

CATEGORY is exactly one of LEADERSHIP (leadership/management/people-development), TECHNICAL (technical/operational/domain-specific), or CREDENTIAL (education/certifications/credentials), in parentheses - the same three-way split used for ordering.

One entry per line. No numbered lists. No bullets. No category headers in the output.`;
}

// Order rank for the (CATEGORY) tag Step 3 emits. Lets entries produced by
// several parallel Step 3 calls be merged back into the leadership / technical /
// credentials order a single call would have produced. An entry with no tag
// (older output, or the model omitted it) sorts with TECHNICAL, the middle band.
export type Step3Category = "LEADERSHIP" | "TECHNICAL" | "CREDENTIAL";
export const STEP3_CATEGORY_RANK: Record<Step3Category, number> = { LEADERSHIP: 0, TECHNICAL: 1, CREDENTIAL: 2 };

// Maps whatever the model put in the parentheses to a category by prefix,
// case-insensitive: "CREDENTIALS", "Leadership", "technical skills" all map;
// anything unrecognized is null (sorted as TECHNICAL). The tag only affects
// ordering - it must never be the reason an entry fails to parse.
function toStep3Category(tag: string | undefined): Step3Category | null {
  const t = (tag ?? "").trim().toUpperCase();
  if (t.startsWith("LEADERSHIP")) return "LEADERSHIP";
  if (t.startsWith("TECHNICAL")) return "TECHNICAL";
  if (t.startsWith("CREDENTIAL")) return "CREDENTIAL";
  return null;
}

// "sentinel" = the model deliberately returned STEP3_ESCALATE_SENTINEL (only
// possible when a correction is in play - see buildStep3Prompt's correctionSection).
// "count_mismatch" = the response wasn't the sentinel, but didn't produce a valid,
// well-formed entry for every input group - this is the case a truncated or
// malformed response falls into, and missingGroupIds/parsedCount/expectedCount/
// rawTextLength exist specifically so a caller can log what actually happened
// instead of the previous bare "not fully parseable" with no data behind it.
// matchedEntries carries whatever entries WERE successfully parsed before the
// mismatch was detected - a "count_mismatch" from a completed (non-truncated)
// response is usually a handful of groups the model simply skipped, not a sign
// the other entries are unreliable, so the caller can retry just the missing
// groupIds and merge the result with these rather than redoing all of them.
export type Step3EscalateReason = "sentinel" | "count_mismatch";
export type Step3Result =
  | {
      kind: "escalate";
      reason: Step3EscalateReason;
      rawTextLength: number;
      parsedCount: number;
      expectedCount: number;
      missingGroupIds: string[];
      matchedEntries: CapabilityEntry[];
      // groupId of each matchedEntries[i], same order - CapabilityEntry itself
      // carries no groupId (it is the persisted shape), but a targeted retry has
      // to know which evidence group produced a given entry.
      matchedEntryGroupIds: string[];
      matchedEntryCategories: Array<Step3Category | null>;
      duplicateGroupIds: string[];
    }
  | {
      kind: "entries";
      capabilitySummary: string;
      capabilityEntries: CapabilityEntry[];
      entryGroupIds: string[];
      entryCategories: Array<Step3Category | null>;
      duplicateGroupIds: string[];
    };

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
    return {
      kind: "escalate",
      reason: "sentinel",
      rawTextLength: trimmed.length,
      parsedCount: 0,
      expectedCount: evidenceGroups.length,
      missingGroupIds: [],
      matchedEntries: [],
      matchedEntryGroupIds: [],
      matchedEntryCategories: [],
      duplicateGroupIds: []
    };
  }

  const capabilityEntries: CapabilityEntry[] = [];
  const entryGroupIds: string[] = [];
  const entryCategories: Array<Step3Category | null> = [];
  const duplicateGroupIds: string[] = [];
  const prosLines: string[] = [];
  const matchedGroupIds = new Set<string>();

  for (const line of raw.split("\n")) {
    // The (CATEGORY) tag is optional and matched loosely - any short
    // parenthetical right after the [groupId], whatever its spelling or case -
    // so a missing or garbled tag can never leave "(" at the start of `rest` and
    // fail the entry match below (which would drop the whole entry as a missing
    // group). It is stripped from the prose summary either way; toStep3Category
    // decides what, if anything, it means.
    const prefixMatch = line.match(/^\[([\w-]+)\]\s*(?:\(([^()*]{0,40})\)\s*)?(.*)$/);
    if (!prefixMatch) {
      prosLines.push(line);
      continue;
    }
    const [, groupId, category, rest] = prefixMatch;
    prosLines.push(rest);

    const entryMatch = rest.match(/^\*\*(.+?)\*\*\s*\[(VERIFIED|USER_PROVIDED)\]:\s*(.*)$/);
    if (!entryMatch) continue;
    const [, name, , description] = entryMatch;
    const group = evidenceGroups.find((g) => g.groupId === groupId);
    if (!group) continue;
    // A groupId the model emitted twice (seen 2026-09-30: one group split into
    // two differently-named entries) keeps only its first entry. Counting both
    // used to inflate the entry count - enough to mask a genuinely missing group
    // in the length check below, or to save a duplicate entry.
    if (matchedGroupIds.has(groupId)) {
      duplicateGroupIds.push(groupId);
      continue;
    }

    capabilityEntries.push({
      name: name.trim(),
      description: description.trim(),
      verificationStatus: group.verificationStatus,
      primaryDocLabel: resolveDocLabel(group.primarySourceDocId, storedDocs),
      primaryDocId: group.primarySourceDocId,
      corroboratingDocLabels: group.corroboratingDocIds.map((id) => resolveDocLabel(id, storedDocs))
    });
    matchedGroupIds.add(groupId);
    entryGroupIds.push(groupId);
    entryCategories.push(toStep3Category(category));
  }

  if (capabilityEntries.length !== evidenceGroups.length) {
    // Not every group produced a valid entry - not safely parseable. Escalate rather
    // than save a capability list that silently dropped or garbled some entries.
    return {
      kind: "escalate",
      reason: "count_mismatch",
      rawTextLength: raw.length,
      parsedCount: capabilityEntries.length,
      expectedCount: evidenceGroups.length,
      missingGroupIds: evidenceGroups.map((g) => g.groupId).filter((id) => !matchedGroupIds.has(id)),
      matchedEntries: capabilityEntries,
      matchedEntryGroupIds: entryGroupIds,
      matchedEntryCategories: entryCategories,
      duplicateGroupIds
    };
  }

  return { kind: "entries", capabilitySummary: prosLines.join("\n"), capabilityEntries, entryGroupIds, entryCategories, duplicateGroupIds };
}

// ---------- Identity-guard targeted retry ----------

// Plain-language correction per guard category, used to tell the model exactly
// what was wrong with a flagged phrase. Keyed by lib/employerTextGuard.ts's
// TextGuardCategory values (as plain strings, so this module stays free of a
// dependency on the guard). These instructions only describe how to REWRITE -
// the guard's detection rules are untouched, and every rewritten entry is
// re-scanned by the same guard before it can be kept.
const GUARD_CATEGORY_CORRECTIONS: Record<string, string> = {
  candidate_name: "Never include the candidate's name or initials. Refer to them only as \"this candidate\".",
  honorific_name: "Never use an honorific with a name (Mr./Ms./Dr. + name). Refer to them only as \"this candidate\".",
  gendered_pronoun: "Use \"this candidate\" or they/them/their only - no he/him/his/she/her.",
  military_rank: "Do not state any rank or rank title. Describe the level of responsibility instead (e.g. \"senior team leader\", \"led a team of 12\").",
  branch_of_service: "Do not name any branch of service, unit, command, or organization type. Describe the work itself generically.",
  clearance_sponsor_or_agency: "Do not name any government agency or organization. A security clearance may be stated as a capability fact, never who granted or sponsored it.",
  explicit_year: "Do not state any calendar year or date.",
  tenure_count: "Do not state any duration, tenure length, or number of years. Describe scope, scale, and outcomes instead.",
  publication_reference: "Do not mention any publication, book, article, or authored work.",
  outsider_framing: "Do not use the words \"military\" or \"civilian\", and do not frame the candidate as transitioning, bridging, translating, or entering a new sector. It is simply their experience.",
  recruiting_officer_term: "Do not say \"officer production\" or \"officer recruiting\". Say \"recruiting targets\" (e.g. \"exceeded annual recruiting targets by 34%\").",
  oversight_office: "Do not name an oversight office such as an inspector general. Say \"an external compliance audit\" or \"a formal external inspection\"."
};

export type GuardFlaggedPhrase = { category: string; match: string };

function formatGuardCorrections(flags: GuardFlaggedPhrase[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const f of flags) {
    const key = f.category + "\u0000" + f.match.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`   - "${f.match}" (${f.category}): ${GUARD_CATEGORY_CORRECTIONS[f.category] ?? "Remove this identifying detail."}`);
  }
  return lines.join("\n");
}

// Re-runs Step 3 for ONLY the entries the identity guard flagged, with the
// previous (rejected) output and the exact phrases that failed spelled out.
// Mirrors the missing-groupIds retry: the same buildStep3Prompt contract and
// the same parseStep3Response parse, so a retried entry is indistinguishable
// in shape from a first-pass entry and can be dropped straight back into place.
export function buildStep3GuardRetryPrompt(
  groups: EvidenceGroup[],
  flagged: Array<{ groupId: string; name: string; description: string; flags: GuardFlaggedPhrase[] }>
): string {
  const corrections = flagged
    .map((f) =>
      `[${f.groupId}] PREVIOUS OUTPUT (REJECTED):\n` +
      `   **${f.name}**: ${f.description}\n` +
      `   Phrases that caused the rejection - none of these may appear in your rewrite:\n` +
      formatGuardCorrections(f.flags)
    )
    .join("\n\n");

  return `${buildStep3Prompt(groups)}

CORRECTION REQUIRED - READ CAREFULLY:
A previous attempt at these exact entries was rejected by an automated identity check, because it contained identifying detail that must never reach an employer. Rewrite each entry below from its evidence group, following every rule above, and specifically removing each flagged phrase. The check is literal and case-insensitive: a flagged word must not appear anywhere in the rewrite in ANY sense - even where you mean it innocently (e.g. "major" meaning "large", "general" meaning "overall", "private" meaning "confidential") - so use a different word. Do not substitute an abbreviation, synonym, or paraphrase that still identifies the same thing (for example, replacing a rank with a different rank, or a branch name with its initials). Keep the capability itself - the scale, nature, and outcomes of the work - fully intact; only the identifying detail goes.

${corrections}

Produce exactly one entry for each groupId listed above, in the same output format.`;
}

// Targeted rewrite of one flagged free-text field (recommended_position,
// entry_point, future_positions, employer_summary). The text itself is the
// input - these fields have no per-group source to regenerate from - and the
// model is told to change only the flagged wording and return the same
// structure, so the field's content and formatting survive the correction.
export function buildGuardRewritePrompt(field: string, text: string, flags: GuardFlaggedPhrase[]): string {
  return `The following text was written for a hiring manager on an anonymous hiring platform, but an automated identity check rejected it because it contains identifying or disallowed wording. This platform never discloses a candidate's identity to an employer.

Rewrite it with the minimum change needed to remove every flagged phrase below. The check is literal and case-insensitive: a flagged word must not appear anywhere in the rewrite in ANY sense - even where you mean it innocently (e.g. "major" meaning "large", "general" meaning "overall") - so use a different word. Keep everything else - meaning, structure, markdown formatting, headings, bold titles, line breaks, and length - as close to the original as possible. Do not substitute an abbreviation, synonym, or paraphrase that still identifies the same thing. Refer to the candidate only as "this candidate" or they/them/their.

FLAGGED PHRASES:
${formatGuardCorrections(flags)}

FIELD: ${field}

ORIGINAL TEXT:
<<<
${text}
>>>

Output ONLY the rewritten text - no preamble, no explanation, no delimiters.`;
}

// ---------- Step 4: recommended position / entry point / future positions ----------

export type Step4Input = {
  desiredRole: string;
  // Structured direction when the candidate has set one; desiredRole and
  // workPreference are the legacy single-field fallback.
  direction?: CandidateDirection | null;
  workPreference: string;
  skills: string;
  summary: string;
  capabilitySummary: string;
};

export function buildStep4Prompt(input: Step4Input): string {
  return `An applicant has provided the following profile information:

${input.direction ? `- Where they want to go (context, not evidence):\n${formatDirectionForPrompt(input.direction).split("\n").map((l) => `  ${l}`).join("\n")}` : `- Desired role/industry: ${input.desiredRole}\n- Work preference: ${input.workPreference}`}
- Skills they listed: ${input.skills}
- Background summary they wrote: ${input.summary}

Their verified capability profile is:

${input.capabilitySummary}

Write about a capable professional deciding what job to pursue next. Describe what they have done and can do as accomplished fact. Do not frame them as coming from outside ordinary work, or as entering a new sector, transitioning, adjusting, acclimating, or bridging into anything, and do not describe their experience as needing translation or conversion - it is simply their experience. Do not use the words "civilian" or "military" anywhere in your output, and do not use any wording that implies the candidate must earn their way into normal employment or prove they can do work they have already done. A genuine gap may be named only as a specific missing item (a named tool, a named certification, a defined amount of on-the-job training), never as a vague category of unfamiliarity.

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

Assessment Mandate: Only recommend a stepping-stone or entry role if there is a genuine demonstrated gap between the candidate's overall capability tier and their stated desired role/industry. If the candidate's overall background already supports the seniority level of their recommended position, ENTRY_POINT should reflect an entry point AT that same tier (e.g. "Security Program Manager" or "Assistant Director of Security Operations"), not a generic junior role. Do not assume the candidate needs to prove themselves in a lesser role first.

Use this exact format:

**[Starting Role Title]**: [Two to three sentences explaining why this is the right entry point — what experience it builds, how it connects to their target role, and what makes it realistic to land now.]

## FUTURE_POSITIONS
List each role this applicant is realistically on track for as they gain experience and take on broader scope. Use this exact format. Do not use numbered lists, bullet points, or any other structure — only the bold-title format below:

CRITICAL ANONYMITY RULE: This platform never discloses candidate identity to an employer, at any tier. Refer to them only as "this candidate" or using they/them/their pronouns - never he/him, she/her, or any gendered term, and never their name or initials. Never name a past employer, unit, command, branch of service, or rank. Never state exact dates, years of service, tenure length, or age. Never name a specific country, region, or named operation/deployment. Never mention a publication or other named authored work. Security clearance is the one exception: if it applies, state it as a capability fact ("holds an active security clearance," or the specific level if given) and never name who granted, sponsored, or investigated it. The candidate's identity must remain fully hidden at all times - describe capability only, never who they are or where/when they did it.

**[Role Title]**: [Brief explanation of why they are on track for this role and what experience or track record positions them for it.]

List only roles that genuinely fit. No minimum or maximum number.

Respond with only the three sections above. No preamble, no closing remarks.`;
}

export type Step4ExtractionResult = {
  recommendedPosition: string;
  entryPoint: string;
  futurePositions: string;
  missingSections: string[];
};

// Validates that Step 4's response actually contains what buildStep4Prompt asked
// for, rather than trusting a 200 response at face value - a truncated response
// (stop_reason "max_tokens") produces exactly this shape: RECOMMENDED_POSITION
// populated, ENTRY_POINT/FUTURE_POSITIONS missing because the response was cut off
// before their headings were ever emitted, and extractSection correctly (per its
// own contract) returns "" for a heading it can't find - nothing throws.
//
// RECOMMENDED_POSITION and ENTRY_POINT are both mandatory single answers per the
// prompt ("State the single best..."), so a missing heading OR an empty one under a
// present heading is a failure for those two. FUTURE_POSITIONS is explicitly allowed
// to have no content ("List only roles that genuinely fit. No minimum or maximum
// number.") - only a missing heading counts as a failure there, since present-heading
// empty-content is the model correctly following that instruction, not truncation.
export function extractStep4Sections(positionsText: string): Step4ExtractionResult {
  const lower = positionsText.toLowerCase();
  const hasHeading = (heading: string) => lower.includes(`## ${heading}`.toLowerCase());

  const recommendedPosition = extractSection(positionsText, "RECOMMENDED_POSITION", "ENTRY_POINT");
  const entryPoint = extractSection(positionsText, "ENTRY_POINT", "FUTURE_POSITIONS");
  const futurePositions = extractSection(positionsText, "FUTURE_POSITIONS");

  const missingSections: string[] = [];
  if (!hasHeading("RECOMMENDED_POSITION") || !recommendedPosition) missingSections.push("RECOMMENDED_POSITION");
  if (!hasHeading("ENTRY_POINT") || !entryPoint) missingSections.push("ENTRY_POINT");
  if (!hasHeading("FUTURE_POSITIONS")) missingSections.push("FUTURE_POSITIONS");

  return { recommendedPosition, entryPoint, futurePositions, missingSections };
}

// ---------- Employer-facing summary ----------
//
// The employer summary is the ONLY capability content an employer ever sees,
// at every stage (decision 2026-10-22). It is written from the candidate's
// capability statements (falling back to capability entries only when no
// statements exist yet) plus their own summary and stated direction as
// context, in a fixed scannable shape:
//
//   ## HEADLINE      one line, who they are NOW and the value they bring
//   ## PROVEN_AT     3-5 bullets: "- **Lead phrase**: proof with a number"
//   ## THRIVES_IN    one line: role FAMILIES and work settings
//   ## GROWING_INTO  one line: where they are heading
//   ## GAP           optional, one line, a clear fixable gap
//
// Every identity / framing rule from the previous versions is unchanged.

export const EMPLOYER_SUMMARY_SYSTEM_PROMPT = `${GUIDING_PRINCIPLE}

You are a talent strategist writing employer-facing candidate summaries. Your audience is a hiring manager or HR director scanning many candidates. This platform never discloses candidate identity to an employer, at any tier - describe capability only, never identity. If a motivated reader could identify a specific individual from your output, the output is wrong. Use no pronouns where you can avoid them, and when you cannot, only they/them/their - never he/him, she/her, or any gendered term. Never use the candidate's name or initials. Never name a past employer, unit, command, or organization. Never state a branch of service (Army, Navy, Air Force, Marines, Coast Guard, Space Force) or a specific rank, grade, or title (e.g. Sergeant First Class, Green Beret, Colonel). Never state exact dates, years of service, tenure length, or age. Never name a specific country, region, or named operation/deployment - use general framing like "high-risk international environments". Never mention a publication, book, article, or other named authored work. Never use unit designations, coded specialty designators, operation names, service acronyms, or any jargon that requires insider context to understand. Write in plain business language a civilian hiring manager already uses.

Write about a capable professional applying for a job. Lead with who this person is NOW and where they are heading; the past is evidence, not identity. Describe what they have done and can do as accomplished fact. Do not frame the candidate as coming from outside ordinary work, entering a new sector, transitioning, adjusting, acclimating, or bridging into anything, and do not describe their experience as needing translation, conversion, or interpretation - it is simply their experience. Do not use the words "civilian" or "military" anywhere in the output, and do not use any wording that implies the candidate must earn their way into normal employment or prove they can do work they have already done.

Security clearance is the one exception to "describe capability only": if the source material states the candidate holds a security clearance with an expiration date, it may be reported as a capability fact with that date. Never name who granted, sponsored, or investigated it.

Let the numbers carry the proof. Never name a document type or its issuer, and never pad a line with a corroboration tail such as "corroborated across multiple performance reviews" or "documented in several reviews".

A genuine gap may be stated, but only as a specific, nameable, fixable missing item ("has not yet worked with a named tool or system," "would benefit from a specific named certification"); never as a vague category of unfamiliarity, which is unfalsifiable and diminishing. No filler language. No paragraphs. No em dashes or en dashes anywhere - use hyphens or commas.`;

export type EmployerSummaryStatement = { statement: string; proof: Array<{ text: string }> };

export type EmployerSummaryInput = {
  // Preferred source: the candidate's core capability statements.
  capabilityStatements?: EmployerSummaryStatement[] | null;
  // Fallback source (capability entries rendered as text) - used only when
  // there are no capability statements yet.
  capabilitySummary: string;
  // Context, not evidence: who they are now and where they want to go.
  selfSummary?: string | null;
  // Structured direction ("Where I'm heading"). When set it drives THRIVES IN
  // and GROWING INTO; desiredRoles / workPreference are the legacy fallback
  // for profiles that have not set one.
  direction?: CandidateDirection | null;
  desiredRoles?: string | null;
  workPreference?: string | null;
  isAlternateSummary: boolean;
  // Named tools and platforms from their documents (candidate_profiles.tools).
  tools?: string[] | null;
  // Every evidence claim on the profile, as text. Never sent to the model:
  // used only to verify the GAP line names nothing the evidence already shows.
  gapEvidence?: string | null;
};

export const EMPLOYER_SUMMARY_PROVEN_MIN = 3;
export const EMPLOYER_SUMMARY_PROVEN_MAX = 5;
// Hard block. The prompt asks for 12-17 words; this is only the ceiling.
export const EMPLOYER_SUMMARY_BULLET_MAX_WORDS = 22;
export const EMPLOYER_SUMMARY_HEADLINE_MAX_WORDS = 20; // "about 15 words"

// The evidence the summary is written from, as text. Exported so the format
// check can verify that every PROVEN AT number came from this text.
export function buildEmployerSummaryEvidence(input: EmployerSummaryInput): { source: "statements" | "entries"; text: string } {
  const statements = (input.capabilityStatements ?? []).filter((s) => s && s.statement);
  if (statements.length > 0) {
    return {
      source: "statements",
      text: statements.map((s) => `- ${s.statement}\n${s.proof.map((p) => `    - ${p.text}`).join("\n")}`).join("\n"),
    };
  }
  return { source: "entries", text: input.capabilitySummary };
}

// The individual facts the summary may draw a bullet from: each statement's
// sentence and each of its proof lines (or one capability entry when there are
// no statements).
// A PROVEN AT bullet's numbers must all come from ONE of these.
export function employerSummaryEvidenceUnits(input: EmployerSummaryInput): string[] {
  const statements = (input.capabilityStatements ?? []).filter((s) => s && s.statement);
  if (statements.length > 0) {
    return statements.flatMap((s) => [s.statement, ...s.proof.map((p) => p.text)]);
  }
  return input.capabilitySummary.split(/\n\s*\n/).map((u) => u.trim()).filter(Boolean);
}

export function buildEmployerSummaryUserPrompt(input: EmployerSummaryInput): string {
  const evidence = buildEmployerSummaryEvidence(input);
  const d = input.direction ?? null;
  const direction = [
    d ? formatDirectionForPrompt(d) : "",
    !d && input.desiredRoles ? `Roles they want: ${input.desiredRoles}` : "",
    !d && input.workPreference ? `Work preference: ${input.workPreference}` : "",
    input.selfSummary ? `Their own summary (context about current work and direction, NOT evidence - never quote it, never take a number from it): ${JSON.stringify(input.selfSummary)}` : "",
  ].filter(Boolean).join("\n");
  const families = d ? roleFamilyLabels(d) : [];
  const onlyThese = d?.scope === "only_these";
  const thrivesIn = d
    ? `One line: ${
        families.length > THRIVES_IN_MAX_FAMILIES
          ? `the 2 or 3 target role families from DIRECTION that the EVIDENCE supports best (never all of them; choose from ${families.map((f) => `"${f}"`).join(", ")})`
          : `the target role families from DIRECTION (${families.map((f) => `"${f}"`).join(", ")})`
      }, named in those words, then the work setting${d.travel === "occasional" || d.travel === "frequent" ? " and travel" : ""} ("${settingClause(d)}"), written naturally, e.g. "${families.slice(0, 2).join(", ").toLowerCase()}; ${settingClause(d)}${d.travel === "occasional" || d.travel === "frequent" ? " for partner meetings and events" : ""}". Do not add a context for travel that the evidence or DIRECTION does not support.${
        onlyThese
          ? ` They want ONLY these roles, so name them too: ${(d.titles ?? []).map((t) => `"${t}"`).join(", ")}.`
          : " Never a specific job title (no director, manager, officer, chief, or similar): they are open to related roles across these families."
      }`
    : `One line naming role FAMILIES and work settings, e.g. "operations leadership, business development, and program management; remote or hybrid". Never a single job title, unless DIRECTION says they want only one specific role.`;
  const growingInto = d
    ? `One line on where they are heading, built from the target role families and how they want to work${d.howIWantToWork ? ` ("${d.howIWantToWork}")` : ""}.${onlyThese ? "" : " No specific job title."}`
    : "One line on where they are heading, taken from their stated direction.";

  return `Write the employer-facing summary for this candidate. A hiring manager should be able to scan it in about ten seconds and know who this person is now, what they are proven at, where they would thrive, and where they are heading.

Output EXACTLY these sections with the "##" headings shown, in this order, and nothing before, between, or after them:

## HEADLINE
One line, about 15 words (never more than ${EMPLOYER_SUMMARY_HEADLINE_MAX_WORDS}): who this person is NOW and the value they bring an employer. Present tense. No job title. Say what they lead (teams, projects, programs), not a generic "operations leader".

## PROVEN_AT
${EMPLOYER_SUMMARY_PROVEN_MIN} to ${EMPLOYER_SUMMARY_PROVEN_MAX} bullets, one per line, each exactly in the form:
- **Lead phrase**: one line of proof
The lead phrase is 2-4 words in bold, followed by a colon, and names a transferable skill a business hires for (e.g. "Decision-making under pressure", "International logistics"), not the task. The proof contains at least one concrete number taken from the EVIDENCE below. Length: the lead phrase and the proof TOGETHER are 12 to 17 words, and never more than ${EMPLOYER_SUMMARY_BULLET_MAX_WORDS}; count every word of both before answering, and cut the proof rather than run over.
Choosing the bullets: pick by relevance to DIRECTION, never by how easy a fact is to quantify. First decide what the roles in DIRECTION are judged on, then pick the evidence that proves exactly that.
- When DIRECTION centers on leadership, trust, authority, or relationships, prefer evidence of judgment, decisions under pressure, leading and developing people, advising senior leaders, and building relationships or partnerships.
- Administrative facts (pay records, inventories, equipment or property accountability, paperwork or records tracking) appear only when DIRECTION is administrative or logistics work.
- Every bullet still needs a number from the EVIDENCE. If the most relevant capability has a number anywhere in its proof, use that number; do not swap in a less relevant fact because its number is cleaner.

## THRIVES_IN
${thrivesIn}${input.isAlternateSummary ? " Lead with the broader set of role families their strengths support, beyond their most direct experience." : ""}

## GROWING_INTO
${growingInto}

## GAP
Optional. Include it only if there is a clear, specific, fixable gap for the role families named in THRIVES_IN: one line naming it and what closes it, framed as the next skill to build. It must never name a tool, system, skill, or credential that appears in the EVIDENCE or in TOOLS AND SYSTEMS (no "no CRM experience" when they use Salesforce). Otherwise omit the heading entirely.

Rules:
- Present and direction first; the past is evidence, not identity.
- Plain civilian business language. Do not reuse jargon from the evidence. Preferred rewrites: "mission success rate" -> "success rate"; "high-threat movements" -> "time-critical moves" or "projects with zero room for error"; "allied nations" -> "partner countries" (or just the count); "multinational staff exercise" -> "international planning exercise".
${CIVILIAN_LANGUAGE_RULES.split("\n").map((l) => (l.startsWith("CIVILIAN") ? `- ${l}` : `  ${l}`)).join("\n")}
- Do not mention physical fitness or physical performance unless their direction is physical work.
- No paragraphs, no em dashes or en dashes, no sentence that names a past organization, place, date, or rank.
- Numbers come only from the EVIDENCE.
- Match the scale the evidence shows; never inflate it. The headline and every lead phrase claim no more than the numbers support: teams of 12 to 100 are teams, not "large organizations", and nothing is "large-scale", "enterprise", "organization-wide", or "major" unless the evidence says so.
- Name each function for what it is. Recruiting is recruiting (or talent acquisition), never sales or selling; training is training. Do not relabel past work to fit a desired role. A role family the person wants may still be named in THRIVES_IN or GROWING_INTO.
- No filler tails. Never end a line with phrases like "corroborated across multiple performance reviews", "documented across reviews", or "consistently recognized". The number is the proof.

DIRECTION:
${direction || "(not stated - infer the most natural direction from the evidence)"}

EVIDENCE (${evidence.source === "statements" ? "capability statements with their proof" : "capability profile"}):
${evidence.text}${
    input.tools && input.tools.length
      ? `\n\nTOOLS AND SYSTEMS THEY USE (named in their documents; shows familiarity, carries no numbers, never a PROVEN_AT bullet on its own):\n${input.tools.join(", ")}`
      : ""
  }`;
}

export type EmployerSummaryProvenItem = { lead: string; proof: string };

export type ParsedEmployerSummary =
  | {
      format: "v2";
      headline: string;
      provenAt: EmployerSummaryProvenItem[];
      thrivesIn: string;
      growingInto: string;
      gap: string | null;
    }
  | {
      // The 2026-09 BEST_FIT / STRENGTHS / GROWTH / GAP format. Rows written
      // in it keep rendering until they are regenerated.
      format: "v1";
      bestFit: string;
      strengths: string[];
      growth: string;
      gap: string | null;
    };

// Every leading list marker on a line ("- ", "• ", "- • ", "1. "), so a line
// the model double-marked never renders with two bullets. A single "*" is a
// marker; "**" opens the bold lead phrase and is kept.
const LIST_MARKERS = /^(?:(?:[-–—•·▪◦]|\*(?!\*))\s*|\d{1,2}[.)]\s+)+/;

function splitBullets(block: string): string[] {
  return block
    .split("\n")
    .map((line) => line.trim().replace(LIST_MARKERS, "").trim())
    .filter(Boolean);
}

// Splits "## NAME" sections into a map keyed by NAME (spaces read as
// underscores: "## PROVEN AT" is PROVEN_AT). Each section runs to the next
// heading of ANY name, so a section the model emits out of order, or a
// missing one, never swallows its neighbours.
function sectionMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const re = /^[ \t]*##[ \t]+([A-Za-z][A-Za-z _]*?)[ \t]*:?[ \t]*$/gm;
  const heads = [...text.matchAll(re)];
  heads.forEach((m, i) => {
    const key = m[1].trim().toUpperCase().replace(/\s+/g, "_");
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index ?? text.length : text.length;
    if (!map.has(key)) map.set(key, text.slice(start, end).trim());
  });
  return map;
}

function parseProvenItem(line: string): EmployerSummaryProvenItem {
  const m = line.match(/^\*\*(.+?)\*\*\s*[:.,-]?\s*(.*)$/);
  // A colon written inside the bold ("**Lead:**") belongs to the separator.
  return m ? { lead: m[1].trim().replace(/[:.,]$/, "").trim(), proof: m[2].trim() } : { lead: "", proof: line };
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();

// Parses either summary format. Returns null for anything else - in practice
// the original plain-paragraph summaries, which callers render as a paragraph.
export function parseEmployerSummary(text: string): ParsedEmployerSummary | null {
  if (!text) return null;

  const sections = sectionMap(text);

  if (sections.has("HEADLINE")) {
    const headline = oneLine(sections.get("HEADLINE") ?? "");
    const provenAt = splitBullets(sections.get("PROVEN_AT") ?? "").map(parseProvenItem);
    const thrivesIn = oneLine(sections.get("THRIVES_IN") ?? "");
    const growingInto = oneLine(sections.get("GROWING_INTO") ?? "");
    const gap = oneLine(sections.get("GAP") ?? "");
    if (!headline || provenAt.length === 0 || !thrivesIn) return null;
    return { format: "v2", headline, provenAt, thrivesIn, growingInto, gap: gap || null };
  }

  if (sections.has("BEST_FIT")) {
    const bestFit = (sections.get("BEST_FIT") ?? "").trim();
    const strengths = splitBullets(sections.get("STRENGTHS") ?? "");
    const growth = (sections.get("GROWTH") ?? "").trim();
    const gapRaw = (sections.get("GAP") ?? "").trim();
    if (!bestFit || strengths.length === 0 || !growth) return null;
    return { format: "v1", bestFit, strengths, growth, gap: gapRaw || null };
  }

  return null;
}

function wordCount(s: string): number {
  return s.split(/\s+/).filter(Boolean).length;
}

// Deterministic format check for a freshly generated summary. Every issue is
// phrased as an instruction so it can be fed straight back to the model.
// Trailing corroboration filler ("corroborated across multiple performance
// reviews"): adds words, not proof.
const SUMMARY_FILLER_TAIL =
  /\b(?:corroborated|documented|confirmed|validated|verified|noted|recognized|reflected|evidenced)\s+(?:across|in|by|through|over)\s+(?:multiple|several|many|numerous|repeated|consecutive|successive|\d+)\s+[\w\s-]*?(?:reviews?|evaluations?|assessments?|reports?|documents?|records?|sources?)\b/i;

// Format and fidelity issues in a v2 summary, as retry instructions.
export function checkEmployerSummaryFormat(text: string, input: EmployerSummaryInput): string[] {
  const issues: string[] = [];
  if (!/^##[ \t]+HEADLINE\b/.test(text.trim())) {
    issues.push("Text appears before ## HEADLINE. Output only the sections, starting with ## HEADLINE, with no preamble or explanation.");
  }
  if (/[–—]/.test(text)) issues.push("Contains an em dash or en dash; use hyphens or commas.");
  const parsed = parseEmployerSummary(text);
  if (!parsed || parsed.format !== "v2") {
    issues.push("Missing required sections: use exactly ## HEADLINE, ## PROVEN_AT, ## THRIVES_IN, ## GROWING_INTO (and optional ## GAP).");
    return issues;
  }
  if (!parsed.growingInto) issues.push("GROWING_INTO is empty; add one line on where they are heading.");
  if (wordCount(parsed.headline) > EMPLOYER_SUMMARY_HEADLINE_MAX_WORDS) {
    issues.push(`HEADLINE has ${wordCount(parsed.headline)} words; keep it to about 15.`);
  }
  const n = parsed.provenAt.length;
  if (n < EMPLOYER_SUMMARY_PROVEN_MIN || n > EMPLOYER_SUMMARY_PROVEN_MAX) {
    issues.push(`PROVEN_AT has ${n} bullets; write ${EMPLOYER_SUMMARY_PROVEN_MIN} to ${EMPLOYER_SUMMARY_PROVEN_MAX}.`);
  }
  const evidenceText = buildEmployerSummaryEvidence(input).text;
  parsed.provenAt.forEach((item, i) => {
    const label = `PROVEN_AT bullet ${i + 1}`;
    const leadWords = wordCount(item.lead);
    if (!item.lead || leadWords < 2 || leadWords > 4) issues.push(`${label} needs a bold 2-4 word lead phrase in the form "- **Lead phrase** proof".`);
    if (!/\d/.test(item.proof)) issues.push(`${label} needs a concrete number from the evidence.`);
    const total = wordCount(item.lead) + wordCount(item.proof);
    if (total > EMPLOYER_SUMMARY_BULLET_MAX_WORDS) {
      issues.push(
        `${label} has ${total} words counting the bold lead phrase; the hard limit is ${EMPLOYER_SUMMARY_BULLET_MAX_WORDS}. Cut at least ${total - 17} words from it (aim for 17 or fewer).`
      );
    }
    const unsourced = findUnsourcedNumbers(item.proof, [evidenceText]);
    if (unsourced.length > 0) issues.push(`${label} uses number(s) not in the evidence: ${unsourced.map((u) => u.raw).join(", ")}.`);
    // One fact per bullet, and shared results stay attributed.
    const bulletText = `${item.lead} ${item.proof}`;
    if (unsourced.length === 0 && extractNumbers(bulletText).length > 0) {
      const units = employerSummaryEvidenceUnits(input).filter((u) => allNumbersFrom(bulletText, u));
      if (units.length === 0 && extractNumbers(bulletText).length > 1) {
        issues.push(`${label} combines numbers from different facts; every number in a bullet must come from the same proof line. Keep one fact per bullet.`);
      } else if (units.length > 0 && !SHARED_ATTRIBUTION_WORDING.test(bulletText)) {
        // The fact this bullet came from: of the units that supply all its
        // numbers, the one sharing the most words with it (a number alone can
        // match an unrelated fact). On a tie, every tied unit must be shared.
        const words = (t: string) => new Set(t.toLowerCase().match(/[a-z]{4,}/g) ?? []);
        const bulletWords = words(bulletText);
        const scored = units.map((u) => ({ u, score: [...words(u)].filter((w) => bulletWords.has(w)).length }));
        const top = Math.max(...scored.map((x) => x.score));
        const source = scored.filter((x) => x.score === top).map((x) => x.u);
        const shared = (u: string) => SHARED_RESULT_MARKER.test(u) || /\b(?:help(?:s|ed|ing)?|contribut(?:ed|es|ing) to|as part of)\b/i.test(u);
        if (source.every(shared)) {
          issues.push(`${label} presents a shared (team- or contract-level) result as theirs alone; attribute it, e.g. "helped raise..." or "as one of two...".`);
        }
      }
    }
    const filler = item.proof.match(SUMMARY_FILLER_TAIL);
    if (filler) issues.push(`${label} ends in filler ("${filler[0]}"); cut it and let the number carry the proof.`);
  });
  // Scale and function fidelity apply to the claims (headline + proven at),
  // not to the role families the person wants (THRIVES_IN / GROWING_INTO).
  const claimText = [parsed.headline, ...parsed.provenAt.map((p) => `${p.lead} ${p.proof}`)].join("\n");
  const inflated = findScaleInflation(claimText, [evidenceText]);
  if (inflated.length > 0) {
    issues.push(`Inflates scale beyond the evidence: ${inflated.map((w) => `"${w}"`).join(", ")}. Describe the scope the numbers show (e.g. "teams of up to 100").`);
  }
  if (relabelsRecruitingAsSales(claimText, [evidenceText])) {
    issues.push('Calls recruiting work "sales". Name it as recruiting or talent acquisition.');
  }
  // GAP must be genuine: nothing it names may already be in the evidence or tools.
  if (parsed.gap) {
    const contradictions = findGapContradictions(parsed.gap, [evidenceText, input.gapEvidence ?? ""].join("\n"), input.tools ?? []);
    if (contradictions.length > 0) {
      issues.push(`GAP names something the evidence already shows: ${contradictions.join("; ")}. Name a different, genuine gap, or omit the GAP section.`);
    }
  }
  // Civilian language: setting words and "operation" as a countable noun
  // (lib/civilianLanguage.ts), anywhere in the summary.
  const settingHits = findSettingLanguage(text);
  if (settingHits.length > 0) {
    issues.push(`Uses wording that reveals the setting instead of the capability: ${describeSettingLanguage(settingHits)}.`);
  }
  // "operations leader", "operations and program leader", ...: generic.
  const genericHeadline = parsed.headline.match(/\boperations\b.*?\bleaders?\b/i);
  if (genericHeadline) {
    issues.push(`HEADLINE says "${genericHeadline[0]}"; say what they lead (teams, projects, programs), not a generic operations leader.`);
  }
  // Direction: THRIVES_IN is written from the selected role families, and
  // names a specific title only when the candidate wants only those roles.
  if (input.direction) {
    const labels = roleFamilyLabels(input.direction);
    const named = familiesNamedIn(parsed.thrivesIn, input.direction);
    if (named.length === 0) {
      issues.push(`THRIVES_IN must name at least one of the selected role families: ${labels.map((l) => `"${l}"`).join(", ")}.`);
    } else if (named.length > THRIVES_IN_MAX_FAMILIES) {
      issues.push(`THRIVES_IN names ${named.length} role families; name only the 2 or 3 the evidence supports best.`);
    }
    if (input.direction.workSetting === "open" && /(?:^|[;,]\s*)open\.?\s*$/i.test(parsed.thrivesIn.trim())) {
      issues.push('THRIVES_IN ends in "open"; write the work setting as "any work setting".');
    }
    if (input.direction.workSettingPreferred && !/\bprefer/i.test(parsed.thrivesIn)) {
      issues.push(`THRIVES_IN must say the work setting is preferred, not required ("${settingClause(input.direction)}").`);
    }
    const travelling = input.direction.travel === "occasional" || input.direction.travel === "frequent";
    if (travelling && !/\btravel/i.test(parsed.thrivesIn)) {
      issues.push(`THRIVES_IN must include their willingness to travel ("${settingClause(input.direction)}").`);
    }
    if (input.direction.travel === "none" && /\b(?:open to|willing to|available (?:for|to))\s+(?:\w+\s+)?travel/i.test(parsed.thrivesIn)) {
      issues.push("THRIVES_IN offers travel, but they are not willing to travel.");
    }
    if (input.direction.scope !== "only_these") {
      const titleWords = findTitleWords(parsed.thrivesIn);
      if (titleWords.length > 0) {
        issues.push(`THRIVES_IN names a specific job title (${titleWords.map((w) => `"${w}"`).join(", ")}); they are open to related roles, so name role families only.`);
      }
    }
  }
  return issues;
}

// The one gate every employer_summary write goes through (synthesis job,
// generate-capability-finalize, correct-capability). Returns the reasons the
// text may NOT be stored; empty means it may. A blocked summary is never
// written: the previous one stays, and the caller reports the failure. The
// identity guard is separate and runs too.
export function employerSummaryStoreBlockers(text: string, input: EmployerSummaryInput): string[] {
  if (!text || !text.trim()) return ["empty response"];
  return checkEmployerSummaryFormat(text, input);
}

export type EmployerSummaryGeneration = {
  text: string;
  stopReason: string | null;
  formatIssues: string[];
  attempts: number;
};

// One generation plus, while the format check fails, up to
// EMPLOYER_SUMMARY_FORMAT_RETRIES targeted retries, each naming the exact
// issues in the latest attempt. Returns the first clean attempt, else the one
// with the fewest issues. Throws on an API error (callers already report those).
export const EMPLOYER_SUMMARY_FORMAT_RETRIES = 2;
export async function generateEmployerSummary(
  anthropic: Anthropic,
  input: EmployerSummaryInput,
  model = "claude-sonnet-4-6"
): Promise<EmployerSummaryGeneration> {
  const userPrompt = buildEmployerSummaryUserPrompt(input);
  const call = async (content: string) => {
    const message = await anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: EMPLOYER_SUMMARY_SYSTEM_PROMPT,
      temperature: 0.2,
      messages: [{ role: "user", content }],
    });
    const text = (message.content.find((b) => b.type === "text") as { text?: string } | undefined)?.text?.trim() ?? "";
    return { text, stopReason: message.stop_reason ?? null };
  };

  const first = await call(userPrompt);
  const firstIssues = first.text ? checkEmployerSummaryFormat(first.text, input) : ["Empty response."];
  if (firstIssues.length === 0) return { ...first, formatIssues: [], attempts: 1 };

  let best = { ...first, formatIssues: firstIssues };
  let latest = best;
  let attempts = 1;
  for (let i = 0; i < EMPLOYER_SUMMARY_FORMAT_RETRIES; i++) {
    const retry = await call(
      `${userPrompt}\n\nYOUR PREVIOUS ANSWER (REJECTED):\n${latest.text}\n\nFix exactly these problems and return the full summary again in the same format:\n${latest.formatIssues.map((x) => `- ${x}`).join("\n")}`
    );
    attempts++;
    const retryIssues = retry.text ? checkEmployerSummaryFormat(retry.text, input) : ["Empty response."];
    latest = { ...retry, formatIssues: retryIssues };
    if (retryIssues.length <= best.formatIssues.length) best = latest;
    if (retryIssues.length === 0) break;
  }
  // GAP is optional. If the only thing still wrong is a GAP the evidence
  // contradicts, drop the GAP rather than lose the whole summary.
  if (best.formatIssues.length > 0 && best.formatIssues.every((i) => i.startsWith("GAP names"))) {
    const withoutGap = best.text.replace(/\n*^[ \t]*##[ \t]+GAP\b[\s\S]*?(?=^[ \t]*##[ \t]|(?![\s\S]))/m, "\n").trim();
    const issues = checkEmployerSummaryFormat(withoutGap, input);
    if (issues.length === 0) return { ...best, text: withoutGap, formatIssues: [], attempts };
  }
  return { ...best, attempts };
}
