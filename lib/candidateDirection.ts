// A candidate's direction: who they want to be hired as NEXT, set on their
// profile ("Where I'm heading"). Stored as candidate_profiles.direction.
//
// Direction is context, never evidence. It decides emphasis and the employer
// summary's THRIVES IN / GROWING INTO lines; it never adds a capability or a
// number. job_types and work_preference are still written from it (see
// directionCompatColumns) so older readers keep working.

import { OTHER_ROLE_FAMILY_ID, ROLE_FAMILY_BY_ID } from "@/lib/roleFamilies";

export type DirectionScope = "open_related" | "only_these";
export type WorkSetting = "remote" | "hybrid" | "onsite" | "open";

export type CandidateDirection = {
  // Role family ids from lib/roleFamilies.ts, plus "other" with otherFamily.
  roleFamilies: string[];
  otherFamily?: string;
  scope: DirectionScope;
  // Specific titles - only kept when scope is "only_these".
  titles?: string[];
  workSetting: WorkSetting;
  howIWantToWork?: string;
};

export const MAX_ROLE_FAMILIES = 5;
export const MAX_TITLES = 3;
export const HOW_I_WANT_TO_WORK_MAX = 160;
export const OTHER_FAMILY_MAX = 60;
export const TITLE_MAX = 60;

const WORK_SETTINGS: WorkSetting[] = ["remote", "hybrid", "onsite", "open"];

const clean = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");

// Validates and normalizes untrusted input. Returns the direction or a
// candidate-readable error.
export function normalizeDirection(raw: unknown): { direction: CandidateDirection } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Direction is required." };
  const r = raw as Record<string, unknown>;

  const ids = Array.isArray(r.roleFamilies) ? r.roleFamilies.filter((x): x is string => typeof x === "string") : [];
  const roleFamilies = [...new Set(ids)].filter((id) => id === OTHER_ROLE_FAMILY_ID || ROLE_FAMILY_BY_ID.has(id));
  const otherFamily = clean(r.otherFamily, OTHER_FAMILY_MAX);
  const families = roleFamilies.filter((id) => id !== OTHER_ROLE_FAMILY_ID || otherFamily);
  if (families.length === 0) return { error: "Choose at least one role family." };
  if (families.length > MAX_ROLE_FAMILIES) return { error: `Choose at most ${MAX_ROLE_FAMILIES} role families.` };

  const scope: DirectionScope = r.scope === "only_these" ? "only_these" : "open_related";
  const titles =
    scope === "only_these"
      ? [...new Set((Array.isArray(r.titles) ? r.titles : []).map((t) => clean(t, TITLE_MAX)).filter(Boolean))].slice(0, MAX_TITLES)
      : [];
  if (scope === "only_these" && titles.length === 0) return { error: "Add at least one role title, or choose \"Open to related roles\"." };

  const workSetting: WorkSetting = WORK_SETTINGS.includes(r.workSetting as WorkSetting) ? (r.workSetting as WorkSetting) : "open";
  const howIWantToWork = clean(r.howIWantToWork, HOW_I_WANT_TO_WORK_MAX);

  return {
    direction: {
      roleFamilies: families,
      ...(families.includes(OTHER_ROLE_FAMILY_ID) ? { otherFamily } : {}),
      scope,
      ...(scope === "only_these" ? { titles } : {}),
      workSetting,
      ...(howIWantToWork ? { howIWantToWork } : {}),
    },
  };
}

// A stored value read back from the database (already validated on write,
// but older or hand-edited rows are tolerated rather than trusted).
export function readStoredDirection(raw: unknown): CandidateDirection | null {
  if (!raw) return null;
  const result = normalizeDirection(raw);
  return "direction" in result ? result.direction : null;
}

export function roleFamilyLabels(direction: CandidateDirection): string[] {
  return direction.roleFamilies
    .map((id) => (id === OTHER_ROLE_FAMILY_ID ? direction.otherFamily ?? "" : ROLE_FAMILY_BY_ID.get(id)?.label ?? ""))
    .filter(Boolean);
}

// Stable form for comparing and hashing (key order and family order fixed).
export function canonicalDirection(direction: CandidateDirection | null): string {
  if (!direction) return "";
  return JSON.stringify({
    roleFamilies: [...direction.roleFamilies].sort(),
    otherFamily: direction.otherFamily ?? "",
    scope: direction.scope,
    titles: direction.scope === "only_these" ? [...(direction.titles ?? [])].sort() : [],
    workSetting: direction.workSetting,
    howIWantToWork: direction.howIWantToWork ?? "",
  });
}

// job_types / work_preference written alongside direction for readers that
// predate it. job_types holds the titles for "only these roles", otherwise the
// role family labels.
export function directionCompatColumns(direction: CandidateDirection): { job_types: string[]; work_preference: WorkSetting } {
  const jobTypes = direction.scope === "only_these" && direction.titles?.length ? direction.titles : roleFamilyLabels(direction);
  return { job_types: jobTypes, work_preference: direction.workSetting };
}

// Plain-text direction for prompts (scorers, alternate paths, Step 4). Always
// framed by the caller as context about what the person wants, not evidence.
export function formatDirectionForPrompt(direction: CandidateDirection): string {
  const lines = [`Target role families: ${roleFamilyLabels(direction).join("; ")}`];
  lines.push(
    direction.scope === "only_these"
      ? `Wants ONLY these specific roles: ${(direction.titles ?? []).join("; ")}`
      : "Open to related roles in these families (no single target title)"
  );
  lines.push(`Work setting: ${direction.workSetting}`);
  if (direction.howIWantToWork) lines.push(`How they want to work: ${direction.howIWantToWork}`);
  return lines.join("\n");
}

// The same, as a JSON-friendly object for scorers that send candidates as JSON.
export function directionForScoring(direction: CandidateDirection) {
  return {
    target_role_families: roleFamilyLabels(direction),
    open_to_related_roles: direction.scope === "open_related",
    ...(direction.scope === "only_these" ? { only_these_titles: direction.titles ?? [] } : {}),
    work_setting: direction.workSetting,
    ...(direction.howIWantToWork ? { how_they_want_to_work: direction.howIWantToWork } : {}),
  };
}

// ---------- employer summary checks ----------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const containsPhrase = (text: string, phrase: string) =>
  phrase.trim() !== "" && new RegExp(`\\b${escapeRe(phrase.trim().toLowerCase())}\\b`, "i").test(text);

// The selected role families that `text` names (by label or a match term).
export function familiesNamedIn(text: string, direction: CandidateDirection): string[] {
  const named: string[] = [];
  for (const id of direction.roleFamilies) {
    if (id === OTHER_ROLE_FAMILY_ID) {
      if (direction.otherFamily && containsPhrase(text, direction.otherFamily)) named.push(direction.otherFamily);
      continue;
    }
    const family = ROLE_FAMILY_BY_ID.get(id);
    if (family && [family.label, ...family.matchTerms].some((term) => containsPhrase(text, term))) named.push(family.label);
  }
  return named;
}

// Words that make a phrase a specific job title rather than a kind of work.
const TITLE_WORDS =
  /\b(?:chief|directors?|managers?|head of|vice presidents?|vps?|presidents?|officers?|coordinators?|specialists?|supervisors?|administrators?|analysts?|engineers?|technicians?|consultants?|recruiters?|coo|ceo|cfo|cto|cio|ciso)\b/gi;

export function findTitleWords(text: string): string[] {
  return [...new Set((text.match(TITLE_WORDS) ?? []).map((m) => m.toLowerCase()))];
}
