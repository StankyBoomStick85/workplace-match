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
const employerGuard = await loadTsModules(["statementGuard", "employerTextGuard"], "employerTextGuard");
const synth = await loadTsModules(
  ["capabilityStatements", "capabilityStatementChecks", "statementGuard", "employerTextGuard", "translationGlossary", "documentLabels", "candidateDirection", "roleFamilies"],
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

  // Scale and function fidelity against the cited claims.
  const fid = (statement) => codes(checks.checkCoreStatement({ ...good, statement }, ctx));
  expect("core: 'larger organizations' not in claims -> inflated_scale", fid("Runs teams and larger organizations whenever the leader is away.").includes("inflated_scale"));
  expect("core: 'several hundred' with no cited number >= 200 -> inflated_scale", fid("Coordinates moves for organizations of several hundred people.").includes("inflated_scale"));
  const recruitCtx = { groupsById: new Map([...groups, { groupId: "r1", verificationStatus: "VERIFIED", claims: ["Achieved 134% of annual recruiting target"] }].map((g) => [g.groupId, g])) };
  const recruitStmt = (statement) => codes(checks.checkCoreStatement({ statement, proof: [{ text: "Achieved 134% of annual recruiting target", groupIds: ["r1"] }, good.proof[1]] }, recruitCtx));
  expect("core: recruiting called 'sales-style' -> recruiting_as_sales", recruitStmt("Delivers sales-style talent acquisition results against a quota.").includes("recruiting_as_sales"));
  expect("core: recruiting named as recruiting passes fidelity", !recruitStmt("Delivers recruiting results against a quota.").some((c) => c === "recruiting_as_sales" || c === "inflated_scale"));
  expect("fidelity: 'hundreds' allowed when a cited number reaches 200", checks.findScaleInflation("Trains hundreds of people", ["Trained 500 partner personnel"]).length === 0);

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

// ───────────────────────── follow-up rules (2026-10-22) ─────────────────────────
{
  const groups = [
    { groupId: "g1", verificationStatus: "VERIFIED", claims: ["Rated #2 of 6 peers by senior rater"] },
    { groupId: "g2", verificationStatus: "VERIFIED", claims: ["Responsible for $2,000,000 of equipment with zero loss"] },
    { groupId: "g3", verificationStatus: "USER_PROVIDED", claims: ["Budget & Asset Accountability", "Led teams of 12 people"] },
  ];
  const ctx = { groupsById: new Map(groups.map((g) => [g.groupId, g])) };
  const codes = (issues) => issues.map((i) => i.code);
  const proof = [
    { text: "Ranked #2 of 6 peers by an independent senior evaluator", groupIds: ["g1"] },
    { text: "Accountable for $2M in equipment with zero loss", groupIds: ["g2"] },
  ];

  const long = { statement: "Keeps " + "very ".repeat(22) + "high-value equipment accountable.", proof };
  expect("rule d: 25+ word statement flagged", codes(checks.checkCoreStatement(long, ctx)).includes("statement_too_long"));
  expect("rule d: 24-word statement allowed", checks.countWords("one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty a b c d") === 24);

  for (const statement of [
    "Consistently ranks in the top few percent of peers.",
    "Ranked in the top 3-5% across reviews.",
    "Earns repeated promotion ahead of peers.",
    "Holds 6 commendations for performance.",
  ]) {
    expect(`rule a: rating as statement flagged: ${statement}`, codes(checks.checkCoreStatement({ statement, proof }, ctx)).includes("rating_as_statement"));
  }
  expect(
    "rule a: ranking inside a proof line is fine",
    !codes(checks.checkCoreStatement({ statement: "Keeps high-value equipment and people accountable.", proof }, ctx)).includes("rating_as_statement")
  );
  expect(
    "rule a: 'recognizes' (verb) is not a rating",
    !codes(checks.checkCoreStatement({ statement: "Recognizes risks early and plans around them.", proof }, ctx)).includes("rating_as_statement")
  );

  const filler = {
    statement: "Keeps high-value equipment accountable.",
    proof: [proof[0], { text: "Accountable for $2M in equipment; self-reports budget and asset accountability as a core strength", groupIds: ["g2", "g3"] }],
  };
  expect("rule b: self-report filler flagged", codes(checks.checkCoreStatement(filler, ctx)).includes("self_report_filler"));
  const fillerB = { ...filler, proof: [proof[0], { text: "Leads teams of 12 people, listing it as a key strength", groupIds: ["g3", "g2"] }] };
  expect("rule b: 'as a key strength' flagged", codes(checks.checkCoreStatement(fillerB, ctx)).includes("self_report_filler"));
  const selfFact = { ...filler, proof: [proof[0], { text: "Leads teams of 12 people", groupIds: ["g3", "g2"] }] };
  expect("rule b: self-reported fact stated as a fact passes", !codes(checks.checkCoreStatement(selfFact, ctx)).includes("self_report_filler"));

  const em = { statement: "Keeps equipment accountable — with zero loss.", proof };
  expect("rule c: em dash flagged", codes(checks.checkCoreStatement(em, ctx)).includes("dash_character"));
  const en = { statement: "Keeps equipment accountable.", proof: [proof[0], { text: "Accountable for $2M – zero loss", groupIds: ["g2"] }] };
  expect("rule c: en dash in proof flagged", codes(checks.checkCoreStatement(en, ctx)).includes("dash_character"));
  const nicheDash = { statement: "Inspects safety-critical equipment.", applicability: ["aviation — safety"], proof: [proof[0]] };
  expect("rule c: dash in applicability tag flagged", codes(checks.checkNicheCapability(nicheDash, ctx)).includes("dash_character"));
  expect(
    "rule c: range dashes are normalized at parse",
    synth.parseSynthesisOutput(JSON.stringify({ core: [{ statement: "x", proof: [{ text: "top 3–5%", groupIds: [] }] }], niche: [], uncertainTerms: [] }))
      .core[0].proof[0].text === "top 3-5%"
  );

  const phrases = checks.buildGlossaryPhraseSet(["A small, self-sufficient specialist team that operates independently, often far from support."]);
  const used = checks.glossaryPhrasesIn(["Directs a team that operates independently, often far from support"], phrases);
  expect("rule d: glossary phrase detected", used.has("operates independently often far"), JSON.stringify([...used]));
  const glue = checks.glossaryPhrasesIn(["for a 12 person team"], checks.buildGlossaryPhraseSet(["Director of operations for a 12-person team"]));
  expect("rule d: a numeric fact ('a 12-person team') is not glossary phrasing", glue.size === 0, JSON.stringify([...glue]));
}

// ───────────────────────── follow-up guard terms ─────────────────────────
{
  const cats = (t) => guard.scanStatementText(t, { knownFullName: "Joel DeToy" }).map((v) => v.category);
  for (const [text, cat] of [
    ["Advised the commander on logistics", "service_term"],
    ["Led 14 movements as the on-scene commander", "service_term"],
    ["Realigned to a new theater with no loss", "service_term"],
    ["Destroyed hostile positions", "service_term"],
    ["Protected coalition forces", "service_term"],
    ["Exceeded the infantry standard by 22 minutes", "service_term"],
    ["Advised senior leaders at two higher commands", "unit_designator"],
    ["Effects felt across multiple commands", "unit_designator"],
    ["Recognized at two levels of command", "unit_designator"],
    ["Lessons provided to a national intelligence agency", "service_term"],
    ["Tracked 88 people during the COVID-19 crisis", "dating_event"],
    ["Kept operations running through the pandemic", "dating_event"],
    ["Restored power after Hurricane Maria", "dating_event"],
  ]) {
    expect(`guard flags (${cat}): ${text}`, cats(text).includes(cat), JSON.stringify(cats(text)));
  }
  for (const text of ["Commands respect from senior partners", "Coordinated 2 command posts"]) {
    expect(`guard passes: ${text}`, guard.scanStatementText(text).length === 0, JSON.stringify(guard.scanStatementText(text)));
  }
  expect("core-only: 'combat' flagged by the core scan", guard.scanCoreOnlyText("Performs under combat conditions").length === 1);
  expect("core-only: 'combat' NOT flagged by the shared statement guard (niche allowed)", !guard.scanStatementText("Coordinates fire under combat conditions").some((v) => /combat/i.test(v.match)));
  expect("core-only: 'under direct threat' passes", guard.scanCoreOnlyText("Leads under direct threat").length === 0);
  for (const text of [
    "Led a 3-person assault element",
    "Trained 7 operators in a week",
    "Holds a valor citation",
    "Recorded in the official service record",
    "Coordinated 2 nine-person assault teams",
  ]) {
    expect(`core-only flags: ${text}`, guard.scanCoreOnlyText(text).length > 0, JSON.stringify(guard.scanCoreOnlyText(text)));
    expect(`core-only term NOT in shared guard (niche keeps it): ${text}`, !guard.scanStatementText(text).some((v) => v.category === "core_only_term"));
  }
  expect("core-only: 'specialists' / 'official records' pass", guard.scanCoreOnlyText("Trained 7 specialists, recorded in official records").length === 0);
  expect(
    "guard: 'master breacher' blocked everywhere",
    guard.scanStatementText("Appointed team master breacher").some((v) => v.category === "school_or_qualification")
  );
}

// ───────────────── state machine with a mocked model (no network) ─────────────────
{
  const groups = [
    { groupId: "a", verificationStatus: "VERIFIED", primarySourceDocId: "d", corroboratingDocIds: [], claims: ["Rated #2 of 6 peers", "Top 3% of peers"] },
    { groupId: "b", verificationStatus: "VERIFIED", primarySourceDocId: "d", corroboratingDocIds: [], claims: ["Responsible for $2,000,000 of equipment"] },
    { groupId: "c", verificationStatus: "VERIFIED", primarySourceDocId: "d", corroboratingDocIds: [], claims: ["Trained 500 partner personnel", "Trained 80 personnel in explosives"] },
    { groupId: "e", verificationStatus: "VERIFIED", primarySourceDocId: "d", corroboratingDocIds: [], claims: ["Coordinated 15 logistics movements", "Planned air support for 8 months"] },
  ];
  const good = (statement, p1, p2) => ({ statement, proof: [p1, p2] });
  const ok1 = good("Keeps high-value equipment accountable under pressure.", { text: "Accountable for $2M in equipment", groupIds: ["b"] }, { text: "Ranked #2 of 6 peers", groupIds: ["a"] });
  const ok2 = good("Builds training that scales to hundreds of people.", { text: "Trained 500 partner personnel", groupIds: ["c"] }, { text: "Placed in the top 3% of peers", groupIds: ["a"] });
  const bad = good("Plans multinational logistics in the combat theater.", { text: "Coordinated 15 movements", groupIds: ["e"] }, { text: "Trained 80 people in explosives", groupIds: ["c"] });
  const fixed = good("Plans multinational logistics across borders on schedule.", { text: "Coordinated 15 logistics movements", groupIds: ["e"] }, { text: "Planned air support for 8 months", groupIds: ["e", "c"] });
  const responses = [
    { core: [ok1, ok2, bad], niche: [], uncertainTerms: [{ term: "X", assumedMeaning: "y", reason: "z" }] },
    { core: [], niche: [], uncertainTerms: [] },
    { core: [fixed], niche: [], uncertainTerms: [] },
  ];
  const prompts = [];
  const efforts = [];
  // A response of "HANG" never resolves until the call is aborted.
  const mockClient = (queue) => ({
    messages: {
      stream: (params) => {
        prompts.push(params.messages[0].content);
        efforts.push(params.output_config?.effort);
        const body = queue.shift();
        let abort = () => {};
        const aborted = new Promise((_, reject) => (abort = () => reject(new Error("Request was aborted."))));
        return {
          abort,
          finalMessage: async () =>
            body === "HANG"
              ? aborted
              : { model: params.model, stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify(body) }] },
        };
      },
    },
  });
  const anthropic = mockClient(responses);
  const result = await synth.runCapabilityStatementSynthesis({ anthropic, groups, storedDocs: [], knownFullName: "Joel DeToy", model: "claude-fable-5-1" });
  expect("state machine: ok after one targeted retry", result.status === "ok", JSON.stringify({ status: result.status, notes: result.notes, rejected: result.rejected }));
  expect("state machine: core call, niche call, 1 retry", result.calls.map((c) => c.phase).join(",") === "initial_core,initial_niche,retry_1", result.calls.map((c) => c.phase).join(","));
  expect("state machine: core call asks for core only", /THIS CALL - CORE ONLY/.test(prompts[0]) && !/THIS CALL - NICHE ONLY/.test(prompts[0]));
  expect("state machine: niche call asks for niche only and sees accepted core", /THIS CALL - NICHE ONLY/.test(prompts[1]) && prompts[1].includes(ok1.statement));
  expect("state machine: replacement lands in the failed slot", result.core[2]?.statement === fixed.statement, JSON.stringify(result.core.map((c) => c.statement)));
  expect("state machine: retry prompt names the rejected phrases", /core_only_term|"combat"/.test(prompts[2]) && /theater/.test(prompts[2]));
  expect("state machine: accepted items not re-sent as rejected", !prompts[2].includes("REJECTED CORE STATEMENTS (2)"));
  expect("state machine: uncertain terms carried through", result.uncertainTerms.length === 1);

  // A state saved before the split ("initial") resumes as the core step.
  {
    const legacy = { ...synth.createSynthesisState("claude-fable-5-1"), next: "initial" };
    delete legacy.effort;
    delete legacy.phaseFailures;
    const step = await synth.runSynthesisStep(legacy, { anthropic: mockClient([{ core: [ok1, ok2], niche: [], uncertainTerms: [] }]), groups, storedDocs: [], knownFullName: null });
    expect("state machine: legacy 'initial' state runs as core step", step.calls[0]?.phase === "initial_core" && step.next === "initial_niche");
  }

  // A call that hangs is aborted at the timeout, recorded, and its phase is
  // run again at medium effort; later calls stay at medium.
  {
    prompts.length = 0;
    efforts.length = 0;
    const t0 = Date.now();
    const r = await synth.runCapabilityStatementSynthesis({
      anthropic: mockClient(["HANG", { core: [ok1, ok2, fixed], niche: [], uncertainTerms: [] }, { core: [], niche: [], uncertainTerms: [] }]),
      groups, storedDocs: [], knownFullName: null, model: "claude-fable-5-1", callTimeoutMs: 50,
    });
    expect("timeout: hung call aborted within the timeout", Date.now() - t0 < 2000);
    expect("timeout: recorded as timed out", r.calls[0]?.timedOut === true && /timed out/.test(r.calls[0]?.error ?? ""), JSON.stringify(r.calls[0]));
    expect("timeout: core phase re-run, then niche", r.calls.map((c) => c.phase).join(",") === "initial_core,initial_core,initial_niche", r.calls.map((c) => c.phase).join(","));
    expect("timeout: first call high effort, later calls medium", efforts.join(",") === "high,medium,medium", efforts.join(","));
    expect("timeout: run still succeeds", r.status === "ok", JSON.stringify({ status: r.status, notes: r.notes }));
  }
  {
    const r = await synth.runCapabilityStatementSynthesis({
      anthropic: mockClient(["HANG", "HANG"]),
      groups, storedDocs: [], knownFullName: null, model: "claude-fable-5-1", callTimeoutMs: 20,
    });
    expect("timeout: phase failing twice fails the run", r.status === "failed" && r.calls.length === 2 && /core synthesis failed twice/.test(r.notes.join(" ")), JSON.stringify(r.notes));
  }

  // Cross-statement glossary phrasing: the second statement to use a phrase fails.
  const dupA = good("Runs a team that works independently far from support.", { text: "Accountable for $2M in equipment", groupIds: ["b"] }, { text: "Ranked #2 of 6 peers", groupIds: ["a"] });
  const dupB = good("Trains partners for a team that works independently far from support.", { text: "Trained 500 partner personnel", groupIds: ["c"] }, { text: "Placed in the top 3% of peers", groupIds: ["a"] });
  responses.push({ core: [dupA, dupB, ok2], niche: [], uncertainTerms: [] }, { core: [], niche: [], uncertainTerms: [] }, { core: [], niche: [], uncertainTerms: [] });
  const dupGlossary = [{ term: "Team", aliases: ["team"], field: "x", employerMeaning: "A team that works independently far from support." }];
  const r2 = await synth.runCapabilityStatementSynthesis({ anthropic, groups, storedDocs: [], knownFullName: null, model: "claude-fable-5-1", glossary: dupGlossary });
  expect(
    "cross-check: repeated glossary phrasing rejects the later statement only",
    r2.rejected.length === 1 && r2.rejected[0].issues[0].code === "repeated_glossary_phrase" && r2.rejected[0].item.statement === dupB.statement,
    JSON.stringify(r2.rejected.map((f) => [f.item.statement, f.issues.map((i) => i.code)]))
  );
  expect("cross-check: first user of the phrase is kept", r2.core.some((c) => c.statement === dupA.statement));
}

// ───────────── self-reported evidence is context / absorbed (2026-10-22) ─────────────
{
  const pipeline = await loadTsModules(["capabilityPipeline", "documentLabels", "capabilityStatementChecks", "candidateDirection", "roleFamilies"], "capabilityPipeline");

  const items = pipeline.buildSelfReportedEvidenceItems({ summary: "Retired senior leader with 20 years", capabilityTags: ["Budget & Asset Accountability", "Cybersecurity"] });
  expect("self-reported items: summary is not evidence", items.length === 2 && items.every((i) => i.claim !== "Retired senior leader with 20 years"));
  expect("self-reported items: tags stay USER_PROVIDED evidence", items.every((i) => i.isOfficialDocument === false && i.sourceDocId === "profile-self-reported"));

  const g = (groupId, verificationStatus, claims, primarySourceDocId = "doc") => ({ groupId, verificationStatus, claims, primarySourceDocId, corroboratingDocIds: [] });
  const groups = [
    g("v1", "VERIFIED", ["Responsible for $2,000,000 of equipment"], "eval"),
    g("v2", "VERIFIED", ["Zero discrepancies in inventory"], "eval2"),
    g("u1", "USER_PROVIDED", ["Budget & Asset Accountability"], "profile-self-reported"),
    g("v3", "VERIFIED", ["Trained 500 partner personnel"], "eval"),
    g("u2", "USER_PROVIDED", ["Training Program Development"], "profile-self-reported"),
    g("u3", "USER_PROVIDED", ["Cybersecurity & Network Defense"], "profile-self-reported"),
    g("u4", "USER_PROVIDED", ["Network defense"], "resume"),
    g("u5", "USER_PROVIDED", ["Authored a book"], "book"),
  ];
  const applied = pipeline.applyMergePlan(groups, { merges: [["v1", "u1", "v2"], ["v3", "u2"], ["u3", "u4"]] });
  const ids = applied.groups.map((x) => x.groupId);
  expect("merge: mixed set keeps the VERIFIED merge", applied.groups.some((x) => x.groupId === "v1" && x.claims.length === 2 && x.verificationStatus === "VERIFIED"));
  expect("merge: VERIFIED merge stays pure (no self-reported claims blended in)", !applied.groups.find((x) => x.groupId === "v1").claims.includes("Budget & Asset Accountability"));
  expect("merge: USER_PROVIDED member of a mixed set is dropped, not passed through", !ids.includes("u1") && !ids.includes("u2"), JSON.stringify(ids));
  expect("merge: dropped groups are reported", JSON.stringify(applied.droppedUserProvidedGroups.map((x) => x.groupId).sort()) === '["u1","u2"]');
  expect("merge: lone VERIFIED member left after the drop passes through unchanged", applied.groups.some((x) => x.groupId === "v3" && x.claims.length === 1));
  expect("merge: an all-self-reported set still merges as USER_PROVIDED", applied.groups.some((x) => x.groupId === "u3" && x.verificationStatus === "USER_PROVIDED" && x.claims.length === 2));
  expect("merge: an unsupported self-reported group stands on its own", ids.includes("u5"));
  expect("merge: nothing unaccounted", applied.unaccountedGroupIds.length === 0);
  expect("merge prompt: tells the model to list self-reported restatements with the document group", /self-reported group[\s\S]{0,200}MUST be listed in that document group's merge set/.test(pipeline.buildEvidenceGroupMergePrompt(groups)));

  // Coverage: a dropped group's evidence counts as represented.
  const evidence = [
    { claim: "x", sourceDocId: "eval", sourceDocLabel: "e", sourceDocType: "NCOER", isOfficialDocument: true },
    { claim: "Budget & Asset Accountability", sourceDocId: "profile-self-reported", sourceDocLabel: "s", sourceDocType: "other", isOfficialDocument: false },
  ];
  const withDropped = pipeline.computeGroupingCoverage(evidence, [groups[0], ...applied.droppedUserProvidedGroups]);
  expect("coverage: absorbed self-reported evidence is not reported as lost", !withDropped.missingDocIds.includes("profile-self-reported"));

  // Statements: no mixed citations.
  const sgroups = [
    { groupId: "d", verificationStatus: "VERIFIED", claims: ["Responsible for $2,000,000 of equipment"] },
    { groupId: "s", verificationStatus: "USER_PROVIDED", claims: ["Budget & Asset Accountability", "Managed 3 budgets"] },
    { groupId: "e", verificationStatus: "VERIFIED", claims: ["Ranked #2 of 6 peers"] },
  ];
  const sctx = { groupsById: new Map(sgroups.map((x) => [x.groupId, x])) };
  const codesOf = (st) => checks.checkCoreStatement(st, sctx).map((i) => i.code);
  const mixed = { statement: "Keeps equipment accountable.", proof: [{ text: "Accountable for $2M in equipment", groupIds: ["d", "s"] }, { text: "Ranked #2 of 6 peers", groupIds: ["e"] }] };
  expect("statements: proof citing self-reported + document group is rejected", codesOf(mixed).includes("mixed_citation"));
  const separate = { ...mixed, proof: [{ text: "Accountable for $2M in equipment", groupIds: ["d"] }, { text: "Managed 3 budgets", groupIds: ["s"] }] };
  expect("statements: self-reported point on its own line is allowed", !codesOf(separate).includes("mixed_citation"), JSON.stringify(codesOf(separate)));

  // Context block: present, marked not-evidence, and its numbers cannot source a proof line.
  const prompt = synth.buildSynthesisPrompt([], undefined, { summary: "Led teams across 50+ countries", capabilityTags: ["Budget & Asset Accountability"] });
  expect("synthesis prompt: summary and tags passed as NOT EVIDENCE context", /CONTEXT ABOUT THE PERSON - NOT EVIDENCE/.test(prompt) && prompt.includes("50+ countries") && prompt.includes("Budget & Asset Accountability"));
  expect("synthesis prompt: no context block when there is no context", !/NOT EVIDENCE/.test(synth.buildSynthesisPrompt([], undefined, {})));
  const fromContext = { statement: "Leads teams.", proof: [{ text: "Led teams across 50 countries", groupIds: ["d"] }, { text: "Ranked #2 of 6 peers", groupIds: ["e"] }] };
  expect("synthesis: a number that exists only in the context is unsourced", codesOf(fromContext).includes("number_not_in_claims"));
}

// ───────────────────────── employer summary v2 (2026-10-22) ─────────────────────────
{
  const pipeline = await loadTsModules(["capabilityPipeline", "documentLabels", "capabilityStatementChecks", "candidateDirection", "roleFamilies"], "capabilityPipeline");
  const input = {
    capabilityStatements: [
      { statement: "Keeps equipment accountable.", proof: [{ text: "Accountable for $3.5M in equipment with zero loss" }, { text: "Trained over 500 people across 5 rounds" }] },
      { statement: "Recruits against quota.", proof: [{ text: "Delivered 134% of the annual target" }] },
    ],
    capabilitySummary: "",
    selfSummary: "Moving into operations leadership and business development",
    desiredRoles: "Operations Manager",
    workPreference: "remote",
    isAlternateSummary: false,
  };
  const good = [
    "## HEADLINE",
    "Operations leader who builds accountable teams and delivers measurable results under pressure.",
    "## PROVEN_AT",
    "- **Asset accountability** Kept $3.5M in equipment fully accounted for with zero loss",
    "- **Training at scale** Trained over 500 people across 5 program rounds",
    "- **Quota delivery** Delivered 134% of an annual recruiting target",
    "## THRIVES_IN",
    "Operations leadership, business development, and program management; remote or hybrid",
    "## GROWING_INTO",
    "Leading operations and growth for a mission-driven company",
  ].join("\n");

  const parsed = pipeline.parseEmployerSummary(good);
  expect("summary v2: parses", parsed && parsed.format === "v2" && parsed.provenAt.length === 3 && parsed.gap === null, JSON.stringify(parsed));
  expect("summary v2: bold lead phrase split from proof", parsed.provenAt[0].lead === "Asset accountability" && parsed.provenAt[0].proof.startsWith("Kept $3.5M"));
  expect("summary v2: valid summary has no format issues", pipeline.checkEmployerSummaryFormat(good, input).length === 0, JSON.stringify(pipeline.checkEmployerSummaryFormat(good, input)));
  const withGap = good + "\n## GAP\nHas not yet used a named ERP system; a short vendor course closes it";
  expect("summary v2: optional GAP parsed", pipeline.parseEmployerSummary(withGap).gap.startsWith("Has not yet"));

  const issues = (t) => pipeline.checkEmployerSummaryFormat(t, input).join(" | ");
  expect("summary check: em dash rejected", /dash/.test(issues(good.replace("measurable results", "results — measurable"))));
  expect("summary check: invented number rejected", /not in the evidence/.test(issues(good.replace("134%", "150%"))));
  expect("summary check: bullet without number rejected", /concrete number/.test(issues(good.replace("Trained over 500 people across 5 program rounds", "Trained many people across program rounds"))));
  expect("summary check: missing bold lead rejected", /lead phrase/.test(issues(good.replace("**Quota delivery** ", ""))));
  expect("summary check: too few bullets rejected", /PROVEN_AT has 2/.test(issues(good.replace(/- \*\*Quota delivery\*\*.*\n/, ""))));
  expect("summary check: long bullet rejected", /keep it under 20/.test(issues(good.replace("Trained over 500 people across 5 program rounds", "Trained over 500 people across 5 program rounds while also building curriculum, coaching instructors, and measuring every result"))));
  expect("summary check: old-format text is reported as missing sections", /Missing required sections/.test(issues("## BEST_FIT\nx\n## STRENGTHS\n- y\n## GROWTH\nz")));
  expect("summary check: filler tail rejected", /filler/.test(issues(good.replace("with zero loss", "corroborated across multiple performance reviews"))));
  expect("summary check: inflated scale rejected", /Inflates scale/.test(issues(good.replace("builds accountable teams", "leads large organizations"))));
  expect("summary check: scale word allowed when the evidence uses it", !/Inflates scale/.test(pipeline.checkEmployerSummaryFormat(good.replace("builds accountable teams", "runs large-scale training"), { ...input, capabilityStatements: [...input.capabilityStatements, { statement: "Runs large-scale training.", proof: [] }] }).join(" ")));
  expect("summary check: recruiting called sales rejected", /recruiting work "sales"/.test(issues(good.replace("Quota delivery** Delivered 134% of an annual recruiting target", "Sales results** Delivered 134% of an annual sales target"))));
  expect("summary check: sales role family in THRIVES_IN still allowed", !/recruiting work/.test(issues(good.replace("business development", "sales"))));
  const colonLead = pipeline.parseEmployerSummary(good.replace("**Asset accountability** ", "**Asset accountability:** ").replace("**Training at scale** ", "**Training at scale**: "));
  expect("summary v2: colon after lead, inside or outside the bold, is not part of lead or proof", colonLead.provenAt[0].lead === "Asset accountability" && colonLead.provenAt[0].proof.startsWith("Kept") && colonLead.provenAt[1].lead === "Training at scale" && colonLead.provenAt[1].proof.startsWith("Trained"), JSON.stringify(colonLead.provenAt.slice(0, 2)));
  expect("summary prompt: lead phrase followed by a colon; scale, recruiting, filler rules", /\*\*Lead phrase\*\*: one line of proof/.test(pipeline.buildEmployerSummaryUserPrompt(input)) && /never inflate/.test(pipeline.buildEmployerSummaryUserPrompt(input)) && /Recruiting is recruiting/.test(pipeline.buildEmployerSummaryUserPrompt(input)) && /No filler tails/.test(pipeline.buildEmployerSummaryUserPrompt(input)));
  {
    const g = (t) => employerGuard.scanEmployerFacingText(t, {}).map((v) => v.category);
    expect("guard: 'officer production' flagged", g("Exceeded annual officer production targets by 34%").includes("recruiting_officer_term"));
    expect("guard: 'officer recruiting' flagged", g("Led officer recruiting across a region").includes("recruiting_officer_term"));
    expect("guard: 'recruiting of officers' flagged", g("Ran recruiting of new officers for 2 regions").includes("recruiting_officer_term"));
    expect("guard: 'compliance officer' not flagged", !g("Works closely with a compliance officer and loan officers").includes("recruiting_officer_term"));
    expect("guard: 'inspector general' flagged", g("Prepared for an inspector general audit").includes("oversight_office"));
    expect("guard: new categories have rewrite instructions", /recruiting targets/.test(pipeline.buildGuardRewritePrompt("employer_summary", "x", [{ category: "recruiting_officer_term", match: "officer production" }])));
  }
  {
    const outOfOrder = [
      "## HEADLINE", "Operations leader.",
      "## THRIVES_IN", "Operations leadership; remote",
      "## GAP", "Has not yet used a named ERP system",
      "## PROVEN_AT",
      "- • **Asset accountability**: Kept $3.5M accounted for",
      "* **Training at scale**: Trained 500 people",
      "1. **Quota delivery**: Delivered 134% of target",
      "**No marker**: Line 4 with 2 numbers",
      "## GROWING_INTO", "Director of Operations",
    ].join("\n");
    const p = pipeline.parseEmployerSummary(outOfOrder);
    expect("summary parse: out-of-order sections each land in their own field",
      p && p.format === "v2" && p.thrivesIn === "Operations leadership; remote" && p.gap === "Has not yet used a named ERP system" && p.growingInto === "Director of Operations" && p.provenAt.length === 4,
      JSON.stringify(p));
    expect("summary parse: double and numbered bullet markers stripped, bold kept",
      p.provenAt.map((x) => x.lead).join("|") === "Asset accountability|Training at scale|Quota delivery|No marker" && p.provenAt.every((x) => !/^[-•*\d]/.test(x.proof)),
      JSON.stringify(p.provenAt));
    const noGap = pipeline.parseEmployerSummary(good);
    expect("summary parse: missing GAP stays null and does not swallow GROWING_INTO", noGap.gap === null && noGap.growingInto === "Leading operations and growth for a mission-driven company");
    expect("summary parse: '## PROVEN AT' with a space is read as PROVEN_AT", pipeline.parseEmployerSummary(good.replace("## PROVEN_AT", "## PROVEN AT")).provenAt.length === 3);
  }
  {
    const pr = pipeline.buildEmployerSummaryUserPrompt(input);
    expect("summary prompt: bullets chosen by DIRECTION, not countability", /pick by relevance to DIRECTION, never by how easy a fact is to quantify/.test(pr) && /Administrative facts \(pay records, inventories/.test(pr) && /decisions under pressure/.test(pr));
  }
  expect("prompts: preferred civilian rewrites in summary and statement prompts", /"allied nations" -> "partner countries"/.test(pipeline.buildEmployerSummaryUserPrompt(input)) && /"mission success rate" -> "success rate"/.test(synth.buildSynthesisPrompt([], [])));
  expect("guard: preferred-rewrite phrases are NOT hard identity violations", employerGuard.scanEmployerFacingText("100% mission success rate across high-threat movements with 8 allied nations in a multinational staff exercise", {}).length === 0);
  expect("store gate: valid summary may be stored", pipeline.employerSummaryStoreBlockers(good, input).length === 0, JSON.stringify(pipeline.employerSummaryStoreBlockers(good, input)));
  expect("store gate: empty summary blocked", pipeline.employerSummaryStoreBlockers("", input).length > 0);
  expect("store gate: preamble before ## HEADLINE blocked", /before ## HEADLINE/.test(pipeline.employerSummaryStoreBlockers("Looking at the evidence carefully, there are no numbers.\n\n" + good, input).join(" ")));
  expect("store gate: apology-style PROVEN_AT blocked", pipeline.employerSummaryStoreBlockers(good.replace(/## PROVEN_AT[\s\S]*?## THRIVES_IN/, "## PROVEN_AT\nNo concrete numbers are present in the submitted evidence.\n\n## THRIVES_IN"), input).length > 0);
  expect("summary system prompt: no longer suggests 'documented across multiple performance reviews'", !/"documented across multiple performance reviews" is correct/.test(pipeline.EMPLOYER_SUMMARY_SYSTEM_PROMPT));

  const v1 = pipeline.parseEmployerSummary("## BEST_FIT\nOperations Manager\n## STRENGTHS\n- One\n- Two\n## GROWTH\nGrows");
  expect("summary v1 (old format) still parses", v1 && v1.format === "v1" && v1.strengths.length === 2);
  expect("summary legacy paragraph returns null", pipeline.parseEmployerSummary("A capable professional with many strengths.") === null);

  const prompt = pipeline.buildEmployerSummaryUserPrompt(input);
  expect("summary prompt: written from statements, self summary is context", prompt.includes("capability statements with their proof") && prompt.includes("NOT evidence") && prompt.includes("Accountable for $3.5M"));
  const fallbackPrompt = pipeline.buildEmployerSummaryUserPrompt({ ...input, capabilityStatements: null, capabilitySummary: "ENTRIES TEXT" });
  expect("summary prompt: falls back to entries only without statements", fallbackPrompt.includes("ENTRIES TEXT") && !fallbackPrompt.includes("Accountable for $3.5M"));
  expect("summary prompt: role families, fitness rule, no dashes", /role FAMILIES/.test(prompt) && /physical fitness/.test(prompt) && /no em dashes or en dashes/i.test(prompt));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
