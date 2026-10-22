/**
 * Tier 1 capability statements - Phase 1 model comparison.
 *
 * Runs synthesis for one candidate with each given model and saves every
 * result to review/statements-<model>.json, plus the model's uncertain terms
 * to review/uncertain-terms-<model>.json. READ-ONLY against the database:
 * it never writes a statement to candidate_profiles.
 *
 * Run:   node scripts/compare-capability-statements.mjs [userIdOrPrefix] [model ...]
 *        defaults: 707ef2c7  claude-sonnet-4-6 claude-fable-5-1
 * Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY
 * (read from .env.local when not already set).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { loadTsModules, loadEnvLocal, ROOT } from "./lib/loadTsModules.mjs";

loadEnvLocal();
const [, , userArg = "707ef2c7", ...modelArgs] = process.argv;
const models = modelArgs.length ? modelArgs : ["claude-sonnet-4-6", "claude-fable-5-1"];

const { runCapabilityStatementSynthesis } = await loadTsModules(
  ["capabilityStatements", "capabilityStatementChecks", "statementGuard", "employerTextGuard", "translationGlossary", "documentLabels"],
  "capabilityStatements"
);

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const { data: rows, error } = await db
  .from("candidate_profiles")
  .select("user_id, display_name, pending_evidence_groups, document_metadata");
if (error) throw error;
const matches = rows.filter((r) => r.user_id === userArg || r.user_id.startsWith(userArg));
if (matches.length !== 1) {
  console.error(`expected exactly one profile matching "${userArg}", found ${matches.length}`);
  process.exit(1);
}
const profile = matches[0];
const groups = Array.isArray(profile.pending_evidence_groups) ? profile.pending_evidence_groups : [];
console.log(`profile ${profile.user_id.slice(0, 8)}: ${groups.length} evidence groups`);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const outDir = join(ROOT, "review");
mkdirSync(outDir, { recursive: true });

await Promise.all(
  models.map(async (model) => {
    const t0 = Date.now();
    const result = await runCapabilityStatementSynthesis({
      anthropic,
      groups,
      storedDocs: Array.isArray(profile.document_metadata) ? profile.document_metadata : [],
      knownFullName: profile.display_name ?? null,
      model,
    });
    const file = join(outDir, `statements-${model}.json`);
    writeFileSync(file, JSON.stringify({ userId: profile.user_id.slice(0, 8), requestedModel: model, ...result }, null, 2) + "\n");
    writeFileSync(
      join(outDir, `uncertain-terms-${model}.json`),
      JSON.stringify({ requestedModel: model, uncertainTerms: result.uncertainTerms }, null, 2) + "\n"
    );
    console.log(
      `${model}: status=${result.status} core=${result.core.length} niche=${result.niche.length} rejected=${result.rejected.length}` +
        ` uncertain=${result.uncertainTerms.length} calls=${result.calls.length} ${Math.round((Date.now() - t0) / 1000)}s -> ${file}`
    );
  })
);
