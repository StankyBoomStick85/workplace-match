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
  // Per-document evidence cache, populated once at upload time (see
  // process-document/route.ts) so generate-capability never has to re-run
  // extraction for a document it's already extracted. Never used when a
  // correction is in progress - extraction behavior itself changes during a
  // correction (see buildExtractionPrompt), so cached evidence is invalid by
  // definition in that path and must always be bypassed.
  evidenceItems?: EvidenceItem[];
  evidenceStatus?: "pending" | "complete" | "failed";
  evidenceExtractedAt?: string;
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
// off. The criteria for what combines are unchanged from the previous prompt.
export function buildEvidenceGroupMergePrompt(groups: EvidenceGroup[]): string {
  return `You are reconciling preliminary capability groups produced independently from separate batches of evidence for the same job applicant. Some groups from different batches describe the exact same underlying capability (e.g. the same duty appearing in evidence from two different documents). Your job is to identify which groups should be combined.

PRELIMINARY GROUPS:
${JSON.stringify(groups, null, 2)}

Rules for deciding what combines:
- Combine two or more groups ONLY when they describe the exact same underlying capability — not merely a similar theme or domain.
- Two distinct capabilities must NOT be combined solely because they relate to a similar theme or domain.
- A group that does not clearly match another is left alone.

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
  splitForVerifiedSafety: string[][]; // merge sets where USER_PROVIDED members were pulled out rather than blended into VERIFIED
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
// group is either folded into a merge or passed through verbatim - nothing is
// dropped (see unaccountedGroupIds, an invariant that must stay empty).
export function applyMergePlan(preliminaryGroups: EvidenceGroup[], plan: MergePlan): MergePlanApplication {
  const byId = new Map(preliminaryGroups.map((g) => [g.groupId, g] as const));
  const invalidGroupIdRefs: string[] = [];
  const duplicateGroupIdRefs: string[] = [];
  const splitForVerifiedSafety: string[][] = [];
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

    // VERIFIED purity: never blend a self-reported-only (USER_PROVIDED) group into
    // a VERIFIED one. If the set mixes both, keep only the VERIFIED members in the
    // merge; the USER_PROVIDED members are left un-consumed and pass through.
    const verifiedMembers = members.filter((g) => g.verificationStatus === "VERIFIED");
    if (verifiedMembers.length > 0 && verifiedMembers.length < members.length) {
      splitForVerifiedSafety.push(ids);
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
      mergePlanDuplicateGroupIdRefs: [], mergePlanUnaccountedGroupIds: [], mergePlanSplitForVerifiedSafety: [],
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
      mergeElapsedMs = Date.now() - mergeStart;

      if (applied.invalidGroupIdRefs.length > 0 || applied.duplicateGroupIdRefs.length > 0 || applied.splitForVerifiedSafety.length > 0) {
        console.error(
          "[capabilityPipeline][step2b] MERGE PLAN issues (instruction(s) partially skipped, no evidence lost) " +
          JSON.stringify({
            invalidGroupIdRefs: applied.invalidGroupIdRefs,
            duplicateGroupIdRefs: applied.duplicateGroupIdRefs,
            splitForVerifiedSafety: applied.splitForVerifiedSafety,
          })
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

  const coverageAfterMerge = mergeRan ? computeGroupingCoverage(evidenceItems, finalGroups) : null;
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

Your ONLY jobs are:
1. Write a plain-business-language capability NAME and DESCRIPTION for each group.
2. Order entries: leadership/management/people-development first, technical/operational/domain-specific second, education/certifications/credentials last.
3. Apply the exact verification tag from each group's verificationStatus field.

Naming rules:
- Names must be immediately understandable to a general business audience with no specialized background.
- NO duty titles, school names, coded specialty designators, "Jumpmaster," "insertion," "joint fires," "signature reduction," or any term whose meaning depends on knowing a specific occupational, trade, or industry context in the NAME. These belong in the description as supporting evidence.
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

// "sentinel" = the model deliberately returned STEP3_ESCALATE_SENTINEL (only
// possible when a correction is in play - see buildStep3Prompt's correctionSection).
// "count_mismatch" = the response wasn't the sentinel, but didn't produce a valid,
// well-formed entry for every input group - this is the case a truncated or
// malformed response falls into, and missingGroupIds/parsedCount/expectedCount/
// rawTextLength exist specifically so a caller can log what actually happened
// instead of the previous bare "not fully parseable" with no data behind it.
export type Step3EscalateReason = "sentinel" | "count_mismatch";
export type Step3Result =
  | {
      kind: "escalate";
      reason: Step3EscalateReason;
      rawTextLength: number;
      parsedCount: number;
      expectedCount: number;
      missingGroupIds: string[];
    }
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
    return {
      kind: "escalate",
      reason: "sentinel",
      rawTextLength: trimmed.length,
      parsedCount: 0,
      expectedCount: evidenceGroups.length,
      missingGroupIds: []
    };
  }

  const capabilityEntries: CapabilityEntry[] = [];
  const prosLines: string[] = [];
  const matchedGroupIds = new Set<string>();

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
    matchedGroupIds.add(groupId);
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
      missingGroupIds: evidenceGroups.map((g) => g.groupId).filter((id) => !matchedGroupIds.has(id))
    };
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

export const EMPLOYER_SUMMARY_SYSTEM_PROMPT = `You are a talent strategist writing employer-facing candidate summaries. Your audience is a hiring manager or HR director. This platform never discloses candidate identity to an employer, at any tier - describe capability only, never identity. If a motivated reader could identify a specific individual from your output, the output is wrong. Write in third person using only they/them/their pronouns - never he/him, she/her, or any gendered term. Never use the candidate's name or initials. Never name a past employer, unit, command, or organization. Never state a branch of service (Army, Navy, Air Force, Marines, Coast Guard, Space Force) or a specific rank, grade, or title (e.g. Sergeant First Class, Green Beret, Colonel). Never state exact dates, years of service, tenure length, or age (no "20 years," no "since 2005" - use relative framing like "an extended career" or "many years" only if duration matters, otherwise omit it). Never name a specific country, region, or named operation/deployment - use general framing like "high-risk international environments" instead of "50+ countries" or a named campaign. Never mention a publication, book, article, or other named authored work. Never use job titles, unit designations, coded specialty designators, operation names, service acronyms, or any jargon that requires insider context to understand. Write in plain business language a hiring manager already uses.

Write about a capable professional applying for a job. Describe what they have done and can do as accomplished fact. Do not frame the candidate as coming from outside ordinary work, entering a new sector, transitioning, adjusting, acclimating, or bridging into anything, and do not describe their experience as needing translation, conversion, or interpretation - it is simply their experience. Do not use the words "civilian" or "military" anywhere in the output, and do not use any wording that implies the candidate must earn their way into normal employment or prove they can do work they have already done.

Security clearance is the one exception to "describe capability only": if the source material states the candidate holds a security clearance, report it as a capability fact - "holds an active security clearance" or, if a specific level is given, name that level (e.g. "holds an active Top Secret clearance"). Never name who granted, sponsored, or investigated it - no agency, department, or branch may appear anywhere near the clearance mention. Workplace Match does not verify clearances; it reports only what the candidate stated and what their documents corroborate.

When the source material indicates a capability was corroborated by more than one document or source, describe it as a corroboration count, never by naming the document type or its issuer - "documented across multiple supervisor evaluations" is correct, "verified by Army NCOERs" is not, because naming the document type itself identifies the branch.

Focus on what this person can do and the scale at which they have done it (team size, budget, scope of responsibility are fine when phrased generically) and why an employer should be interested. Be specific and factual about capability. A genuine gap may be stated, but only as a specific, nameable missing item ("has not yet worked with a named tool or system," "would benefit from a specific named certification"); never as a vague category of unfamiliarity, which is unfalsifiable and diminishing. No filler language.`;

export type EmployerSummaryInput = {
  capabilitySummary: string;
  recommendedPosition: string;
  entryPoint: string;
  isAlternateSummary: boolean;
};

export function buildEmployerSummaryUserPrompt(input: EmployerSummaryInput): string {
  const leadIn = input.isAlternateSummary
    ? `Lead with the strengths that make this candidate competitive for a broader set of roles than their most recent title suggests - name those roles explicitly. Use their most direct experience as supporting detail in the second half.\n\nStructure the summary in three parts:\n1. What this person can do right now and what specific role they are best suited for today - use a real job title, not a tier label\n2. Whether a specific, nameable gap exists (a particular certification or tool) and what it would take to close it - omit this part entirely if there is no specific gap\n3. Where this person can realistically grow within your organization or industry given their trajectory`
    : `Structure the summary in three parts:\n1. What this person can do right now and what specific role they are best suited for today - use a real job title, not a tier label\n2. Whether a specific, nameable gap exists (a particular certification or tool) and what it would take to close it - omit this part entirely if there is no specific gap\n3. Where this person can realistically grow within your organization or industry given their trajectory`;

  return `Based on the following candidate profile sections, write a compelling employer-facing paragraph of 200-300 words (up to 1,500 characters) for a hiring manager. This platform never discloses candidate identity to an employer, at any tier - describe capability only. If a motivated reader could identify a specific individual from your output, the output is wrong.

Write about a capable professional applying for a job, and describe what they have done and can do as accomplished fact. Do not frame the candidate as coming from outside ordinary work, entering or breaking into a sector, transitioning, adjusting, acclimating, or bridging into anything, and do not describe their experience as needing translation or conversion - it is simply their experience. Do not use the words "civilian" or "military" anywhere in the output, and do not use any wording that implies the candidate has to earn their way into normal employment or prove they can do work they have already done.

Use they/them/their pronouns throughout - never he/him, she/her, or any gendered term. Do not include the candidate's name or initials. Do not name a past employer, unit, command, or organization. Do not state a branch of service or a specific rank, grade, or title. Do not state exact dates, years of service, tenure length, or age - omit duration entirely unless it is essential, in which case use relative framing ("an extended career") rather than a number. Do not name a specific country, region, or named operation/deployment - describe the type of environment generically instead (e.g. "high-risk international environments"). Do not mention a publication, book, article, or other named authored work.

Security clearance is the one exception: if the source material states the candidate holds a security clearance, report it as a capability fact - "holds an active security clearance," or the specific level if one is given (e.g. "holds an active Top Secret clearance"). Never name who granted, sponsored, or investigated it - no agency, department, or branch may appear near the clearance mention.

If the source material indicates a capability was corroborated by more than one document or source, describe it as a corroboration count, never by naming the document type or issuer - "documented across multiple supervisor evaluations" is correct, "verified by Army NCOERs" is not, because the document type itself identifies the branch.

Do not use generic experience tier labels such as "entry level," "junior," "mid-level," or "senior." Instead, use specific role titles that reflect actual capability.

${leadIn}

Write in the business-impact language a hiring manager already uses. Do not reuse jargon from the source material. Never frame the summary in a way that diminishes what the candidate has built. Do not use job titles, unit names, operation names, service acronyms, or any term that requires insider context to understand.

A genuine gap may be stated, but only as a specific, nameable missing item - "has not yet worked with a named tool or system," "would benefit from a specific named certification." Never state a gap as a vague category of unfamiliarity (for example "needs exposure to standard industry systems" or "requires sector context"); that phrasing is unfalsifiable and diminishing and is not allowed.

If any identifying detail (name, employer, branch, rank, clearance sponsor/agency, exact dates, country, publication) appears in the source material below, omit it from your output entirely - describe only what the capability demonstrates, never who held it or where it happened.

CAPABILITY PROFILE:
${input.capabilitySummary}

RECOMMENDED POSITION:
${input.recommendedPosition}

ENTRY POINT:
${input.entryPoint}`;
}
