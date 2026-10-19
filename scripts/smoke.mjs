// Step 6. Waits until the live Worker serves the new build, then checks the site, the API + database (through
// Hyperdrive), and that the live API refuses calls without login.
const [url, sha] = process.argv.slice(2);
if (!url) { console.error("APP_URL is not set (GitHub > Settings > Variables). Run START-HERE.bat."); process.exit(1); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A Worker deploy is live everywhere within seconds; allow 3 minutes.
let live = "";
for (let i = 0; i < 36 && live !== sha; i++) {
  try { live = (await (await fetch(`${url}/api/version`)).text()).trim(); } catch {}
  if (live !== sha) await wait(5000);
}
if (live !== sha) {
  console.error(`Live site still reports "${live || "nothing"}", expected ${sha}. Is APP_URL the hhcs-caredesk Worker's address? ` +
    "Cloudflare > Workers & Pages > hhcs-caredesk > Deployments.");
  process.exit(1);
}

const home = await fetch(url + "/");
if (!home.ok) { console.error("Frontend returned " + home.status); process.exit(1); }

let db = "";
for (let i = 0; i < 6 && db !== "UP"; i++) {
  try { db = (await (await fetch(url + "/api/v1/health")).json()).database; } catch {}
  if (db !== "UP") await wait(5000);
}
if (db !== "UP") {
  console.error("The live API cannot reach the database (health: " + (db || "no answer") + "). Check Cloudflare > Storage & Databases > " +
    "Hyperdrive > hhcs-caredesk-db (it is made from the GitHub secret SUPABASE_DB_URL), and Cloudflare > hhcs-caredesk > Logs.");
  process.exit(1);
}

for (const path of ["/api/v1/bmm/leads", "/api/v1/me", "/api/v1/admin/webhooks", "/api/v1/admin/integrations"]) {
  const r = await fetch(url + path);
  if (r.status !== 401) {
    console.error(`SECURITY: live GET ${path} without login returned ${r.status}, expected 401. Roll back now (PROJECT.md > Rollback).`);
    process.exit(1);
  }
}
const bmmStatus = await fetch(url + "/api/v1/bmm/leads/00000000-0000-4000-8000-000000000000/status", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
});
if (bmmStatus.status !== 401) {
  console.error("SECURITY: live BMM status endpoint without login returned " + bmmStatus.status + ", expected 401.");
  process.exit(1);
}

console.log(`Smoke OK: ${url} serves ${sha}; database up; API closed without login`);
