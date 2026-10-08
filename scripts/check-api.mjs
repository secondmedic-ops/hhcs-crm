// Step 3d. Every backend call in the frontend goes through src/api.ts. This checks each path + method used there
// exists in the backend's contract (docs/openapi.json, exported in step 3c). A frontend call to an endpoint the
// backend doesn't have fails here, before anything is deployed.
import { readFileSync, readdirSync } from "node:fs";

const spec = JSON.parse(readFileSync("docs/openapi.json", "utf8"));
const norm = (p) => p.replace(/\?.*$/, "").replace(/\$\{[^}]+\}/g, "{}").replace(/\{[^}]+\}/g, "{}");
const known = new Set();
for (const [path, ops] of Object.entries(spec.paths || {})) {
  for (const method of Object.keys(ops)) known.add(`${method.toUpperCase()} ${norm(path)}`);
}

const src = readFileSync("src/api.ts", "utf8");
const calls = [];
const re = /request<[\s\S]*?>\(\s*([`'"])(\/api\/[^`'"]*)\1/g;
let m;
while ((m = re.exec(src))) {
  const rest = src.slice(re.lastIndex);
  const next = rest.search(/request</);
  const segment = next >= 0 ? rest.slice(0, next) : rest;
  const method = (segment.match(/method:\s*['"](\w+)['"]/) || [, "GET"])[1].toUpperCase();
  calls.push(`${method} ${norm(m[2])}`);
}

// Direct fetch() to the API anywhere else would skip the login token.
const stray = [];
const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]);
for (const f of walk("src").filter((f) => /\.(ts|tsx)$/.test(f) && !/src\/(api\.ts|generated\/)/.test(f))) {
  if (/\bfetch\(\s*[`'"]\/api/.test(readFileSync(f, "utf8"))) stray.push(f);
}

const missing = calls.filter((c) => !known.has(c));
if (missing.length || stray.length) {
  if (missing.length) console.error("src/api.ts calls endpoints the backend does not have:\n  " + missing.join("\n  "));
  if (stray.length) console.error("These files call the API with fetch() directly (no login token) - use src/api.ts:\n  " + stray.join("\n  "));
  process.exit(1);
}
console.log(`API contract OK: ${calls.length} frontend calls all exist in the backend`);
