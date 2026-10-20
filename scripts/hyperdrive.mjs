// Step 5 (before wrangler deploy). The Worker reaches Supabase through Cloudflare Hyperdrive (free plan: 100,000
// queries a day). Hyperdrive is needed because Supabase's certificates are signed by Supabase's own CA, which a
// Worker's direct connection refuses; Hyperdrive also pools connections close to the database.
//  - creates the Hyperdrive config "hhcs-caredesk-db" from the GitHub secret SUPABASE_DB_URL, or updates it (a changed
//    database password is picked up on the next ship);
//  - caching OFF: case stages, SLA timers and payments must never be a minute old;
//  - origin connection limit 10: Supabase's session pooler takes only 15 clients. Cloudflare's default of 20 filled it
//    on 20 Oct 2026 ("max clients reached": site "Database is unavailable" and migrations failed). 10 leaves room for
//    the pipeline's migrations and Hyperdrive's soft-limit extras;
//  - writes cloudflare/wrangler.deploy.jsonc = wrangler.jsonc with the real Hyperdrive id (not committed);
//  - removes Worker secrets left from the old Spring setups (DB_* with the DB password, and SUPABASE_URL, which is now
//    a plain setting - a secret with the same name would make the deploy fail).
// Nothing secret is printed.
import { readFileSync, writeFileSync } from "node:fs";

const NAME = "hhcs-caredesk-db";
const { CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: account, SUPABASE_DB_URL: dbUrl } = process.env;
const die = (m) => { console.error("Hyperdrive: " + m); process.exit(1); };
if (!token || !account) die("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are not set - run CLOUDFLARE-TOKEN.bat.");
if (!dbUrl) die("GitHub secret SUPABASE_DB_URL is not set - run START-HERE.bat.");

/** postgresql://user:password@host:port/db -> Hyperdrive origin. The transaction pooler (6543) becomes session mode (5432). */
function originFrom(url) {
  let u;
  try { u = new URL(url.trim()); } catch { die("SUPABASE_DB_URL is not a postgres connection string."); }
  if (!/^postgres(ql)?:$/.test(u.protocol)) die("SUPABASE_DB_URL must start with postgresql://");
  let port = Number(u.port || 5432);
  if (port === 6543 && /pooler\.supabase\.com$/.test(u.hostname)) {
    console.log("Hyperdrive: using the Supabase session pooler (5432) instead of the transaction pooler (6543) - Hyperdrive pools itself.");
    port = 5432;
  }
  return {
    scheme: "postgres", host: u.hostname, port, database: decodeURIComponent(u.pathname.replace(/^\//, "") || "postgres"),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
  };
}

async function cf(method, path, body) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/hyperdrive${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok || j.success === false) {
    const errs = (j.errors || []).map((e) => `${e.message} [${e.code}]`).join("; ") || `HTTP ${r.status}`;
    if (r.status === 403 || /auth|permission/i.test(errs)) {
      die(`the Cloudflare token may not manage Hyperdrive (${errs}).\n` +
        "  Fix: Cloudflare > My Profile > API Tokens > Edit your CareDesk token > Add more > Account > Hyperdrive > Edit\n" +
        "  > Continue to summary > Update token (the token text stays the same). Then run CLOUDFLARE-TOKEN.bat and paste it again.");
    }
    die(`${method} ${path || "/configs"} failed: ${errs}`);
  }
  return j.result;
}

const origin = originFrom(dbUrl);
const body = { name: NAME, origin, caching: { disabled: true }, origin_connection_limit: 10 };
const list = (await cf("GET", "/configs")) || [];
const existing = list.find((c) => c.name === NAME);
const result = existing ? await cf("PUT", `/configs/${existing.id}`, body) : await cf("POST", "/configs", body);
const id = result?.id || existing?.id;
if (!/^[0-9a-f]{32}$/.test(id || "")) die("Cloudflare returned no Hyperdrive id.");
console.log(`Hyperdrive ${existing ? "updated" : "created"}: ${NAME} (${id}) -> ${origin.host}:${origin.port}/${origin.database}, caching off`);

const config = readFileSync("cloudflare/wrangler.jsonc", "utf8");
const deploy = config.replace(/("binding":\s*"HYPERDRIVE",\s*"id":\s*")[0-9a-f]{32}(")/, `$1${id}$2`);
if (deploy === config && !config.includes(id)) die('cloudflare/wrangler.jsonc has no hyperdrive binding "HYPERDRIVE" to fill in.');
writeFileSync("cloudflare/wrangler.deploy.jsonc", deploy);

// Old Worker secrets (Spring in a Container / Render forwarding era). Missing Worker or secret = nothing to do.
const OLD_SECRETS = ["DB_URL", "DB_USERNAME", "DB_PASSWORD", "DB_HOST", "DB_USER", "DB_PORT", "SUPABASE_URL", "BACKEND_URL"];
const script = (JSON.parse(readFileSync("cloudflare/wrangler.jsonc", "utf8").replace(/^\s*\/\/.*$/gm, "")).name) || "hhcs-caredesk";
const api = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${script}/secrets`;
const listed = await fetch(api, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()).catch(() => ({}));
for (const { name } of (listed && listed.success && listed.result) || []) {
  if (!OLD_SECRETS.includes(name)) continue;
  const r = await fetch(`${api}/${name}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
  console.log(r.ok ? `Removed old Worker secret ${name}` : `Could not remove old Worker secret ${name} (HTTP ${r.status}) - delete it in Cloudflare > hhcs-caredesk > Settings > Variables and Secrets.`);
}
