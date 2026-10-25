/**
 * Profile control slice 1 checks - no network, no database:
 *   - direction validation / normalization (lib/candidateDirection.ts)
 *   - employer summary prompt + THRIVES IN checks driven by direction
 *   - direction passed to synthesis and Step 4, experience level gone
 *   - candidate rebuild limits and the one-deep follow-up queue
 *     (lib/profileRebuilds.ts) against an in-memory Supabase stand-in
 *
 *   node scripts/verify-profile-direction.mjs
 */
import { loadTsModules } from "./lib/loadTsModules.mjs";

process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-service-role-key";

const ALL = [
  "profileRebuilds", "capabilityStatementJobs", "capabilityPipeline", "capabilityStatements", "capabilityStatementChecks",
  "statementGuard", "employerTextGuard", "translationGlossary", "documentLabels", "generationAlerts", "email",
  "candidateDirection", "roleFamilies", "civilianLanguage", "candidateTools", "summaryNotice",
];
const dir = await loadTsModules(ALL, "candidateDirection");
const fam = await loadTsModules(ALL, "roleFamilies");
const pipeline = await loadTsModules(ALL, "capabilityPipeline");
const synth = await loadTsModules(ALL, "capabilityStatements");
const rebuilds = await loadTsModules(ALL, "profileRebuilds");

let failed = 0;
let passed = 0;
function expect(name, cond, detail) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}`);
  }
}

// ───────────────────────── role families ─────────────────────────
{
  expect("families: about 25 curated", fam.ROLE_FAMILIES.length >= 24 && fam.ROLE_FAMILIES.length <= 30, String(fam.ROLE_FAMILIES.length));
  expect("families: ids unique", new Set(fam.ROLE_FAMILIES.map((f) => f.id)).size === fam.ROLE_FAMILIES.length);
  const titled = fam.ROLE_FAMILIES.filter((f) => dir.findTitleWords(f.label).length > 0);
  expect("families: no label is itself a job title", titled.length === 0, titled.map((f) => f.label).join(", "));
}

// ───────────────────────── normalizeDirection ─────────────────────────
{
  const ok = (raw) => dir.normalizeDirection(raw);
  expect("direction: at least one family required", "error" in ok({ roleFamilies: [], scope: "open_related", workSetting: "remote" }));
  expect("direction: unknown family ids dropped", "error" in ok({ roleFamilies: ["not_a_family"], workSetting: "remote" }));
  expect("direction: 'other' needs its text", "error" in ok({ roleFamilies: ["other"], otherFamily: "  " }));
  const other = ok({ roleFamilies: ["other"], otherFamily: "Nonprofit leadership" });
  expect("direction: 'other' with text accepted", "direction" in other && other.direction.otherFamily === "Nonprofit leadership");
  expect("direction: more than 5 families rejected", "error" in ok({ roleFamilies: fam.ROLE_FAMILIES.slice(0, 6).map((f) => f.id) }));
  expect("direction: only_these requires a title", "error" in ok({ roleFamilies: ["operations_leadership"], scope: "only_these", titles: ["", " "] }));
  const open = ok({ roleFamilies: ["operations_leadership", "operations_leadership"], scope: "open_related", titles: ["Director of Operations"], workSetting: "remote" });
  expect("direction: titles dropped when open to related roles; duplicates removed", "direction" in open && !open.direction.titles && open.direction.roleFamilies.length === 1);
  const only = ok({ roleFamilies: ["operations_leadership"], scope: "only_these", titles: ["Director of Operations", "COO", "VP Ops", "Fourth"], workSetting: "bogus" });
  expect("direction: only_these keeps up to 3 titles; bad work setting -> open", "direction" in only && only.direction.titles.length === 3 && only.direction.workSetting === "open");
  const long = ok({ roleFamilies: ["operations_leadership"], howIWantToWork: "x".repeat(400) });
  expect("direction: howIWantToWork capped at 160", "direction" in long && long.direction.howIWantToWork.length === 160);

  const d1 = ok({ roleFamilies: ["business_development", "operations_leadership"], scope: "open_related", workSetting: "remote" }).direction;
  const d2 = ok({ roleFamilies: ["operations_leadership", "business_development"], scope: "open_related", workSetting: "remote" }).direction;
  expect("direction: canonical form ignores family order", dir.canonicalDirection(d1) === dir.canonicalDirection(d2));
  expect("direction: canonical form changes with work setting", dir.canonicalDirection(d1) !== dir.canonicalDirection({ ...d1, workSetting: "hybrid" }));
  expect("direction: compat job_types = family labels when open", JSON.stringify(dir.directionCompatColumns(d1)) === JSON.stringify({ job_types: ["Business development and partnerships", "Operations leadership"], work_preference: "remote" }));
  expect("direction: compat job_types = titles when only_these", dir.directionCompatColumns(only.direction).job_types[0] === "Director of Operations");
  expect("direction: readStoredDirection tolerates junk", dir.readStoredDirection({ nope: 1 }) === null && dir.readStoredDirection(null) === null);
}

// ───────────────────────── employer summary: THRIVES IN ─────────────────────────
const openDir = dir.normalizeDirection({
  roleFamilies: ["operations_leadership", "business_development", "program_project_management"],
  scope: "open_related",
  workSetting: "remote",
  howIWantToWork: "Real responsibility, minimal oversight, built on relationships",
}).direction;
const onlyDir = dir.normalizeDirection({ roleFamilies: ["operations_leadership"], scope: "only_these", titles: ["Director of Operations"], workSetting: "remote" }).direction;
const input = (direction) => ({
  capabilityStatements: [
    { statement: "Keeps equipment accountable.", proof: [{ text: "Accountable for $3.5M in equipment with zero loss" }, { text: "Trained over 500 people across 5 rounds" }] },
    { statement: "Recruits against quota.", proof: [{ text: "Delivered 134% of the annual recruiting target" }] },
  ],
  capabilitySummary: "",
  selfSummary: "Building things.",
  direction,
  isAlternateSummary: false,
});
const summary = (thrives, growing = "Leading operations for a company where technology and people meet") =>
  [
    "## HEADLINE", "Leads accountable teams and programs that deliver measurable results under pressure.",
    "## PROVEN_AT",
    "- **Asset accountability**: Kept $3.5M in equipment fully accounted for with zero loss",
    "- **Training at scale**: Trained over 500 people across 5 program rounds",
    "- **Recruiting results**: Delivered 134% of an annual recruiting target",
    "## THRIVES_IN", thrives,
    "## GROWING_INTO", growing,
  ].join("\n");
{
  const issues = (text, direction) => pipeline.checkEmployerSummaryFormat(text, input(direction)).join(" | ");
  expect("thrives: families + setting passes", issues(summary("Operations leadership, business development, and program management; remote"), openDir) === "", issues(summary("Operations leadership, business development, and program management; remote"), openDir));
  expect("thrives: paraphrased family (match term) counts", issues(summary("Operations and partnerships work; remote"), openDir) === "");
  expect("thrives: no selected family -> rejected", /must name at least one of the selected role families/.test(issues(summary("Cybersecurity and data analytics; remote"), openDir)));
  expect("thrives: a title when open to related roles -> rejected", /names a specific job title \("director"\)/.test(issues(summary("Director of Operations roles in operations leadership; remote"), openDir)));
  expect("thrives: 'COO' counts as a title", /specific job title/.test(issues(summary("Operations leadership, COO track; remote"), openDir)));
  expect("thrives: title allowed when only_these", issues(summary("Director of Operations in operations leadership; remote"), onlyDir) === "");
  expect("thrives: no direction -> no direction checks (legacy)", issues(summary("Director of Operations; remote"), null) === "");

  // THRIVES IN names only the best 2-3 of many families; "open" reads as "any work setting".
  const fiveDir = dir.normalizeDirection({
    roleFamilies: ["operations_leadership", "executive_leadership", "program_project_management", "customer_success", "recruiting_talent"],
    scope: "open_related",
    workSetting: "open",
  }).direction;
  expect("thrives: 4+ of 5 families named -> rejected", /names 5 role families; name only the 2 or 3/.test(issues(summary("Operations leadership, executive leadership, program management, customer success, and recruiting; any work setting"), fiveDir)));
  expect("thrives: 2 of 5 families named passes", issues(summary("Operations leadership and recruiting; any work setting"), fiveDir) === "", issues(summary("Operations leadership and recruiting; any work setting"), fiveDir));
  expect("thrives: bare 'open' setting rejected", /ends in "open"/.test(issues(summary("Operations leadership and recruiting; open"), fiveDir)));
  const fivePrompt = pipeline.buildEmployerSummaryUserPrompt(input(fiveDir));
  expect("summary prompt: many families -> 2 or 3 the evidence supports best", /the 2 or 3 target role families from DIRECTION that the EVIDENCE supports best \(never all of them/.test(fivePrompt));
  expect("summary prompt: 'open' rendered as 'any work setting'", fivePrompt.includes('("any work setting")') && fivePrompt.includes("Work setting: any work setting") && !/Work setting: open/.test(fivePrompt));
  expect("summary prompt: 3 or fewer families -> no 'never all of them'", !/never all of them/.test(pipeline.buildEmployerSummaryUserPrompt(input(openDir))));

  // Preferred work setting + travel willingness (2026-10-25)
  {
    const base = { roleFamilies: ["operations_leadership", "business_development"], scope: "open_related" };
    const pref = dir.normalizeDirection({ ...base, workSetting: "remote", workSettingPreferred: true, travel: "occasional" }).direction;
    expect("direction: preferred + travel kept", pref.workSettingPreferred === true && pref.travel === "occasional");
    expect("direction: 'preferred' dropped for open; bad travel dropped", (() => { const d = dir.normalizeDirection({ ...base, workSetting: "open", workSettingPreferred: true, travel: "always" }).direction; return !d.workSettingPreferred && !d.travel; })());
    const strict = dir.normalizeDirection({ ...base, workSetting: "remote", travel: "occasional" }).direction;
    const noTravel = dir.normalizeDirection({ ...base, workSetting: "remote", workSettingPreferred: true, travel: "none" }).direction;
    expect("direction hash: preferred changes it", dir.canonicalDirection(pref) !== dir.canonicalDirection(strict));
    expect("direction hash: travel changes it", dir.canonicalDirection(pref) !== dir.canonicalDirection(noTravel));
    expect("direction: setting clause reads naturally", dir.settingClause(pref) === "remote preferred, open to occasional travel" && dir.settingClause(noTravel) === "remote preferred" && dir.settingClause(strict) === "remote, open to occasional travel");
    expect("direction: compat work_preference 'remote preferred'", dir.directionCompatColumns(pref).work_preference === "remote preferred");
    expect("direction: prompt text has setting and travel", /Work setting: remote preferred\nTravel: open to occasional travel/.test(dir.formatDirectionForPrompt(pref)) && /Travel: not willing to travel/.test(dir.formatDirectionForPrompt(noTravel)));
    expect("direction: scoring object carries both", JSON.stringify(dir.directionForScoring(pref)).includes('"work_setting":"remote preferred","travel":"occasional"'));

    const p = pipeline.buildEmployerSummaryUserPrompt(input(pref));
    expect("summary prompt: setting clause with travel", p.includes('then the work setting and travel ("remote preferred, open to occasional travel")') && p.includes("remote preferred, open to occasional travel for partner meetings and events"));
    const ok = "Operations leadership and business development; remote preferred, open to travel for partner meetings and events";
    expect("thrives: preferred + travel rendered naturally passes", issues(summary(ok), pref) === "", issues(summary(ok), pref));
    expect("thrives: 'preferred' missing -> rejected", /must say the work setting is preferred/.test(issues(summary("Operations leadership and business development; remote, open to travel for events"), pref)));
    expect("thrives: travel missing -> rejected", /willingness to travel/.test(issues(summary("Operations leadership and business development; remote preferred"), pref)));
    expect("thrives: travel offered when none -> rejected", /not willing to travel/.test(issues(summary("Operations leadership and business development; remote preferred, open to occasional travel"), noTravel)));
    expect("thrives: no travel mention when none passes", issues(summary("Operations leadership and business development; remote preferred"), noTravel) === "");
  }

  const prompt = pipeline.buildEmployerSummaryUserPrompt(input(openDir));
  expect("summary prompt: lists the selected families", prompt.includes('"Operations leadership"') && prompt.includes('"Business development and partnerships"'));
  expect("summary prompt: open -> never a specific title", /Never a specific job title \(no director, manager, officer, chief, or similar\)/.test(prompt));
  expect("summary prompt: GROWING_INTO uses how they want to work", prompt.includes('built from the target role families and how they want to work ("Real responsibility, minimal oversight, built on relationships")'));
  expect("summary prompt: direction block replaces legacy roles line", prompt.includes("Target role families:") && !prompt.includes("Roles they want:"));
  const onlyPrompt = pipeline.buildEmployerSummaryUserPrompt(input(onlyDir));
  expect("summary prompt: only_these names the titles", onlyPrompt.includes('name them too: "Director of Operations"'));
  const legacy = pipeline.buildEmployerSummaryUserPrompt({ ...input(null), desiredRoles: "Chief/Director of Operations", workPreference: "remote" });
  expect("summary prompt: legacy profiles keep the old roles line", legacy.includes("Roles they want: Chief/Director of Operations"));
}

// ───────────────────────── synthesis + Step 4 ─────────────────────────
{
  const p = synth.buildSynthesisPrompt([], [], { summary: "s", capabilityTags: [], direction: openDir });
  expect("synthesis: direction in the NOT EVIDENCE context block", /CONTEXT ABOUT THE PERSON - NOT EVIDENCE[\s\S]*Where they want to go[\s\S]*Target role families: Operations leadership/.test(p));
  const s4 = pipeline.buildStep4Prompt({ desiredRole: "x", direction: openDir, workPreference: "remote", skills: "", summary: "", capabilitySummary: "" });
  expect("step 4: direction in, experience level gone", s4.includes("Target role families:") && !/Experience level/i.test(s4));
  const s4legacy = pipeline.buildStep4Prompt({ desiredRole: "Ops", direction: null, workPreference: "remote", skills: "", summary: "", capabilitySummary: "" });
  expect("step 4: legacy desired role when no direction", s4legacy.includes("- Desired role/industry: Ops") && !/Experience level/i.test(s4legacy));
}

// ───────────────────────── rebuild limits + queue ─────────────────────────
function fakeDb(seed, denied = []) {
  const tables = JSON.parse(JSON.stringify(seed));
  let n = 0;
  class Q {
    constructor(t) { this.t = t; this.f = []; this.op = "select"; this.ret = false; }
    select(_c, opts) { if (this.op === "select") { if (opts?.count) { this.count = true; this.head = opts.head; } } else this.ret = true; return this; }
    insert(row) { this.op = "insert"; this.payload = Array.isArray(row) ? row : [row]; return this; }
    update(p) { this.op = "update"; this.payload = p; return this; }
    delete() { this.op = "delete"; return this; }
    eq(c, v) { this.f.push((r) => r[c] === v); return this; }
    gte(c, v) { this.f.push((r) => r[c] >= v); return this; }
    in(c, vs) { this.f.push((r) => vs.includes(r[c])); return this; }
    order(c, o = {}) { this.ord = [c, o.ascending !== false]; return this; }
    maybeSingle() { this.one = "maybe"; return this.run(); }
    single() { this.one = "one"; return this.run(); }
    then(a, b) { return this.run().then(a, b); }
    async run() {
      if (denied.includes(this.t)) return { data: null, count: null, error: { message: `permission denied for table ${this.t}` } };
      const rows = (tables[this.t] ??= []);
      const match = () => rows.filter((r) => this.f.every((fn) => fn(r)));
      const shape = (list) => (this.one ? { data: list[0] ?? null, error: this.one === "one" && !list[0] ? { message: "no row" } : null } : { data: list, error: null });
      if (this.op === "insert") {
        const added = this.payload.map((r) => ({ id: r.id ?? (this.t === "capability_statement_jobs" ? `job-${++n}` : ++n), created_at: new Date().toISOString(), ...r }));
        rows.push(...added);
        return this.ret ? shape(added) : { data: null, error: null };
      }
      if (this.op === "update") {
        const hit = match();
        hit.forEach((r) => Object.assign(r, this.payload));
        return this.ret ? shape(hit) : { data: null, error: null };
      }
      if (this.op === "delete") {
        const hit = new Set(match());
        tables[this.t] = rows.filter((r) => !hit.has(r));
        return { data: null, error: null };
      }
      let list = match();
      if (this.ord) { const [c, asc] = this.ord; list = [...list].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1)); }
      if (this.count) return { count: list.length, data: this.head ? null : list, error: null };
      return shape(list);
    }
  }
  return { tables, from: (t) => new Q(t) };
}

const triggered = [];
globalThis.fetch = async (url, init) => {
  triggered.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return { status: 202, ok: true, json: async () => ({}), text: async () => "" };
};
const silence = console.error;
console.error = () => {};
const U = "user-1";
const profileRow = (over = {}) => ({
  user_id: U,
  display_name: "Test Person",
  summary: "s",
  capability_tags: [],
  direction: openDir,
  pending_evidence_groups: [{ groupId: "b0-g1", claims: ["Led 12"], verificationStatus: "VERIFIED", primarySourceDocId: "d1", corroboratingDocIds: [] }],
  document_metadata: [],
  capability_statements: [{ statement: "Leads teams.", proof: [{ text: "Led 12", groupIds: ["b0-g1"] }] }],
  niche_capabilities: [],
  capability_profile_generated_at: "2026-10-25T00:00:00Z",
  ...over,
});
const jobs = (db) => db.tables.capability_statement_jobs ?? [];
const logs = (db) => db.tables.profile_rebuild_log ?? [];
try {
  {
    const db = fakeDb({ candidate_profiles: [profileRow()] });
    triggered.length = 0;
    const r1 = await rebuilds.requestRebuild(db, "https://app.test", U, "summary", "direction_change");
    expect("rebuild: nothing running -> summary job started", r1.status === "started" && jobs(db).length === 1 && jobs(db)[0].result?.summaryOnly === true, JSON.stringify(r1));
    expect("rebuild: step 1 triggered at the step route", triggered.length === 1 && triggered[0].url === "https://app.test/api/admin/capability-statement-jobs/step" && triggered[0].body.seq === 1);
    expect("rebuild: logged as started with the job id", logs(db).some((l) => l.status === "started" && l.kind === "summary" && l.job_id === r1.jobId));

    jobs(db)[0].step_started_at = new Date().toISOString(); // running, fresh
    const r2 = await rebuilds.requestRebuild(db, "https://app.test", U, "summary", "direction_change");
    expect("rebuild: while a job runs -> queued, no new job", r2.status === "queued" && jobs(db).length === 1);
    const r3 = await rebuilds.requestRebuild(db, "https://app.test", U, "full", "candidate_request");
    const queuedRows = logs(db).filter((l) => l.status === "queued");
    expect("rebuild: second request while running -> still exactly one queued, upgraded to full", r3.status === "queued" && r3.kind === "full" && queuedRows.length === 1 && queuedRows[0].kind === "full", JSON.stringify(queuedRows));

    const notYet = await rebuilds.startQueuedRebuild(db, "https://app.test", U);
    expect("rebuild: queued follow-up waits while the job still runs", notYet === null && jobs(db).length === 1);

    jobs(db)[0].status = "succeeded";
    const r4 = await rebuilds.startQueuedRebuild(db, "https://app.test", U);
    expect("rebuild: job finished -> queued follow-up starts as full", r4?.status === "started" && r4.kind === "full" && jobs(db).length === 2 && !jobs(db)[1].result, JSON.stringify(r4));
    expect("rebuild: queued row marked dequeued", logs(db).filter((l) => l.status === "queued").length === 0 && logs(db).some((l) => l.status === "dequeued"));
    expect("rebuild: nothing left to start", (await rebuilds.startQueuedRebuild(db, "https://app.test", U)) === null);
  }
  {
    const now = Date.now();
    const old = new Date(now - 25 * 3600 * 1000).toISOString();
    const recent = new Date(now - 3600 * 1000).toISOString();
    const startedRows = (kind, at, count) => Array.from({ length: count }, (_, i) => ({ id: `${kind}-${at}-${i}`, user_id: U, kind, status: "started", source: "candidate_request", created_at: at }));
    const db = fakeDb({ candidate_profiles: [profileRow()], profile_rebuild_log: [...startedRows("full", recent, 3), ...startedRows("full", old, 5)] });
    const r = await rebuilds.requestRebuild(db, "https://app.test", U, "full", "candidate_request");
    expect("limit: 4th full rebuild in 24h refused", r.status === "limited" && r.limit === 3 && jobs(db).length === 0, JSON.stringify(r));
    expect("limit: refusal logged", logs(db).some((l) => l.status === "limited"));
    const s = await rebuilds.requestRebuild(db, "https://app.test", U, "summary", "direction_change");
    expect("limit: summary limit counted separately", s.status === "started");

    const db2 = fakeDb({ candidate_profiles: [profileRow()], profile_rebuild_log: [...startedRows("summary", recent, 20)] });
    const s2 = await rebuilds.requestRebuild(db2, "https://app.test", U, "summary", "direction_change");
    expect("limit: 21st summary rebuild in 24h refused", s2.status === "limited" && s2.limit === 20);
    const db3 = fakeDb({ candidate_profiles: [profileRow()], profile_rebuild_log: [...startedRows("full", old, 10)] });
    expect("limit: rebuilds older than 24h do not count", (await rebuilds.requestRebuild(db3, "https://app.test", U, "full", "after_generation")).status === "started");
  }
  {
    const db = fakeDb({ candidate_profiles: [profileRow({ capability_statements: null })] });
    const r = await rebuilds.requestRebuild(db, "https://app.test", U, "summary", "direction_change");
    expect("skip: summary rebuild with no statements is skipped, not failed", r.status === "skipped" && /no capability statements/.test(r.reason) && jobs(db).length === 0, JSON.stringify(r));
    const f = await rebuilds.requestRebuild(db, "https://app.test", U, "full", "after_generation");
    expect("skip: a full rebuild still starts without statements", f.status === "started" && !jobs(db)[0].result);
  }
  {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const db = fakeDb({
      candidate_profiles: [profileRow()],
      capability_statement_jobs: [
        { id: "job-stale", user_id: U, status: "running", step_seq: 2, step_started_at: stale, created_at: stale, model: "m" },
        { id: "job-never", user_id: U, status: "running", step_seq: 0, step_started_at: null, created_at: stale, model: "m" },
      ],
      profile_rebuild_log: [{ id: "q1", user_id: U, kind: "full", status: "queued", source: "after_generation", created_at: stale }],
    });
    const r = await rebuilds.requestRebuild(db, "https://app.test", U, "summary", "direction_change");
    expect("stale: killed and never-started jobs do not block", r.status === "started", JSON.stringify(r));
    expect("stale: both marked failed", jobs(db).filter((j) => j.id !== r.jobId).every((j) => j.status === "failed"));
    expect("stale: orphaned queued full request folded in (starts as full)", r.kind === "full" && logs(db).find((l) => l.id === "q1")?.status === "superseded");
  }
  {
    // The production failure (2026-10-25): no service_role grant on the log.
    const db = fakeDb({ candidate_profiles: [profileRow()] }, ["profile_rebuild_log"]);
    const r = await rebuilds.requestRebuildSafely(db, "https://app.test", U, "full", "after_generation");
    expect("failed start: reported as failed, not thrown", r.status === "failed" && /permission denied/.test(r.reason), JSON.stringify(r));
    expect("failed start: admin log entry written", (db.tables.error_logs ?? []).some((e) => e.error_type === "profile_rebuild_failed"), JSON.stringify(db.tables.error_logs));
    const notice = db.tables.candidate_profiles[0].employer_summary_notice;
    expect("failed start: candidate notice set", notice?.message === "Your summary couldn't be updated; showing the previous version." && /went wrong/.test(notice.reason), JSON.stringify(notice));
    expect("failed start: no job created", jobs(db).length === 0);
  }
  {
    const recent = new Date(Date.now() - 3600 * 1000).toISOString();
    const db = fakeDb({ candidate_profiles: [profileRow()], profile_rebuild_log: Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, user_id: U, kind: "summary", status: "started", source: "x", created_at: recent })) });
    await rebuilds.requestRebuildSafely(db, "https://app.test", U, "summary", "direction_change");
    expect("limited: candidate notice says so", /limit of 20/.test(db.tables.candidate_profiles[0].employer_summary_notice?.reason ?? ""));
  }
} finally {
  console.error = silence;
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
