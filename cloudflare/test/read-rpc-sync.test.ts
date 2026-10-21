// The browser's list of read-only actions (src/lib/pg-adapter.js READ_ONLY_RPC) must equal the Worker's READ_RPC.
// A read missing in the browser counts as a write there: every screen reloads after it, and a loader that calls it
// reloads itself in a loop (21 Oct 2026: my_pending_wrapup / provider_portal used up the Hyperdrive daily budget).
import { test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { READ_RPC } from '../src/services/data';

test('browser read-only actions match the Worker READ_RPC', () => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'lib', 'pg-adapter.js'), 'utf8');
  const m = src.match(/const READ_ONLY_RPC = new Set\(\[([^\]]*)\]\)/);
  expect(m, 'READ_ONLY_RPC not found in src/lib/pg-adapter.js').toBeTruthy();
  const browser = [...m![1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]).sort();
  expect(browser).toEqual([...READ_RPC].sort());
});
