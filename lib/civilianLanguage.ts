// The guiding principle and civilian-language rules shared by the employer
// summary and capability statement prompts, plus the deterministic part of
// those rules as a check (setting words, "operation" as a countable noun).

export const GUIDING_PRINCIPLE = `GUIDING PRINCIPLE: The reader must see this person's real capability, translated into the language of the business world, never their veteran status. Military background is evidence, not identity. Never inflate and never invent. Lead with where the person genuinely thrives and where their interest and drive show. Frame gaps as growth: the next skill to build or the role that would develop them, not a verdict. Every person has strengths; find them in the evidence and say them plainly.`;

export const CIVILIAN_LANGUAGE_RULES = `CIVILIAN LANGUAGE:
- Describe the work the way a civilian manager would describe the same responsibility, keeping every number. Test each line: would it read naturally on a resume at a civilian company in that field?
- Drop words that reveal the setting without adding meaning: "high-risk" and "high-threat" (say "zero room for error" when the stakes matter), "ground leader" ("led" already says it), "no capability loss" (say "zero losses" or "no disruption"), "cross-border" (say "international").
- "Operation" as a countable thing is military vocabulary. Translate it by what it was: a time-bound effort with a goal is a project, assignment, or initiative; moving people or equipment is a shipment, move, or delivery; an event with a start and end is an event or exercise. "Operations" as a business FUNCTION (operations leadership, director of operations) is fine.
- Examples of the target:
  "Led 14 time-critical projects with a 100% success rate, no supervision, and zero room for error."
  "Led transport teams moving people and high-value equipment by road and air across multiple countries for 8 months, with zero losses."`;

export type SettingLanguageHit = { match: string; rewrite: string };

const SETTING_WORDS: Array<{ re: RegExp; rewrite: string }> = [
  { re: /\bhigh[\s-]risk\b/gi, rewrite: 'drop it, or say "zero room for error" when the stakes matter' },
  { re: /\bhigh[\s-]threat\b/gi, rewrite: 'drop it, or say "zero room for error" when the stakes matter' },
  { re: /\bground leader\b/gi, rewrite: 'drop it: "led" already says it' },
  { re: /\b(?:no|zero|without)\s+(?:loss of\s+)?capability(?:\s+loss)?\b/gi, rewrite: 'say "zero losses" or "no disruption"' },
  { re: /\bcross[\s-]border\b/gi, rewrite: 'say "international"' },
];

const NUMBER_WORDS =
  "\\d[\\d,.]*\\+?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|several|multiple|many|numerous|dozens of|hundreds of|each|every|an";

// "15 logistics operations", "an operation", "each operation": a count of
// operations. "operations leadership" / "day-to-day operations" (a function)
// never matches - there is no count in front of it.
// "an operations leader" / "two operations roles" name the function, not a
// count of operations, so a following function noun excludes the match.
const COUNTABLE_OPERATION = new RegExp(
  `\\b(?:${NUMBER_WORDS})\\s+(?:[a-z][\\w-]*\\s+){0,2}?operations?\\b(?!\\s+(?:leadership|leaders?|management|managers?|directors?|roles?|teams?|functions?|staff|support|centers?|centres?|experience|background)\\b)`,
  "gi"
);

export function findSettingLanguage(text: string): SettingLanguageHit[] {
  const hits: SettingLanguageHit[] = [];
  const seen = new Set<string>();
  const add = (match: string, rewrite: string) => {
    const key = match.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ match, rewrite });
  };
  for (const { re, rewrite } of SETTING_WORDS) {
    for (const m of text.matchAll(re)) add(m[0], rewrite);
  }
  for (const m of text.matchAll(COUNTABLE_OPERATION)) {
    add(m[0], 'translate "operation" by what it was: project, assignment, or initiative; shipment, move, or delivery; or event or exercise');
  }
  return hits;
}

export function describeSettingLanguage(hits: SettingLanguageHit[]): string {
  return hits.map((h) => `"${h.match}" (${h.rewrite})`).join("; ");
}
