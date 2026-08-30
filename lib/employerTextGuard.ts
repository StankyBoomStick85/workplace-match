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

export type TextGuardCategory =
  | "candidate_name"
  | "honorific_name"
  | "gendered_pronoun"
  | "military_rank"
  | "branch_of_service"
  | "clearance_sponsor_or_agency"
  | "explicit_year"
  | "tenure_count"
  | "publication_reference";

export type TextGuardViolation = {
  category: TextGuardCategory;
  match: string;
  index: number;
};

const RANK_TERMS = [
  "private first class",
  "private",
  "specialist",
  "corporal",
  "sergeant first class",
  "staff sergeant",
  "master sergeant",
  "first sergeant",
  "sergeant major",
  "command sergeant major",
  "sergeant",
  "warrant officer",
  "chief warrant officer",
  "second lieutenant",
  "first lieutenant",
  "lieutenant colonel",
  "lieutenant commander",
  "lieutenant junior grade",
  "lieutenant",
  "captain",
  "major general",
  "brigadier general",
  "lieutenant general",
  "major",
  "colonel",
  "general",
  "ensign",
  "commander",
  "rear admiral",
  "vice admiral",
  "admiral",
  "airman first class",
  "senior airman",
  "airman",
  "technical sergeant",
  "chief master sergeant",
  "gunnery sergeant",
  "master gunnery sergeant",
  "petty officer",
  "chief petty officer",
  "master chief petty officer",
  "green beret",
  "navy seal",
  "delta force",
  "army ranger"
];

const BRANCH_TERMS = [
  "u\\.?s\\.?\\s*army",
  "\\barmy\\b",
  "\\bnavy\\b",
  "air force",
  "marine corps",
  "\\bmarines\\b",
  "coast guard",
  "space force",
  "national guard",
  "department of the army",
  "department of the navy",
  "department of the air force",
  "special forces"
];

// Clearance LEVEL is an allowed capability fact (e.g. "holds an active Top
// Secret clearance") — the policy only forbids naming who granted, sponsored,
// or investigated it. Only the sponsor/agency/investigator language is
// flagged here; clearance level words alone are never a violation.
const CLEARANCE_AGENCY_TERMS = [
  "\\bnsa\\b",
  "\\bcia\\b",
  "\\bfbi\\b",
  "\\bdia\\b",
  "\\bnga\\b",
  "\\bnro\\b",
  "\\bdhs\\b",
  "\\bdod\\b",
  "department of defense",
  "department of homeland security",
  "office of personnel management",
  "\\bopm\\b",
  "granted by",
  "sponsored by",
  "investigated by",
  "background investigation conducted by",
  "adjudicated by"
];

const PRONOUN_TERMS = ["he", "him", "his", "himself", "she", "her", "hers", "herself"];

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

  pushMatches(violations, text, "gendered_pronoun", new RegExp(`\\b(${PRONOUN_TERMS.join("|")})\\b`, "gi"));
  pushMatches(violations, text, "military_rank", new RegExp(`\\b(${RANK_TERMS.join("|")})\\b`, "gi"));
  pushMatches(violations, text, "branch_of_service", new RegExp(`(${BRANCH_TERMS.join("|")})`, "gi"));
  pushMatches(
    violations,
    text,
    "clearance_sponsor_or_agency",
    new RegExp(`(${CLEARANCE_AGENCY_TERMS.join("|")})`, "gi")
  );
  pushMatches(violations, text, "explicit_year", /\b(19|20)\d{2}\b/g);
  pushMatches(violations, text, "tenure_count", /\b\d{1,2}\+?[\s-]?years?\b/gi);
  pushMatches(
    violations,
    text,
    "publication_reference",
    /\b(authored|co-authored|wrote a book|published a book|wrote the book|self-published)\b/gi
  );
  pushMatches(violations, text, "honorific_name", /\b(Mr|Mrs|Ms|Dr)\.\s+[A-Z][a-z]+/g);

  if (options?.knownFullName) {
    const nameParts = options.knownFullName
      .split(/\s+/)
      .map((part) => part.trim())
      .filter((part) => part.length > 1);
    for (const part of nameParts) {
      pushMatches(violations, text, "candidate_name", new RegExp(`\\b${escapeRegExp(part)}\\b`, "gi"));
    }
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
