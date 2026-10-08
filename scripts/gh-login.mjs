// GitHub CLI login used by START-HERE (setup.mjs) and SHIP (ship.mjs). Logs in if needed, makes sure the login can
// push .github/workflows/ files (GitHub refuses that without the "workflow" scope), and lets git push with it.
// Verifies at the end - never assumes the browser step worked.
import { spawnSync } from "node:child_process";

const status = () => {
  const r = spawnSync("gh auth status --hostname github.com", { shell: true, encoding: "utf8" });
  return { ok: r.status === 0, text: `${r.stdout || ""}\n${r.stderr || ""}` };
};
const interactive = (cmd) => spawnSync(cmd, { shell: true, stdio: "inherit" }).status === 0;

const HOW = `
  ------------------------------------------------------------------
  GitHub login - 3 steps:
   1. This window shows a one-time code (it is also copied for you).
   2. Press ENTER here, in THIS black window. The browser opens.
   3. Paste the code in the browser, click Continue, then Authorize.
  Come back here and wait for "Logged in". Don't click inside this
  window while it waits (Windows pauses it - press Esc if it looks stuck).
  ------------------------------------------------------------------`;

export function ensureGhLogin() {
  let s = status();
  if (!s.ok) {
    console.log(HOW);
    interactive("gh auth login --hostname github.com --git-protocol https --web --scopes workflow");
    s = status();
    if (!s.ok) {
      console.error("\nGitHub login did not finish (the code must be entered AND Enter pressed in this window).\n" +
        "Run this again and follow the 3 steps above. Nothing was changed.");
      process.exit(1);
    }
  }
  // Older logins lack the workflow scope: pushing .github/workflows/ship.yml would be refused.
  const scopes = (s.text.match(/Token scopes:\s*(.*)/i) || [])[1] || "";
  if (!/workflow/.test(scopes)) {
    console.log("\nGitHub needs one more permission (\"workflow\") so the pipeline file can be pushed." + HOW);
    interactive("gh auth refresh --hostname github.com --scopes workflow");
    const again = (status().text.match(/Token scopes:\s*(.*)/i) || [])[1] || "";
    if (!/workflow/.test(again)) {
      console.error("\nThe \"workflow\" permission was not granted. Run this again and click Authorize in the browser.");
      process.exit(1);
    }
  }
  // git push uses the GitHub CLI login (no separate password prompt).
  spawnSync("gh auth setup-git --hostname github.com", { shell: true, stdio: "ignore" });
  const who = (status().text.match(/account\s+(\S+)/i) || status().text.match(/as\s+(\S+)/i) || [])[1] || "";
  console.log(`Logged in to GitHub${who ? " as " + who : ""} (can push the pipeline).`);
}
