/**
 * Transpiles a set of lib/*.ts modules in-memory with the installed
 * `typescript` package so plain `node` scripts can import them - no build step,
 * no test runner. `@/lib/x` imports between them are rewritten to sibling
 * files. Output goes under node_modules/.cache so package imports
 * (@anthropic-ai/sdk, @supabase/supabase-js) still resolve from the project.
 *
 *   const { scanStatementText } = await loadTsModules(["statementGuard", "employerTextGuard"], "statementGuard");
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

export async function loadTsModules(names, entry) {
  const outDir = join(ROOT, "node_modules", ".cache", "wpm-ts");
  mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    const src = readFileSync(join(ROOT, "lib", `${name}.ts`), "utf8");
    const { outputText } = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    });
    const rewritten = outputText.replace(/from\s+["']@\/lib\/([\w-]+)["']/g, (_m, dep) => {
      if (!names.includes(dep)) throw new Error(`lib/${name}.ts imports @/lib/${dep}, which was not listed`);
      return `from "./${dep}.mjs"`;
    });
    writeFileSync(join(outDir, `${name}.mjs`), rewritten);
  }
  return import(pathToFileURL(join(outDir, `${entry}.mjs`)).href);
}

// Minimal .env.local reader (KEY=value per line) for scripts that talk to
// Supabase or Anthropic. Never prints values.
export function loadEnvLocal() {
  const text = readFileSync(join(ROOT, ".env.local"), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}

export { ROOT };
