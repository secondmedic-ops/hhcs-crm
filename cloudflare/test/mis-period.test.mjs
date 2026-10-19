import { expect, test } from 'vitest';
import { rangeFor, selectMisPeriod, shiftMonth } from '../../src/lib/mis-period.js';

const initial = () => ({ mode: 'daily', anchor: '2026-10-18', custom: ['2026-10-12', '2026-10-18'] });
const range = (p) => rangeFor(p.mode, p.anchor, p.custom);

test('Weekly to Monthly retains October instead of resetting to September', () => {
  let p = initial();
  expect(range(p)).toEqual(['2026-10-18', '2026-10-18']);
  p = selectMisPeriod(p, 'weekly');
  expect(range(p)).toEqual(['2026-10-12', '2026-10-18']);
  p = selectMisPeriod(p, 'monthly');
  expect(range(p)).toEqual(['2026-10-01', '2026-10-31']);
  p = selectMisPeriod(p, 'daily');
  expect(range(p)).toEqual(['2026-10-18', '2026-10-18']);
});

test('period switches preserve historical dates across year and leap-month boundaries', () => {
  let p = selectMisPeriod({ ...initial(), anchor: '2024-02-29' }, 'monthly');
  expect(range(p)).toEqual(['2024-02-01', '2024-02-29']);
  p = { ...p, anchor: shiftMonth(p.anchor, -1) };
  expect(range(p)).toEqual(['2024-01-01', '2024-01-31']);
  p = { ...p, anchor: shiftMonth(p.anchor, -1) };
  p = selectMisPeriod(p, 'weekly');
  expect(range(p)).toEqual(['2023-11-27', '2023-12-03']);
});

test('Custom starts with the displayed range and fixed periods use its first date', () => {
  let p = selectMisPeriod(initial(), 'weekly');
  p = selectMisPeriod(p, 'custom');
  expect(range(p)).toEqual(['2026-10-12', '2026-10-18']);
  p = { ...p, custom: ['2026-09-30', '2026-09-10'] };
  expect(range(p)).toEqual(['2026-09-10', '2026-09-30']);
  p = selectMisPeriod(p, 'monthly');
  expect(range(p)).toEqual(['2026-09-01', '2026-09-30']);
});
