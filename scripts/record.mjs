// Step 7. Records the outcome everywhere: generated contracts committed to GitHub, a row in public.deployments,
// a deploy-* tag for rollback, and the GitHub job summary.
import { execSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const sh = (c) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
const status = process.argv[2];
const sha = sh("git rev-parse HEAD");
const short = sha.slice(0, 7);
const subject = sh("git log -1 --format=%s").replace(/'/g, "''");
const author = sh("git log -1 --format=%an").replace(/'/g, "''");
const areas = ["supabase/", "cloudflare/", "src/"].filter((p) => {
  try { return sh(`git diff --name-only HEAD~1 HEAD -- ${p}`); } catch { return true; }
}).map((p) => ({ "supabase/": "database", "cloudflare/": "api", "src/": "frontend" })[p]).join(",") || "other";

if (status === "success" && process.env.GITHUB_EVENT_NAME === "push") {
  sh(`git config user.name "ship-bot" && git config user.email "ship-bot@users.noreply.github.com"`);
  sh("git add docs/openapi.json docs/schema.md");
  if (sh("git diff --cached --name-only")) {
    sh(`git commit -m "chore: sync API contract and schema for ${short} [skip ci]" -m "Shipped-With: ship"`);
    for (let i = 0; i < 3; i++) {
      try { sh("git pull --rebase --autostash origin main && git push origin HEAD:main"); break; } catch (e) { if (i === 2) throw e; }
    }
  }
  const tag = "deploy-" + new Date().toISOString().replace(/\D/g, "").slice(0, 12);
  sh(`git tag ${tag} ${sha} && git push origin ${tag}`);
}

if (process.env.SUPABASE_DB_URL) {
  try {
    sh(`psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c "insert into public.deployments(sha, subject, author, areas, status, run_url) values ('${sha}', '${subject}', '${author}', '${areas}', '${status}', '${process.env.RUN_URL || ""}')"`);
  } catch (e) {
    if (status === "success") throw e;
    console.error("Could not write the deployments row (the failure happened earlier - see the failed step).");
  }
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### ${status === "success" ? "✅ Shipped" : "❌ Failed"} ${short}\n- ${subject}\n- Changed: ${areas}\n- Live: ${process.env.APP_URL}\n`);
}
console.log(`Recorded ${status} for ${short}`);
