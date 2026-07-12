import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";
import Anthropic from "@anthropic-ai/sdk";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Extracts complete top-level {...} objects from a (possibly truncated) JSON array string.
// Tracks brace depth and quoted-string state so nested arrays/objects inside each
// top-level object (e.g. EvidenceGroup's "claims" array) don't throw off matching.
function extractBalancedJsonObjects(raw: string): string[] {
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

// Step 2 processes evidence in batches so a single Sonnet call never has to hold
// and group hundreds of items at once. Tune here if batches still truncate.
const EVIDENCE_BATCH_SIZE = 150;

function buildEvidenceGroupingPrompt(items: EvidenceItem[]): string {
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
}

function buildEvidenceGroupMergePrompt(groups: EvidenceGroup[]): string {
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

// Shared JSON.parse + salvage logic for any Sonnet call expected to return EvidenceGroup[]
// (used by both the per-batch grouping calls and the cross-batch merge call).
function parseEvidenceGroupsFromRaw(raw: string): {
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
      // EvidenceGroup nests a "claims" array, so a flat /\{[^{}]*\}/g regex isn't
      // reliable here — use the brace-depth/string-aware scanner instead.
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
    .select("capability_tags, summary, document_metadata")
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

  // --- Step 2: Cross-document grouping pass (chunked + merge) ---
  const t5 = Date.now();
  console.log("[generate-capability][timing] step2 START t5=" + t5 + " delta=" + (t5 - t4) + "ms evidenceCount=" + allEvidenceItems.length);

  let evidenceGroups: EvidenceGroup[] = [];

  if (allEvidenceItems.length > 0) {
    // --- Step 2a: chunked grouping ---
    const evidenceBatches: EvidenceItem[][] = [];
    for (let i = 0; i < allEvidenceItems.length; i += EVIDENCE_BATCH_SIZE) {
      evidenceBatches.push(allEvidenceItems.slice(i, i + EVIDENCE_BATCH_SIZE));
    }
    console.log("[generate-capability][timing] step2a START batchCount=" + evidenceBatches.length + " batchSize=" + EVIDENCE_BATCH_SIZE);

    const groupBatch = async (batch: EvidenceItem[], batchIdx: number): Promise<EvidenceGroup[]> => {
      const tBatchStart = Date.now();
      try {
        const batchResponse = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 8192,
          temperature: 0.2,
          messages: [{ role: "user", content: buildEvidenceGroupingPrompt(batch) }],
        });

        const rawBatch = batchResponse.content.find(b => b.type === "text")?.text ?? "[]";
        const { groups, wasTruncated, candidateCount, salvagedCount } = parseEvidenceGroupsFromRaw(rawBatch);
        const lostCount = candidateCount !== null && salvagedCount !== null ? candidateCount - salvagedCount : 0;

        if (wasTruncated && candidateCount !== null) {
          console.log("[generate-capability][step2a][batch" + batchIdx + "] salvage attempt: found " + candidateCount + " candidate objects in raw output, parsed " + salvagedCount + " successfully");
        }

        const tBatchEnd = Date.now();
        console.log("[generate-capability][timing] step2a[batch" + batchIdx + "] END delta=" + (tBatchEnd - tBatchStart) + "ms evidenceIn=" + batch.length + " groupsOut=" + groups.length + " stop_reason=" + batchResponse.stop_reason);
        console.log("[generate-capability][step2a][batch" + batchIdx + "] truncated=" + wasTruncated + " recovered=" + groups.length + (wasTruncated ? " lost=" + lostCount + " (via fallback)" : "") + " stop_reason=" + batchResponse.stop_reason);

        if (wasTruncated && groups.length === 0) {
          console.error("[generate-capability][step2a][batch" + batchIdx + "] JSON parse failed raw=" + rawBatch.slice(0, 300));
        }

        // Prefix groupIds so they stay unique across batches going into the merge pass.
        return groups.map(g => ({ ...g, groupId: "b" + batchIdx + "-" + (g.groupId ?? "g?") }));
      } catch (err) {
        console.error("[generate-capability][step2a][batch" + batchIdx + "] Sonnet error, skipping batch", err);
        return [];
      }
    };

    const batchResults = await Promise.allSettled(
      evidenceBatches.map((batch, idx) => groupBatch(batch, idx))
    );

    const preliminaryGroups: EvidenceGroup[] = [];
    batchResults.forEach((result, idx) => {
      if (result.status === "fulfilled") {
        preliminaryGroups.push(...result.value);
      } else {
        console.error("[generate-capability][step2a][batch" + idx + "] batch promise rejected, skipping batch", result.reason);
      }
    });

    const t5a = Date.now();
    console.log("[generate-capability][timing] step2a complete t5a=" + t5a + " delta=" + (t5a - t5) + "ms preliminaryGroupCount=" + preliminaryGroups.length);

    // --- Step 2b: cross-batch merge pass ---
    if (preliminaryGroups.length > 1) {
      try {
        const mergeResponse = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 8192,
          temperature: 0.2,
          messages: [{ role: "user", content: buildEvidenceGroupMergePrompt(preliminaryGroups) }],
        });

        const rawMerge = mergeResponse.content.find(b => b.type === "text")?.text ?? "[]";
        const tMergeEnd = Date.now();
        console.log("[generate-capability][timing] step2b END t=" + tMergeEnd + " delta=" + (tMergeEnd - t5a) + "ms rawLen=" + rawMerge.length + " groupCount=" + (rawMerge.match(/"groupId"/g) ?? []).length);

        const { groups: mergedGroups, wasTruncated: wasTruncatedMerge, candidateCount: candidateCountMerge, salvagedCount: salvagedCountMerge } = parseEvidenceGroupsFromRaw(rawMerge);
        const lostCountMerge = candidateCountMerge !== null && salvagedCountMerge !== null ? candidateCountMerge - salvagedCountMerge : 0;

        if (wasTruncatedMerge && candidateCountMerge !== null) {
          console.log("[generate-capability][step2b] salvage attempt: found " + candidateCountMerge + " candidate objects in raw output, parsed " + salvagedCountMerge + " successfully");
        }

        console.log("[generate-capability][step2b] truncated=" + wasTruncatedMerge + " recovered=" + mergedGroups.length + (wasTruncatedMerge ? " lost=" + lostCountMerge + " (via fallback)" : "") + " stop_reason=" + mergeResponse.stop_reason);

        if (wasTruncatedMerge && mergedGroups.length === 0) {
          console.error("[generate-capability][step2b] JSON parse failed raw=" + rawMerge.slice(0, 300));
        }

        if (mergedGroups.length === 0) {
          console.error("[generate-capability][step2b] MERGE FAILURE: groupCount=0 after all fallbacks from preliminaryGroupCount=" + preliminaryGroups.length + " — falling back to unmerged preliminary groups");
          evidenceGroups = preliminaryGroups;
        } else {
          console.log("[generate-capability][step2b] merge summary: preliminaryGroupCount=" + preliminaryGroups.length + " finalGroupCount=" + mergedGroups.length + " merged=" + (preliminaryGroups.length - mergedGroups.length));
          evidenceGroups = mergedGroups;
        }
      } catch (err) {
        console.error("[generate-capability][step2b] Sonnet error, falling back to unmerged preliminary groups", err);
        evidenceGroups = preliminaryGroups;
      }
    } else if (preliminaryGroups.length === 1) {
      console.log("[generate-capability][step2b] SKIPPED merge pass (only 1 preliminary group, nothing to merge)");
      evidenceGroups = preliminaryGroups;
    } else {
      console.error("[generate-capability][step2] EVIDENCE GROUPING FAILURE: groupCount=0 after all batches from evidenceCount=" + allEvidenceItems.length + " — Step 3 will be skipped and the capability profile will be empty");
    }
  }

  const t5b = Date.now();
  console.log("[generate-capability][timing] step2 complete t5b=" + t5b + " delta=" + (t5b - t5) + "ms groupCount=" + evidenceGroups.length);

  // --- Phase 1 handoff: save grouped evidence for Phase 2 to pick up ---
  const { error: updateError } = await adminClient
    .from("candidate_profiles")
    .update({
      pending_evidence_groups: evidenceGroups,
      capability_generation_status: "groups_ready"
    })
    .eq("user_id", user.id);

  if (updateError) {
    console.error("[generate-capability] Failed to save pending evidence groups", updateError);
    return NextResponse.json({ error: "Failed to save evidence groups." }, { status: 500 });
  }

  // Temporary debug gate: when set, Phase 1 still saves pending_evidence_groups as
  // normal but tells the frontend not to auto-chain into Phase 2, so the raw groups
  // can be inspected via Supabase SQL before finalize overwrites/clears them.
  const skipAutoFinalize = process.env.SKIP_AUTO_FINALIZE === "true";

  const tEnd = Date.now();
  console.log("[generate-capability][timing] phase1 complete tEnd=" + tEnd + " totalDelta=" + (tEnd - t0) + "ms evidenceCount=" + allEvidenceItems.length + " groupCount=" + evidenceGroups.length + " skipAutoFinalize=" + skipAutoFinalize);

  return NextResponse.json({
    success: true,
    status: "groups_ready",
    evidenceCount: allEvidenceItems.length,
    groupCount: evidenceGroups.length,
    skipAutoFinalize
  });
}
