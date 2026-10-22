// Deterministic, code-side checks for Tier 1 capability statements. Kept free
// of runtime imports so scripts/verify-capability-statements.mjs can transpile
// and unit-test it directly (same approach as scripts/verify-text-guard.mjs).
//
// The model writes the statements; this module decides whether each one is
// allowed to stand. Nothing here asks the model anything.

export type GroupVerification = "VERIFIED" | "USER_PROVIDED";

// The minimum a check needs from an evidence group. Structurally compatible
// with EvidenceGroup in lib/capabilityPipeline.ts.
export type CheckGroup = {
  groupId: string;
  claims: string[];
  verificationStatus: GroupVerification;
};

export type EvidenceBasis = "documented" | "self_reported" | "mixed";

export type ProofLine = {
  text: string;
  groupIds: string[];
  // Computed in code from the cited groups - never taken from the model.
  evidenceBasis?: EvidenceBasis;
};

export type CoreStatement = {
  statement: string;
  proof: ProofLine[];
  evidenceBasis?: EvidenceBasis;
};

export type NicheCapability = {
  statement: string;
  applicability: string[];
  proof: ProofLine[];
  evidenceBasis?: EvidenceBasis;
};

export const CORE_MIN = 3;
export const CORE_MAX = 12;
export const CORE_PROOF_MIN = 2;
export const PROOF_MAX = 4;
// A niche skill is often backed by a single narrow piece of evidence (one
// language score, one appointment). Requiring two proof lines would force it
// out of the list entirely, and niche skills are never dropped - so one proof
// line is enough here. Every proof line still needs a sourced number.
export const NICHE_PROOF_MIN = 1;
export const CORE_MIN_DISTINCT_GROUPS = 2;
// "Under 25 words" - a statement must be readable at a glance.
export const STATEMENT_MAX_WORDS = 24;

export type StatementIssueCode =
  | "empty_statement"
  | "proof_count"
  | "proof_missing_digit"
  | "proof_no_citation"
  | "unknown_group_id"
  | "too_few_distinct_groups"
  | "number_not_in_claims"
  | "overstated_verification"
  | "pronoun_or_subject"
  | "time_limited_without_end_date"
  | "no_applicability"
  | "statement_too_long"
  | "rating_as_statement"
  | "self_report_filler"
  | "dash_character"
  | "repeated_glossary_phrase";

export type StatementIssue = {
  code: StatementIssueCode;
  detail: string;
  proofIndex?: number;
};

// ---------- numbers ----------

// `end` is the index just past the match in the source text.
export type ExtractedNumber = { raw: string; value: number; end: number };

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100, thousand: 1000,
  dozen: 12, single: 1, both: 2, twice: 2,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};

const MAGNITUDE: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9,
};

// Digit-based numbers, with $ / commas / K / M / B / "million" / % normalized
// away. "3-5%" yields 3 and 5; "#2 of 6" yields 2 and 6; "1+/1+" yields 1 and 1;
// "2:38" yields 2 and 38. Ordinal suffixes ("6th") are ignored.
export function extractNumbers(text: string): ExtractedNumber[] {
  const out: ExtractedNumber[] = [];
  // Letter magnitudes (K/M/B) must touch the number ("$2M"); spelled-out ones
  // may follow a space ("2 million"). "1,800 m" is meters, not millions.
  const re = /\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(?:(k|mm|m|bn|b)(?![a-z])|\s?(thousand|million|billion)\b)?/gi;
  for (const m of text.matchAll(re)) {
    const intPart = m[1].replace(/,/g, "");
    const value = parseFloat(m[2] ? `${intPart}.${m[2]}` : intPart);
    const magWord = m[3] ?? m[4];
    const mag = magWord ? MAGNITUDE[magWord.toLowerCase()] ?? 1 : 1;
    out.push({ raw: m[0].trim(), value: value * mag, end: (m.index ?? 0) + m[0].length });
  }
  return out;
}

// Numbers a claim can supply: every digit-number plus spelled-out number words
// ("three FRG events", "two NATO exercises").
export function extractClaimNumbers(text: string): number[] {
  const values = extractNumbers(text).map((n) => n.value);
  for (const m of text.toLowerCase().matchAll(/\b[a-z]+\b/g)) {
    if (m[0] in NUMBER_WORDS) values.push(NUMBER_WORDS[m[0]]);
  }
  return values;
}

function roundSig(value: number, sig: number): number {
  if (value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const factor = Math.pow(10, magnitude - sig + 1);
  return Math.round(value / factor) * factor;
}

function approxEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

// Rounding is allowed (1-3 significant figures) only when it moves the number
// by at most this much - "14,259 feet" may become "14,000 feet", but "181
// candidates" may not become "200 candidates".
export const MAX_ROUNDING_DRIFT = 0.05;

// Unit changes the check recognizes (length, weight, time). A conversion only
// counts when the proof line names the unit it converted INTO right after the
// number - otherwise a claim's "1" would quietly source any 7, 12, or 60.
const UNIT_CONVERSIONS: Array<{ factor: number; unitAfter: RegExp }> = [
  { factor: 0.3048, unitAfter: /^[\s-]*(?:m|meters?|metres?)\b/i }, // feet -> meters
  { factor: 1 / 0.3048, unitAfter: /^[\s-]*(?:ft|feet|foot)\b/i }, // meters -> feet
  { factor: 1.609344, unitAfter: /^[\s-]*(?:km|kilometers?|kilometres?)\b/i }, // miles -> km
  { factor: 1 / 1.609344, unitAfter: /^[\s-]*(?:mi|miles?)\b/i }, // km -> miles
  { factor: 0.45359237, unitAfter: /^[\s-]*(?:kg|kilograms?)\b/i }, // lb -> kg
  { factor: 1 / 0.45359237, unitAfter: /^[\s-]*(?:lbs?|pounds?)\b/i }, // kg -> lb
  { factor: 60, unitAfter: /^[\s-]*(?:min|mins|minutes?)\b/i }, // hours -> minutes
  { factor: 1 / 60, unitAfter: /^[\s-]*(?:hrs?|hours?)\b/i }, // minutes -> hours
  { factor: 7, unitAfter: /^[\s-]*days?\b/i }, // weeks -> days
  { factor: 1 / 7, unitAfter: /^[\s-]*weeks?\b/i }, // days -> weeks
  { factor: 12, unitAfter: /^[\s-]*months?\b/i }, // years -> months
];

// True when proof number `n` can be derived from claim number `c` by an exact
// match, an allowed rounding, or a unit change (with rounding). `textAfter` is
// the proof text immediately following the number, used to confirm the unit.
export function numberDerivableFrom(n: number, c: number, textAfter = ""): boolean {
  if (approxEqual(n, c)) return true;
  const withinDrift = (target: number) => target !== 0 && Math.abs(n - target) / Math.abs(target) <= MAX_ROUNDING_DRIFT;
  for (const sig of [1, 2, 3]) {
    if (approxEqual(roundSig(c, sig), n) && withinDrift(c)) return true;
  }
  for (const { factor, unitAfter } of UNIT_CONVERSIONS) {
    if (unitAfter.test(textAfter) && withinDrift(c * factor)) return true;
  }
  return false;
}

// Returns the proof-line numbers that cannot be traced to any of the source
// texts (cited claims plus any glossary allowed facts that apply to them).
// Ranges are covered automatically: "3-5%" is two numbers, each of which must
// come from some claim (they may come from two different claims).
export function findUnsourcedNumbers(proofText: string, sourceTexts: string[]): ExtractedNumber[] {
  const available = sourceTexts.flatMap(extractClaimNumbers);
  return extractNumbers(proofText).filter((n) => {
    const after = proofText.slice(n.end, n.end + 20);
    return !available.some((c) => numberDerivableFrom(n.value, c, after));
  });
}

// ---------- verification / evidence basis ----------

export function deriveEvidenceBasis(groupIds: string[], groupsById: Map<string, CheckGroup>): EvidenceBasis {
  const statuses = groupIds.map((id) => groupsById.get(id)?.verificationStatus).filter(Boolean);
  const verified = statuses.filter((s) => s === "VERIFIED").length;
  if (verified === statuses.length && verified > 0) return "documented";
  if (verified === 0) return "self_reported";
  return "mixed";
}

// Wording that asserts a third party documented or evaluated the claim. Only
// legitimate when at least one cited group is backed by an official document.
const VERIFICATION_WORDING =
  /\b(?:documented|verified|certified by|independent(?:ly)?|evaluat(?:ed|ors?|ions?)|ranked by|rated by|official(?:ly)?|on record|confirmed by|per (?:annual )?reviews?|performance reviews?|by (?:senior )?(?:managers?|reviewers?|raters?))\b/i;

// ---------- statement-level checks ----------

const SUBJECT_OR_PRONOUN = /\b(?:this candidate|the candidate|candidate's|they|them|their|theirs|themselves|he|him|his|she|her|hers|i|me|my|we|our|us)\b/i;

// Security clearances specifically - "customs clearance" or "mine clearance"
// are ordinary work, not a time-limited personal eligibility.
const TIME_LIMITED = /\b(?:security clearance|(?:secret|top secret|ts\/sci|classified|government|federal|active|current)[- ]?(?:level )?clearance|top secret|ts\/sci)\b/i;
const END_DATE_WORDING = /\b(?:expir\w*|valid (?:through|until)|current through|eligible through|through|until)\b[^.;]{0,30}\b(?:19|20)\d{2}\b/i;
const PERMANENT_WORDING = /\b(?:permanent(?:ly)?|lifetime|never expires)\b/i;

function checkProofLines(
  proof: ProofLine[],
  groupsById: Map<string, CheckGroup>,
  sourceTextsFor: (groupIds: string[]) => string[]
): StatementIssue[] {
  const issues: StatementIssue[] = [];
  proof.forEach((line, i) => {
    const ids = Array.isArray(line.groupIds) ? line.groupIds : [];
    if (!/\d/.test(line.text ?? "")) {
      issues.push({ code: "proof_missing_digit", detail: `proof line has no number: "${line.text}"`, proofIndex: i });
    }
    if (ids.length === 0) {
      issues.push({ code: "proof_no_citation", detail: "proof line cites no evidence group", proofIndex: i });
      return;
    }
    const unknown = ids.filter((id) => !groupsById.has(id));
    if (unknown.length > 0) {
      issues.push({ code: "unknown_group_id", detail: `cites groupIds that do not exist: ${unknown.join(", ")}`, proofIndex: i });
    }
    const known = ids.filter((id) => groupsById.has(id));
    const unsourced = findUnsourcedNumbers(line.text ?? "", sourceTextsFor(known));
    if (unsourced.length > 0) {
      issues.push({
        code: "number_not_in_claims",
        detail: `numbers not found in the cited claims: ${unsourced.map((n) => n.raw).join(", ")}`,
        proofIndex: i,
      });
    }
    if (known.length > 0 && deriveEvidenceBasis(known, groupsById) === "self_reported" && VERIFICATION_WORDING.test(line.text ?? "")) {
      issues.push({
        code: "overstated_verification",
        detail: "wording implies third-party documentation, but every cited group is self-reported",
        proofIndex: i,
      });
    }
  });
  return issues;
}

export function countWords(text: string): number {
  return (text.match(/[A-Za-z0-9$%#][\w$%#.,'+/-]*/g) ?? []).length;
}

// A rating, ranking, award, or promotion result is proof inside the
// capability it supports - never the capability itself. Checked on the
// statement sentence only; proof lines are exactly where these belong.
const RATING_IN_STATEMENT =
  /\b(?:ranks?|ranked|rankings?|rated|ratings?|top (?:\d+(?:\s?-\s?\d+)?|few) ?(?:%|percent)|promot\w*|awards?|awarded|commendations?|medals?|decorat\w*|recogni[sz](?:ed|ation)|honou?r(?:s|ed)?|accolades?)\b/i;

// "Self-reports X as a strength" and similar: a self-reported fact is stated
// as a fact with its own number, or left out.
const SELF_REPORT_FILLER =
  /\b(?:self-?report\w*|self-?describ\w*|self-?identif\w*|self-?assess\w*|by (?:their|his|her) own account|describes? (?:it|this|themselves) as|lists? (?:it|this) as|claims? (?:it|this) as|as an? (?:core |key |personal )?(?:strength|capability|competenc\w*))\b/i;

// En dash (U+2013) and em dash (U+2014). Hyphens or commas only.
const DASH_CHARACTER = /[–—]/;

function checkItemText(statement: string, proofTexts: string[], extraTexts: string[] = []): StatementIssue[] {
  const issues: StatementIssue[] = [];
  const words = countWords(statement);
  if (words > STATEMENT_MAX_WORDS) {
    issues.push({ code: "statement_too_long", detail: `statement has ${words} words; keep it under ${STATEMENT_MAX_WORDS + 1}` });
  }
  const rating = statement.match(RATING_IN_STATEMENT);
  if (rating) {
    issues.push({
      code: "rating_as_statement",
      detail: `statement is built on a rating/ranking/award/promotion ("${rating[0]}"); make it the capability, and put the result in a proof line`,
    });
  }
  proofTexts.forEach((t, i) => {
    const filler = t.match(SELF_REPORT_FILLER);
    if (filler) {
      issues.push({
        code: "self_report_filler",
        detail: `"${filler[0]}" is filler; state the self-reported fact with its own number, or leave it out`,
        proofIndex: i,
      });
    }
  });
  if ([statement, ...proofTexts, ...extraTexts].some((t) => DASH_CHARACTER.test(t))) {
    issues.push({ code: "dash_character", detail: "contains an em dash or en dash; use a hyphen or a comma" });
  }
  return issues;
}

// ---------- cross-statement: repeated glossary phrasing ----------

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "at", "by", "with", "from", "as", "is", "it",
  "its", "that", "this", "who", "which", "every", "all", "any", "each", "be", "are", "was", "their", "often",
]);

function tokens(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]+/g, " ").split(/\s+/).filter(Boolean);
}

// 4-word sequences with at least 3 content words (numbers do not count):
// specific enough to be a recognizable phrase ("operates independently often
// far"), not a fact several statements may need ("a 12 person team").
function phraseGrams(text: string): string[] {
  const t = tokens(text);
  const out: string[] = [];
  for (let i = 0; i + 4 <= t.length; i++) {
    const gram = t.slice(i, i + 4);
    if (gram.filter((w) => !STOPWORDS.has(w) && !/\d/.test(w)).length >= 3) out.push(gram.join(" "));
  }
  return out;
}

export function buildGlossaryPhraseSet(glossaryTexts: string[]): Set<string> {
  return new Set(glossaryTexts.flatMap(phraseGrams));
}

// Glossary phrases an item uses (statement sentence + proof lines).
export function glossaryPhrasesIn(texts: string[], glossaryPhrases: Set<string>): Set<string> {
  return new Set(texts.flatMap(phraseGrams).filter((g) => glossaryPhrases.has(g)));
}

function checkSharedText(texts: string[]): StatementIssue[] {
  const issues: StatementIssue[] = [];
  const joined = texts.join(" \n ");
  if (TIME_LIMITED.test(joined)) {
    if (!END_DATE_WORDING.test(joined)) {
      issues.push({ code: "time_limited_without_end_date", detail: "mentions a time-limited fact (clearance) without its expiration date" });
    }
    if (PERMANENT_WORDING.test(joined)) {
      issues.push({ code: "time_limited_without_end_date", detail: "describes a time-limited fact as permanent" });
    }
  }
  return issues;
}

function checkStatementNumbers(
  statement: string,
  proof: ProofLine[],
  groupsById: Map<string, CheckGroup>,
  sourceTextsFor: (groupIds: string[]) => string[]
): StatementIssue[] {
  // The headline sentence may only use numbers its own proof lines can source.
  const cited = proof.flatMap((p) => (Array.isArray(p.groupIds) ? p.groupIds : [])).filter((id) => groupsById.has(id));
  const unsourced = findUnsourcedNumbers(statement, sourceTextsFor(cited));
  return unsourced.length
    ? [{ code: "number_not_in_claims", detail: `statement numbers not found in any cited claim: ${unsourced.map((n) => n.raw).join(", ")}` }]
    : [];
}

export type CheckContext = {
  groupsById: Map<string, CheckGroup>;
  // Texts the numbers in a proof line may come from, given its cited groups.
  // Defaults to the claims of those groups.
  sourceTextsFor?: (groupIds: string[]) => string[];
};

function defaultSourceTexts(groupsById: Map<string, CheckGroup>) {
  return (ids: string[]) => ids.flatMap((id) => groupsById.get(id)?.claims ?? []);
}

export function checkCoreStatement(s: CoreStatement, ctx: CheckContext): StatementIssue[] {
  const sourceTextsFor = ctx.sourceTextsFor ?? defaultSourceTexts(ctx.groupsById);
  const issues: StatementIssue[] = [];
  const proof = Array.isArray(s.proof) ? s.proof : [];
  if (!s.statement || !s.statement.trim()) issues.push({ code: "empty_statement", detail: "statement text is empty" });
  if (SUBJECT_OR_PRONOUN.test(s.statement ?? "")) {
    issues.push({ code: "pronoun_or_subject", detail: "statement uses a subject or pronoun; write plain present tense with no subject" });
  }
  if (proof.length < CORE_PROOF_MIN || proof.length > PROOF_MAX) {
    issues.push({ code: "proof_count", detail: `has ${proof.length} proof lines; needs ${CORE_PROOF_MIN}-${PROOF_MAX}` });
  }
  issues.push(...checkProofLines(proof, ctx.groupsById, sourceTextsFor));
  issues.push(...checkStatementNumbers(s.statement ?? "", proof, ctx.groupsById, sourceTextsFor));
  const distinct = new Set(proof.flatMap((p) => (Array.isArray(p.groupIds) ? p.groupIds : [])).filter((id) => ctx.groupsById.has(id)));
  if (distinct.size < CORE_MIN_DISTINCT_GROUPS) {
    issues.push({
      code: "too_few_distinct_groups",
      detail: `proof cites ${distinct.size} distinct evidence group(s); a core statement must draw on at least ${CORE_MIN_DISTINCT_GROUPS}`,
    });
  }
  issues.push(...checkItemText(s.statement ?? "", proof.map((p) => p.text ?? "")));
  issues.push(...checkSharedText([s.statement ?? "", ...proof.map((p) => p.text ?? "")]));
  return issues;
}

export function checkNicheCapability(s: NicheCapability, ctx: CheckContext): StatementIssue[] {
  const sourceTextsFor = ctx.sourceTextsFor ?? defaultSourceTexts(ctx.groupsById);
  const issues: StatementIssue[] = [];
  const proof = Array.isArray(s.proof) ? s.proof : [];
  if (!s.statement || !s.statement.trim()) issues.push({ code: "empty_statement", detail: "statement text is empty" });
  if (SUBJECT_OR_PRONOUN.test(s.statement ?? "")) {
    issues.push({ code: "pronoun_or_subject", detail: "statement uses a subject or pronoun; write plain present tense with no subject" });
  }
  if (!Array.isArray(s.applicability) || s.applicability.filter((a) => a && a.trim()).length === 0) {
    issues.push({ code: "no_applicability", detail: "niche capability needs at least one plain-word applicability tag" });
  }
  if (proof.length < NICHE_PROOF_MIN || proof.length > PROOF_MAX) {
    issues.push({ code: "proof_count", detail: `has ${proof.length} proof lines; needs ${NICHE_PROOF_MIN}-${PROOF_MAX}` });
  }
  issues.push(...checkProofLines(proof, ctx.groupsById, sourceTextsFor));
  issues.push(...checkStatementNumbers(s.statement ?? "", proof, ctx.groupsById, sourceTextsFor));
  issues.push(...checkItemText(s.statement ?? "", proof.map((p) => p.text ?? ""), s.applicability ?? []));
  issues.push(...checkSharedText([s.statement ?? "", ...proof.map((p) => p.text ?? ""), ...(s.applicability ?? [])]));
  return issues;
}

// Stamps the code-derived evidence basis onto every proof line and statement.
export function withEvidenceBasis<T extends { proof: ProofLine[]; evidenceBasis?: EvidenceBasis }>(
  s: T,
  groupsById: Map<string, CheckGroup>
): T {
  const proof = s.proof.map((p) => ({ ...p, evidenceBasis: deriveEvidenceBasis(p.groupIds.filter((id) => groupsById.has(id)), groupsById) }));
  const all = proof.flatMap((p) => p.groupIds).filter((id) => groupsById.has(id));
  return { ...s, proof, evidenceBasis: deriveEvidenceBasis(all, groupsById) };
}
