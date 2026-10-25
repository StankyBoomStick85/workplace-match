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
//
// The run is a resumable state machine (createSynthesisState ->
// runSynthesisStep ... -> finishSynthesis), one model call per step, with a
// JSON-serializable state between steps. A full Fable run takes longer than
// one 300s function invocation, so lib/capabilityStatementJobs.ts persists the
// state and runs each step in its own invocation. runCapabilityStatementSynthesis
// drives the same steps in-process for scripts.
//
// No single step may outlive its invocation: the first synthesis is split into
// a core step and a niche step (one combined call ran 306-307s), and every
// call is aborted at SYNTHESIS_CALL_TIMEOUT_MS. A call that times out is run
// again once at lower effort, and every later call in that run stays there.

import type Anthropic from "@anthropic-ai/sdk";
import type { EvidenceGroup, StoredDoc } from "@/lib/capabilityPipeline";
import { getCivilianDocLabel } from "@/lib/documentLabels";
import {
  CORE_MAX,
  CORE_MIN,
  STATEMENT_MAX_WORDS,
  buildGlossaryPhraseSet,
  checkCoreStatement,
  checkNicheCapability,
  glossaryPhrasesIn,
  withEvidenceBasis,
  type CheckGroup,
  type CoreStatement,
  type NicheCapability,
  type StatementIssue,
} from "@/lib/capabilityStatementChecks";
import { STATEMENT_GUARD_CORRECTIONS, scanCoreOnlyText, scanStatementText, type StatementGuardViolation } from "@/lib/statementGuard";
import { TRANSLATION_GLOSSARY, formatGlossaryForPrompt, matchGlossaryEntries, type GlossaryEntry } from "@/lib/translationGlossary";
import { formatDirectionForPrompt, type CandidateDirection } from "@/lib/candidateDirection";

// Chosen 2026-10-22 from the Phase 1 comparison (vs claude-sonnet-4-6): more
// statements pass the checks, and the translation of scope is markedly better.
export const DEFAULT_SYNTHESIS_MODEL = "claude-fable-5-1";

export const SYNTHESIS_MAX_TOKENS = 32000;
export const SYNTHESIS_RETRY_ATTEMPTS = 2;
// Hard ceiling on one model call. The step route's maxDuration is 300s; the
// rest is headroom for loading and saving the job around the call.
export const SYNTHESIS_CALL_TIMEOUT_MS = 240_000;

export type SynthesisEffort = "high" | "medium";

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
  // "initial" is the old combined core+niche call (states saved before the
  // split); new runs make "initial_core" then "initial_niche".
  phase: "initial" | "initial_core" | "initial_niche" | `retry_${number}`;
  effort?: SynthesisEffort;
  timedOut?: boolean;
  // The model that actually served the response - differs from the requested
  // one only when a server-side refusal fallback ran.
  model: string;
  requestedModel?: string;
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

export function buildSynthesisPrompt(
  promptGroups: PromptGroup[],
  glossary: GlossaryEntry[] = TRANSLATION_GLOSSARY,
  context?: PersonContext
): string {
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
   - A rating, ranking, award, or promotion result is never a statement on its own. It is proof inside the capability it supports (a top peer ranking is a proof line under the leadership or operations statement it reflects, not a statement about being ranked).
   - Plain present tense, no subject, no pronouns: "Directs ...", "Builds ...", "Keeps ...". Never "this candidate", never they/he/she.
   - One sentence, under ${STATEMENT_MAX_WORDS + 1} words, specific about scope and stakes, readable in five seconds.
   - Write in the vocabulary a civilian hiring manager uses, strictly, in the statement and every proof line: "specialists" not "operators", "team" not "element" or "unit", "official records" not "service record". If a hiring manager in an ordinary company would not say the word, find the word they would. Preferred rewrites: "mission success rate" -> "success rate"; "high-threat movements" -> "high-risk operations"; "allied nations" -> "partner countries" (or just the count); "multinational staff exercise" -> "international planning exercise".
   - Do not repeat the same glossary phrasing across statements. If one statement already says a team "works independently far from support", the others describe their own point in their own words.
   - Match the scale the cited evidence shows; never inflate it. Teams of 12 to 100 are teams, not "large organizations" or "larger organizations"; nothing is "large-scale", "enterprise", "organization-wide", or "major" unless a cited claim says so; "hundreds" or "thousands" only when a cited number reaches them.
   - Name each function for what it is. Recruiting is recruiting (or talent acquisition), never sales, selling, or "sales-style"; training is training. Do not relabel past work to fit a role the person wants.
   - Strongest first. Fewer strong statements beat many thin ones; a thin profile ships with as few as 3.
   - Specialized skills (see "niche") never go here.

2. Every core statement has 2 to 4 "proof" lines. Each proof line:
   - Contains at least one concrete number, taken from the claims of the groups it cites.
   - Lists the groupIds it draws from in "groupIds" (exact ids from the evidence).
   - Across one statement's proof lines, at least 2 different evidence groups are cited.
   - Numbers come ONLY from the cited claims. Allowed: rounding, unit changes, a range built from two claims ("top 3-5%" from a "top 3%" claim and a "top 5%" claim), writing a spelled-out number as digits, and the "Facts you may state" of a glossary entry whose term appears in the cited claims. Never add numbers up into totals, never compute percentages, averages, or counts of your own, never estimate. Round dollar amounts to 2 significant figures ($1,000,000 -> $1M; $3,500 -> $3.5K).
   - Shows how strong the evidence is through wording alone, e.g. "ranked #2 of 6 peers by an independent senior evaluator" or "across annual performance reviews". No badges, check marks, or labels like "verified". Never claim documentation or third-party evaluation for USER_PROVIDED evidence.
   - Never write "self-reports X as a strength" or similar filler. A self-reported fact is stated as a fact with its own number, or left out.

3. "niche": specialized skills - for example demolitions, precision marksmanship, parachute operations, a foreign language, fire support coordination, and every glossary entry marked NICHE that the evidence supports. These never go in core and are never dropped.
   - "statement": what the person can do with the skill, same style as core.
   - "applicability": plain-word tags for where the skill matters to an employer (e.g. "construction blasting", "mining", "international business", "range safety").
   - "proof": 1 to 4 proof lines under the same rules (the two-group rule does not apply to niche).
   - Use the same civilian vocabulary as core, except that a niche item may keep a technical term when the skill itself is technical (e.g. "breaching", "artillery") - never a qualification or course name.

4. "uncertainTerms": every term you were unsure how to translate - the term, the meaning you assumed, and why you were unsure. Empty array if none.

NEVER APPEARS ANYWHERE IN THE OUTPUT (identity and jargon - the person is anonymous to employers):
- The person's name or initials; any pronoun.
- Any rank or pay grade; any branch of service; the words military, civilian, veteran, enlisted, NCO, noncommissioned, sergeant, warrant, battalion, soldier, troops, special operations, Green Beret, embassy, commander, theater, hostile, coalition, infantry, intelligence agency; "company" used as a unit; "commands" meaning organizations.
- In core statements and their proof lines: "combat", "assault", "operators", "valor", "service record". Say "under direct threat", "specialists", "official records", and describe what a formal recognition was for instead.
- Named historical events that date the work (e.g. a pandemic by name).
- Em dashes and en dashes. Use hyphens or commas.
- Award, medal, badge, or tab names (state a count only, e.g. "6 formal commendations for performance"); school, course, or qualification names; specialty codes; unit names, designators, or command areas; evaluation document type names (say "annual performance reviews"); operation or exercise names.
- Any location: country, state, region, base, or installation. Describe the environment instead ("austere international settings", "high-threat environments").
- Calendar years and dates; years of service or tenure length; publications or books.
- Transition framing (no "transitioning", "bridging", "translating experience", "new sector").
- Exception: a time-limited fact such as a security clearance may be stated, and must carry its expiration date; never say who granted it and never call it permanent.

GLOSSARY (authoritative corrections when a term matches):
${formatGlossaryForPrompt(glossary)}

${formatPersonContext(context)}EVIDENCE GROUPS:
${JSON.stringify(promptGroups, null, 1)}

Return only the JSON object.`;
}

// The first synthesis runs as two calls so neither can approach the function
// time limit. Same prompt and schema; this names which half to return.
export function buildInitialScopeInstruction(scope: "core" | "niche", acceptedCore: CoreStatement[] = []): string {
  if (scope === "core") {
    return `

THIS CALL - CORE ONLY:
Return "core" and "uncertainTerms". Return "niche" as an empty array: specialized skills are written in a separate call, so leave them out of core entirely rather than folding them in.`;
  }
  return `

THIS CALL - NICHE ONLY:
Return "niche" and "uncertainTerms". Return "core" as an empty array: the core statements were written in a separate call and are listed below for reference only. Do not restate their substance as a niche item, and do not reuse their wording.
CORE STATEMENTS ALREADY WRITTEN:
${JSON.stringify(acceptedCore.map((c) => c.statement))}`;
}

// The self-written summary, signup skill tags, and direction ("Where I'm
// heading") describe who the person is and where they want to go. They help
// decide emphasis, order, and wording, but they are not evidence: they are
// never cited, and a number in them can never appear in a proof line (the
// provenance check only sources numbers from cited claims, so this is enforced
// in code as well as asked for here).
export type PersonContext = {
  summary?: string | null;
  capabilityTags?: string[] | null;
  direction?: CandidateDirection | null;
};

function formatPersonContext(context?: PersonContext): string {
  const summary = context?.summary?.trim();
  const tags = (context?.capabilityTags ?? []).filter((t) => t && t.trim());
  const direction = context?.direction ?? null;
  if (!summary && tags.length === 0 && !direction) return "";
  return `CONTEXT ABOUT THE PERSON - NOT EVIDENCE. Use it only to understand who this person is, where they want to go, and which capabilities they want to lead with. Never cite it, never take a fact or number from it, and never write a statement or proof line that exists only because of it. Every statement and proof line comes from the evidence groups below.
${direction ? `Where they want to go (decides emphasis and order - put the capabilities those roles are judged on first):\n${formatDirectionForPrompt(direction)}\n` : ""}${summary ? `Self-written summary: ${JSON.stringify(summary)}\n` : ""}${tags.length ? `Skills they listed at signup: ${JSON.stringify(tags)}\n` : ""}
`;
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

// Server-side refusal fallback: if the model's safety classifiers decline
// (plausible on explosives / weapons evidence), the API re-runs the request on
// a fallback model inside the same call instead of returning nothing. The
// served model is recorded on every call so a fallback is never silent.
// Passed untyped: @anthropic-ai/sdk 0.95 predates the parameter.
const REFUSAL_FALLBACK_BETA = "server-side-fallback-2026-07-01";

type RawCall = { text: string; record: ModelCallRecord };

async function callModel(
  anthropic: Anthropic,
  model: string,
  prompt: string,
  phase: ModelCallRecord["phase"],
  effort: SynthesisEffort = "high",
  timeoutMs: number = SYNTHESIS_CALL_TIMEOUT_MS
): Promise<RawCall> {
  const start = Date.now();
  const legacy = isLegacySamplingModel(model);
  const params = {
    model,
    max_tokens: SYNTHESIS_MAX_TOKENS,
    messages: [{ role: "user" as const, content: prompt }],
    output_config: {
      format: { type: "json_schema" as const, schema: SYNTHESIS_OUTPUT_SCHEMA },
      ...(legacy ? {} : { effort }),
    },
    ...(legacy ? { temperature: 0.2 } : { fallbacks: "default" }),
  };
  const base = { phase, requestedModel: model, effort: legacy ? undefined : effort, inputTokens: null, outputTokens: null, parseOk: false };
  // Streamed: a long synthesis on a thinking model can run past the SDK's
  // non-streaming timeout. Aborted at timeoutMs so the step that made the
  // call always finishes inside its function invocation.
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stream = anthropic.messages.stream(
      params as Anthropic.MessageStreamParams,
      legacy ? undefined : { headers: { "anthropic-beta": REFUSAL_FALLBACK_BETA } }
    );
    timer = setTimeout(() => {
      timedOut = true;
      stream.abort();
    }, timeoutMs);
    const message = await stream.finalMessage();
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const stopReason = message.stop_reason ?? null;
    return {
      text: stopReason === "refusal" ? "" : text,
      record: {
        ...base,
        model: message.model ?? model,
        stopReason,
        inputTokens: message.usage?.input_tokens ?? null,
        outputTokens: message.usage?.output_tokens ?? null,
        elapsedMs: Date.now() - start,
        error: stopReason === "refusal" ? "model and its fallback declined the request (stop_reason=refusal)" : null,
      },
    };
  } catch (err) {
    const error = timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : err instanceof Error ? err.message : String(err);
    return {
      text: "",
      record: { ...base, model, stopReason: null, elapsedMs: Date.now() - start, error, ...(timedOut ? { timedOut: true } : {}) },
    };
  } finally {
    clearTimeout(timer);
  }
}

// Ranges written with an en/em dash ("3–5%") are normalized to a hyphen -
// same meaning, and the no-dash rule is about punctuation. Every other dash is
// left in place for the checks to reject and the retry to rewrite.
function normalizeRangeDashes(text: string): string {
  return text.replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2");
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
  const str = (v: unknown) => (typeof v === "string" ? normalizeRangeDashes(v) : "");
  const asProof = (p: unknown) => {
    const o = (p ?? {}) as Record<string, unknown>;
    return {
      text: str(o.text),
      groupIds: Array.isArray(o.groupIds) ? o.groupIds.filter((x): x is string => typeof x === "string") : [],
    };
  };
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  return {
    core: arr(obj.core).map((c: Record<string, unknown>) => ({
      statement: str(c?.statement),
      proof: arr(c?.proof).map(asProof),
    })),
    niche: arr(obj.niche).map((n: Record<string, unknown>) => ({
      statement: str(n?.statement),
      applicability: arr(n?.applicability).filter((x): x is string => typeof x === "string").map(normalizeRangeDashes),
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
  const glossaryPhrases = buildGlossaryPhraseSet(glossary.flatMap((e) => [e.employerMeaning, ...(e.allowedFacts ?? [])]));
  return { groupsById, sourceTextsFor, glossaryPhrases };
}

type CheckContextFull = ReturnType<typeof buildCheckContext>;

function itemTexts(item: CoreStatement | NicheCapability): string[] {
  return [item.statement, ...item.proof.map((p) => p.text), ...("applicability" in item ? item.applicability : [])];
}

function guardItem(kind: "core" | "niche", item: CoreStatement | NicheCapability, knownFullName: string | null): StatementGuardViolation[] {
  const texts = itemTexts(item);
  const violations = texts.flatMap((t) => scanStatementText(t, { knownFullName }));
  if (kind === "core") {
    for (const t of texts) {
      violations.push(...scanCoreOnlyText(t));
    }
  }
  return violations;
}

export function validateItem(
  kind: "core" | "niche",
  item: CoreStatement | NicheCapability,
  ctx: CheckContextFull,
  knownFullName: string | null
): ItemFailure | null {
  const issues = kind === "core" ? checkCoreStatement(item as CoreStatement, ctx) : checkNicheCapability(item as NicheCapability, ctx);
  const guardViolations = guardItem(kind, item, knownFullName);
  return issues.length || guardViolations.length ? { kind, item, issues, guardViolations } : null;
}

// ---------- resumable state machine ----------

type Slot<T> = { item: T; failure: ItemFailure | null };

export type SynthesisState = {
  version: 1;
  model: string;
  generatedAt: string;
  // "initial_core" -> core statements; "initial_niche" -> niche items;
  // "retry" -> a targeted retry; "done" -> call finishSynthesis. "initial" is
  // a state saved before the split and runs as "initial_core".
  next: "initial" | "initial_core" | "initial_niche" | "retry" | "done";
  retriesDone: number;
  // Drops to "medium" after any call times out, for the rest of the run.
  effort?: SynthesisEffort;
  // Unusable calls (timed out or unparseable) in the current initial phase.
  phaseFailures?: number;
  // Set when the run cannot continue (unusable initial response).
  fatal: string | null;
  coreSlots: Slot<CoreStatement>[];
  nicheSlots: Slot<NicheCapability>[];
  uncertainTerms: UncertainTerm[];
  calls: ModelCallRecord[];
  failureLog: Array<{ attempt: string; failures: ItemFailure[] }>;
  notes: string[];
};

export type SynthesisInput = {
  groups: EvidenceGroup[];
  storedDocs: StoredDoc[];
  knownFullName: string | null;
  glossary?: GlossaryEntry[];
  // Summary + signup tags: context about the person, never evidence.
  context?: PersonContext;
  // Overrides SYNTHESIS_CALL_TIMEOUT_MS (tests only).
  callTimeoutMs?: number;
};

export function createSynthesisState(model: string = DEFAULT_SYNTHESIS_MODEL): SynthesisState {
  return {
    version: 1,
    model,
    generatedAt: new Date().toISOString(),
    next: "initial_core",
    retriesDone: 0,
    effort: "high",
    phaseFailures: 0,
    fatal: null,
    coreSlots: [],
    nicheSlots: [],
    uncertainTerms: [],
    calls: [],
    failureLog: [],
    notes: [],
  };
}

type IndexedFailure = { kind: "core" | "niche"; index: number; failure: ItemFailure };

// Every current failure: each slot's own checks, plus the cross-statement
// rule that a glossary phrase may appear in only one statement. The first
// passing statement to use a phrase keeps it; any later one fails.
function currentFailures(state: SynthesisState, ctx: CheckContextFull): IndexedFailure[] {
  const out: IndexedFailure[] = [];
  const used = new Map<string, string>(); // phrase -> statement that owns it
  const visit = (kind: "core" | "niche", slots: Slot<CoreStatement | NicheCapability>[]) => {
    slots.forEach((slot, index) => {
      if (slot.failure) {
        out.push({ kind, index, failure: slot.failure });
        return;
      }
      const phrases = glossaryPhrasesIn(itemTexts(slot.item), ctx.glossaryPhrases);
      const repeated = [...phrases].filter((p) => used.has(p));
      if (repeated.length > 0) {
        const issue: StatementIssue = {
          code: "repeated_glossary_phrase",
          detail: `repeats glossary phrasing already used by another statement: ${repeated
            .map((p) => `"${p}" (used in: "${used.get(p)!.slice(0, 60)}")`)
            .join("; ")}. Say it in different words or drop it`,
        };
        out.push({ kind, index, failure: { kind, item: slot.item, issues: [issue], guardViolations: [] } });
        return;
      }
      for (const p of phrases) used.set(p, slot.item.statement);
    });
  };
  visit("core", state.coreSlots);
  visit("niche", state.nicheSlots);
  return out;
}

function evaluateSlot<T extends CoreStatement | NicheCapability>(kind: "core" | "niche", item: T, ctx: CheckContextFull, name: string | null): Slot<T> {
  return { item, failure: validateItem(kind, item, ctx, name) };
}

// Runs exactly one model call (the initial synthesis or one targeted retry)
// and returns the next state. Never throws for model/parse problems - those
// are recorded on the state.
export async function runSynthesisStep(state: SynthesisState, input: SynthesisInput & { anthropic: Anthropic }): Promise<SynthesisState> {
  if (state.next === "done") return state;
  const glossary = input.glossary ?? TRANSLATION_GLOSSARY;
  const ctx = buildCheckContext(input.groups, glossary);
  const basePrompt = buildSynthesisPrompt(toPromptGroups(input.groups, input.storedDocs), glossary, input.context);
  const s: SynthesisState = JSON.parse(JSON.stringify(state));

  if (s.next === "initial") s.next = "initial_core";
  const effort: SynthesisEffort = s.effort ?? "high";

  if (s.next === "initial_core" || s.next === "initial_niche") {
    const scope = s.next === "initial_core" ? "core" : "niche";
    if (input.groups.length === 0) {
      s.fatal = "no evidence groups";
      s.next = "done";
      return s;
    }
    const acceptedCore = s.coreSlots.filter((x) => !x.failure).map((x) => x.item);
    const call = await callModel(
      input.anthropic,
      s.model,
      basePrompt + buildInitialScopeInstruction(scope, acceptedCore),
      s.next,
      effort,
      input.callTimeoutMs
    );
    const parsed = parseSynthesisOutput(call.text);
    call.record.parseOk = parsed !== null;
    s.calls.push(call.record);
    if (call.record.timedOut) s.effort = "medium";
    if (!parsed) {
      const why = call.record.error ?? `response not parseable (stop_reason=${call.record.stopReason})`;
      s.phaseFailures = (s.phaseFailures ?? 0) + 1;
      if (s.phaseFailures < 2) {
        // Same phase again, as its own step (at medium effort if it timed out).
        s.notes.push(`${scope} synthesis call unusable (${why}); running it again${call.record.timedOut ? " at medium effort" : ""}`);
        return s;
      }
      s.fatal = `${scope} synthesis failed twice: ${why}`;
      s.next = "done";
      return s;
    }
    s.phaseFailures = 0;
    s.uncertainTerms.push(...parsed.uncertainTerms);
    if (scope === "core") {
      let core = parsed.core;
      if (core.length > CORE_MAX) {
        s.notes.push(`model returned ${core.length} core statements; kept the first ${CORE_MAX} (strongest first)`);
        core = core.slice(0, CORE_MAX);
      }
      if (parsed.niche.length) s.notes.push(`core call also returned ${parsed.niche.length} niche item(s); ignored - niche has its own call`);
      s.coreSlots = core.map((c) => evaluateSlot("core", c, ctx, input.knownFullName));
      s.next = "initial_niche";
      return s;
    }
    if (parsed.core.length) s.notes.push(`niche call also returned ${parsed.core.length} core statement(s); ignored`);
    s.nicheSlots = parsed.niche.map((n) => evaluateSlot("niche", n, ctx, input.knownFullName));
    s.failureLog.push({ attempt: "initial", failures: currentFailures(s, ctx).map((f) => f.failure) });
  } else {
    const attempt = s.retriesDone + 1;
    const failures = currentFailures(s, ctx);
    const extraCoreWanted = Math.max(0, CORE_MIN - s.coreSlots.length);
    const failedSet = new Set(failures.map((f) => `${f.kind}:${f.index}`));
    const accepted = {
      core: s.coreSlots.filter((_, i) => !failedSet.has(`core:${i}`)).map((x) => x.item),
      niche: s.nicheSlots.filter((_, i) => !failedSet.has(`niche:${i}`)).map((x) => x.item),
    };
    const retry = await callModel(
      input.anthropic,
      s.model,
      buildSynthesisRetryPrompt(basePrompt, accepted, failures.map((f) => f.failure), extraCoreWanted),
      `retry_${attempt}`,
      effort,
      input.callTimeoutMs
    );
    const retryParsed = parseSynthesisOutput(retry.text);
    retry.record.parseOk = retryParsed !== null;
    s.calls.push(retry.record);
    if (retry.record.timedOut) s.effort = "medium";
    s.retriesDone = attempt;
    if (!retryParsed) {
      s.notes.push(`retry ${attempt} unusable: ${retry.record.error ?? `stop_reason=${retry.record.stopReason}`}`);
    } else {
      s.uncertainTerms.push(...retryParsed.uncertainTerms);
      const failedCore = failures.filter((f) => f.kind === "core").map((f) => f.index);
      const failedNiche = failures.filter((f) => f.kind === "niche").map((f) => f.index);
      failedCore.forEach((slotIdx, i) => {
        const replacement = retryParsed.core[i];
        if (replacement) s.coreSlots[slotIdx] = evaluateSlot("core", replacement, ctx, input.knownFullName);
      });
      // Extra statements beyond one-per-failure are only taken to reach the minimum.
      for (const extra of retryParsed.core.slice(failedCore.length, failedCore.length + extraCoreWanted)) {
        if (s.coreSlots.length < CORE_MAX) s.coreSlots.push(evaluateSlot("core", extra, ctx, input.knownFullName));
      }
      failedNiche.forEach((slotIdx, i) => {
        const replacement = retryParsed.niche[i];
        if (replacement) s.nicheSlots[slotIdx] = evaluateSlot("niche", replacement, ctx, input.knownFullName);
      });
    }
    s.failureLog.push({ attempt: `retry_${attempt}`, failures: currentFailures(s, ctx).map((f) => f.failure) });
  }

  const remaining = currentFailures(s, ctx).length;
  const needMoreCore = s.coreSlots.length < CORE_MIN;
  s.next = (remaining > 0 || needMoreCore) && s.retriesDone < SYNTHESIS_RETRY_ATTEMPTS ? "retry" : "done";
  return s;
}

export function finishSynthesis(state: SynthesisState, input: SynthesisInput): SynthesisResult {
  const ctx = buildCheckContext(input.groups, input.glossary ?? TRANSLATION_GLOSSARY);
  const failures = state.fatal ? [] : currentFailures(state, ctx);
  const failedSet = new Set(failures.map((f) => `${f.kind}:${f.index}`));
  const core = state.coreSlots.filter((_, i) => !failedSet.has(`core:${i}`)).map((x) => withEvidenceBasis(x.item, ctx.groupsById));
  const niche = state.nicheSlots.filter((_, i) => !failedSet.has(`niche:${i}`)).map((x) => withEvidenceBasis(x.item, ctx.groupsById));
  const notes = [...state.notes];
  let status: SynthesisResult["status"];
  if (state.fatal) {
    status = "failed";
    notes.push(state.fatal);
  } else if (core.length >= CORE_MIN) {
    status = "ok";
  } else {
    status = "insufficient";
    notes.push(`only ${core.length} core statement(s) passed every check; at least ${CORE_MIN} are required`);
  }
  if (failures.some((f) => f.kind === "niche")) {
    notes.push("one or more niche items never passed the checks - see rejected; they need review rather than silent removal");
  }
  return {
    status,
    model: state.model,
    generatedAt: state.generatedAt,
    core: status === "failed" ? [] : core,
    niche: status === "failed" ? [] : niche,
    uncertainTerms: state.uncertainTerms,
    rejected: failures.map((f) => f.failure),
    failureLog: state.failureLog,
    calls: state.calls,
    notes,
  };
}

// In-process driver (scripts, tests). The state is JSON round-tripped between
// steps exactly as the background job persists it, so this exercises the
// same resume path.
export async function runCapabilityStatementSynthesis(
  input: SynthesisInput & { anthropic: Anthropic; model?: string }
): Promise<SynthesisResult> {
  let state = createSynthesisState(input.model ?? DEFAULT_SYNTHESIS_MODEL);
  while (state.next !== "done") {
    state = JSON.parse(JSON.stringify(await runSynthesisStep(state, input)));
  }
  return finishSynthesis(state, input);
}
