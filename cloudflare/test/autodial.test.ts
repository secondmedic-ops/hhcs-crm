import { afterEach, expect, test, vi } from 'vitest';
import { runAutodial } from '../src/services/autodial';
import { clickToCall } from '../src/services/myoperator';
import { asSystem } from '../src/db';
import { ApiError } from '../src/domain/errors';
import type { Env } from '../src/env';
vi.mock('../src/services/myoperator', () => ({ clickToCall: vi.fn() }));
vi.mock('../src/services/myoperator-config', () => ({ moEnv: async (env: Env) => env, missingCallingSettings: (env: Env) => env.MYOPERATOR_COMPANY_ID ? [] : ['Company ID'] }));
vi.mock('../src/db', () => ({ asSystem: vi.fn() }));
afterEach(() => vi.resetAllMocks());
test('missing calling configuration never claims a callback or creates a false call', async () => {
  expect(await runAutodial({} as Env, {} as any)).toMatchObject({dialled:0,failed:0,skipped:'calling not configured'});
  expect(asSystem).not.toHaveBeenCalled(); expect(clickToCall).not.toHaveBeenCalled();
});
test.each([502,504])('provider %i: one agent-first request, rejection retries only its ringing call; uncertainty stays reserved', async status => {
  const tx: any = vi.fn().mockResolvedValue([{id:'call'}]); tx.json = (v: unknown) => v;
  vi.mocked(asSystem).mockResolvedValueOnce({result:[{callback_id:'cb',call_id:'call',ref:'ref',number:'+919800000001',myoperator_user_id:'mo'}],changed:[]})
    .mockImplementationOnce(async (_sql, fn) => ({result:await fn(tx),changed:[]}));
  vi.mocked(clickToCall).mockRejectedValueOnce(new ApiError(status,'provider'));
  await runAutodial({MYOPERATOR_COMPANY_ID:'company'} as Env, {} as any);
  expect(clickToCall).toHaveBeenCalledExactlyOnceWith(expect.anything(),{myoperatorUserId:'mo',number:'+919800000001',referenceId:'ref'});
  const queries = tx.mock.calls.map((c: any[]) => c[0].join(' ')).join('\n');
  expect(queries.includes('callback_retry')).toBe(status===502);
  expect(queries.includes('unconfirmed')).toBe(status===504);
});
