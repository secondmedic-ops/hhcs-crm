// CareDesk lives at github.com/secondmedic-ops/hhcs-crm, pushed ONLY as the GitHub account secondmedic-ops
// (or an account that owns the secondmedic-ops organisation). Used by START-HERE (setup.mjs) and SHIP (ship.mjs).
// If the GitHub CLI is signed in as another account, it switches to secondmedic-ops, or signs it in.
import { execSync, spawnSync } from "node:child_process";

export const OWNER = "secondmedic-ops";
export const NAME = "hhcs-crm";
export const REPO = `${OWNER}/${NAME}`;

const out = (c) => execSync(c, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const quiet = (c) => { try { return out(c); } catch { return ""; } };
const interactive = (c) => spawnSync(c, { shell: true, stdio: "inherit" }).status === 0;

/** Can the signed-in GitHub account manage secondmedic-ops/hhcs-crm (create it, push, set secrets)? */
function canManage(login) {
  if (!login) return false;
  if (login.toLowerCase() === OWNER) return true;
  if (quiet(`gh api orgs/${OWNER}/memberships/${login} --jq .role`) === "admin") return true;
  return quiet(`gh repo view ${REPO} --json viewerPermission --jq .viewerPermission`) === "ADMIN";
}

/** Can the signed-in account push to secondmedic-ops/hhcs-crm (an invited developer, e.g. Pritesh)? Enough for SHIP. */
function canPush(login) {
  if (!login) return false;
  if (canManage(login)) return true;
  return ["WRITE", "MAINTAIN"].includes(quiet(`gh repo view ${REPO} --json viewerPermission --jq .viewerPermission`));
}

/** SHIP.bat: the owner account, or a developer the owner invited to the repository. Commits are still authored as secondmedic-ops. */
export function ensurePushAccount() {
  const login = quiet("gh api user --jq .login");
  if (login && login.toLowerCase() !== OWNER && canPush(login)) {
    spawnSync("gh auth setup-git --hostname github.com", { shell: true, stdio: "ignore" });
    try {
      execSync(`git config user.name "${OWNER}"`, { stdio: "ignore" });
      execSync(`git config user.email "${OWNER}@users.noreply.github.com"`, { stdio: "ignore" });
    } catch { /* not a git folder yet */ }
    console.log(`GitHub: using ${login} (invited developer) for ${REPO}.`);
    return login;
  }
  return ensureOwnerAccount();
}

export function ensureOwnerAccount() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const login = quiet("gh api user --jq .login");
    if (canManage(login)) {
      spawnSync("gh auth setup-git --hostname github.com", { shell: true, stdio: "ignore" });
      try { // commits from this folder are authored as secondmedic-ops (this repository only, not your global git settings)
        execSync(`git config user.name "${OWNER}"`, { stdio: "ignore" });
        execSync(`git config user.email "${OWNER}@users.noreply.github.com"`, { stdio: "ignore" });
      } catch { /* not a git folder yet */ }
      console.log(`GitHub: using ${login} for ${REPO}.`);
      return login;
    }
    // Already signed in on this computer as secondmedic-ops? Switch to it.
    if (attempt === 0 && interactive(`gh auth switch --hostname github.com --user ${OWNER} >nul 2>&1`) && canManage(quiet("gh api user --jq .login"))) continue;
    console.log(`
  ------------------------------------------------------------------
  CareDesk is published only from the GitHub account ${OWNER}
  (or an account that owns the ${OWNER} organisation).
  This computer's GitHub CLI is signed in as "${login || "nobody"}".
  Sign in with that account now:
   1. In your browser, sign in to github.com as ${OWNER} FIRST
      (sign out of any other GitHub account there).
   2. Press ENTER in THIS black window; paste the code it shows
      in the browser, then Authorize.
  ------------------------------------------------------------------`);
    interactive("gh auth login --hostname github.com --git-protocol https --web --scopes repo,workflow");
  }
  const login = quiet("gh api user --jq .login");
  if (canManage(login)) return ensureOwnerAccount();
  console.error(`\nStill signed in as "${login}", which cannot manage ${REPO}. Sign in to GitHub as ${OWNER} and run this again.`);
  process.exit(1);
}

/** Make sure secondmedic-ops/hhcs-crm exists and this folder pushes to it. */
export function ensureRepo() {
  const url = `https://github.com/${REPO}.git`;
  const current = quiet("git remote get-url origin");
  if (current && current.replace(/\.git$/, "").toLowerCase() !== url.replace(/\.git$/, "").toLowerCase()) {
    execSync(`git remote set-url origin ${url}`);
    console.log(`Remote origin changed to ${url}`);
  } else if (!current) {
    execSync(`git remote add origin ${url}`);
  }
  if (!quiet(`gh repo view ${REPO} --json name --jq .name`)) {
    if (!interactive(`gh repo create ${REPO} --private`)) {
      console.error(`Could not create ${REPO}. Make sure you are signed in as ${OWNER}.`);
      process.exit(1);
    }
    console.log(`Created private repository ${REPO}`);
  }
}
