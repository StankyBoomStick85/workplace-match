/**
 * Verifies parseStep3Response's handling of the optional (CATEGORY) tag Step 3
 * emits after each [groupId]. The tag only drives ordering; a missing,
 * misspelled, or unexpected tag must never cause an entry to be dropped (a
 * dropped entry reads as a missing group and can fail the whole run as
 * retry_exhausted).
 *
 * Run:   node scripts/verify-step3-parser.mjs
 *
 * lib/capabilityPipeline.ts is TypeScript with "@/..." imports, so it is loaded
 * through the installed `jiti` with the "@" alias - no build step, no test
 * runner needed.
 */
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const jiti = require("jiti")(fileURLToPath(import.meta.url), { alias: { "@": root }, interopDefault: true });
const { parseStep3Response } = jiti(join(root, "lib/capabilityPipeline.ts"));

const group = (groupId, verificationStatus = "VERIFIED") => ({
  groupId,
  claims: ["claim"],
  verificationStatus,
  primarySourceDocId: "doc-1",
  corroboratingDocIds: []
});
const storedDocs = [{ id: "doc-1", label: "Doc One", filename: "a.pdf", path: "a.pdf", contentType: "application/pdf" }];

let failures = 0;
function check(label, ok, detail) {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${label}${ok ? "" : "\n       " + detail}`);
  if (!ok) failures++;
}

// Each case: one line for one group - must parse as a complete entry with the
// expected category, the tag must not leak into the name, and the prose
// summary line must not start with "(".
const single = [
  { label: "(CREDENTIALS) - plural", line: "[g1] (CREDENTIALS) **Accredited Training** [VERIFIED]: Completed accredited coursework.", category: "CREDENTIAL" },
  { label: "(Leadership) - mixed case", line: "[g1] (Leadership) **Team Leadership** [VERIFIED]: Led a team of twelve.", category: "LEADERSHIP" },
  { label: "(technical) - lower case", line: "[g1] (technical) **Systems Maintenance** [VERIFIED]: Maintained complex systems.", category: "TECHNICAL" },
  { label: "(OTHER) - unrecognized tag", line: "[g1] (OTHER) **Cross-Functional Coordination** [VERIFIED]: Coordinated across teams.", category: null },
  { label: "no tag at all", line: "[g1] **Budget Oversight** [VERIFIED]: Managed a large budget.", category: null },
  { label: "(LEADERSHIP) - exact", line: "[g1] (LEADERSHIP) **Mentoring** [VERIFIED]: Mentored junior staff.", category: "LEADERSHIP" },
  { label: "(Technical Skills) - prefix with suffix", line: "[g1] (Technical Skills) **Network Operations** [VERIFIED]: Ran networks.", category: "TECHNICAL" },
  { label: "( credential ) - inner spaces", line: "[g1] ( credential ) **Certification** [VERIFIED]: Holds a certification.", category: "CREDENTIAL" },
  { label: "() - empty parentheses", line: "[g1] () **Planning** [VERIFIED]: Planned operations.", category: null },
  { label: "no space after groupId", line: "[g1](CREDENTIAL) **Degree Coursework** [VERIFIED]: Coursework in progress.", category: "CREDENTIAL" }
];

for (const c of single) {
  const r = parseStep3Response(c.line, [group("g1")], storedDocs);
  const entry = r.kind === "entries" ? r.capabilityEntries[0] : undefined;
  const category = r.kind === "entries" ? r.entryCategories[0] : undefined;
  const ok =
    r.kind === "entries" &&
    r.capabilityEntries.length === 1 &&
    r.entryGroupIds[0] === "g1" &&
    category === c.category &&
    !entry.name.includes("(") &&
    !r.capabilitySummary.trimStart().startsWith("(");
  check(`parses as entry: ${c.label}`, ok, `got kind=${r.kind} ` + JSON.stringify(r.kind === "entries" ? { entry, category, summary: r.capabilitySummary } : r));
}

// Whole response mixing every variant - all five groups must come back, in
// order, with no missing groupIds.
const mixed = [
  "[a] (CREDENTIALS) **Accredited Training** [VERIFIED]: Completed accredited coursework.",
  "[b] (Leadership) **Team Leadership** [VERIFIED]: Led a team of twelve.",
  "[c] (technical) **Systems Maintenance** [USER_PROVIDED]: Maintained complex systems.",
  "[d] (OTHER) **Cross-Functional Coordination** [VERIFIED]: Coordinated across teams.",
  "[e] **Budget Oversight** [VERIFIED]: Managed a large budget."
].join("\n");
const groups = ["a", "b", "c", "d", "e"].map((id) => group(id, id === "c" ? "USER_PROVIDED" : "VERIFIED"));
const m = parseStep3Response(mixed, groups, storedDocs);
check(
  "mixed response: all 5 groups parse, none missing",
  m.kind === "entries" && m.capabilityEntries.length === 5 && m.entryGroupIds.join(",") === "a,b,c,d,e",
  JSON.stringify(m.kind === "entries" ? m.entryGroupIds : { reason: m.reason, missing: m.missingGroupIds, parsed: m.parsedCount })
);
check(
  "mixed response: categories mapped",
  m.kind === "entries" && JSON.stringify(m.entryCategories) === JSON.stringify(["CREDENTIAL", "LEADERSHIP", "TECHNICAL", null, null]),
  JSON.stringify(m.kind === "entries" ? m.entryCategories : null)
);

// Duplicate groupId keeps the first entry and is reported, and still counts
// only once toward the expected total.
const dup = parseStep3Response(
  "[a] (LEADERSHIP) **First** [VERIFIED]: one.\n[a] (TECHNICAL) **Second** [VERIFIED]: two.",
  [group("a")],
  storedDocs
);
check(
  "duplicate groupId: first kept, duplicate reported",
  dup.kind === "entries" && dup.capabilityEntries.length === 1 && dup.capabilityEntries[0].name === "First" && dup.duplicateGroupIds.join() === "a",
  JSON.stringify(dup)
);

console.log(failures === 0 ? `\nALL PASS — ${single.length + 3} cases` : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
