// Step 3c. Runs the real Worker (wrangler dev) against the local database that `supabase db start` built from
// supabase/migrations/, with a stand-in for Supabase's login keys: schema check, login required, API tests,
// then exports docs/openapi.json and docs/schema.md. The work is in cloudflare/test/rehearse.mjs (it uses the
// Worker's own packages); run `npm ci` in cloudflare/ first.
import { spawnSync } from "node:child_process";

const r = spawnSync(process.execPath, ["cloudflare/test/rehearse.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
