// MIS calendar helpers on 'YYYY-MM-DD' strings
export const D = (s) => new Date(s + 'T00:00:00Z');
const S = (d) => d.toISOString().slice(0, 10);
export const add = (s, n) => S(new Date(D(s).getTime() + n * 86400e3));
const monday = (s) => add(s, -((D(s).getUTCDay() + 6) % 7));
const monthStart = (s) => s.slice(0, 7) + '-01';
const monthEnd = (s) => { const d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + 1); return add(S(d), -1); };
export const shiftMonth = (s, n) => { const d = D(monthStart(s)); d.setUTCMonth(d.getUTCMonth() + n); return S(d); };

export function rangeFor(mode, anchor, custom) {
  if (mode === 'daily') return [anchor, anchor];
  if (mode === 'weekly') { const m = monday(anchor); return [m, add(m, 6)]; }
  if (mode === 'monthly') return [monthStart(anchor), monthEnd(anchor)];
  return custom[0] <= custom[1] ? custom : [custom[1], custom[0]];
}

export function selectMisPeriod({ mode, anchor, custom }, nextMode) {
  const [from, to] = rangeFor(mode, anchor, custom);
  return {
    mode: nextMode,
    anchor: mode === 'custom' ? from : anchor,
    custom: nextMode === 'custom' ? [from, to] : custom,
  };
}
