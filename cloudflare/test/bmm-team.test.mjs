import { test, expect, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createUser } from '../src/services/admin.ts';

const dir = join(import.meta.dirname, '..', '..', 'supabase', 'migrations');

test('BMM supervisor team creation & role locking', { timeout: 30000 }, async () => {
  const db = new PGlite();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(dir, f), 'utf8'));
  }

  const ws = (await db.query(`select id from workspaces where code='HHC'`)).rows[0].id;
  const bmm = (await db.query(`select id from providers where workspace_id=$1 and code='BMM'`, [ws])).rows[0];
  const sm = (await db.query(`select id from providers where workspace_id=$1 and code='SM'`, [ws])).rows[0];

  const bmmCoordId = 'b3333333-3333-4333-8333-333333333333';
  await db.query(`insert into profiles(id, workspace_id, full_name, email, role, provider_id, active)
    values ($1, $2, 'BMM Coordinator', 'bmm.coord@test.com', 'provider', $3, true)`,
    [bmmCoordId, ws, bmm.id]);

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('/auth/v1/admin/users')) {
      return new Response(JSON.stringify({ id: 'b9999999-9999-4999-8999-999999999999' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return origFetch(url, opts);
  };

  try {
    const mockSql = Object.assign(
      async (strings, ...values) => {
        let text = strings[0];
        const params = [];
        for (let i = 0; i < values.length; i++) {
          params.push(values[i]);
          text += '$' + params.length + strings[i + 1];
        }
        return (await db.query(text, params)).rows;
      },
      {
        unsafe: async (q, params = []) => (await db.query(q, params)).rows,
        begin: async (fn) => {
          await db.exec('BEGIN');
          try {
            const tx = async (strings, ...values) => {
              let text = strings[0];
              const params = [];
              for (let i = 0; i < values.length; i++) {
                params.push(values[i]);
                text += '$' + params.length + strings[i + 1];
              }
              return (await db.query(text, params)).rows;
            };
            const res = await fn(tx);
            await db.exec('COMMIT');
            return res;
          } catch (e) {
            await db.exec('ROLLBACK');
            throw e;
          }
        },
      }
    );

    const cProvider = {
      sql: mockSql,
      env: { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key' },
      user: { id: bmmCoordId, workspaceId: ws, role: 'provider' },
      changed: [],
    };

    // 1. Provider coordinator cannot create a non-field role (supervisor, admin, coordinator)
    await expect(createUser(cProvider, {
      full_name: 'Attempted Coordinator',
      email: 'bad.role@test.com',
      password: 'validpassword123!',
      role: 'coordinator',
    })).rejects.toThrow(/Provider coordinators can only create field staff logins/);

    await expect(createUser(cProvider, {
      full_name: 'Attempted Admin',
      email: 'bad.admin@test.com',
      password: 'validpassword123!',
      role: 'admin',
    })).rejects.toThrow(/Provider coordinators can only create field staff logins/);

    // 2. Provider coordinator creating field_staff is strictly locked to their provider_id
    const created = await createUser(cProvider, {
      full_name: 'Ramesh Patil',
      email: 'ramesh.patil@test.com',
      phone: '9820011223',
      password: 'validpassword123!',
      role: 'field_staff',
      provider_id: sm.id, // Attempt to assign to SM
      skills: ['delivery', 'equipment'],
      agent_code: 'A-99',
    });

    expect(created.provider_id).toBe(bmm.id);
    expect(created.role).toBe('field_staff');
    expect(created.skills).toEqual(expect.arrayContaining(['delivery', 'equipment']));
    expect(created.agent_code).toBeNull();
  } finally {
    globalThis.fetch = origFetch;
  }
});
