// Mechanical, regex-based safety net for AI-generated text that may reach an
// employer. Workplace Match's core premise is that an employer NEVER learns a
// candidate's identity, at any tier — this is not a style preference, it is
// the thing the product is for. Prompt instructions alone are not a control:
// a model can still slip a name, rank, branch, or exact tenure into prose
// even when told not to (this is exactly how commit e79cd4f7 shipped a live
// disclosure — the prompt asked for anonymity and the output ignored it).
// This module is the check that catches that failure mode mechanically,
// after generation and again at render time, instead of relying on someone
// reading the output and deciding it "looks right."
//
// This is a coarse net, not a certified anonymizer: it is tuned to catch the
// known failure categories (see the policy list below) with reasonable
// precision, not to guarantee perfect recall against a creative adversary. It
// is meant to be paired with human review of any flagged text, never treated
// as proof a clean pass means the text is safe from every possible leak.
//
// ── 2026-09 precision pass ──────────────────────────────────────────────────
// The first version of this list was a flat set of rank/agency words matched
// with nothing but \b…\b boundaries. That destroyed valid, policy-compliant
// output: the word "General" inside the civilian job titles "General Manager"
// and "Assistant General Manager" was flagged as the O-10 rank and the whole
// employer summary was blanked (confirmed in production 2026-09-07). The lists
// below are now split into "identifying on its own" vs. "only identifying in
// context", and the context-dependent terms are gated on an independent
// military / clearance signal appearing in the same text. See the block
// comment above each list for the specific reasoning and why the gate does
// not simply move the false positives somewhere else.

export type TextGuardCategory =
  | "candidate_name"
  | "honorific_name"
  | "gendered_pronoun"
  | "military_rank"
  | "branch_of_service"
  | "clearance_sponsor_or_agency"
  | "explicit_year"
  | "tenure_count"
  | "publication_reference"
  | "outsider_framing";

export type TextGuardViolation = {
  category: TextGuardCategory;
  match: string;
  index: number;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Military rank ───────────────────────────────────────────────────────────
//
// TIER 1 — RANK_TERMS_UNAMBIGUOUS: forms that effectively never occur in
// civilian business prose. Multi-word ranks ("Sergeant First Class", "Chief
// Warrant Officer"), special-unit names ("Green Beret", "Navy SEAL"), and the
// handful of bare words whose only ordinary meaning IS the rank
// ("sergeant", "corporal", "colonel", "admiral", "airman"). Flagged on any
// word-boundary match, regardless of surrounding context.
//
// TIER 2 — RANK_TERMS_CONTEXT_DEPENDENT: words that are real ranks AND
// everyday civilian job-title / business words:
//   general     → General Manager, Attorney General, general oversight
//   major       → major account, major program, major overhaul
//   captain     → team / airline / ship / precinct captain
//   commander   → Incident Commander, Scene Commander
//   specialist  → Security Specialist, Operations Specialist, IT Specialist
//   private     → private sector, private equity, private practice
//   lieutenant  → Lieutenant Governor, police / fire lieutenant
//   ensign      → a ship's flag; a fictional (Star Trek) rank
// These are flagged ONLY when the same text independently shows military
// context (MILITARY_CONTEXT_PATTERN) OR the word sits in an explicit
// rank-attribution phrase ("held the rank of Major", "served as a Captain").
//
// Why this does not just relocate the false positives: every time the Tier-2
// gate opens via MILITARY_CONTEXT_PATTERN, that pattern matched on a branch
// name or a Tier-1 rank — each of which is ALREADY an independent violation,
// so the field is being blanked with or without the Tier-2 hit; the Tier-2
// match only adds detail to the report. The only case where a Tier-2 term is
// the sole trigger is the rank-attribution phrase, and that construction does
// not appear around civilian titles — "General Manager" is never preceded by
// "the rank of". Clean civilian prose has neither signal, so it now passes.
const RANK_TERMS_UNAMBIGUOUS = [
  "private first class",
  "sergeant first class",
  "command sergeant major",
  "sergeant major",
  "staff sergeant",
  "master sergeant",
  "first sergeant",
  "gunnery sergeant",
  "master gunnery sergeant",
  "technical sergeant",
  "chief master sergeant",
  "drill sergeant",
  "sergeant",
  "corporal",
  "chief warrant officer",
  "warrant officer",
  "second lieutenant",
  "first lieutenant",
  "lieutenant colonel",
  "lieutenant commander",
  "lieutenant junior grade",
  "major general",
  "brigadier general",
  "lieutenant general",
  "colonel",
  "rear admiral",
  "vice admiral",
  "admiral",
  "airman first class",
  "senior airman",
  "airman",
  "master chief petty officer",
  "chief petty officer",
  "petty officer",
  "green beret",
  "navy seal",
  "delta force",
  "army ranger",
];

const RANK_TERMS_CONTEXT_DEPENDENT = [
  "general",
  "major",
  "captain",
  "commander",
  "specialist",
  "private",
  "lieutenant",
  "ensign",
];

// A small, CLOSED set of civilian proper-noun titles that embed a Tier-1 rank
// word. Because these are fixed compound phrases (not an open pattern like
// "General <x>"), an allowlist is safe here — it cannot push a false positive
// onto some unrelated phrase the way a broad pattern would. Occurrences are
// blanked (length-preserving) before rank scanning.
const CIVILIAN_RANK_PHRASE_ALLOWLIST: RegExp[] = [
  /\bsergeants?[- ]at[- ]arms\b/gi,
  /\blieutenant governors?\b/gi,
  /\bkentucky colonels?\b/gi,
  /\bcolonel sanders\b/gi,
];

// ── Branch of service ──────────────────────────────────────────────────────
// "army" and "navy" are the only entries with a civilian collision worth
// guarding: "Salvation Army" (a real employer/volunteer org) and "navy blue"
// (a colour). Everything else here is unambiguous. Residual, accepted: a
// purely metaphorical "an army of volunteers" still matches.
const BRANCH_TERMS = [
  "u\\.?s\\.?\\s*army",
  "(?<!salvation\\s)\\barmy\\b",
  "\\bnavy\\b(?!\\s+blue\\b)",
  "\\bair force\\b",
  "\\bmarine corps\\b",
  "\\bmarines\\b",
  "\\bcoast guard\\b",
  "\\bspace force\\b",
  "\\bnational guard\\b",
  "\\bdepartment of the army\\b",
  "\\bdepartment of the navy\\b",
  "\\bdepartment of the air force\\b",
  "\\bspecial forces\\b",
];

// Everyday-English tokens that signal the text is genuinely about military
// service. Any ONE, anywhere in the scanned text, "arms" the Tier-2 rank
// words. Kept broad on purpose — a false arm here is harmless because the
// branch / Tier-1 term that armed it is itself already a violation.
const MILITARY_VOCAB = [
  "\\bmilitary\\b",
  "\\bservicemembers?\\b",
  "\\bservice members?\\b",
  "\\bactive[- ]duty\\b",
  "\\bveterans?\\b",
  "\\barmed forces\\b",
  "\\buniformed service\\b",
  "\\bwar ?fighters?\\b",
  "\\bdeployed\\b",
  "\\bdeployments?\\b",
  "\\bcombat (?:tour|deployment|zone|operations?|arms?)\\b",
  "\\binfantry\\b",
  "\\bplatoons?\\b",
  "\\bbattalions?\\b",
  "\\bbrigades?\\b",
  "\\bsquadrons?\\b",
  "\\bregiments?\\b",
  "\\bgarrison\\b",
  "\\benlisted\\b",
  "\\bnon[- ]commissioned officers?\\b",
  "\\bcommissioned officers?\\b",
  "\\bcourt[- ]martial\\b",
  "\\bdd[- ]?214\\b",
  "\\bgi bill\\b",
  "\\bbasic training\\b",
  "\\bboot camp\\b",
  "\\bmilitary occupational special", // "...ty" / "...ties" — MOS spelled out
  "\\bpay grade\\b",
  "\\b[ewo]-[1-9]\\b", // pay grades E-1..W-9..O-9
];

const MILITARY_CONTEXT_PATTERN = new RegExp(
  [
    ...BRANCH_TERMS,
    ...RANK_TERMS_UNAMBIGUOUS.map((t) => `\\b${escapeRegExp(t)}\\b`),
    ...MILITARY_VOCAB,
  ].join("|"),
  "i"
);

// Text immediately before a Tier-2 rank word that, on its own, makes the word
// a rank rather than a job title.
const RANK_ATTRIBUTION_BEFORE =
  /(?:rank of|ranked|promoted to|rose to(?: the rank of)?|held the rank of|attained the rank of|served as|serving as|commissioned as|retired as|decorated as)\s+(?:a |an |the )?$/i;

// ── Clearance sponsor / agency ─────────────────────────────────────────────
// Clearance LEVEL is an allowed capability fact ("holds an active Top Secret
// clearance"). The policy forbids naming who granted, sponsored, or
// investigated it.
//
// Spelled-out agency names are identifying on their own — flagged always.
// Bare acronyms and generic "<x> by" attributions are a disclosure ONLY when
// clearance language sits within ~80 characters. On their own they collide
// constantly with ordinary professional text:
//   CIA  → Certified Internal Auditor, Culinary Institute of America
//   DHS  → a state Department of Human / Health Services
//   DIA  → Denver International Airport (IATA code)
//   NGA  → National Governors Association, National Gallery of Art
//   OPM  → "other people's money"
//   "sponsored by" / "granted by" / "investigated by" → routine business prose
const CLEARANCE_AGENCY_NAMES = [
  "central intelligence agency",
  "national security agency",
  "federal bureau of investigation",
  "defense intelligence agency",
  "national geospatial[- ]intelligence agency",
  "national reconnaissance office",
  "defense counterintelligence and security agency",
  "diplomatic security service",
  "department of defense",
  "department of homeland security",
  "office of personnel management",
];

const CLEARANCE_CONTEXT_DEPENDENT = [
  "\\bnsa\\b",
  "\\bcia\\b",
  "\\bfbi\\b",
  "\\bdia\\b",
  "\\bnga\\b",
  "\\bnro\\b",
  "\\bdhs\\b",
  "\\bdod\\b",
  "\\bopm\\b",
  "\\bdcsa\\b",
  "granted by",
  "sponsored by",
  "investigated by",
  "adjudicated by",
  "background investigation (?:conducted |performed )?by",
  "cleared by",
];

const CLEARANCE_CONTEXT_PATTERN =
  /\b(?:clearances?|classified|declassified|top secret|ts\/sci|sci|secret clearance|security clearance|polygraph|special access program|compartmented|need[- ]to[- ]know|cleared for)\b/i;

// ── Publication reference ─────────────────────────────────────────────────
// Policy: never mention a publication, book, article, or other named authored
// work. Bare "authored" / "co-authored" was far too broad — "authored the
// quarterly compliance report", "co-authored 12 SOPs" are normal work product
// that names nothing. Require an authorship verb tied to a published-media
// noun, or the fixed phrase "published author" / "best-seller".
const PUBLICATION_PATTERN =
  /\b(?:co-?)?(?:authored|wrote|co-?wrote|published)\s+(?:(?:a|an|the|his|her|their|numerous|several|multiple|two|three|four|five|\d+)\s+)?(?:[a-z][a-z-]+\s+){0,2}(?:books?|novels?|memoirs?|articles?|papers?|op-?eds?|columns?|blogs?|publications?|textbooks?|white ?papers?|essays?|monographs?)\b|\bpublished author\b|\bbest[- ]sell(?:er|ing)\b/gi;

const PRONOUN_TERMS = ["he", "him", "his", "himself", "she", "her", "hers", "herself"];

// ── Outsider / deficit framing ─────────────────────────────────────────────
// Employer-facing generated text must read as a capable professional applying
// for a job — not as someone being brought into ordinary work from elsewhere.
// "civilian" and "military" have NO legitimate use in an anonymized capability
// summary: each word is only meaningful as the other's opposite, so using
// either one discloses the background every anonymity rule here exists to
// hide. The rest are deficit constructions ("bridge into", "sector
// acclimation", "must earn their way in", "step down"). The genuinely
// ambiguous words — "translate", "transition", "context" — are matched only
// next to a framing/deficit cue, not on every ordinary use ("translate
// strategy into results", "a systems transition", "brings industry context").
const OUTSIDER_FRAMING_ALWAYS = [
  "\\bcivilian\\b",
  "\\bmilitary\\b",
  "\\bacclimat(?:e|es|ed|ing|ion)\\b",
  "\\bre-?acclimat\\w*\\b",
  "\\bstep(?:ping)?[- ]down\\b",
  "\\bcareer transition\\b",
  "\\bbridg(?:e|es|ed|ing)\\s+(?:in)?to\\b",
  "\\bbridge\\s+(?:role|position|job|step)\\b",
  "\\bbridg(?:e|ing)\\s+(?:their|the|them|his|her|this candidate'?s?)\\s+(?:background|experience|gap|way|transition)\\b",
  "\\btransition(?:ing)?\\s+(?:in)?to\\s+(?:the\\s+)?(?:workforce|private[- ]sector|the private sector|corporate world|business world|commercial sector)\\b",
];

const OUTSIDER_FRAMING_CONTEXTUAL: { re: RegExp; near: RegExp; window: number }[] = [
  {
    re: /\btranslat(?:e|es|ed|ing|ion)\b/gi,
    near: /\b(?:experience|background|skills?|capabilit\w*|service|leadership|record|resume|history)\b/i,
    window: 45,
  },
  {
    re: /\btransition(?:s|ed|ing)?\b/gi,
    near: /\b(?:new sector|new field|new industry|the industry|corporate|commercial|workforce|private[- ]?sector|business world)\b/i,
    window: 40,
  },
  {
    re: /\b(?:sector|industry|corporate|commercial|business)\s+context\b/gi,
    near: /\b(?:need|needs|needed|lack|lacks|lacking|require|requires|required|missing|without|build|building|gain|gaining|acquire|acquiring|develop|developing|first|before)\b/i,
    window: 45,
  },
  {
    re: /\b(?:earn|earns|earned|earning|prove|proves|proved|proving)\b/gi,
    near: /\b(?:their way|the way|entry|a place|legitimacy|credibility|themselves|they can|their worth|their value|into the|belong)\b/i,
    window: 40,
  },
];

// Given-name tokens that are also ordinary English words. A lone occurrence of
// one of these is almost never the candidate; it is flagged only when another
// token of the same name also appears (see scanForKnownName).
const COMMON_WORD_NAME_STOPLIST = new Set([
  "will", "mark", "grace", "hope", "joy", "faith", "art", "rich", "dawn", "day",
  "may", "june", "april", "august", "chase", "hunter", "hunt", "drew", "brook",
  "brooke", "sky", "skye", "lane", "reed", "reid", "rose", "bill", "guy", "jack",
  "chuck", "frank", "gene", "bob", "rob", "van", "star", "summer", "autumn",
  "destiny", "angel", "sunny", "misty", "case", "reign", "royal", "legend",
  "king", "earl", "duke", "chip", "buddy", "red", "cliff", "dale", "penny",
  "carol", "wade", "kit", "colt", "chance", "major", "sergeant", "france",
  "sonny", "bunny", "true", "love", "song", "wren", "fox", "bear", "moon",
]);

function pushMatches(
  violations: TextGuardViolation[],
  text: string,
  category: TextGuardCategory,
  pattern: RegExp
) {
  for (const match of text.matchAll(pattern)) {
    violations.push({ category, match: match[0], index: match.index ?? -1 });
  }
}

// Returns the earliest pair of DISTINCT name tokens that occur within
// `windowChars` of each other, or null. Used for names made entirely of
// common words, where mere co-occurrence anywhere in a long paragraph is too
// weak a signal.
function partsCoOccurNearby(
  text: string,
  parts: string[],
  windowChars: number
): { index: number; label: string } | null {
  const hits: { part: string; index: number }[] = [];
  for (const p of parts) {
    for (const m of text.matchAll(new RegExp(`\\b${escapeRegExp(p)}\\b`, "gi"))) {
      hits.push({ part: p.toLowerCase(), index: m.index ?? 0 });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  for (let i = 0; i + 1 < hits.length; i++) {
    for (let j = i + 1; j < hits.length && hits[j].index - hits[i].index <= windowChars; j++) {
      if (hits[j].part !== hits[i].part) {
        return { index: hits[i].index, label: `${hits[i].part} … ${hits[j].part}` };
      }
    }
  }
  return null;
}

function scanForKnownName(
  violations: TextGuardViolation[],
  text: string,
  knownFullName: string
): void {
  const parts = knownFullName
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 1);
  if (parts.length === 0) return;

  const isDistinctive = (p: string) =>
    p.length >= 4 && !COMMON_WORD_NAME_STOPLIST.has(p.toLowerCase());
  const present = (p: string) => new RegExp(`\\b${escapeRegExp(p)}\\b`, "i").test(text);

  const distinctiveParts = parts.filter(isDistinctive);
  const anyDistinctivePresent = distinctiveParts.some(present);

  for (const part of parts) {
    if (isDistinctive(part)) {
      // An unusual token (surname, distinctive given name) is identifying on
      // its own.
      pushMatches(violations, text, "candidate_name", new RegExp(`\\b${escapeRegExp(part)}\\b`, "gi"));
    } else if (anyDistinctivePresent && present(part)) {
      // A common-word token counts once a distinctive token of the SAME name
      // is also in the text (e.g. "Will" alongside "Kowalski").
      pushMatches(violations, text, "candidate_name", new RegExp(`\\b${escapeRegExp(part)}\\b`, "gi"));
    }
  }

  // Name made entirely of common words (no distinctive token at all): only a
  // near co-occurrence of two of its tokens is enough to flag.
  if (distinctiveParts.length === 0 && parts.length >= 2) {
    const near = partsCoOccurNearby(text, parts, 40);
    if (near) {
      violations.push({ category: "candidate_name", match: near.label, index: near.index });
    }
  }
}

/**
 * Scans a piece of employer-facing text for the identity-disclosure patterns
 * this platform's policy forbids. Pass `knownFullName` whenever the actual
 * candidate name is available (every server-side generation call site has
 * it) — that turns the name check from a fuzzy heuristic into an exact,
 * low-false-positive match against the one name that actually matters for
 * that piece of text.
 */
export function scanEmployerFacingText(
  text: string,
  options?: { knownFullName?: string | null }
): TextGuardViolation[] {
  const violations: TextGuardViolation[] = [];
  if (!text) {
    return violations;
  }

  // Gendered pronouns — genuinely gendered, negligible civilian collision.
  pushMatches(violations, text, "gendered_pronoun", new RegExp(`\\b(${PRONOUN_TERMS.join("|")})\\b`, "gi"));

  // ── Military rank ────────────────────────────────────────────────────────
  // Blank the closed civilian-title allowlist first (length-preserving, so
  // match indices stay aligned with the original string).
  let rankScanText = text;
  for (const re of CIVILIAN_RANK_PHRASE_ALLOWLIST) {
    rankScanText = rankScanText.replace(re, (m) => " ".repeat(m.length));
  }

  const unambiguousRankRe = new RegExp(
    `\\b(${[...RANK_TERMS_UNAMBIGUOUS]
      .sort((a, b) => b.length - a.length)
      .map(escapeRegExp)
      .join("|")})\\b`,
    "gi"
  );
  pushMatches(violations, rankScanText, "military_rank", unambiguousRankRe);

  const militaryContext = MILITARY_CONTEXT_PATTERN.test(rankScanText);
  const contextRankRe = new RegExp(`\\b(${RANK_TERMS_CONTEXT_DEPENDENT.join("|")})\\b`, "gi");
  for (const m of rankScanText.matchAll(contextRankRe)) {
    const idx = m.index ?? 0;
    const before = rankScanText.slice(Math.max(0, idx - 48), idx);
    if (militaryContext || RANK_ATTRIBUTION_BEFORE.test(before)) {
      violations.push({ category: "military_rank", match: m[0], index: idx });
    }
  }

  // ── Branch of service ───────────────────────────────────────────────────
  pushMatches(violations, text, "branch_of_service", new RegExp(`(${BRANCH_TERMS.join("|")})`, "gi"));

  // ── Clearance sponsor / agency ─────────────────────────────────────────
  pushMatches(
    violations,
    text,
    "clearance_sponsor_or_agency",
    new RegExp(`(${CLEARANCE_AGENCY_NAMES.join("|")})`, "gi")
  );
  const clearanceCtxRe = new RegExp(`(${CLEARANCE_CONTEXT_DEPENDENT.join("|")})`, "gi");
  for (const m of text.matchAll(clearanceCtxRe)) {
    const idx = m.index ?? 0;
    const window = text.slice(Math.max(0, idx - 80), idx + m[0].length + 80);
    if (CLEARANCE_CONTEXT_PATTERN.test(window)) {
      violations.push({ category: "clearance_sponsor_or_agency", match: m[0], index: idx });
    }
  }

  // ── Explicit year ─────────────────────────────────────────────────────
  // Skip digits that are part of a currency amount or a longer number
  // ("$2000", "12000") rather than a standalone year. Residual, accepted: a
  // bare four-digit magnitude like "a team of 2000" still matches.
  pushMatches(violations, text, "explicit_year", /(?<![$£€\d,.\-])\b(19|20)\d{2}\b/g);

  // ── Tenure count ─────────────────────────────────────────────────────
  // "5 years of service" is a disclosure; "within 3-5 years" / "over the next
  // 2 years" in a growth timeline is not. A range ("3-5 years") is matched as
  // one unit (first alternative) so it is skipped as a whole, and the ~40
  // chars in front of each match are checked for forward-looking framing.
  const tenureRe =
    /\b\d{1,2}\s*(?:to|through|[-–])\s*\d{1,2}\+?[\s-]?years?\b|\b\d{1,2}\+?[\s-]?years?\b/gi;
  const forwardFraming =
    /\b(?:within|next|in|over the next|after|another|coming|following|upcoming|ensuing|by|first|initial|projected|targeting|target|expect|expects|anticipated|anticipating)\s+(?:the\s+)?(?:next\s+)?$/i;
  for (const m of text.matchAll(tenureRe)) {
    const idx = m.index ?? 0;
    const before = text.slice(Math.max(0, idx - 40), idx);
    if (!forwardFraming.test(before)) {
      violations.push({ category: "tenure_count", match: m[0], index: idx });
    }
  }

  // ── Publication reference ───────────────────────────────────────────
  pushMatches(violations, text, "publication_reference", PUBLICATION_PATTERN);

  // ── Outsider / deficit framing ─────────────────────────────────────
  pushMatches(
    violations,
    text,
    "outsider_framing",
    new RegExp(`(${OUTSIDER_FRAMING_ALWAYS.join("|")})`, "gi")
  );
  for (const { re, near, window } of OUTSIDER_FRAMING_CONTEXTUAL) {
    for (const m of text.matchAll(re)) {
      const idx = m.index ?? 0;
      const w = text.slice(Math.max(0, idx - window), idx + m[0].length + window);
      if (near.test(w)) {
        violations.push({ category: "outsider_framing", match: m[0], index: idx });
      }
    }
  }

  // ── Honorific + name ────────────────────────────────────────────────
  pushMatches(violations, text, "honorific_name", /\b(Mr|Mrs|Ms|Dr)\.\s+[A-Z][a-z]+/g);

  // ── Candidate's own name ──────────────────────────────────────────
  if (options?.knownFullName) {
    scanForKnownName(violations, text, options.knownFullName);
  }

  return violations;
}

export function isEmployerFacingTextSafe(text: string, options?: { knownFullName?: string | null }): boolean {
  return scanEmployerFacingText(text, options).length === 0;
}

export function formatViolations(violations: TextGuardViolation[]): string {
  return violations.map((violation) => `${violation.category}:"${violation.match}"`).join(", ");
}

// Loosely typed on purpose: this module has no Supabase dependency of its
// own, and accepting a minimal structural shape here (rather than importing
// SupabaseClient) keeps it usable from any server route without coupling to
// a specific client construction. "Fail loudly" is the whole point of this
// function, so every step below is wrapped so a logging failure can never
// mask the violation it's trying to report - the console.error always fires
// first, before either the DB write or the email attempt.
export async function reportTextGuardViolation({
  adminClient,
  sendEmailFn,
  route,
  field,
  userId,
  violations,
  text,
  severity = "high"
}: {
  adminClient: { from: (table: string) => { insert: (row: Record<string, unknown>) => PromiseLike<unknown> } };
  sendEmailFn: (args: { to: string; subject: string; html: string; text?: string }) => Promise<unknown>;
  route: string;
  field: string;
  userId: string;
  violations: TextGuardViolation[];
  text: string;
  severity?: "high" | "medium";
}): Promise<void> {
  const summary = formatViolations(violations);
  const message = `Employer text guard blocked "${field}": ${summary}`;
  console.error(`[employerTextGuard] ${message}`, { route, field, userId, violations, text });

  try {
    await adminClient.from("error_logs").insert({
      route,
      error_message: message,
      error_type: "privacy_violation",
      user_id: userId,
      severity,
      metadata: { field, violations, textPreview: text.slice(0, 500) }
    });
  } catch (err) {
    console.error("[employerTextGuard] Failed to write error_logs row", err);
  }

  if (severity !== "high") {
    return;
  }

  try {
    await sendEmailFn({
      to: "joel@workplacematchapp.com",
      subject: `WPM Alert - candidate identity guard blocked ${field}`,
      html: `<p><b>Route:</b> ${route}</p><p><b>Field:</b> ${field}</p><p><b>User:</b> ${userId}</p><p><b>Violations:</b> ${summary}</p>`,
      text: `Route: ${route}\nField: ${field}\nUser: ${userId}\nViolations: ${summary}`
    });
  } catch (err) {
    console.error("[employerTextGuard] Failed to send alert email", err);
  }
}
