// Tier 1 capability statements - Phase 1 synthesis.
//
// Turns a candidate's evidence groups (Step 2 output, pending_evidence_groups)
// into 3-12 core capability statements, each backed by 2-4 quantified proof
// lines, plus a separate list of niche skills. The model writes; code decides
// what stands (lib/capabilityStatementChecks.ts for counts / citations /
// number provenance / evidence basis, lib/statementGuard.ts for the expanded
// identity and jargon guard). Anything that fails goes back to the model in a
// targeted retry naming exactly what was wrong - the same pattern as the Step 3
// identity-guard retry in generate-capability-finalize - and only the failing
// statements are regenerated.
//
// Phase 1: run on demand from an admin route or the comparison script only.
// Not chained into normal generation, and nothing here touches employer views.

import type Anthropic from "@anthropic-ai/sdk";
import type { EvidenceGroup, StoredDoc } from "@/lib/capabilityPipeline";
import { getCivilianDocLabel } from "@/lib/documentLabels";
import {
  CORE_MAX,
  CORE_MIN,
  checkCoreStatement,
  checkNicheCapability,
  withEvidenceBasis,
  type CheckGroup,
  type CoreStatement,
  type NicheCapability,
  type StatementIssue,
} from "@/lib/capabilityStatementChecks";
import { STATEMENT_GUARD_CORRECTIONS, scanStatementText, type StatementGuardViolation } from "@/lib/statementGuard";
import { TRANSLATION_GLOSSARY, formatGlossaryForPrompt, matchGlossaryEntries, type GlossaryEntry } from "@/lib/translationGlossary";

// The model the rest of the pipeline uses for its language passes today. Used
// until a model is chosen from the Phase 1 comparison.
export const DEFAULT_SYNTHESIS_MODEL = "claude-sonnet-4-6";

export const SYNTHESIS_MAX_TOKENS = 32000;
export const SYNTHESIS_RETRY_ATTEMPTS = 2;

export type UncertainTerm = { term: string; assumedMeaning: string; reason: string };

export type SynthesisModelOutput = {
  core: CoreStatement[];
  niche: NicheCapability[];
  uncertainTerms: UncertainTerm[];
};

export type ItemFailure = {
  kind: "core" | "niche";
  item: CoreStatement | NicheCapability;
  issues: StatementIssue[];
  guardViolations: StatementGuardViolation[];
};

export type ModelCallRecord = {
  phase: "initial" | `retry_${number}`;
  model: string;
  stopReason: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  elapsedMs: number;
  parseOk: boolean;
  error: string | null;
};

export type SynthesisResult = {
  status: "ok" | "insufficient" | "failed";
  model: string;
  generatedAt: string;
  core: CoreStatement[];
  niche: NicheCapability[];
  uncertainTerms: UncertainTerm[];
  // Items the model produced that never passed the checks, with the reasons.
  // Kept for review only - never persisted as statements.
  rejected: ItemFailure[];
  // Every failure seen along the way, including ones a retry fixed.
  failureLog: Array<{ attempt: string; failures: ItemFailure[] }>;
  calls: ModelCallRecord[];
  notes: string[];
};

// ---------- prompt ----------

type PromptGroup = {
  groupId: string;
  verificationStatus: EvidenceGroup["verificationStatus"];
  source: string;
  claims: string[];
};

function toPromptGroups(groups: EvidenceGroup[], storedDocs: StoredDoc[]): PromptGroup[] {
  const sourceLabel = (docId: string) => {
    if (docId === "profile-self-reported") return "Self-reported by the person";
    const doc = storedDocs.find((d) => d.id === docId);
    return doc ? getCivilianDocLabel({ label: doc.label, contentType: doc.contentType }) : "Supporting document";
  };
  return groups.map((g) => ({
    groupId: g.groupId,
    verificationStatus: g.verificationStatus,
    source: sourceLabel(g.primarySourceDocId),
    claims: g.claims,
  }));
}

export function buildSynthesisPrompt(promptGroups: PromptGroup[], glossary: GlossaryEntry[] = TRANSLATION_GLOSSARY): string {
  return `You are writing the capability statements a hiring manager will read about one person. Your job is to turn what this person has DONE into what they CAN DO and what they are capable of, in the plain language any hiring manager already uses.

THE CORE RULE: TRANSLATE, DON'T STRIP.
- Never repeat a specialist term from the evidence. That is listing, and a hiring manager outside the field cannot read it.
- Never delete what the term means. That is stripping, and it throws away the scope and stakes that make the person valuable.
- Carry the meaning across in plain words, keeping the scope. Example: "Team Sergeant on an ODA" becomes "directs day-to-day operations, people, and equipment for a 12-person team that works independently far from support" - not "Team Sergeant", and not a vague "team member".

READING THE EVIDENCE
- The evidence can come from any field or background. Use your own knowledge to understand any role, title, rank, organization, credential, or document.
- The GLOSSARY below is a short list of corrections for terms where general knowledge is wrong or ambiguous. When a term in the evidence matches a glossary entry (by term or alias), the glossary is authoritative and overrides your own understanding. Entries marked [applies to: ...] only apply in that organizational context.
- Scope depends on the organization. A title or rank means different things in different organizations; translate the scope for the organization the evidence actually describes.
- Each evidence group has a verificationStatus: VERIFIED means an official document backs it (performance reviews, service records, certifications); USER_PROVIDED means the person reported it. Self-reported evidence counts fully as evidence - just never describe it as documented or evaluated by someone else.
- When you are not sure what a term means or how large its scope is, make your best translation and also list the term in uncertainTerms.

WHAT TO PRODUCE

1. "core": 3 to 12 capability statements.
   - Each is a CONCLUSION drawn ACROSS the evidence: something this person can do that shows up in more than one place. Never a restatement of one award, rating, course, appointment, or event.
   - Plain present tense, no subject, no pronouns: "Directs ...", "Builds ...", "Keeps ...". Never "this candidate", never they/he/she.
   - One sentence, specific about scope and stakes, readable in five seconds.
   - Strongest first. Fewer strong statements beat many thin ones; a thin profile ships with as few as 3.
   - Specialized skills (see "niche") never go here.

2. Every core statement has 2 to 4 "proof" lines. Each proof line:
   - Contains at least one concrete number, taken from the claims of the groups it cites.
   - Lists the groupIds it draws from in "groupIds" (exact ids from the evidence).
   - Across one statement's proof lines, at least 2 different evidence groups are cited.
   - Numbers come ONLY from the cited claims. Allowed: rounding, unit changes, a range built from two claims ("top 3-5%" from a "top 3%" claim and a "top 5%" claim), writing a spelled-out number as digits, and the "Facts you may state" of a glossary entry whose term appears in the cited claims. Never add numbers up into totals, never compute percentages, averages, or counts of your own, never estimate. Round dollar amounts to 2 significant figures ($1,000,000 -> $1M; $3,500 -> $3.5K).
   - Shows how strong the evidence is through wording alone, e.g. "ranked #2 of 6 peers by an independent senior evaluator" or "across annual performance reviews". No badges, check marks, or labels like "verified". Never claim documentation or third-party evaluation for USER_PROVIDED evidence.

3. "niche": specialized skills - for example demolitions, precision marksmanship, parachute operations, a foreign language, fire support coordination, and every glossary entry marked NICHE that the evidence supports. These never go in core and are never dropped.
   - "statement": what the person can do with the skill, same style as core.
   - "applicability": plain-word tags for where the skill matters to an employer (e.g. "construction blasting", "mining", "international business", "range safety").
   - "proof": 1 to 4 proof lines under the same rules (the two-group rule does not apply to niche).

4. "uncertainTerms": every term you were unsure how to translate - the term, the meaning you assumed, and why you were unsure. Empty array if none.

NEVER APPEARS ANYWHERE IN THE OUTPUT (identity and jargon - the person is anonymous to employers):
- The person's name or initials; any pronoun.
- Any rank or pay grade; any branch of service; the words military, civilian, veteran, enlisted, NCO, noncommissioned, sergeant, warrant, battalion, soldier, troops, special operations, Green Beret, embassy; "company" used as a unit.
- Award, medal, badge, or tab names (state a count only, e.g. "6 formal commendations for performance"); school, course, or qualification names; specialty codes; unit names, designators, or command areas; evaluation document type names (say "annual performance reviews"); operation or exercise names.
- Any location: country, state, region, base, or installation. Describe the environment instead ("austere international settings", "high-threat environments").
- Calendar years and dates; years of service or tenure length; publications or books.
- Transition framing (no "transitioning", "bridging", "translating experience", "new sector").
- Exception: a time-limited fact such as a security clearance may be stated, and must carry its expiration date; never say who granted it and never call it permanent.

GLOSSARY (authoritative corrections when a term matches):
${formatGlossaryForPrompt(glossary)}

EVIDENCE GROUPS:
${JSON.stringify(promptGroups, null, 1)}

Return only the JSON object.`;
}

const PROOF_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text", "groupIds"],
  properties: {
    text: { type: "string" },
    groupIds: { type: "array", items: { type: "string" } },
  },
};

export const SYNTHESIS_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["core", "niche", "uncertainTerms"],
  properties: {
    core: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "proof"],
        properties: { statement: { type: "string" }, proof: { type: "array", items: PROOF_SCHEMA } },
      },
    },
    niche: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["statement", "applicability", "proof"],
        properties: {
          statement: { type: "string" },
          applicability: { type: "array", items: { type: "string" } },
          proof: { type: "array", items: PROOF_SCHEMA },
        },
      },
    },
    uncertainTerms: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["term", "assumedMeaning", "reason"],
        properties: { term: { type: "string" }, assumedMeaning: { type: "string" }, reason: { type: "string" } },
      },
    },
  },
};

function formatIssues(f: ItemFailure): string {
  const lines: string[] = [];
  for (const issue of f.issues) {
    lines.push(`   - ${issue.code}${issue.proofIndex !== undefined ? ` (proof line ${issue.proofIndex + 1})` : ""}: ${issue.detail}`);
  }
  const seen = new Set<string>();
  for (const v of f.guardViolations) {
    const key = v.category + "\u0000" + v.match.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`   - "${v.match}" (${v.category}): ${STATEMENT_GUARD_CORRECTIONS[v.category] ?? "Remove this identifying detail."}`);
  }
  return lines.join("\n");
}

export function buildSynthesisRetryPrompt(
  basePrompt: string,
  accepted: { core: CoreStatement[]; niche: NicheCapability[] },
  failures: ItemFailure[],
  extraCoreWanted: number
): string {
  const failedCore = failures.filter((f) => f.kind === "core");
  const failedNiche = failures.filter((f) => f.kind === "niche");
  const describe = (list: ItemFailure[]) =>
    list
      .map((f, i) => `#${i + 1} PREVIOUS OUTPUT (REJECTED):\n${JSON.stringify(f.item)}\n   Why it was rejected:\n${formatIssues(f)}`)
      .join("\n\n");

  return `${basePrompt}

CORRECTION REQUIRED - READ CAREFULLY:
A previous attempt was checked by code. Some items passed and are already accepted; others were rejected for the exact reasons listed. The checks are literal: a flagged word must not appear anywhere in the rewrite in any sense, and every number must be traceable to the claims of the groups that proof line cites. Fix each rejected item by rewriting it from the evidence - keep the capability, change what was wrong. If an item cannot be fixed honestly (for example, no cited claim has a number for that point), replace it with a different, well-supported item instead, or omit it.

ALREADY ACCEPTED (do not repeat these or restate their substance):
${JSON.stringify(accepted)}

REJECTED CORE STATEMENTS (${failedCore.length}):
${failedCore.length ? describe(failedCore) : "(none)"}

REJECTED NICHE ITEMS (${failedNiche.length}):
${failedNiche.length ? describe(failedNiche) : "(none)"}

In "core", return one replacement for each rejected core statement, in the same order${extraCoreWanted > 0 ? `, plus up to ${extraCoreWanted} additional new core statement(s) so the profile reaches at least ${CORE_MIN} - only if the evidence genuinely supports them` : ""}. In "niche", return one replacement for each rejected niche item, in the same order. Return only these replacements - not the accepted items. "uncertainTerms" may list any new uncertain terms.`;
}

// ---------- model call ----------

// Models whose request surface takes sampling parameters and no effort
// setting (the 4.x family the existing pipeline runs on). Everything newer
// runs with thinking on and effort set instead; temperature is rejected there.
function isLegacySamplingModel(model: string): boolean {
  return /^claude-(?:sonnet|haiku|opus)-4-/.test(model);
}

type RawCall = { text: string; record: ModelCallRecord };

async function callModel(anthropic: Anthropic, model: string, prompt: string, phase: ModelCallRecord["phase"]): Promise<RawCall> {
  const start = Date.now();
  const params = {
    model,
    max_tokens: SYNTHESIS_MAX_TOKENS,
    messages: [{ role: "user" as const, content: prompt }],
    output_config: {
      format: { type: "json_schema" as const, schema: SYNTHESIS_OUTPUT_SCHEMA },
      ...(isLegacySamplingModel(model) ? {} : { effort: "high" as const }),
    },
    ...(isLegacySamplingModel(model) ? { temperature: 0.2 } : {}),
  };
  try {
    // Streamed: a long synthesis on a thinking model can run past the SDK's
    // non-streaming timeout.
    const message = await anthropic.messages.stream(params).finalMessage();
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return {
      text,
      record: {
        phase,
        model: message.model ?? model,
        stopReason: message.stop_reason ?? null,
        inputTokens: message.usage?.input_tokens ?? null,
        outputTokens: message.usage?.output_tokens ?? null,
        elapsedMs: Date.now() - start,
        parseOk: false,
        error: null,
      },
    };
  } catch (err) {
    return {
      text: "",
      record: {
        phase, model, stopReason: null, inputTokens: null, outputTokens: null,
        elapsedMs: Date.now() - start, parseOk: false,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

export function parseSynthesisOutput(raw: string): SynthesisModelOutput | null {
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const obj = tryParse(raw.trim()) ?? tryParse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!obj || typeof obj !== "object") return null;
  const asProof = (p: unknown) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return {
      text: typeof o.text === "string" ? o.text : "",
      groupIds: Array.isArray(o.groupIds) ? o.groupIds.filter((x): x is string => typeof x === "string") : [],
    };
  };
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    core: arr(obj.core).map((c: Record<string, unknown>) => ({
      statement: typeof c?.statement === "string" ? c.statement : "",
      proof: arr(c?.proof).map(asProof),
    })),
    niche: arr(obj.niche).map((n: Record<string, unknown>) => ({
      statement: typeof n?.statement === "string" ? n.statement : "",
      applicability: arr(n?.applicability).filter((x): x is string => typeof x === "string"),
      proof: arr(n?.proof).map(asProof),
    })),
    uncertainTerms: arr(obj.uncertainTerms).map((u: Record<string, unknown>) => ({
      term: String(u?.term ?? ""),
      assumedMeaning: String(u?.assumedMeaning ?? ""),
      reason: String(u?.reason ?? ""),
    })),
  };
}

// ---------- validation ----------

export function buildCheckContext(groups: EvidenceGroup[], glossary: GlossaryEntry[] = TRANSLATION_GLOSSARY) {
  const groupsById = new Map<string, CheckGroup>(groups.map((g) => [g.groupId, g]));
  // A proof line's numbers may come from its cited claims, plus the allowed
  // facts of any glossary entry whose term appears in those claims (e.g. the
  // "12 people" team size when a cited claim names the team).
  const sourceTextsFor = (ids: string[]) => {
    const claims = ids.flatMap((id) => groupsById.get(id)?.claims ?? []);
    const facts = matchGlossaryEntries(claims.join("\n"), glossary).flatMap((e) => e.allowedFacts ?? []);
    return [...claims, ...facts];
  };
  return { groupsById, sourceTextsFor };
}

function guardItem(item: CoreStatement | NicheCapability, knownFullName: string | null): StatementGuardViolation[] {
  const texts = [item.statement, ...item.proof.map((p) => p.text), ...("applicability" in item ? item.applicability : [])];
  return texts.flatMap((t) => scanStatementText(t, { knownFullName }));
}

export function validateItem(
  kind: "core" | "niche",
  item: CoreStatement | NicheCapability,
  ctx: ReturnType<typeof buildCheckContext>,
  knownFullName: string | null
): ItemFailure | null {
  const issues = kind === "core" ? checkCoreStatement(item as CoreStatement, ctx) : checkNicheCapability(item as NicheCapability, ctx);
  const guardViolations = guardItem(item, knownFullName);
  return issues.length || guardViolations.length ? { kind, item, issues, guardViolations } : null;
}

// ---------- orchestration ----------

export async function runCapabilityStatementSynthesis(input: {
  anthropic: Anthropic;
  groups: EvidenceGroup[];
  storedDocs: StoredDoc[];
  knownFullName: string | null;
  model?: string;
  glossary?: GlossaryEntry[];
}): Promise<SynthesisResult> {
  const model = input.model ?? DEFAULT_SYNTHESIS_MODEL;
  const glossary = input.glossary ?? TRANSLATION_GLOSSARY;
  const result: SynthesisResult = {
    status: "failed",
    model,
    generatedAt: new Date().toISOString(),
    core: [],
    niche: [],
    uncertainTerms: [],
    rejected: [],
    failureLog: [],
    calls: [],
    notes: [],
  };
  if (input.groups.length === 0) {
    result.notes.push("no evidence groups");
    return result;
  }

  const ctx = buildCheckContext(input.groups, glossary);
  const basePrompt = buildSynthesisPrompt(toPromptGroups(input.groups, input.storedDocs), glossary);

  const initial = await callModel(input.anthropic, model, basePrompt, "initial");
  const parsed = parseSynthesisOutput(initial.text);
  initial.record.parseOk = parsed !== null;
  result.calls.push(initial.record);
  if (!parsed) {
    result.notes.push(initial.record.error ? `initial call failed: ${initial.record.error}` : `initial response not parseable (stop_reason=${initial.record.stopReason})`);
    return result;
  }
  result.uncertainTerms.push(...parsed.uncertainTerms);

  let coreCandidates = parsed.core;
  if (coreCandidates.length > CORE_MAX) {
    result.notes.push(`model returned ${coreCandidates.length} core statements; kept the first ${CORE_MAX} (strongest first)`);
    coreCandidates = coreCandidates.slice(0, CORE_MAX);
  }

  // Slots keep each statement's position, so a retried replacement lands where
  // the original was rather than at the end.
  type Slot<T> = { item: T; failure: ItemFailure | null };
  const evaluate = <T extends CoreStatement | NicheCapability>(kind: "core" | "niche", item: T): Slot<T> => ({
    item,
    failure: validateItem(kind, item, ctx, input.knownFullName),
  });
  let coreSlots = coreCandidates.map((c) => evaluate("core", c));
  let nicheSlots = parsed.niche.map((n) => evaluate("niche", n));

  const currentFailures = () => [...coreSlots, ...nicheSlots].map((s) => s.failure).filter((f): f is ItemFailure => f !== null);
  const passingCore = () => coreSlots.filter((s) => !s.failure).length;
  result.failureLog.push({ attempt: "initial", failures: currentFailures() });

  for (let attempt = 1; attempt <= SYNTHESIS_RETRY_ATTEMPTS; attempt++) {
    const failures = currentFailures();
    const extraCoreWanted = Math.max(0, CORE_MIN - coreSlots.length);
    if (failures.length === 0 && extraCoreWanted === 0) break;

    const accepted = {
      core: coreSlots.filter((s) => !s.failure).map((s) => s.item),
      niche: nicheSlots.filter((s) => !s.failure).map((s) => s.item),
    };
    const retry = await callModel(
      input.anthropic,
      model,
      buildSynthesisRetryPrompt(basePrompt, accepted, failures, extraCoreWanted),
      `retry_${attempt}`
    );
    const retryParsed = parseSynthesisOutput(retry.text);
    retry.record.parseOk = retryParsed !== null;
    result.calls.push(retry.record);
    if (!retryParsed) {
      result.notes.push(`retry ${attempt} unusable: ${retry.record.error ?? `stop_reason=${retry.record.stopReason}`}`);
      continue;
    }
    result.uncertainTerms.push(...retryParsed.uncertainTerms);

    const failedCoreIdx = coreSlots.map((s, i) => (s.failure ? i : -1)).filter((i) => i >= 0);
    const failedNicheIdx = nicheSlots.map((s, i) => (s.failure ? i : -1)).filter((i) => i >= 0);

    coreSlots = [...coreSlots];
    failedCoreIdx.forEach((slotIdx, i) => {
      const replacement = retryParsed.core[i];
      if (replacement) coreSlots[slotIdx] = evaluate("core", replacement);
    });
    // Extra statements beyond one-per-failure are only taken to reach the minimum.
    for (const extra of retryParsed.core.slice(failedCoreIdx.length, failedCoreIdx.length + extraCoreWanted)) {
      if (coreSlots.length < CORE_MAX) coreSlots.push(evaluate("core", extra));
    }
    nicheSlots = [...nicheSlots];
    failedNicheIdx.forEach((slotIdx, i) => {
      const replacement = retryParsed.niche[i];
      if (replacement) nicheSlots[slotIdx] = evaluate("niche", replacement);
    });

    result.failureLog.push({ attempt: `retry_${attempt}`, failures: currentFailures() });
  }

  result.rejected = currentFailures();
  result.core = coreSlots.filter((s) => !s.failure).map((s) => withEvidenceBasis(s.item, ctx.groupsById));
  result.niche = nicheSlots.filter((s) => !s.failure).map((s) => withEvidenceBasis(s.item, ctx.groupsById));
  result.status = passingCore() >= CORE_MIN ? "ok" : "insufficient";
  if (result.status === "insufficient") {
    result.notes.push(`only ${passingCore()} core statement(s) passed every check; at least ${CORE_MIN} are required`);
  }
  if (result.rejected.some((f) => f.kind === "niche")) {
    result.notes.push("one or more niche items never passed the checks - see rejected; they need review rather than silent removal");
  }
  return result;
}
