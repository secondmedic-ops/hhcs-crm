// One-time setup for the one-push pipeline (double-click START-HERE.bat). Safe to run again: finished steps are skipped.
// Creates the GitHub repository if this folder has none, sets the GitHub secrets/variables the pipeline needs
// (Supabase connection, Cloudflare key, MyOperator keys, optional Gemini / MIS e-mail), then prints the few
// browser-only steps. Secrets are typed hidden and never printed.
// Everything runs on free plans: one Cloudflare Worker (frontend + API, database through Hyperdrive) + Supabase.
import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, copyFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { createInterface as createInterfaceCb } from "node:readline";
import { ensureGhLogin } from "./gh-login.mjs";
import { ensureOwnerAccount, ensureRepo, REPO } from "./gh-owner.mjs";
import { setCloudflareSecrets } from "./cloudflare-token.mjs";

const out = (c) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const ok = (c) => { try { out(c); return true; } catch { return false; } };
const quiet = (c) => { try { return out(c); } catch { return ""; } };
/** Names of the repo's GitHub secrets / variables from the plain list (first column), so any gh version works (8 Oct 2026). */
const names = (kind) => { try { return out(`gh ${kind} list`).split(/\r?\n/).map((l) => l.split(/\s+/)[0]).filter(Boolean); } catch { return []; } };
const interactive = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: "inherit", shell: true, ...opts }).status === 0;
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q, def = "") => ((await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim() || def);
const step = (n, t) => console.log(`\n=== ${n}. ${t}`);
const setSecret = (name, value) => execSync(`gh secret set ${name}`, { input: value, stdio: ["pipe", "ignore", "inherit"] });
/** Typed input that shows * instead of the characters. */
function askHidden(q) {
  return new Promise((resolve) => {
    const r = createInterfaceCb({ input: process.stdin, output: process.stdout, terminal: true });
    r._writeToOutput = (t) => { if (t.includes(q)) r.output.write(t); else if (!/[\r\n]/.test(t)) r.output.write("*"); };
    r.question(q, (a) => { r.close(); process.stdout.write("\n"); resolve(a.trim()); });
  });
}

// 1. Tools
step(1, "Tools");
if (!ok("git --version")) { console.error("Install Git for Windows, then run START-HERE.bat again."); process.exit(1); }
if (!ok("gh --version")) {
  console.log("Installing GitHub CLI ...");
  interactive("winget", ["install", "--id", "GitHub.cli", "-e", "--accept-source-agreements", "--accept-package-agreements"]);
  console.log("\nGitHub CLI installed. CLOSE this window and double-click START-HERE.bat again (Windows needs a new window to find it).");
  process.exit(0);
}
ensureGhLogin();
// The pipeline file travels as scripts/ship.workflow.yml (files under .github/ cannot always be copied in directly).
if (!existsSync(".github/workflows/ship.yml") && existsSync("scripts/ship.workflow.yml")) {
  mkdirSync(".github/workflows", { recursive: true });
  copyFileSync("scripts/ship.workflow.yml", ".github/workflows/ship.yml");
  console.log("Installed .github/workflows/ship.yml");
}
// CareDesk is published only to github.com/secondmedic-ops/hhcs-crm, as the GitHub account secondmedic-ops.
ensureOwnerAccount();
if (!quiet("git remote get-url origin")) {
  // First run in this folder: start a clean history authored by secondmedic-ops (nothing was ever pushed from here).
  execSync("node scripts/retire.mjs", { stdio: "inherit" });
  if (existsSync(".git")) rmSync(".git", { recursive: true, force: true });
  execSync("git init -q -b main");
  ensureOwnerAccount(); // sets this repository's author to secondmedic-ops
  execSync("git add -A", { stdio: "inherit" });
  // [skip ci]: the pipeline needs the secrets below first; SHIP.bat starts the first real run.
  execSync('git commit -q -m "CareDesk CRM: first import [skip ci]" -m "Shipped-With: ship"', { stdio: "inherit" });
}
ensureRepo();
// First push only (GitHub has no main yet); later changes go out with SHIP.bat.
if (!quiet("git ls-remote --heads origin main")) {
  if (!interactive("git", ["push", "-u", "origin", "HEAD:main"])) {
    console.error(`Push to ${REPO} failed. If the repository already has files (README etc.), delete and recreate it EMPTY, then run this again.`);
    process.exit(1);
  }
}
const repo = REPO;
console.log("Repository: " + repo);

// 2. Supabase connection (GitHub secret SUPABASE_DB_URL: used for migrations and for the Worker's Hyperdrive)
step(2, "Supabase connection");
const secrets = names("secret");
const vars0 = names("variable");
const env = {};
if (existsSync("backend/.env")) { // written by the old Spring setup; still a handy source if it is there
  for (const line of readFileSync("backend/.env", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.\-]+)\s*=\s*(.*)\s*$/);
    if (m) env[m[1].toUpperCase().replace(/[.\-]/g, "_")] = m[2].replace(/^["']|["']$/g, "");
  }
}
let dbUrl = "";
let ref = "";
let hostPort = "";
let dbUser = "";
if (secrets.includes("SUPABASE_DB_URL") && vars0.includes("VITE_SUPABASE_URL")) {
  const url = out("gh variable get VITE_SUPABASE_URL");
  ref = (url.match(/^https:\/\/(\w+)\.supabase\.co/) || [])[1] || "";
  console.log(`Already set (secret SUPABASE_DB_URL, variable VITE_SUPABASE_URL = ${url}).`);
} else {
  const jdbc = env.DB_URL || env.SPRING_DATASOURCE_URL || "";
  dbUser = env.DB_USERNAME || env.SPRING_DATASOURCE_USERNAME || "";
  const dbPass = env.DB_PASSWORD || env.SPRING_DATASOURCE_PASSWORD || "";
  hostPort = (jdbc.match(/^jdbc:postgresql:\/\/([^/?]+)/) || [])[1] || "";
  if (hostPort && dbUser && dbPass) {
    dbUrl = `postgresql://${dbUser}:${encodeURIComponent(dbPass)}@${hostPort.includes(":") ? hostPort : hostPort + ":5432"}/postgres?sslmode=require`;
    console.log("Using the Supabase connection from backend/.env.");
  } else {
    console.log(`Supabase > your project > Connect (top) > "Session pooler" > copy the connection string
  (postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-...pooler.supabase.com:5432/postgres).`);
    for (;;) {
      const uri = (await ask("Paste the Session pooler connection string")).replace(/^["']|["']$/g, "");
      const m = uri.match(/^postgres(?:ql)?:\/\/([^:@\/]+)(?::[^@]*)?@([^\/?]+)\/?(\w*)/);
      if (!m || !/^postgres\.\w+$/.test(m[1])) { console.log("That is not a Supabase Session pooler string (user must be postgres.<ref>). Try again."); continue; }
      rl.pause();
      const pass = await askHidden("Database password (Supabase > Project Settings > Database; hidden): ");
      rl.resume();
      dbUser = m[1];
      hostPort = m[2];
      dbUrl = `postgresql://${dbUser}:${encodeURIComponent(pass)}@${hostPort.includes(":") ? hostPort : hostPort + ":5432"}/${m[3] || "postgres"}?sslmode=require`;
      break;
    }
  }
  ref = (dbUser.match(/^postgres\.(\w+)$/) || [])[1] || "";
}
const supabaseUrl = ref ? `https://${ref}.supabase.co` : "";
if (supabaseUrl) console.log(`Supabase project: ${ref}  (${supabaseUrl})`);

// 3. GitHub: workflow permissions, secrets, variables
step(3, "GitHub settings");
ok(`gh api -X PUT repos/${repo}/actions/permissions/workflow -f default_workflow_permissions=write -F can_approve_pull_request_reviews=false`);
if (dbUrl) {
  setSecret("SUPABASE_DB_URL", dbUrl);
  console.log("Set secret SUPABASE_DB_URL");
}
if (!secrets.includes("CLOUDFLARE_ACCOUNT_ID") || !secrets.includes("CLOUDFLARE_API_TOKEN")) {
  // Cleans the paste and checks it with Cloudflare before saving (a bad token only failed later, in deploy step 5).
  rl.pause();
  if (!(await setCloudflareSecrets())) process.exit(1);
  rl.resume();
}
const vars = names("variable");
if (!vars.includes("APP_URL")) {
  console.log("The live URL will be https://hhcs-caredesk.<your-subdomain>.workers.dev (Cloudflare > Workers & Pages shows <your-subdomain> on the right),\n" +
    "or your own domain later (for example https://hhcs.secondmedic.com).");
  const appUrl = (await ask("Live URL of CareDesk")).replace(/\/+$/, "");
  execSync(`gh variable set APP_URL --body "${appUrl}"`, { stdio: "inherit" });
}
if (!vars.includes("VITE_SUPABASE_URL") && supabaseUrl) execSync(`gh variable set VITE_SUPABASE_URL --body "${supabaseUrl}"`, { stdio: "inherit" });
if (!vars.includes("VITE_SUPABASE_ANON_KEY")) {
  console.log("Supabase > Project Settings > API Keys > copy the anon / publishable key (it is meant for browsers, not secret).");
  const key = await ask("Paste the anon / publishable key");
  execSync(`gh variable set VITE_SUPABASE_ANON_KEY --body "${key}"`, { stdio: "inherit" });
}

// 4a. MyOperator (GitHub secrets -> Worker secrets). Enter skips one; run START-HERE.bat again later to add it.
step(4, "MyOperator keys (Enter = skip, add later by running this again)");
const MYOP = [
  ["MYOPERATOR_WEBHOOK_KEY", "Webhook key: any long random text; enter the SAME text in MyOperator > Webhooks (v2) as the x-webhook-key header"],
  ["MYOPERATOR_COMPANY_ID", "Company ID (MyOperator > Developer > API)"],
  ["MYOPERATOR_SECRET_TOKEN", "Secret token (click-to-call)"],
  ["MYOPERATOR_OBD_API_KEY", "OBD (click-to-call) API key"],
  ["MYOPERATOR_PUBLIC_IVR_ID", "Public IVR ID (click-to-call)"],
  ["MYOPERATOR_API_TOKEN", "API token (call logs and recording links)"],
  ["MYOPERATOR_WABA_API_KEY", "WhatsApp API key (optional)"],
  ["MYOPERATOR_WABA_PHONE_ID", "WhatsApp phone number ID (optional)"],
];
for (const [name, help] of MYOP) {
  if (secrets.includes(name)) { console.log(`${name} already set.`); continue; }
  rl.pause();
  const v = await askHidden(`${help}\n  ${name} (hidden, Enter = skip): `);
  rl.resume();
  if (v) { setSecret(name, v); console.log(`Set secret ${name}`); }
}

// 4b. Supabase service key: Settings > Users > "Add user" creates logins with it (optional).
if (!secrets.includes("SUPABASE_SERVICE_ROLE_KEY")) {
  console.log("Supabase > Project Settings > API Keys > service_role / secret key. Lets admins add users inside CareDesk (Enter = skip;\n" +
    "you can always add users in Supabase > Authentication instead). It goes only to the Worker, never to the browser.");
  rl.pause();
  const v = await askHidden("Supabase service_role key (hidden, Enter = skip): ");
  rl.resume();
  if (v) { setSecret("SUPABASE_SERVICE_ROLE_KEY", v); console.log("Set secret SUPABASE_SERVICE_ROLE_KEY"); }
}

// 4c. Optional: Gemini key (GitHub secret GEMINI_API_KEY -> Worker secret)
step("4c", "AI key (optional)");
if (!secrets.includes("GEMINI_API_KEY")) {
  let key = env.GEMINI_API_KEY || "";
  if (!key) {
    console.log("AI call transcripts, summaries, QA scores and the command bar use it. Get one at https://aistudio.google.com/apikey - or press Enter to skip.");
    rl.pause();
    key = await askHidden("Gemini API key (hidden, Enter = skip): ");
    rl.resume();
  }
  if (key) { setSecret("GEMINI_API_KEY", key); console.log("Set secret GEMINI_API_KEY"); }
  else console.log("Skipped. Run START-HERE.bat again later to add it.");
} else {
  console.log("GEMINI_API_KEY already set.");
}
// 4d. Optional: outbound e-mail (MIS, e-mail templates) through Gmail SMTP as customer.support@secondmedic.com
if (!secrets.includes("SMTP_PASSWORD")) {
  console.log("Outbound e-mail needs a Gmail app password for customer.support@secondmedic.com (Google Account > Security > App passwords). Enter = skip.");
  rl.pause();
  const k = await askHidden("Gmail app password (hidden, Enter = skip): ");
  rl.resume();
  if (k) setSecret("SMTP_PASSWORD", k.replace(/\s+/g, ""));
}
if (!secrets.includes("MIS_RECIPIENTS")) {
  const to = await ask("MIS recipients (comma separated e-mails, Enter = skip)");
  if (to) setSecret("MIS_RECIPIENTS", to);
}
console.log("The database connection for the live API (Cloudflare Hyperdrive \"hhcs-caredesk-db\") is made by the pipeline from SUPABASE_DB_URL.");

// 5. PROJECT.md values
step(5, "PROJECT.md");
if (existsSync("PROJECT.md")) {
  let p = readFileSync("PROJECT.md", "utf8");
  const appUrl = ok("gh variable get APP_URL") ? out("gh variable get APP_URL") : "";
  p = p.replace(/^- Live URL: .*$/m, `- Live URL: ${appUrl}`);
  if (ref) p = p.replace(/^- Supabase project ref: .*$/m, `- Supabase project ref: ${ref}   region: ap-south-1   URL: ${supabaseUrl}`);
  if (hostPort) p = p.replace(/^- DB pooler host: .*$/m, `- DB pooler host: ${hostPort.split(":")[0]}   user: ${dbUser}`);
  writeFileSync("PROJECT.md", p);
  console.log("PROJECT.md updated.");
}
let gitEmail = "";
try { gitEmail = out("git config user.email"); } catch {}
const loginEmail = await ask("The email you will log in to CareDesk with (becomes the first platform admin)", gitEmail);
const loginName = await ask("Your name as shown in CareDesk", "Ravi Namdeo");
rl.close();

const q = (v) => v.replace(/'/g, "''");
console.log(`
============================================================
 Almost done. Do these in the browser (once), then double-click SHIP.bat:

 1. Supabase > Project Settings > JWT Keys: the current signing key must be ECC (P-256).
    If it still shows "Legacy JWT secret", click "Migrate JWT secret", then "Rotate keys".
 2. Supabase > Authentication > Sign In / Providers: turn OFF "Allow new users to sign up".
    Supabase > Authentication > Multi-Factor: enable TOTP (CareDesk asks for the code at login).
 3. Supabase > Authentication > URL Configuration:
      Site URL: your live URL      Redirect URLs: <live URL>/**  and  http://localhost:3000/**
 4. Supabase > Authentication > Users > Add user > your email + a password, tick "Auto Confirm User".
 5. Supabase > Project Settings > Integrations > GitHub: leave it disconnected (the pipeline applies migrations).

 Then SHIP.bat. When it prints LIVE, open Supabase > SQL Editor and run (makes you the platform admin):
   insert into public.profiles (id, workspace_id, full_name, email, role)
   select u.id, w.id, '${q(loginName)}', u.email, 'admin' from auth.users u, public.workspaces w
   where u.email = '${q(loginEmail)}' and w.code = 'HHC'
   on conflict (id) do update set role = 'admin', active = true;
 Log in on the live URL. Add everyone else in Settings > Users (agents with their MyOperator user ID),
 and set the MyOperator lines (Khar, Mahim numbers) in Settings > Workspace.
============================================================`);
