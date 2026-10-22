/**
 * Unit tests for the Tier 1 capability statement checks:
 *   - number provenance (lib/capabilityStatementChecks.ts findUnsourcedNumbers)
 *   - citation / count / evidence-basis checks (checkCoreStatement, checkNicheCapability)
 *   - glossary allowed facts as a number source (lib/capabilityStatements.ts buildCheckContext)
 *   - the expanded statement guard (lib/statementGuard.ts)
 *
 * Run:   node scripts/verify-capability-statements.mjs
 * Exits non-zero on any failure. No network, no database.
 */
import { loadTsModules } from "./lib/loadTsModules.mjs";

const checks = await loadTsModules(["capabilityStatementChecks"], "capabilityStatementChecks");
const guard = await loadTsModules(["statementGuard", "employerTextGuard"], "statementGuard");
const synth = await loadTsModules(
  ["capabilityStatements", "capabilityStatementChecks", "statementGuard", "employerTextGuard", "translationGlossary", "documentLabels"],
  "capabilityStatements"
);

let failed = 0;
let passed = 0;
function expect(name, cond, detail = "") {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ───────────────────────── number extraction ─────────────────────────
{
  const vals = (t) => checks.extractNumbers(t).map((n) => n.value);
  expect("extract: $ and commas", JSON.stringify(vals("$1,000,000 of equipment")) === "[1000000]", JSON.stringify(vals("$1,000,000")));
  expect("extract: K suffix", JSON.stringify(vals("a $3.5K fund")) === "[3500]");
  expect("extract: M suffix", JSON.stringify(vals("over $2M")) === "[2000000]");
  expect("extract: million word", JSON.stringify(vals("2 million dollars")) === "[2000000]");
  expect("extract: percent range", JSON.stringify(vals("top 3-5%")) === "[3,5]");
  expect("extract: ranking", JSON.stringify(vals("#2 of 6")) === "[2,6]");
  expect("extract: meters not millions", JSON.stringify(vals("1,800 m")) === "[1800]");
  expect("extract: ordinal suffix ignored", JSON.stringify(vals("6th award")) === "[6]");
  expect("claim numbers include words", checks.extractClaimNumbers("coordinated three FRG events").includes(3));
}

// ───────────────────────── number provenance ─────────────────────────
{
  const unsourced = (proof, claims) => checks.findUnsourcedNumbers(proof, claims).map((n) => n.raw);
  const C = [
    "Responsible for over $1,000,000 of detachment equipment",
    "Rated #2 of 6 highly competitive SFCs, easily in the top 3% of E7s observed",
    "Ranked in the top 5% of E7s",
    "Managed and balanced a $10,000 OPFUND with zero discrepancies",
    "Summited a peak at 14,259 feet",
    "Conducted 220 hours of physical training with 181 Special Operations candidates",
    "Coordinated three FRG events",
    "Completed a 12-mile march in 2 hours",
  ];
  expect("provenance: exact number", unsourced("Ranked #2 of 6 peers", C).length === 0);
  expect("provenance: $ normalization ($1M from $1,000,000)", unsourced("Accountable for $1M in equipment", C).length === 0);
  expect("provenance: K normalization ($10K from $10,000)", unsourced("Managed a $10K fund", C).length === 0);
  expect("provenance: comma normalization", unsourced("Accountable for 1,000,000 dollars", C).length === 0);
  expect("provenance: percent", unsourced("Placed in the top 3% of peers", C).length === 0);
  expect("provenance: range from two claims", unsourced("Ranked in the top 3-5% of peers", C).length === 0);
  expect("provenance: rounding within 5% (14,000 from 14,259)", unsourced("Operates safely above 14,000 feet", C).length === 0);
  expect("provenance: spelled-out claim number as digit", unsourced("Ran 3 family support events", C).length === 0);
  expect("provenance: unit change with unit named (feet -> meters)", unsourced("Operates at 4,346 meters", C).length === 0);
  expect("provenance: unit change hours -> minutes", unsourced("Finished in 120 minutes", C).length === 0);

  expect("provenance: invented number rejected", JSON.stringify(unsourced("Led 40 people", C)) === '["40"]');
  expect("provenance: invented total rejected ($1M + $10K)", unsourced("Accountable for $1,010,000 in assets", C).length === 1);
  expect("provenance: computed percentage rejected (#2 of 6 -> 33%)", unsourced("Ranked in the top 33% of peers", C).length === 1);
  expect("provenance: inflating round-up rejected (181 -> 200)", unsourced("Trained 200 candidates", C).length === 1);
  expect("provenance: unit change without unit named rejected (2 hours -> 120)", unsourced("Completed 120 drills", C).length === 1);
  expect("provenance: magnitude mismatch rejected ($10M vs $10,000)", unsourced("Managed a $10M fund", C).length === 1);
}

// ───────────────────────── citations and counts ─────────────────────────
{
  const groups = [
    { groupId: "g1", verificationStatus: "VERIFIED", claims: ["Rated #2 of 6 peers by senior rater", "Top 3% of peers"] },
    { groupId: "g2", verificationStatus: "VERIFIED", claims: ["Responsible for $2,000,000 of equipment with zero loss"] },
    { groupId: "g3", verificationStatus: "USER_PROVIDED", claims: ["Led teams of 12 people"] },
    { groupId: "g4", verificationStatus: "USER_PROVIDED", claims: ["Trained 40 partner personnel"] },
  ];
  const ctx = { groupsById: new Map(groups.map((g) => [g.groupId, g])) };
  const codes = (issues) => issues.map((i) => i.code);
  const good = {
    statement: "Keeps high-value equipment and people accountable under pressure.",
    proof: [
      { text: "Ranked #2 of 6 peers by an independent senior evaluator", groupIds: ["g1"] },
      { text: "Accountable for $2M in equipment with zero loss", groupIds: ["g2"] },
    ],
  };
  expect("core: valid statement passes", checks.checkCoreStatement(good, ctx).length === 0, JSON.stringify(checks.checkCoreStatement(good, ctx)));

  const oneGroup = { ...good, proof: [good.proof[0], { text: "Placed in the top 3% of peers", groupIds: ["g1"] }] };
  expect("core: two proof lines from one group -> too_few_distinct_groups", codes(checks.checkCoreStatement(oneGroup, ctx)).includes("too_few_distinct_groups"));

  const unknown = { ...good, proof: [good.proof[0], { text: "Accountable for $2M", groupIds: ["g99"] }] };
  const unknownCodes = codes(checks.checkCoreStatement(unknown, ctx));
  expect("core: unknown groupId flagged", unknownCodes.includes("unknown_group_id"));
  expect("core: unknown groupId does not count toward distinct groups", unknownCodes.includes("too_few_distinct_groups"));

  const noCite = { ...good, proof: [good.proof[0], { text: "Accountable for $2M", groupIds: [] }] };
  expect("core: proof with no citation flagged", codes(checks.checkCoreStatement(noCite, ctx)).includes("proof_no_citation"));

  const noDigit = { ...good, proof: [good.proof[0], { text: "Accountable for millions in equipment", groupIds: ["g2"] }] };
  expect("core: proof without digit flagged", codes(checks.checkCoreStatement(noDigit, ctx)).includes("proof_missing_digit"));

  const wrongGroupNumber = { ...good, proof: [good.proof[0], { text: "Accountable for $2M in equipment", groupIds: ["g3"] }] };
  expect(
    "core: number present in claims but not in the CITED group's claims is rejected",
    codes(checks.checkCoreStatement(wrongGroupNumber, ctx)).includes("number_not_in_claims")
  );

  const tooFew = { ...good, proof: [good.proof[0]] };
  expect("core: one proof line -> proof_count", codes(checks.checkCoreStatement(tooFew, ctx)).includes("proof_count"));
  const tooMany = { ...good, proof: [good.proof[0], good.proof[1], good.proof[0], good.proof[1], good.proof[0]] };
  expect("core: five proof lines -> proof_count", codes(checks.checkCoreStatement(tooMany, ctx)).includes("proof_count"));

  const pronoun = { ...good, statement: "This candidate keeps their equipment accountable." };
  expect("core: subject/pronoun flagged", codes(checks.checkCoreStatement(pronoun, ctx)).includes("pronoun_or_subject"));

  const statementNumber = { ...good, statement: "Keeps $50M of equipment accountable." };
  expect("core: invented number in the statement sentence flagged", codes(checks.checkCoreStatement(statementNumber, ctx)).includes("number_not_in_claims"));

  const overstated = {
    statement: "Builds and leads capable teams.",
    proof: [
      { text: "Documented leading teams of 12 people", groupIds: ["g3"] },
      { text: "Trained 40 partner personnel", groupIds: ["g4"] },
    ],
  };
  expect("core: documentation wording on self-reported evidence flagged", codes(checks.checkCoreStatement(overstated, ctx)).includes("overstated_verification"));
  const selfReportedOk = { ...overstated, proof: [{ text: "Leads teams of 12 people", groupIds: ["g3"] }, overstated.proof[1]] };
  expect("core: self-reported evidence counts fully when worded plainly", checks.checkCoreStatement(selfReportedOk, ctx).length === 0);

  const stamped = checks.withEvidenceBasis(
    { statement: "x", proof: [{ text: "1", groupIds: ["g1", "g3"] }, { text: "2", groupIds: ["g2"] }, { text: "3", groupIds: ["g4"] }] },
    ctx.groupsById
  );
  expect("basis: mixed line", stamped.proof[0].evidenceBasis === "mixed");
  expect("basis: documented line", stamped.proof[1].evidenceBasis === "documented");
  expect("basis: self-reported line", stamped.proof[2].evidenceBasis === "self_reported");
  expect("basis: statement mixed", stamped.evidenceBasis === "mixed");

  const clearanceNoDate = { ...good, statement: "Holds an active security clearance and keeps equipment accountable." };
  expect("time-limited: clearance without end date flagged", codes(checks.checkCoreStatement(clearanceNoDate, ctx)).includes("time_limited_without_end_date"));
  const clearanceWithDate = {
    ...good,
    statement: "Holds a security clearance that expires in 2029 and keeps equipment accountable.",
  };
  expect(
    "time-limited: clearance with expiration date passes the end-date check",
    !codes(checks.checkCoreStatement(clearanceWithDate, ctx)).includes("time_limited_without_end_date")
  );
  const clearancePermanent = { ...good, statement: "Holds a permanent security clearance through 2029." };
  expect("time-limited: 'permanent' clearance flagged", codes(checks.checkCoreStatement(clearancePermanent, ctx)).includes("time_limited_without_end_date"));
  const customs = { ...good, statement: "Moves equipment across borders with full customs clearance." };
  expect(
    "time-limited: customs clearance is not a time-limited fact (regression: 2026-10-22 comparison run)",
    !codes(checks.checkCoreStatement(customs, ctx)).includes("time_limited_without_end_date")
  );

  const niche = { statement: "Inspects safety-critical equipment.", applicability: ["aviation safety"], proof: [{ text: "Ranked #2 of 6 peers", groupIds: ["g1"] }] };
  expect("niche: one proof line from one group passes", checks.checkNicheCapability(niche, ctx).length === 0, JSON.stringify(checks.checkNicheCapability(niche, ctx)));
  expect("niche: missing applicability flagged", codes(checks.checkNicheCapability({ ...niche, applicability: [] }, ctx)).includes("no_applicability"));
}

// ───────────────────────── glossary allowed facts ─────────────────────────
{
  const groups = [
    { groupId: "a", verificationStatus: "VERIFIED", claims: ["Serves as Senior Engineer Sergeant on an SFOD-A"] },
    { groupId: "b", verificationStatus: "VERIFIED", claims: ["Responsible for $1,000,000 of equipment"] },
  ];
  const ctx = synth.buildCheckContext(groups);
  const issues = checks.checkCoreStatement(
    {
      statement: "Runs construction and demolition work for a small independent team.",
      proof: [
        { text: "Leads engineering work for a 12-person team", groupIds: ["a"] },
        { text: "Accountable for $1M in equipment", groupIds: ["b"] },
      ],
    },
    ctx
  );
  expect("glossary: team size 12 is sourced via the ODA entry's allowed facts", issues.length === 0, JSON.stringify(issues));
  const notSourced = checks.checkCoreStatement(
    {
      statement: "Runs construction work.",
      proof: [
        { text: "Leads engineering work for a 12-person team", groupIds: ["b"] },
        { text: "Accountable for $1M in equipment", groupIds: ["b", "a"] },
      ],
    },
    ctx
  );
  expect(
    "glossary: allowed fact does not apply to a proof line whose claims lack the term",
    notSourced.some((i) => i.code === "number_not_in_claims" && i.proofIndex === 0)
  );
}

// ───────────────────────── expanded guard ─────────────────────────
{
  const cats = (t) => guard.scanStatementText(t, { knownFullName: "Joel DeToy" }).map((v) => v.category);
  const MUST_FLAG = [
    ["Earned a Bronze Star for leadership", "award_name"],
    ["Awarded the Joint Service Achievement Medal", "award_name"],
    ["Graduated the SFQC", "school_or_qualification"],
    ["Qualified jumpmaster for 200 jumps", "school_or_qualification"],
    ["Served as an 18C engineer", "specialty_code"],
    ["Held MOS 79R", "specialty_code"],
    ["Assigned to 3rd Battalion, 10th Group", "unit_designator"],
    ["Coordinated across the EUCOM AOR", "unit_designator"],
    ["Ranked #2 on the NCOER", "document_type"],
    ["Supported Operation Atlantic Resolve", "operation_name"],
    ["Trained partner forces in Latvia", "location"],
    ["Led 12 soldiers", "service_term"],
    ["A respected NCO", "service_term"],
    ["Liaison to the embassy", "service_term"],
    ["Built a veteran-led team", "service_term"],
    ["Served as the company commander's adviser", "unit_designator"],
    ["Rated top 3% of E-7s", "military_rank"],
    ["Worked in 2019 on supply", "explicit_year"],
    // seen in the 2026-10-22 comparison run
    ["Placed first of 6 shooters, recognized by company command", "unit_designator"],
    ["Trained U.S. and allied forces", "location"],
    ["Trained US and allied forces", "location"],
    ["Tags: international business, Eastern European markets", "location"],
    ["Briefed a senior defense-department office", "service_term"],
    ["Increased partner-force lethality by 25%", "service_term"],
    ["Fire that destroyed enemy positions", "service_term"],
    ["Ran 7 static-line operations", "school_or_qualification"],
  ];
  for (const [text, cat] of MUST_FLAG) {
    expect(`guard flags (${cat}): ${text}`, cats(text).includes(cat), JSON.stringify(cats(text)));
  }
  const MUST_PASS = [
    "Directs day-to-day operations for a 12-person team that works independently far from support",
    "Accountable for $2M in equipment with zero loss across annual inventories",
    "Ranked #2 of 6 peers by an independent senior evaluator, top 3-5% overall",
    "Grew a company's sales pipeline by 20%",
    "Managed a $12M budget and a 50K-unit inventory",
    "Speaks Russian at a working level, scored 2 on a standardized test",
    "Halo effect aside, kept 181 candidates injury-free",
    "Holds a security clearance that expires in 2029",
    "Most people would call it a halo project",
    "Helps us deliver projects for our partners",
    "Moves equipment across borders with full customs clearance in 2 countries",
  ];
  for (const text of MUST_PASS) {
    const hits = guard.scanStatementText(text, { knownFullName: "Joel DeToy" });
    expect(`guard passes: ${text}`, hits.length === 0, JSON.stringify(hits));
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
