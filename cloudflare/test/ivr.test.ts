import { expect, test } from 'vitest';
import { callbackStart, decideIvr, officeHours, type IvrState } from '../src/domain/ivr';

test('IST opening/closing boundaries and next-opening callbacks, including month/year rollover', () => {
  for (const [at, open, start] of [
    ['2026-10-24T02:29:59Z', false, '2026-10-24T02:30:00.000Z'],
    ['2026-10-24T02:30:00Z', true, '2026-10-24T02:30:00.000Z'],
    ['2026-10-24T14:29:59Z', true, '2026-10-24T14:29:59.000Z'],
    ['2026-10-24T14:30:00Z', false, '2026-10-25T02:30:00.000Z'],
    ['2026-12-31T18:29:59Z', false, '2027-01-01T02:30:00.000Z'],
    ['2026-12-31T18:30:00Z', false, '2027-01-01T02:30:00.000Z'],
  ] as const) {
    expect(officeHours(new Date(at))).toBe(open);
    expect(callbackStart(new Date(at)).toISOString()).toBe(start);
  }
});

test('office menus, CSE availability, exact three-minute queue boundary and callback / voicemail options', () => {
  const s: IvrState = { afterHours: false, lastAction: 'main_menu' };
  expect(decideIvr(s, 'entry', '', false, 0)).toBe('main_menu');
  expect(decideIvr(s, 'menu', '1', false, 0)).toBe('information');
  expect(decideIvr(s, 'menu', '2', false, 0)).toBe('billing');
  expect(decideIvr(s, 'menu', '5', true, 1000)).toBe('homecare');
  expect(decideIvr(s, 'menu', '5', false, 1000)).toBe('hold');
  s.lastAction = 'hold';
  expect(decideIvr(s, 'queue', '', false, 180999)).toBe('hold');
  expect(decideIvr(s, 'queue', '', false, 181000)).toBe('callback_offer');
  expect(decideIvr(s, 'queue', '', true, 181000)).toBe('homecare');
  s.lastAction = 'callback_offer';
  expect(decideIvr(s, 'callback_offer', '1', false, 181000)).toBe('callback');
  expect(decideIvr(s, 'callback_offer', '2', false, 181000)).toBe('voicemail');
});

test('after-hours urgent routing, callback consent, invalid/no input and terminal retries', () => {
  const s: IvrState = { afterHours: true, lastAction: 'after_hours' };
  expect(decideIvr(s, 'entry', '', false, 0)).toBe('after_hours');
  expect(decideIvr(s, 'after_hours', '1', false, 0)).toBe('emergency');
  expect(decideIvr(s, 'after_hours', '2', false, 0)).toBe('callback');
  expect(decideIvr(s, 'after_hours', '9', false, 0)).toBe('after_hours');
  expect(decideIvr(s, 'after_hours', '', false, 0)).toBe('after_hours');
  expect(decideIvr(s, 'after_hours', '', false, 0)).toBe('voicemail');
  expect(() => decideIvr(s, 'queue', '', false, 0)).toThrow();
  expect(() => decideIvr(s, 'menu', '5', false, 0)).toThrow();
  s.terminal = 'callback_confirm';
  expect(decideIvr(s, 'after_hours', '2', false, 0)).toBe('callback_confirm');
});
