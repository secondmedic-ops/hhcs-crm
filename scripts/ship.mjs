// ONE command for every change, big or small:  node scripts/ship.mjs "what changed"   (or double-click SHIP.bat)
// Pull -> remove retired files -> commit everything -> push -> watch the pipeline -> print ✅ LIVE or the failed step.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { ensureGhLogin } from "./gh-login.mjs";
import { ensurePushAccount, ensureRepo } from "./gh-owner.mjs";
// Pause without a shell command (Windows "timeout" refuses to run from a script: "Input redirection is not supported").
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const run = (c) => execSync(c, { stdio: "inherit" });
const out = (c) => execSync(c, { encoding: "utf8" }).trim();
const msg = process.argv.slice(2).join(" ").trim() || "update";

try { out("gh --version"); } catch { console.error("GitHub CLI missing - double-click START-HERE.bat first."); process.exit(1); }
ensureGhLogin(); // logs in right here if needed (no need to go back to START-HERE)

// No GitHub repository yet (SHIP.bat before START-HERE.bat): run the one-time setup instead of failing.
let hasOrigin = false;
try { hasOrigin = !!out("git remote get-url origin"); } catch { hasOrigin = false; }
if (!hasOrigin) {
  console.log("\nThis folder is not connected to GitHub yet. Starting the one-time setup (same as START-HERE.bat) ...\n");
  const r = spawnSync(process.execPath, ["scripts/setup.mjs"], { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
  console.log("\nSetup finished. Do the browser steps printed above, then double-click SHIP.bat again.");
  process.exit(0);
}
// Always secondmedic-ops/hhcs-crm: as secondmedic-ops, or as a developer it invited (commits authored as secondmedic-ops).
ensurePushAccount();
ensureRepo();
// First push of a new repository: there is no main on GitHub to pull yet.
let remoteMain = false;
try { remoteMain = !!out("git ls-remote --heads origin main"); } catch { remoteMain = false; }
if (remoteMain) run("git pull --rebase --autostash origin main");

// Files retired by an earlier change (e.g. the old startup schema runner) are removed here, so they never ship again.
if (existsSync("scripts/obsolete.txt")) {
  for (const f of readFileSync("scripts/obsolete.txt", "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))) {
    // A retired folder (e.g. backend/) loses its tracked and its new, never-committed files; git-ignored ones there
    // (backend/.env with the DB password, build output) stay on this computer and stay out of git.
    // A retired single file that was never committed is simply deleted.
    if (!existsSync(f)) continue;
    const tracked = out(`git ls-files -- "${f}"`);
    const fresh = out(`git ls-files --others --exclude-standard -- "${f}"`);
    if (!tracked && !fresh) continue; // only git-ignored leftovers (e.g. backend/.env) - leave them alone
    const dir = statSync(f).isDirectory();
    if (tracked) run(`git rm -r -q -f -- "${f}"`);
    if (dir) run(`git clean -f -d -q -- "${f}"`);
    else if (existsSync(f)) rmSync(f);
    console.log("Removed retired " + f);
  }
}

run("git add -A");
// Backstop: never commit a secret file, even if .gitignore is damaged (backend/.env holds the DB password).
const secret = out("git diff --cached --name-only").split(/\r?\n/).filter((f) =>
  /(^|\/)\.env(\..+)?$/.test(f) && !/\.env\.example$/.test(f) || /(^|\/)(secrets\.json|MY-SETUP-DETAILS\.json)$/.test(f));
if (secret.length) {
  run(`git reset -q -- ${secret.map((f) => `"${f}"`).join(" ")}`);
  console.error("Refused to commit secret files: " + secret.join(", ") + "\nThey were left out. Check .gitignore, then run SHIP.bat again.");
  process.exit(1);
}
if (out("git diff --cached --name-only")) run(`git commit -q -m "${msg.replace(/"/g, "'")}" -m "Shipped-With: ship"`);
else console.log("Nothing new to commit - re-shipping current main.");
run("git push origin HEAD:main");

const sha = out("git rev-parse HEAD");
console.log("\nWaiting for the pipeline to pick up " + sha.slice(0, 7) + " ...");
let id = "";
for (let i = 0; i < 30 && !id; i++) {
  id = out(`gh run list --workflow ship.yml --commit ${sha} --json databaseId --jq ".[0].databaseId"`);
  if (!id) sleep(4000);
}
if (!id) { console.error("Pipeline did not start. Open GitHub > Actions."); process.exit(1); }
const r = spawnSync("gh", ["run", "watch", id, "--exit-status", "--interval", "10"], { stdio: "inherit", shell: true });
if (r.status === 0) {
  console.log("\n✅ LIVE. Database, API, frontend and docs are all on " + sha.slice(0, 7));
} else {
  console.error("\n❌ Failed. Nothing after the failed step was changed in production.");
  showFailure(id);
  process.exit(1);
}

/** Prints the end of the failed step's log (where the reason is), without the timestamps, instead of the whole log. */
export function showFailure(runId) {
  const r = spawnSync("gh", ["run", "view", String(runId), "--log-failed"], { encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 });
  const lines = (r.stdout || "").split(/\r?\n/)
    .map((l) => l.replace(/^[^\t]*\t[^\t]*\t\S+Z /, "").replace(/\x1b\[[0-9;]*m/g, ""))
    .filter((l) => l.trim() && !/^##\[(group|endgroup)\]/.test(l));
  console.error("---- last lines of the failed step (the reason is usually at the bottom) ----");
  console.error(lines.slice(-40).join("\n"));
  console.error(`---- full log: gh run view ${runId} --log-failed ----`);
}
