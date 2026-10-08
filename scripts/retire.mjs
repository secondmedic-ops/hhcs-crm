// Removes the paths listed in scripts/obsolete.txt from this folder (files left from an older layout, for example after
// unpacking a new version over an old one). Git then records them as deleted with the next commit (START-HERE.bat's
// first commit or SHIP.bat). Run by RUN-LOCAL-TEST.bat and START-HERE.bat; safe to run any time.
import { existsSync, readFileSync, rmSync } from "node:fs";

const list = existsSync("scripts/obsolete.txt")
  ? readFileSync("scripts/obsolete.txt", "utf8").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
  : [];
for (const p of list) {
  if (p.includes("..") || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.startsWith(".git")) continue;
  if (!existsSync(p)) continue;
  rmSync(p, { recursive: true, force: true });
  console.log("Removed retired " + p);
}
