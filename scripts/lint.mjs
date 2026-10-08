// Step 2. Migration + placeholder checks, and "is the API still closed?".
// - Migration names YYYYMMDDHHMMSS_snake_name.sql, non-empty.
// - Destructive SQL (drop/rename) needs "[contract]" in the commit message and the column must be unused.
// - No mock/placeholder markers in shipped code.
// - Security must stay on: the Worker verifies Supabase logins (ES256, issuer, audience) on every business endpoint,
//   only the health/version endpoints are public, and production config never turns login off.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const errors = [];
const dir = "supabase/migrations";
const msg = execSync("git log -1 --format=%B", { encoding: "utf8" });
const before = process.env.BEFORE_SHA && !/^0+$/.test(process.env.BEFORE_SHA) ? process.env.BEFORE_SHA : "HEAD~1";
let added = [];
try {
  added = execSync(`git diff --name-only --diff-filter=A ${before} HEAD -- ${dir}`, { encoding: "utf8" }).split("\n").filter(Boolean);
} catch {
  added = execSync(`git ls-files ${dir}`, { encoding: "utf8" }).split("\n").filter(Boolean);
}
const walk = (d) => !existsSync(d) ? [] : readdirSync(d).flatMap((f) => {
  const p = join(d, f);
  return statSync(p).isDirectory() ? walk(p) : [p];
});
const code = [...walk("cloudflare/src"), ...walk("src")]
  .filter((f) => /\.(java|ts|tsx|js|jsx)$/.test(f) && !/generated[\\/]api-schema\.ts$/.test(f));

for (const f of existsSync(dir) ? readdirSync(dir) : []) {
  const p = join(dir, f).replace(/\\/g, "/");
  const sql = readFileSync(p, "utf8");
  if (!/^\d{14}_[a-z0-9_]+\.sql$/.test(f)) errors.push(`${f}: name must be YYYYMMDDHHMMSS_snake_name.sql`);
  if (!sql.trim()) errors.push(`${f}: empty file`);
  const drops = [...sql.matchAll(/drop\s+column\s+(?:if\s+exists\s+)?"?(\w+)"?|rename\s+column\s+"?(\w+)"?/gi)].map((m) => m[1] || m[2]);
  const destructive = drops.length || /drop\s+table/i.test(sql);
  if (destructive && added.includes(p)) {
    if (!/\[contract\]/.test(msg)) errors.push(`${f}: drops/renames need "[contract]" in the commit message (expand first, contract later)`);
    for (const col of drops) {
      const camel = col.replace(/_(\w)/g, (_, c) => c.toUpperCase());
      const users = code.filter((c) => new RegExp(`\\b(${col}|${camel})\\b`).test(readFileSync(c, "utf8")));
      if (users.length) errors.push(`${f}: column "${col}" is still used in ${users.join(", ")}`);
    }
  }
}

const banned = /\b(REPLACE_WITH|TODO_SECRET|mockData|dummyData|placeholder data|hardcoded)\b/;
for (const c of code) {
  if (!/[\\/]test[\\/]/.test(c) && banned.test(readFileSync(c, "utf8"))) errors.push(`${c}: contains a mock/placeholder marker`);
}

// Security gate: the API must never ship open.
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : "");
const routes = read("cloudflare/src/api/routes.ts");
const index = read("cloudflare/src/index.ts");
const auth = read("cloudflare/src/api/auth.ts");
const wrangler = read("cloudflare/wrangler.jsonc");
if (!routes) errors.push("cloudflare/src/api/routes.ts is missing - every endpoint needs a role rule there");
const PUBLIC_OK = new Set(["/api/v1/health", "/api/version", "/api/actuator/health", "/api/actuator/health/liveness"]);
for (const m of routes.matchAll(/path:\s*'([^']+)',\s*access:\s*'public'/g)) {
  if (!PUBLIC_OK.has(m[1])) errors.push(`routes.ts: ${m[1]} is public - business endpoints must require login`);
}
for (const m of routes.matchAll(/\{\s*method:\s*'(\w+)',\s*path:\s*'([^']+)'(?![^}]*access:)/g)) {
  errors.push(`routes.ts: ${m[1]} ${m[2]} has no access rule`);
}
if (!/if \(!who\) return unauthorized\(\);/.test(index)) errors.push("cloudflare/src/index.ts: the login check (if (!who) return unauthorized();) is missing");
if (!/algorithms:\s*\['ES256'\]/.test(auth) || !/audience:\s*'authenticated'/.test(auth) || !/issuer:/.test(auth)) {
  errors.push("cloudflare/src/api/auth.ts: tokens must be verified with ES256, the Supabase issuer and audience 'authenticated'");
}
for (const k of ["AUTH_MODE", "EXPOSE_CONTRACT", "DATABASE_URL"]) {
  if (new RegExp(`"${k}"`).test(wrangler)) errors.push(`cloudflare/wrangler.jsonc: ${k} must never be set in the deployed config (local / rehearsal only)`);
}

if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log("Lint OK");
