/**
 * Verifies lib/employerTextGuard.ts against:
 *   1. Civilian-title false-positive regressions that MUST now pass clean
 *      (the "General Manager" landmine and everything found in the same audit).
 *   2. Genuine identity disclosures that MUST still be caught - including the
 *      verbatim leak string from the 2026-09-07 incident.
 *
 * Run:   node scripts/verify-text-guard.mjs
 *        node scripts/verify-text-guard.mjs --db   (also scans the real stored
 *              text from the 2026-09-07 15:27:20 generate-capability-finalize
 *              run; needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *              in the environment - no files are read)
 *
 * The guard is TypeScript with no imports, so it is transpiled in-memory with
 * the installed `typescript` package - no build step, no test runner needed.
 */
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const GUARD_PATH = new URL("../lib/employerTextGuard.ts", import.meta.url);
const src = readFileSync(GUARD_PATH, "utf8");
const { outputText } = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const dir = mkdtempSync(join(tmpdir(), "guardcheck-"));
const modPath = join(dir, "employerTextGuard.mjs");
writeFileSync(modPath, outputText);
const { scanEmployerFacingText, formatViolations } = await import(pathToFileURL(modPath).href);

/** @type {{name:string, text:string, name_opt?:string, expectViolation:boolean, expectCategory?:string}[]} */
const CASES = [
  // ─────────── MUST PASS CLEAN (civilian-title / audit false positives) ───────────
  {
    name: "confirmed landmine: General Manager titles",
    text: "Best suited today as a **General Manager** or **Assistant General Manager**, this candidate has run multi-site operations, owned a P&L, and led cross-functional teams of 40+.",
    expectViolation: false,
  },
  {
    name: "general oversight / Attorney General style usage",
    text: "Provided general oversight of vendor compliance and coordinated with the office of the state attorney general on regulatory filings.",
    expectViolation: false,
  },
  { name: "Security Specialist title", text: "A strong fit as a Security Specialist or Operations Specialist on a corporate risk team.", expectViolation: false },
  { name: "Incident Commander title", text: "Has served as Incident Commander during large-scale emergency responses and knows unified command structure cold.", expectViolation: false },
  { name: "major account / major program", text: "Grew a major account portfolio and led a major program overhaul that cut cycle time 30%.", expectViolation: false },
  { name: "team / airline captain", text: "Natural team captain; previously an airline captain-equivalent scheduling lead.", expectViolation: false },
  { name: "private sector / equity / practice", text: "Bridges the public and private sector; comfortable with private equity diligence and private practice clients.", expectViolation: false },
  { name: "Lieutenant Governor (allowlisted phrase)", text: "Coordinated a statewide initiative out of the Lieutenant Governor's office.", expectViolation: false },
  { name: "Sergeant at Arms (allowlisted phrase)", text: "Elected Sergeant-at-Arms for a 900-member professional association.", expectViolation: false },
  {
    name: "user-quoted compliant phrasing",
    text: "This capability is documented across multiple supervisor evaluations. The candidate holds an active security clearance and has a track record of program leadership.",
    expectViolation: false,
  },
  { name: "CIA = Certified Internal Auditor", text: "Holds the CIA (Certified Internal Auditor) credential and a CPA.", expectViolation: false },
  { name: "DHS = state Dept of Human Services", text: "Spent three years as a caseworker for the state Department of Human Services (DHS).", expectViolation: false },
  { name: "DIA = Denver International Airport", text: "Directed ground logistics for a carrier operating out of DIA.", expectViolation: false },
  { name: "'sponsored by' in business prose", text: "The transformation program was sponsored by the parent company and governed by a steering committee.", expectViolation: false },
  { name: "authored business documents", text: "Authored the quarterly compliance report and co-authored more than a dozen standard operating procedures.", expectViolation: false },
  { name: "forward-looking growth timeline", text: "On track for a director-level role within 3-5 years, and a VP track over the next 2 years after that.", expectViolation: false },
  { name: "currency amount, not a year", text: "Accountable for a $2000 daily field budget and a 12000 unit annual throughput target.", expectViolation: false },
  { name: "Salvation Army employer", text: "Regional volunteer coordinator for the Salvation Army across a five-county area.", expectViolation: false },
  { name: "navy blue, not the branch", text: "Rolled out a navy blue uniform standard and a new brand palette company-wide.", expectViolation: false },
  { name: "lone common-word name token", text: "They will pursue efficiencies aggressively and hold teams accountable.", name_opt: "Will Hunt", expectViolation: false },
  { name: "Chief of Staff / C-suite titles", text: "Ready now for a Chief of Staff or Chief Operating Officer seat at a mid-market company.", expectViolation: false },
  { name: "'generally' / 'operations' - no false substring", text: "Generally regarded as the person who stabilized operations and rebuilt the ration-planning workflow.", expectViolation: false },
  { name: "pronoun-free 'they' summary", text: "They rebuilt the function, they hired the leaders, and their playbook is still in use.", expectViolation: false },

  // ─────────── OUTSIDER FRAMING - must PASS CLEAN (guard not over-broad) ───────────
  { name: "translate = render strategy into action", text: "Known for the ability to translate strategy into measurable execution across three business units.", expectViolation: false },
  { name: "transition = systems migration, not sector", text: "Led a major systems transition to a new ERP platform, on time and under budget.", expectViolation: false },
  { name: "context = brings it, does not lack it", text: "Brings deep industry context to procurement and vendor negotiations.", expectViolation: false },
  { name: "bridge = liaison between functions", text: "Served as the bridge between engineering and sales, keeping both aligned on delivery.", expectViolation: false },
  { name: "earn = earns trust, not entry", text: "Quickly earns the trust of frontline teams and executives alike.", expectViolation: false },
  { name: "veteran = experienced, not the noun", text: "A veteran operator who has run high-volume distribution centers for years.", expectViolation: false },

  // ─────────── OUTSIDER FRAMING - must be CAUGHT ───────────
  { name: "live example: 'inside a civilian operational structure'", text: "This step places them inside a civilian operational structure where the same skills apply.", expectViolation: true, expectCategory: "outsider_framing" },
  { name: "live example: 'sector acclimation' timeline", text: "Within 12-24 months of sector acclimation, they are positioned for a director-level role.", expectViolation: true, expectCategory: "outsider_framing" },
  { name: "live example: 'familiarity with civilian operational systems'", text: "Would benefit from familiarity with civilian operational systems and industry-standard software platforms.", expectViolation: true, expectCategory: "outsider_framing" },
  { name: "'translate' their leadership experience", text: "The task is to translate their leadership experience into terms a hiring manager recognizes.", expectViolation: true, expectCategory: "outsider_framing" },
  { name: "'bridge role into' a career", text: "This is a strong bridge role into a commercial operations career.", expectViolation: true, expectCategory: "outsider_framing" },
  { name: "'prove they can' framing", text: "They will need to prove they can operate in a corporate environment before advancing.", expectViolation: true, expectCategory: "outsider_framing" },
  { name: "bare 'military' in output", text: "Draws on a military background to lead calmly under pressure.", expectViolation: true, expectCategory: "outsider_framing" },
  { name: "'career transition' phrase", text: "Supports a smooth career transition into operations management.", expectViolation: true, expectCategory: "outsider_framing" },
  { name: "'needs industry context' vague gap", text: "The main gap is that they still need broader industry context before leading a P&L.", expectViolation: true, expectCategory: "outsider_framing" },
  { name: "'step down' to entry role", text: "May have to step down into a coordinator role to get started.", expectViolation: true, expectCategory: "outsider_framing" },

  // Composite: the current live employer-summary style vs. a rewrite that
  // follows the new prompts. BEFORE must be caught; AFTER must be clean.
  {
    name: "COMPOSITE before: outsider-framed employer summary",
    text: "This step places the candidate inside a civilian operational structure and begins to translate verified leadership and accountability capabilities into sector-specific context. They would build familiarity with civilian operational systems and industry-standard software platforms. Within 12-24 months of sector acclimation, they are positioned to bridge into a general management track.",
    expectViolation: true,
    expectCategory: "outsider_framing",
  },
  {
    name: "COMPOSITE after: capability-first rewrite (new prompts)",
    text: "This candidate is ready now for a General Manager or Assistant General Manager role in a multi-site operations environment. They have run day-to-day operations for organizations of several hundred people, owning workforce scheduling and readiness, equipment and asset accountability across large inventories, resupply under tight timelines, and safety oversight for high-consequence work. They have built and led teams from the ground up, developed first-line supervisors into managers, and held direct accountability for training programs, standards enforcement, and audit-ready recordkeeping. Their leadership record is documented across multiple independent supervisor evaluations, and they hold an active Top Secret security clearance. What they bring to a hiring manager is a proven operations brain that already thinks in throughput, cost control, risk, and people development. The one concrete gap is hands-on time with a specific commercial ERP or workforce-management platform such as NetSuite, SAP, or Kronos, which is a few weeks of platform-specific ramp-up, not a capability gap. On this trajectory they are well positioned to move into a Director of Operations or Site General Manager seat.",
    expectViolation: false,
  },

  // ─────────── MUST STILL BE CAUGHT (genuine disclosures) ───────────
  {
    name: "VERBATIM 2026-09-07 leak string",
    text: "Joel DeToy is a retired U.S. Army Special Forces Sergeant First Class with 20 years of service, the last 15 as a Green Beret, who deployed to combat zones and held a Top Secret clearance granted by the Department of Defense.",
    name_opt: "Joel DeToy",
    expectViolation: true,
  },
  { name: "rank by attribution: 'held the rank of Major'", text: "Over a long career they held the rank of Major and led a staff section of 60.", expectViolation: true, expectCategory: "military_rank" },
  { name: "rank by attribution: 'served as a Captain'", text: "They served as a Captain before moving into the civilian workforce.", expectViolation: true, expectCategory: "military_rank" },
  { name: "Tier-2 rank armed by military vocab", text: "A decorated General who deployed to combat zones and led an infantry brigade.", expectViolation: true },
  { name: "clearance sponsor: 'granted by the DoD'", text: "Their security clearance was granted by the DoD following a full background investigation.", expectViolation: true, expectCategory: "clearance_sponsor_or_agency" },
  { name: "Tier-1 rank alone", text: "Finished as a Sergeant First Class responsible for training and readiness.", expectViolation: true, expectCategory: "military_rank" },
  { name: "branch of service", text: "Twelve years in U.S. Army logistics and sustainment.", expectViolation: true, expectCategory: "branch_of_service" },
  { name: "gendered pronoun", text: "He was promoted ahead of his peers every cycle.", expectViolation: true, expectCategory: "gendered_pronoun" },
  { name: "tenure of service", text: "Brings 20 years of service and deep institutional knowledge.", expectViolation: true, expectCategory: "tenure_count" },
  { name: "explicit year", text: "Has led continuous improvement efforts since 2005.", expectViolation: true, expectCategory: "explicit_year" },
  { name: "publication reference", text: "Published a book on operational leadership and wrote several articles on the topic.", expectViolation: true, expectCategory: "publication_reference" },
  { name: "honorific + name", text: "Mentored directly by Dr. Reyes during a two-year rotation.", expectViolation: true, expectCategory: "honorific_name" },
  { name: "candidate name, distinctive", text: "Joel DeToy personally rebuilt the intake process end to end.", name_opt: "Joel DeToy", expectViolation: true, expectCategory: "candidate_name" },
  { name: "candidate name, all common words, near co-occurrence", text: "Under Will Hunt the division doubled its output in a year.", name_opt: "Will Hunt", expectViolation: true, expectCategory: "candidate_name" },

  // ─────────── RUN 2026-09-07 16:50 REGRESSIONS ───────────
  // FP1: "deployments" armed the Tier-2 gate and flagged "General" in a
  // civilian title. Must be CLEAN now (deployed/deployments are no longer an
  // arming signal, and there is no strong signal or nearby weak signal).
  {
    name: "FP1: 'General' in 'Assistant General Manager', 'active deployments' elsewhere",
    text: "This candidate is ready to step into an Assistant General Manager role today. They have driven measurable gains across audits, organizational transitions, and active deployments, and have led teams of forty or more.",
    expectViolation: false,
  },
  {
    name: "FP1 exact: employer_summary sentence from run 16:50",
    text: "This candidate is ready to step into an Assistant General Manager role today.",
    expectViolation: false,
  },
  // FP2: "step down" inside an explicit negation - the model REJECTING the
  // frame. Must be CLEAN now.
  {
    name: "FP2: 'step down' inside 'rather than a step down'",
    text: "The seniority is calibrated to what they already lead, making this the right entry point at the appropriate tier rather than a step down.",
    expectViolation: false,
  },
  { name: "negated framing: 'not a bridge role'", text: "This is a genuine leadership seat, not a bridge role or a holding pattern.", expectViolation: false },
  { name: "negated framing: 'without stepping down'", text: "They can move into this position without stepping down in scope or pay.", expectViolation: false },
  { name: "negated framing: 'does not need to prove they can'", text: "Given the track record, the candidate does not need to prove they can operate at this level.", expectViolation: false },

  // Negation must NOT excuse a hard term or a real disclosure.
  { name: "negation does NOT excuse 'military'", text: "This is not a military role, but the same discipline shows up daily.", expectViolation: true, expectCategory: "outsider_framing" },
  { name: "must still catch: 'held the rank of General'", text: "Earlier in their career they held the rank of General, overseeing a large staff.", expectViolation: true, expectCategory: "military_rank" },
  { name: "must still catch: 'must prove they can' (not negated)", text: "They will still have to prove they can operate in a corporate environment before advancing.", expectViolation: true, expectCategory: "outsider_framing" },
];

let failures = 0;
console.log("\n=== employerTextGuard verification ===\n");
for (const c of CASES) {
  const v = scanEmployerFacingText(c.text, c.name_opt ? { knownFullName: c.name_opt } : undefined);
  const got = v.length > 0;
  const catOk = !c.expectCategory || v.some((x) => x.category === c.expectCategory);
  const ok = got === c.expectViolation && catOk;
  if (!ok) failures++;
  const tag = ok ? "PASS" : "FAIL";
  const detail = v.length ? formatViolations(v) : "(clean)";
  console.log(`[${tag}] ${c.name}`);
  console.log(`       expect=${c.expectViolation ? "violation" : "clean"}${c.expectCategory ? ` (${c.expectCategory})` : ""}  got=${detail}`);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURE(S)"} — ${CASES.length} cases\n`);

if (process.argv.includes("--db")) {
  await runDbCheck();
}

process.exit(failures === 0 ? 0 : 1);

async function runDbCheck() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("--db: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not in env; skipping DB check.");
    console.log("      run with env loaded, e.g.  node --env-file=.env.local scripts/verify-text-guard.mjs --db");
    return;
  }
  // Optional: `--db=2026-09-07T16` restricts to rows whose created_at starts
  // with that prefix. Default: the 20 most recent generation_debug rows.
  const arg = process.argv.find((a) => a.startsWith("--db="));
  const prefix = arg ? arg.slice("--db=".length) : null;

  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  let q = db
    .from("error_logs")
    .select("created_at, route, error_type, metadata")
    .in("error_type", ["generation_debug", "privacy_violation"])
    .order("created_at", { ascending: false })
    .limit(prefix ? 200 : 20);
  if (prefix) q = q.gte("created_at", prefix).lt("created_at", prefix + "￿");
  const { data, error } = await q;

  if (error) {
    console.log("--db: query failed:", error.message);
    return;
  }
  if (!data?.length) {
    console.log(`--db: no generation_debug / privacy_violation rows found${prefix ? ` for prefix ${prefix}` : ""}.`);
    return;
  }

  console.log(`=== --db: scanning real stored text (${data.length} row(s)${prefix ? `, prefix ${prefix}` : ", most recent"}) ===\n`);
  for (const row of data) {
    /** @type {{label:string, text:string}[]} */
    const fields = [];
    const md = row.metadata ?? {};
    if (row.error_type === "generation_debug") {
      if (md.step3?.raw) fields.push({ label: "step3.raw", text: md.step3.raw });
      if (md.step4?.raw) fields.push({ label: "step4.raw (recommended_position + entry_point + future_positions)", text: md.step4.raw });
      if (md.employerSummary?.raw) fields.push({ label: "employerSummary.raw", text: md.employerSummary.raw });
    } else if (md.textPreview) {
      fields.push({ label: `privacy_violation[${md.field}].textPreview`, text: md.textPreview });
    }
    if (!fields.length) continue;
    console.log(`--- ${row.created_at}  ${row.route}  (${row.error_type}) ---`);
    for (const f of fields) {
      const v = scanEmployerFacingText(f.text);
      const status = v.length === 0 ? "CLEAN" : `${v.length} violation(s)`;
      console.log(`  [${status}] ${f.label}  (${f.text.length} chars)`);
      if (v.length) console.log(`            ${formatViolations(v)}`);
    }
    console.log("");
  }
}
