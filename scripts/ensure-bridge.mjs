// Helper to ensure the central WhatsApp bridge is running in the background.
// Only ONE instance runs centrally on the server / host PC.
// Individual client PCs never need to run WHATSAPP-CONNECT.bat.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const BRIDGE_DIR = join(ROOT, '.whatsapp-bridge');
const PID_FILE = join(BRIDGE_DIR, 'bridge.pid');

export function ensureBridgeRunning(opts = {}) {
  if (existsSync(PID_FILE)) {
    try {
      const oldPid = parseInt(readFileSync(PID_FILE, 'utf8'), 10);
      if (oldPid && !isNaN(oldPid)) {
        try {
          process.kill(oldPid, 0);
          return { running: true, pid: oldPid };
        } catch {
          // PID is stale
        }
      }
    } catch {}
  }

  const script = join(ROOT, 'scripts', 'whatsapp-bridge.mjs');
  if (!existsSync(script)) return { running: false, error: 'Bridge script not found' };

  try {
    const child = spawn(process.execPath, [script], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ...opts.env },
    });
    child.unref();
    return { started: true, pid: child.pid };
  } catch (err) {
    return { running: false, error: err.message };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const res = ensureBridgeRunning();
  console.log('[ensure-bridge]', res);
}
