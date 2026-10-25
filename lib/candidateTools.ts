// Named tools, software, and platforms a candidate uses, extracted from each
// document as its own list - no number required, unlike evidence claims. A
// "Tools and systems" table used to be dropped entirely by claim extraction
// (2026-10-25: Salesforce, daily use, vanished), which let the employer
// summary's GAP claim the candidate had no CRM experience.
//
// Per document: StoredDoc.tools / toolsStatus (lib/capabilityPipeline.ts).
// Per candidate: candidate_profiles.tools, the de-duplicated union across the
// candidate's current documents (collectCandidateTools).

import type Anthropic from "@anthropic-ai/sdk";

export const TOOLS_MODEL = "claude-sonnet-4-6";
export const MAX_CANDIDATE_TOOLS = 40;
const MAX_TEXT_CHARS = 60_000;

const TOOLS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tools"],
  properties: { tools: { type: "array", items: { type: "string" } } },
};

export function buildToolsPrompt(documentText: string): string {
  return `List every named tool, software product, platform, system, or portal this document says the person uses or has used: CRMs, ERPs, applicant tracking systems, office suites, analytics and BI tools, programming languages, cloud platforms, procurement or quoting portals, and the like.

Rules:
- Names only, as written in the document (e.g. "Salesforce", "Microsoft 365", "Govly"). One entry per tool.
- Include tools from tables, lists, and running text alike.
- Do not include skills, methods, certifications, job titles, organizations, or generic categories ("CRM", "spreadsheets") unless a specific product is named.
- If the document names no tools, return an empty list.

Return only the JSON object.

DOCUMENT:
${documentText.slice(0, MAX_TEXT_CHARS)}`;
}

export function parseToolsOutput(raw: string): string[] | null {
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };
  const obj = tryParse(raw.trim()) ?? tryParse(raw.match(/\{[\s\S]*\}/)?.[0] ?? "");
  if (!obj || !Array.isArray(obj.tools)) return null;
  return dedupeTools(obj.tools.filter((t: unknown): t is string => typeof t === "string"));
}

export function dedupeTools(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/\s+/g, " ").trim().slice(0, 60);
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

// One model call per document. Never throws: a failure is reported as status.
export async function extractDocumentTools(
  anthropic: Anthropic,
  documentText: string
): Promise<{ tools: string[]; status: "complete" | "failed" }> {
  if (!documentText.trim()) return { tools: [], status: "complete" };
  try {
    const params = {
      model: TOOLS_MODEL,
      max_tokens: 1024,
      temperature: 0,
      messages: [{ role: "user" as const, content: buildToolsPrompt(documentText) }],
      output_config: { format: { type: "json_schema" as const, schema: TOOLS_SCHEMA } },
    };
    const message = await anthropic.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming);
    const text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const tools = parseToolsOutput(text);
    return tools ? { tools, status: "complete" } : { tools: [], status: "failed" };
  } catch (err) {
    console.error("[candidateTools] tool extraction failed", err);
    return { tools: [], status: "failed" };
  }
}

// The candidate's tools: union across their current documents.
export function collectCandidateTools(docs: Array<{ tools?: unknown }>): string[] {
  return dedupeTools(docs.flatMap((d) => (Array.isArray(d.tools) ? d.tools.filter((t): t is string => typeof t === "string") : []))).slice(
    0,
    MAX_CANDIDATE_TOOLS
  );
}

// ---------- GAP verification ----------

// Categories a GAP line might name, with products that prove the category.
const TOOL_CATEGORIES: Array<{ re: RegExp; members: string[] }> = [
  {
    re: /\bCRMs?\b|customer relationship management/i,
    members: ["Salesforce", "HubSpot", "Microsoft Dynamics", "Dynamics 365", "Zoho", "Pipedrive", "SugarCRM", "Freshsales", "Insightly", "Copper", "Zendesk Sell"],
  },
  {
    re: /\bATS\b|applicant tracking/i,
    members: ["Greenhouse", "Lever", "Workday", "iCIMS", "Taleo", "SmartRecruiters", "Jobvite", "Bullhorn", "BambooHR", "JazzHR", "Ashby"],
  },
  {
    re: /\bERPs?\b|enterprise resource planning/i,
    members: ["SAP", "Oracle", "NetSuite", "Microsoft Dynamics", "Dynamics 365", "Infor", "Epicor", "Sage", "Odoo", "Workday"],
  },
  {
    re: /\b(?:project management (?:software|tools?|platforms?)|PM tools?)\b/i,
    members: ["Jira", "Asana", "Trello", "Monday.com", "Smartsheet", "Microsoft Project", "ClickUp", "Wrike", "Basecamp"],
  },
  {
    re: /\b(?:BI tools?|business intelligence|dashboarding)\b/i,
    members: ["Power BI", "Tableau", "Looker", "Qlik"],
  },
  {
    re: /\b(?:Microsoft Office|Office 365|Microsoft 365|office suite|Excel|spreadsheets?)\b/i,
    members: ["Microsoft 365", "Office 365", "Microsoft Office", "Excel"],
  },
];

// Capitalized words a GAP uses that are not names of tools or skills.
const GENERIC_CAPITALIZED = new Set(
  "director operations manager chief officer president program project management leadership business development executive commercial technology enterprise certification certified professional formal title role company industry sector private public it hands-on experience has have not yet no lacks would benefit from a an the with in on for of and or to".split(" ")
);
const TITLE_ACRONYMS = new Set(["COO", "CEO", "CFO", "CTO", "CIO", "CISO", "VP", "SVP", "EVP", "GM"]);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const mentions = (text: string, name: string) => new RegExp(`(?:^|[^A-Za-z0-9])${escapeRe(name)}(?:$|[^A-Za-z0-9])`, "i").test(text);

// What a GAP line names that the evidence or tools list shows the candidate
// already has. Empty when the gap is genuine.
export function findGapContradictions(gap: string, evidenceText: string, tools: string[]): string[] {
  const corpus = `${evidenceText}\n${tools.join("\n")}`;
  const found = new Set<string>();

  for (const { re, members } of TOOL_CATEGORIES) {
    const m = gap.match(re);
    if (!m) continue;
    const shown = [...new Set([...tools.filter((t) => members.some((x) => x.toLowerCase() === t.toLowerCase())), ...members.filter((x) => mentions(corpus, x))])];
    if (shown.length) found.add(`"${m[0]}" (they use ${shown.join(", ")})`);
  }
  for (const tool of tools) {
    if (mentions(gap, tool)) found.add(`"${tool}" (in their tools)`);
  }
  // Named terms in the gap - acronyms and capitalized names after the first
  // word - that the evidence already contains.
  const words = gap.match(/[A-Za-z][A-Za-z0-9+.#-]*/g) ?? [];
  words.forEach((word, i) => {
    const clean = word.replace(/[.,]+$/, "");
    const acronym = /^[A-Z][A-Z0-9+#]{1,}$/.test(clean);
    const named = i > 0 && /^[A-Z]/.test(clean) && clean.length >= 3;
    if (!acronym && !named) return;
    if (TITLE_ACRONYMS.has(clean) || GENERIC_CAPITALIZED.has(clean.toLowerCase())) return;
    if (mentions(evidenceText, clean)) found.add(`"${clean}" (in the evidence)`);
  });
  return [...found];
}
