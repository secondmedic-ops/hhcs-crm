// A throw-away Postgres for local runs, with nothing to install: PGlite (real Postgres compiled to WebAssembly) in
// memory, reachable over the normal Postgres protocol on 127.0.0.1. Built from supabase/migrations/ like production,
// plus a stand-in for Supabase's auth.users table. Everything is gone when the process stops.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

export async function startLocalDb({ root, port = 54330, demoData = false }) {
  const db = await PGlite.create();
  await db.exec(`create schema if not exists auth;
    create table if not exists auth.users (id uuid primary key, email text, aud text, role text,
      created_at timestamptz default now(), last_sign_in_at timestamptz);`);
  const dir = join(root, 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    try {
      await db.exec(readFileSync(join(dir, f), 'utf8'));
    } catch (e) {
      throw new Error(`Migration ${f} failed on the local database: ${e.message}`);
    }
  }
  if (demoData) {
    // the same week of sample MMR operations the browser demo shows (src/demo/seed.js builds it as SQL)
    const { buildSeedSql } = await import(pathToFileURL(join(root, 'src', 'demo', 'seed.js')).href);
    const ws = (await db.query(`select id from workspaces where code = 'HHC'`)).rows[0].id;
    const services = (await db.query(`select id, code, name, category, price from services`)).rows;
    const templates = (await db.query(`select id, code from templates`)).rows;
    const zones = (await db.query(`select id, name from zones`)).rows;
    await db.exec(`set session_replication_role = replica;\n${buildSeedSql({ ws, services, templates, zones })}\nset session_replication_role = origin;`);
  }
  const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 });
  keepExtendedQueriesTogether(server.queryQueue);
  await server.start();
  return { url: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, stop: async () => { await server.stop(); await db.close(); } };
}

// pglite-socket queues single protocol messages from all connections onto one PGlite. With several requests at
// once (a screen loading 4 lists), connection A's Parse / Bind / Execute could interleave with B's, and Postgres
// then answered "bind message supplies 1 parameters, but prepared statement requires 0". Local test only:
// production Postgres has one backend per connection. This keeps every connection's messages together until its
// Sync ('S') or simple Query ('Q') ends the exchange, and inside a transaction as before.
function keepExtendedQueriesTogether(q) {
  let owner = null; // handler whose extended-protocol exchange is open
  q.processQueue = async function () {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;
    while (this.queue.length > 0) {
      const holder = owner ?? (this.db.isInTransaction() ? this.lastHandlerId : null);
      let item;
      if (holder !== null && holder !== undefined) {
        const i = this.queue.findIndex((x) => x.handlerId === holder);
        if (i === -1) break; // wait for that connection's next message (enqueue restarts the queue)
        item = this.queue.splice(i, 1)[0];
      } else item = this.queue.shift();
      const kind = item.message[0];
      // Sync, simple Query, Terminate, startup (length byte 0) and password end an exchange.
      owner = kind === 0x53 || kind === 0x51 || kind === 0x58 || kind === 0x00 || kind === 0x70 ? null : item.handlerId;
      try {
        let bytes = 0;
        await this.db.runExclusive(() => this.db.execProtocolRawStream(item.message, { onRawData: (d) => { bytes += d.length; item.onData(d); } }));
        this.lastHandlerId = item.handlerId;
        item.resolve(bytes);
      } catch (e) {
        owner = null;
        item.reject(e);
      }
    }
    this.processing = false;
  };
  const clear = q.clearQueueForHandler.bind(q);
  q.clearQueueForHandler = (id) => { if (owner === id) owner = null; clear(id); };
}
