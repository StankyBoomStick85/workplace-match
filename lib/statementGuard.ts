// Expanded text guard for Tier 1 capability statements and niche capabilities
// ONLY. capability_entries keep using lib/employerTextGuard.ts unchanged.
//
// Statements are the text that replaces capability_entries on employer views
// (Phase 2), and their whole point is TRANSLATE, DON'T STRIP: a service term
// must never appear (that is "listing"), but its meaning must survive in
// civilian words. So this guard is deliberately stricter than the employer
// guard. On top of every scanEmployerFacingText category it blocks award and
// badge names, school and qualification names, specialty codes, unit
// designators, evaluation document types, operation names, locations, and a
// fixed list of service vocabulary. A hit sends the statement back to the
// model with the exact phrase named (see lib/capabilityStatements.ts); it is
// never silently stripped.
//
// One deliberate relaxation versus the employer guard: a calendar year is
// allowed when it is the END DATE of a time-limited fact ("clearance expires
// 2029"), because the statement rules require that end date to be stated.

import { scanEmployerFacingText, type TextGuardViolation } from "@/lib/employerTextGuard";

export type StatementGuardCategory =
  | TextGuardViolation["category"]
  | "award_name"
  | "school_or_qualification"
  | "specialty_code"
  | "unit_designator"
  | "document_type"
  | "operation_name"
  | "location"
  | "service_term"
  | "dating_event"
  | "core_only_term";

export type StatementGuardViolation = {
  category: StatementGuardCategory;
  match: string;
  index: number;
};

// ---------- term lists (exported so the added terms can be reported) ----------

// Named awards, medals, badges, tabs. Case-insensitive. A capitalized
// "<Something> Medal/Badge/Tab/Ribbon/Cross" phrase is also caught by
// AWARD_NAME_SHAPE below, so this list is the safety net for lower-cased or
// abbreviated forms.
export const AWARD_TERMS = [
  "bronze star", "silver star", "purple heart", "legion of merit", "meritorious service medal",
  "commendation medal", "achievement medal", "good conduct medal", "national defense service medal",
  "campaign medal", "service medal", "unit award", "unit citation", "valorous unit", "superior unit",
  "combat infantryman badge", "combat action badge", "combat action ribbon", "expert infantryman badge",
  "parachutist badge", "jump wings", "special forces tab", "ranger tab", "sapper tab", "president's hundred tab",
  "distinguished service cross", "navy cross", "air force cross", "air medal", "army service ribbon",
  "overseas service ribbon", "professional development ribbon", "marksmanship badge", "expert marksman",
  "arcom", "acm", "aam", "msm", "cib", "cab", "eib", "v device",
];

// Capitalized award-shaped proper names ("Joint Service Achievement Medal").
const AWARD_NAME_SHAPE = /\b(?:[A-Z][a-z]+\s+){1,5}(?:Medal|Badge|Tab|Ribbon|Cross)\b/g;

export const SCHOOL_AND_QUALIFICATION_TERMS = [
  "sfqc", "q course", "q-course", "qualification course", "sfas", "assessment and selection",
  "selection course", "ranger school", "airborne school", "air assault", "pathfinder", "sere",
  "jumpmaster", "jump master", "halo", "haho", "military free fall", "static line", "static-line", "master breacher",
  "advanced leader course", "advanced leaders course", "senior leader course", "senior leaders course",
  "basic leader course", "master leader course", "master leaders course", "warrior leader course",
  "alc", "slc", "blc", "mlc", "wlc", "sfauc", "solt", "dlpt", "dlab", "opi", "jfkswcs", "swcs",
  "recruiter course", "joint fires observer", "jfo", "jtac", "acft", "apft", "cmms",
  "lethal operators", "lone operators", "senior mountaineering", "special operations language training",
];

// Units, commands, and command areas. Case-insensitive, word-bounded.
export const UNIT_DESIGNATOR_TERMS = [
  "sfg", "sfg(a)", "special forces group", "sfod", "sfod-a", "sfod-b", "oda", "odb", "det",
  "usasoc", "socom", "ussocom", "jsoc", "usarec", "tradoc", "forscom", "eucom", "centcom",
  "africom", "indopacom", "southcom", "northcom", "aor", "area of responsibility", "nato",
  "arsof", "sof", "hhc", "fist", "cft",
];

// Ordinal + formation designators ("3rd Battalion", "10th Group", "3/10th").
const UNIT_DESIGNATOR_SHAPES = [
  /\b\d{1,3}(?:st|nd|rd|th)\s+(?:special forces|sfg|group|battalion|brigade|division|regiment|infantry|airborne|ranger|cavalry|marines?|fleet|wing|squadron|corps)\b/gi,
  /\b\d{1,2}\/\d{1,3}(?:st|nd|rd|th)\b/gi,
  /\b(?:alpha|bravo|charlie|delta|echo|headquarters)\s+company\b/gi,
  // Letter companies only as written in unit style ("A Company"), so the
  // sentence "A company grew..." is not a unit.
  /\b[A-D]\s+Company\b/g,
];

export const DOCUMENT_TYPE_TERMS = [
  "ncoer", "oer", "noncommissioned officer evaluation", "officer evaluation report", "evaluation report",
  "epr", "opr", "fitrep", "fitness report", "award order", "dd-214", "dd214", "dd 214", "erb", "orb",
];

// Named operations, exercises and their abbreviations.
export const OPERATION_TERMS = [
  "oif", "oef", "oir", "ofs", "iraqi freedom", "enduring freedom", "inherent resolve", "freedom's sentinel",
  "atlantic resolve", "trojan footprint", "have ace", "jcet", "joint combined exchange training",
];
const OPERATION_SHAPES = [/\b(?:Operation|Exercise|Task Force)\s+[A-Z][A-Za-z]+/g, /\bTF\s?\d+\b/g];

// Service vocabulary that may never appear in a statement, whatever it means
// in context. "military" and "civilian" are already blocked by the employer
// guard; they are not repeated here.
export const SERVICE_TERMS = [
  "enlisted", "nco", "ncos", "ncoic", "noncommissioned", "non-commissioned", "sergeant", "sergeants",
  "warrant", "battalion", "battalions", "special operations", "special operator", "green beret",
  "green berets", "veteran", "veterans", "embassy", "embassies", "soldier", "soldiers", "troops",
  "platoon", "squad", "brigade", "regiment", "commissioned officer", "pay grade", "mos", "afsc",
  "chain of command", "commander's intent", "warrior ethos", "army values",
  // Added after the 2026-10-22 comparison run surfaced them in otherwise-clean output.
  "enemy", "enemies", "lethality", "sniper", "snipers", "airborne", "defense department", "defense-department",
  "department of defense",
  // Added 2026-10-22 at Joel's direction after reviewing the Fable/Sonnet comparison.
  "commander", "commanders", "on-scene commander", "theater", "theatre", "theaters", "hostile", "hostiles",
  "coalition", "infantry", "intelligence agency", "intelligence agencies", "intelligence organization",
  "intelligence community",
];

// "commands" as organizations ("two higher commands", "across multiple
// commands", "two levels of command"). The verb ("Commands respect") is fine.
const COMMANDS_AS_ORGS = [
  /\b(?:\d+|two|three|four|five|several|multiple|many|higher|sister|other|both|all|various|senior|subordinate|adjacent|separate|different)\s+(?:higher\s+)?commands\b/gi,
  /\b(?:across|between|among)\s+(?:the\s+)?commands\b/gi,
  /\blevels? of command\b/gi,
  /\bcommand (?:team|staff|level|headquarters|group|element)\b/gi,
];

// Named historical events that date the work. "pandemic" is included because
// it dates the work as surely as the name does.
export const DATING_EVENT_TERMS = [
  "covid", "covid-19", "covid19", "coronavirus", "sars-cov-2", "pandemic", "9/11", "september 11",
  "september 11th", "y2k", "brexit", "arab spring", "gulf war", "desert storm", "desert shield", "cold war",
  "global war on terror", "global war on terrorism", "gwot", "great recession",
  "deepwater horizon", "fall of kabul", "ebola outbreak", "ebola crisis",
];
const DATING_EVENT_SHAPES = [/\bHurricane\s+[A-Z][a-z]+/g, /\b(?:Super)?[Ss]torm\s+[A-Z][a-z]+/g];

// Blocked in CORE statements only (statement and proof lines): core
// statements use the vocabulary a civilian hiring manager uses. Niche skills
// may keep a technical term when the skill itself is technical (fire
// coordination, explosives work), so these are not in the shared lists above.
const CORE_ONLY_TERMS =
  /\b(?:combat|assault(?:s|ed|ing)?|operators?|valou?r(?:ous)?|service records?)\b/gi;

// "company" is an ordinary business word; it is only a unit when used like one.
const COMPANY_AS_UNIT = [
  /\bcompany[- ](?:command|commander|level|grade|headquarters|first sergeant|formation|staff|area)\b/gi,
  /\bcompany of (?:about |roughly |nearly |over |more than )?\d+\s+(?:soldiers|troops|personnel)\b/gi,
  /\b(?:rifle|infantry|engineer|support|line|airborne)\s+company\b/gi,
];

// Pay grades and rank abbreviations. The employer guard treats "E-7" only as
// context for other rank words; here it is a violation on its own, plural
// included ("top 3% of E-7s"). Abbreviations count only in capitals.
const PAY_GRADE = /\b[EWO]-?[1-9]s?\b/g;
export const RANK_ABBREVIATIONS = [
  "pvt", "pfc", "spc", "cpl", "sgt", "ssg", "sfc", "msg", "1sg", "sgm", "csm", "wo1", "cw2", "cw3", "cw4", "cw5",
  "2lt", "1lt", "cpt", "maj", "ltc", "col",
];

// Specialty codes: "18C", "13F", "79R", "11B", "0311", "3D1X2". The two-digit
// form is only flagged when nothing else explains it - never after "$", never
// with a K/M/B magnitude letter - and only with specialty context nearby or
// in the 18-series. The explicit "MOS 18C" / "AFSC 3D1" form always counts.
const SPECIALTY_EXPLICIT = /\b(?:MOS|AFSC|NEC|military occupational specialty)\b\s*[:#]?\s*\w+/g;
// Uppercase only (codes are written that way); K, M and B are excluded so
// "$12M" / "50K" are never read as codes.
const SPECIALTY_SHAPE = /(?<![$\d.,])\b\d{2}[AC-JLN-Z](?![a-z])\d?\b/g;
const SPECIALTY_CONTEXT = /\b(?:specialty|specialist|qualified|code|designat\w*|engineer|operator|sergeant|medic|trained as|served as)\b/i;

// Countries, US states, and regions. Language names ("Russian") are allowed -
// a language is a skill, a place is a location.
export const LOCATION_TERMS = [
  // countries
  "afghanistan", "albania", "algeria", "angola", "argentina", "armenia", "australia", "austria", "azerbaijan",
  "bahrain", "bangladesh", "belarus", "belgium", "bolivia", "bosnia", "botswana", "brazil", "bulgaria",
  "burkina faso", "cambodia", "cameroon", "canada", "chad", "chile", "china", "colombia", "congo", "croatia",
  "cuba", "cyprus", "czech republic", "czechia", "denmark", "djibouti", "ecuador", "egypt", "el salvador",
  "eritrea", "estonia", "ethiopia", "finland", "france", "georgia", "germany", "ghana", "greece", "guatemala",
  "haiti", "honduras", "hungary", "iceland", "india", "indonesia", "iran", "iraq", "ireland", "israel", "italy",
  "jamaica", "japan", "jordan", "kazakhstan", "kenya", "korea", "kosovo", "kuwait", "kyrgyzstan", "laos",
  "latvia", "lebanon", "liberia", "libya", "lithuania", "luxembourg", "macedonia", "madagascar", "malaysia",
  "mali", "mauritania", "mexico", "moldova", "mongolia", "montenegro", "morocco", "mozambique", "myanmar",
  "nepal", "netherlands", "new zealand", "nicaragua", "niger", "nigeria", "norway", "oman", "pakistan",
  "panama", "paraguay", "peru", "philippines", "poland", "portugal", "qatar", "romania", "russia", "rwanda",
  "saudi arabia", "senegal", "serbia", "sierra leone", "singapore", "slovakia", "slovenia", "somalia",
  "south africa", "south sudan", "spain", "sri lanka", "sudan", "sweden", "switzerland", "syria", "taiwan",
  "tajikistan", "tanzania", "thailand", "tunisia", "turkey", "turkmenistan", "uganda", "ukraine",
  "united arab emirates", "uae", "united kingdom", "uk", "united states", "uruguay", "uzbekistan",
  "venezuela", "vietnam", "yemen", "zambia", "zimbabwe",
  // US states (Georgia is listed above)
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland",
  "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada",
  "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio",
  "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee",
  "texas", "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming",
  // regions and well-known installations
  "europe", "middle east", "africa", "asia", "baltic", "baltics", "balkans", "eastern europe", "caucasus",
  "central asia", "latin america", "south america", "pacific", "fort carson", "ft carson", "fort bragg",
  "fort liberty", "fort campbell", "fort lewis",
  // adjectival region forms and the home country (an "Eastern European markets" tag
  // or "US and allied forces" places the person as surely as a country name)
  "european", "eastern european", "middle eastern", "african", "asian", "balkan", "u.s.", "us", "usa",
];

// ---------- scanning ----------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termListRegex(terms: string[]): RegExp {
  const body = [...terms]
    .sort((a, b) => b.length - a.length)
    .map((t) => {
      const e = escapeRegExp(t);
      return (/^\w/.test(t) ? "\\b" : "") + e + (/\w$/.test(t) ? "\\b" : "");
    })
    .join("|");
  return new RegExp(`(?:${body})`, "gi");
}

const AWARD_RE = termListRegex(AWARD_TERMS);
const SCHOOL_RE = termListRegex(SCHOOL_AND_QUALIFICATION_TERMS);
const UNIT_RE = termListRegex(UNIT_DESIGNATOR_TERMS);
const DOCUMENT_RE = termListRegex(DOCUMENT_TYPE_TERMS);
const OPERATION_RE = termListRegex(OPERATION_TERMS);
const SERVICE_RE = termListRegex(SERVICE_TERMS);
const DATING_EVENT_RE = termListRegex(DATING_EVENT_TERMS);
const LOCATION_RE = termListRegex(LOCATION_TERMS);
const RANK_ABBREV_RE = termListRegex(RANK_ABBREVIATIONS);

// Short all-caps abbreviations that collide with ordinary words when matched
// case-insensitively ("det" in "det." is rare, but "aor"/"alc"/"cab"/"halo"
// can be ordinary words). These only count when written in capitals.
const CAPS_ONLY = new Set([
  "acm", "aam", "msm", "cab", "cib", "eib", "alc", "slc", "blc", "mlc", "wlc", "opi", "halo", "haho", "jfo",
  "oda", "odb", "det", "aor", "sof", "hhc", "fist", "cft", "uk", "uae", "oif", "oef", "oir", "ofs", "nco",
  "ncos", "mos", "afsc", ...RANK_ABBREVIATIONS, "epr", "opr", "erb", "orb", "oer", "acft", "apft", "sere", "cmms", "nato", "us", "usa",
]);

function push(out: StatementGuardViolation[], category: StatementGuardCategory, text: string, re: RegExp) {
  for (const m of text.matchAll(re)) {
    const word = m[0];
    if (CAPS_ONLY.has(word.toLowerCase()) && word !== word.toUpperCase()) continue;
    out.push({ category, match: word, index: m.index ?? 0 });
  }
}

const YEAR_END_DATE_BEFORE = /\b(?:expir\w*|valid (?:through|until)|current through|eligible through|through|until|ends?|lapses?)\b[^.;]{0,25}$/i;

// Core statements get one extra rule on top of scanStatementText.
export function scanCoreOnlyText(text: string): StatementGuardViolation[] {
  if (!text) return [];
  return Array.from(text.matchAll(CORE_ONLY_TERMS), (m) => ({ category: "core_only_term" as const, match: m[0], index: m.index ?? 0 }));
}

export function scanStatementText(text: string, options?: { knownFullName?: string | null }): StatementGuardViolation[] {
  if (!text) return [];
  const out: StatementGuardViolation[] = [];

  for (const v of scanEmployerFacingText(text, options)) {
    if (v.category === "explicit_year" && YEAR_END_DATE_BEFORE.test(text.slice(Math.max(0, v.index - 40), v.index))) continue;
    out.push(v);
  }

  push(out, "award_name", text, AWARD_RE);
  push(out, "award_name", text, AWARD_NAME_SHAPE);
  push(out, "school_or_qualification", text, SCHOOL_RE);
  push(out, "unit_designator", text, UNIT_RE);
  for (const re of UNIT_DESIGNATOR_SHAPES) push(out, "unit_designator", text, re);
  for (const re of COMPANY_AS_UNIT) push(out, "unit_designator", text, re);
  push(out, "document_type", text, DOCUMENT_RE);
  push(out, "operation_name", text, OPERATION_RE);
  for (const re of OPERATION_SHAPES) push(out, "operation_name", text, re);
  push(out, "service_term", text, SERVICE_RE);
  push(out, "military_rank", text, PAY_GRADE);
  push(out, "military_rank", text, RANK_ABBREV_RE);
  push(out, "location", text, LOCATION_RE);
  for (const re of COMMANDS_AS_ORGS) push(out, "unit_designator", text, re);
  push(out, "dating_event", text, DATING_EVENT_RE);
  for (const re of DATING_EVENT_SHAPES) push(out, "dating_event", text, re);

  push(out, "specialty_code", text, SPECIALTY_EXPLICIT);
  for (const m of text.matchAll(SPECIALTY_SHAPE)) {
    const idx = m.index ?? 0;
    const around = text.slice(Math.max(0, idx - 60), idx + m[0].length + 60);
    if (m[0].startsWith("18") || SPECIALTY_CONTEXT.test(around)) {
      out.push({ category: "specialty_code", match: m[0], index: idx });
    }
  }

  // De-duplicate overlapping hits of the same span (e.g. "Bronze Star Medal"
  // caught by both the list and the shape).
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.index - b.index)
    .filter((v) => {
      const key = `${v.category}\u0000${v.index}\u0000${v.match.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

// Plain-language rewrite instruction per category, for the targeted retry.
export const STATEMENT_GUARD_CORRECTIONS: Record<string, string> = {
  recruiting_officer_term: "Do not say \"officer production\" or \"officer recruiting\". Say \"recruiting targets\".",
  oversight_office: "Do not name an oversight office such as an inspector general. Say \"an external compliance audit\".",
  candidate_name: "Never include the person's name or initials.",
  honorific_name: "Never use an honorific with a name.",
  gendered_pronoun: "Use no pronouns at all - plain present tense with no subject.",
  military_rank: "Do not state any rank. Translate the scope of responsibility for the organization the evidence describes.",
  branch_of_service: "Do not name any branch of service or organization. Describe the work itself.",
  clearance_sponsor_or_agency: "Do not name any agency. A clearance may be stated only with its expiration date, never who granted it.",
  explicit_year: "Do not state a calendar year, except the expiration date of a time-limited fact.",
  tenure_count: "Do not state years of service or tenure. Use the scale and outcome of the work instead.",
  publication_reference: "Do not mention any publication, book, or article.",
  outsider_framing: "Do not use the words \"military\" or \"civilian\" or any transition framing.",
  award_name: "Never name an award, medal, badge, or tab. State only how many, and what the recognition was for in plain words.",
  school_or_qualification: "Never name a school, course, or qualification. Describe what it proves the person can do (e.g. \"completed a highly selective multi-year training pipeline\").",
  specialty_code: "Never use a specialty code. Describe the specialty in plain words.",
  unit_designator: "Never name a unit, command, or command area. Describe the organization by size and what it does.",
  document_type: "Never name an evaluation document type. Say \"annual performance reviews\" or \"independent senior evaluators\" instead.",
  operation_name: "Never name an operation or exercise. Describe the type of environment instead.",
  location: "Never name a country, state, region, or installation. Describe the environment (e.g. \"austere international settings\").",
  dating_event: "Never name a historical event that dates the work (e.g. a pandemic). Describe the situation instead (\"a prolonged organization-wide crisis\").",
  core_only_term:
    "Core statements use the vocabulary a civilian hiring manager uses: \"under direct threat\" not \"combat\", \"specialists\" not \"operators\", \"official records\" not \"service record\"; no \"assault\" or \"valor\" (say what was done and that it was formally recognized).",
  service_term: "Do not use this service term. Carry its meaning across in plain business words - translate it, do not just delete it.",
};
