import { expect, test } from 'vitest';
import { parsePgArray } from '../src/db';
import { pgArray, buildQuery } from '../src/domain/query';

test('Postgres array text round-trips', () => {
  expect(parsePgArray('{}')).toEqual([]);
  expect(parsePgArray('{phlebotomy,ecg}')).toEqual(['phlebotomy', 'ecg']);
  expect(parsePgArray('{"chest pain mentioned","say \\"hi\\"",NULL,"NULL"}')).toEqual(['chest pain mentioned', 'say "hi"', null, 'NULL']);
  const v = ['a,b', 'c"d', 'e\\f', 'plain'];
  expect(parsePgArray(pgArray(v))).toEqual(v);
});

test('query translator refuses SQL in names and keeps values as parameters', () => {
  expect(() => buildQuery({ table: 'cases; drop table cases' })).toThrow();
  expect(() => buildQuery({ table: 'cases', cols: 'id, (select 1)' })).toThrow();
  expect(() => buildQuery({ table: 'cases', op: 'update', patch: { stage: 'x' } })).toThrow(/filter/);
  expect(() => buildQuery({ table: 'cases', op: 'delete' })).toThrow(/filter/);
  const q = buildQuery({ table: 'v_cases', filters: [{ col: 'case_no', op: 'eq', val: "x' or '1'='1" }], limit: 99999 }, 'raw');
  expect(q.text).toBe('select * from v_cases where case_no = $1 limit 10000');
  expect(q.params).toEqual(["x' or '1'='1"]);
  const u = buildQuery({ table: 'zones', op: 'update', patch: { pincodes: ['400050'], name: 'Khar' }, filters: [{ col: 'id', op: 'eq', val: 'z1' }] }, 'raw');
  expect(u.text).toBe('update zones set pincodes = $2, name = $3 where id = $1 returning *');
  expect(u.params).toEqual(['z1', '{"400050"}', 'Khar']);
});
