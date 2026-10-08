// Sets the GitHub secrets CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN - only after Cloudflare confirms they work.
// Used by START-HERE (setup.mjs) and on its own by CLOUDFLARE-TOKEN.bat (to replace a bad token, then re-run the
// failed deploy). Accepts a messy paste (spaces, line breaks, "Bearer ...", the whole sample curl command) and keeps
// only the token. Nothing secret is printed.
import { execSync, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
// Pause without a shell command (Windows "timeout" refuses to run from a script: "Input redirection is not supported").
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Pulls the token out of whatever was pasted. Returns "" if nothing token-like is there. */
export function cleanToken(pasted) {
  const s = String(pasted || "").replace(/[​-‍﻿]/g, "");
  const bearer = s.match(/Bearer\s+([A-Za-z0-9_\-.]{30,})/i);
  if (bearer) return bearer[1];
  const words = s.split(/[\s"'`<>]+/).filter((w) => /^[A-Za-z0-9_\-.]{30,}$/.test(w) && !/^https?:/i.test(w));
  return words.length ? words[words.length - 1] : "";
}

/** Account id is 32 hex characters (dash.cloudflare.com, right side of Workers & Pages, or the URL). */
export function cleanAccountId(pasted) {
  const m = String(pasted || "").toLowerCase().match(/[0-9a-f]{32}/);
  return m ? m[0] : "";
}

/** Asks Cloudflare whether the token is valid and can use the account. Returns "" when fine, else the problem. */
export async function checkWithCloudflare(token, accountId, fetchImpl = fetch) {
  const call = async (path) => {
    try {
      const r = await fetchImpl("https://api.cloudflare.com/client/v4" + path, { headers: { Authorization: `Bearer ${token}` } });
      let body = {};
      try { body = await r.json(); } catch {}
      return { ok: r.ok && body.success !== false, status: r.status, errors: (body.errors || []).map((e) => `${e.message} [${e.code}]`).join("; ") };
    } catch (e) {
      return { ok: false, status: 0, errors: "no connection to Cloudflare (" + e.message + ")" };
    }
  };
  // User tokens verify at /user/tokens/verify, account-owned tokens at /accounts/<id>/tokens/verify.
  let v = await call("/user/tokens/verify");
  if (!v.ok) v = await call(`/accounts/${accountId}/tokens/verify`);
  if (!v.ok) return `Cloudflare does not accept this token (${v.errors || "HTTP " + v.status}). Create a new one: template "Edit Cloudflare Workers".`;
  const a = await call(`/accounts/${accountId}`);
  if (!a.ok) return `The token works, but not for account ${accountId} (${a.errors || "HTTP " + a.status}). Check the Account ID, or give the token access to that account.`;
  const w = await call(`/accounts/${accountId}/workers/scripts`);
  if (!w.ok) return `The token can't manage Workers in this account (${w.errors || "HTTP " + w.status}). Use the template "Edit Cloudflare Workers".`;
  // The Worker reaches Supabase through Hyperdrive, which the pipeline creates / updates with this token.
  const h = await call(`/accounts/${accountId}/hyperdrive/configs`);
  if (!h.ok) return `The token can't manage Hyperdrive (${h.errors || "HTTP " + h.status}). In Cloudflare > My Profile > API Tokens > Edit this token > Add more > "Account > Hyperdrive > Edit" > Continue to summary > Update token. The token text stays the same - paste it again here.`;
  return "";
}

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else if (!/[\r\n]/.test(s)) rl.output.write("*"); };
    }
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write("\n"); resolve(a); });
  });
}

/** Interactive: asks until Cloudflare confirms, then stores both GitHub secrets. */
export async function setCloudflareSecrets() {
  console.log(`
  ------------------------------------------------------------------
  Cloudflare deploy key - 2 things to paste:
   A. Account ID: dash.cloudflare.com > Workers & Pages > right side
      "Account ID" (32 letters/digits).
   B. API token: https://dash.cloudflare.com/profile/api-tokens
      > Create Token > template "Edit Cloudflare Workers"
      > Add more > Account > Hyperdrive > Edit
      > Continue to summary > Create Token.
      Copy the token with the Copy button (you can paste the whole
      box - extra text is removed). It is hidden while you paste.
  ------------------------------------------------------------------`);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const accountId = cleanAccountId(await ask("Paste the Account ID: "));
    if (!accountId) { console.log("That is not an Account ID (32 letters/digits). Try again."); continue; }
    const token = cleanToken(await ask("Paste the API token (hidden): ", true));
    if (!token) { console.log("No token found in what was pasted. Try again."); continue; }
    process.stdout.write("Checking with Cloudflare ... ");
    const problem = await checkWithCloudflare(token, accountId);
    if (problem) { console.log("NOT OK\n  " + problem); continue; }
    console.log("OK");
    execSync("gh secret set CLOUDFLARE_ACCOUNT_ID", { input: accountId, stdio: ["pipe", "ignore", "inherit"] });
    execSync("gh secret set CLOUDFLARE_API_TOKEN", { input: token, stdio: ["pipe", "ignore", "inherit"] });
    console.log("Saved CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in GitHub (checked by Cloudflare).");
    return true;
  }
  console.error("Cloudflare key not saved after 3 tries. Nothing was changed.");
  return false;
}

// Run on its own (CLOUDFLARE-TOKEN.bat): replace the secrets, then re-run the last failed deploy.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const { ensureGhLogin } = await import("./gh-login.mjs");
  ensureGhLogin();
  if (!(await setCloudflareSecrets())) process.exit(1);
  const last = spawnSync('gh run list --workflow ship.yml --limit 1 --json databaseId,conclusion --jq ".[0].databaseId,.[0].conclusion"',
    { shell: true, encoding: "utf8" }).stdout.trim().split(/\r?\n/);
  if (last[0] && last[1] === "failure") {
    console.log(`\nRe-running the failed deploy (run ${last[0]}) - migrations already applied are skipped automatically ...`);
    spawnSync(`gh run rerun ${last[0]}`, { shell: true, stdio: "inherit" });
    sleep(8000);
    const r = spawnSync(`gh run watch ${last[0]} --exit-status --interval 10`, { shell: true, stdio: "inherit" });
    if (r.status === 0) console.log("\n✅ LIVE.");
    else { console.error("\n❌ Still failing. Failed step log:"); spawnSync(`gh run view ${last[0]} --log-failed`, { shell: true, stdio: "inherit" }); process.exit(1); }
  } else {
    console.log("\nDone. Double-click SHIP.bat to deploy.");
  }
}
