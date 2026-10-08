// Step 1. Fails when a commit in this push touches Claude-owned files without the ship trailer
// (i.e. AI Studio or a manual commit changed the API (Worker), database, pipeline or login/API client files).
import { execSync } from "node:child_process";

const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const [before, after] = process.argv.slice(2);
const zero = /^0+$/;
const range = !before || zero.test(before) ? after : `${before}..${after}`;

const reserved = [
  /^(backend|supabase|\.github|scripts|docs|cloudflare)\//,
  /^(PROJECT\.md|CLAUDE\.md|SHIP\.bat|START-HERE\.bat|PUBLISH-CHANGES\.bat|RUN-LOCAL-TEST\.bat|CLOUDFLARE-TOKEN\.bat|server\.ts)$/,
  /^src\/(api\.ts|main\.jsx|lib\/|demo\/)/,
];
const generated = /^docs\/(openapi\.json|schema\.md)$/;

const bad = [];
for (const sha of sh(`git rev-list ${range}`).split("\n").filter(Boolean)) {
  const body = sh(`git log -1 --format=%B ${sha}`);
  if (/^Shipped-With: ship$/m.test(body)) continue;
  const files = sh(`git diff-tree --no-commit-id --name-only -r ${sha}`).split("\n").filter(Boolean);
  const hit = files.filter((f) => reserved.some((r) => r.test(f)) && !generated.test(f));
  if (hit.length) bad.push(`${sha.slice(0, 7)} "${body.split("\n")[0]}" touched: ${hit.join(", ")}`);
}
if (bad.length) {
  console.error("Blocked: these commits changed Claude-owned files without going through SHIP.bat:\n" + bad.join("\n") +
    "\nIf this was AI Studio: restore those paths from the last deploy tag and ship again (see PROJECT.md). Nothing was deployed.");
  process.exit(1);
}
console.log("Guard OK");
