// Lightweight SVG charts (no chart library). All accept plain arrays.

const C = { accent: '#0e5e57', ink: '#1a1d1b', muted: '#9a9f98', line: '#e6e2d7', danger: '#a3362e', warn: '#9a5b0b' };

// Vertical bars with optional second series (e.g. calls vs missed per hour)
export function Bars({ data, x, y, y2, height = 140, labelEvery = 1, colors = [C.accent, C.danger], format = (v) => v }) {
  if (!data?.length) return <div className="sk" style={{ height }} />;
  const max = Math.max(1, ...data.map((d) => Number(d[y]) || 0));
  const w = 100 / data.length;
  return (
    <div>
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img">
      {[0.25, 0.5, 0.75, 1].map((g) => <line key={g} x1="0" x2="100" y1={height - g * height} y2={height - g * height} stroke={C.line} strokeWidth="0.3" vectorEffect="non-scaling-stroke" />)}
      {data.map((d, i) => {
        const h1 = ((Number(d[y]) || 0) / max) * (height - 4);
        const h2 = y2 ? ((Number(d[y2]) || 0) / max) * (height - 4) : 0;
        return (
          <g key={i}>
            <rect x={i * w + w * 0.18} y={height - h1} width={w * 0.64} height={h1} fill={colors[0]}><title>{`${d[x]}: ${format(d[y])}${y2 ? ` · ${d[y2]}` : ''}`}</title></rect>
            {y2 && h2 > 0 && <rect x={i * w + w * 0.18} y={height - h2} width={w * 0.64} height={h2} fill={colors[1]} />}
          </g>
        );
      })}
    </svg>
    <div style={{ display: 'flex', marginTop: 4 }}>
      {data.map((d, i) => <div key={i} className="mono tiny faint center" style={{ flex: 1, minWidth: 0 }}>{i % labelEvery === 0 ? d[x] : ''}</div>)}
    </div>
    </div>
  );
}

// Horizontal labelled bars (zones, services, reasons)
export function HBars({ data, label, value, format = (v) => v, max: maxIn, color = C.accent, sub }) {
  if (!data) return null;
  const max = maxIn || Math.max(1, ...data.map((d) => Number(d[value]) || 0));
  return (
    <div className="col" style={{ gap: 9 }}>
      {data.map((d, i) => (
        <div key={i}>
          <div className="row between small"><span className="truncate">{d[label]}</span><span className="mono">{format(d[value])}{sub ? <span className="faint"> {sub(d)}</span> : null}</span></div>
          <div className="bar-track mt-4"><div className="bar-fill" style={{ width: `${((Number(d[value]) || 0) / max) * 100}%`, background: color }} /></div>
        </div>
      ))}
    </div>
  );
}

// Funnel as stepped bars with conversion between steps
export function Funnel({ steps }) {
  const max = Math.max(1, ...steps.map((s) => s.value || 0));
  return (
    <div className="col" style={{ gap: 6 }}>
      {steps.map((s, i) => {
        const prev = i ? steps[i - 1].value : null;
        const conv = prev ? Math.round(((s.value || 0) / prev) * 100) : null;
        return (
          <button key={s.label} type="button" onClick={s.onClick} className="row" style={{ background: 'none', border: 0, padding: 0, cursor: s.onClick ? 'pointer' : 'default', font: 'inherit', textAlign: 'left' }}>
            <div style={{ width: 92 }} className="small muted">{s.label}</div>
            <div className="grow" style={{ background: 'var(--paper-2)', height: 22 }}>
              <div style={{ width: `${((s.value || 0) / max) * 100}%`, height: '100%', background: i === steps.length - 1 ? C.ink : C.accent, opacity: 1 - i * 0.1 }} />
            </div>
            <div className="mono right" style={{ width: 40 }}>{s.value ?? '–'}</div>
            <div className="mono small faint right" style={{ width: 44 }}>{conv != null ? `${conv}%` : ''}</div>
          </button>
        );
      })}
    </div>
  );
}

// Small line/area sparkline
export function Line({ data, y, height = 48, color = C.accent }) {
  if (!data?.length) return <div className="sk" style={{ height }} />;
  const vals = data.map((d) => Number(d[y]) || 0);
  const max = Math.max(1, ...vals), n = vals.length;
  const pts = vals.map((v, i) => `${(i / Math.max(1, n - 1)) * 100},${height - (v / max) * (height - 4) - 2}`).join(' ');
  return (
    <svg viewBox={`0 0 100 ${height}`} preserveAspectRatio="none" width="100%" height={height}>
      <polyline points={`0,${height} ${pts} 100,${height}`} fill={color} opacity="0.1" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// Percentage meter with target marker
export function Meter({ value, target, label }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  const tone = target != null && v < target ? C.warn : C.accent;
  return (
    <div>
      <div className="row between small"><span>{label}</span><span className="mono">{value == null ? '–' : `${Number(value).toFixed(1)}%`}</span></div>
      <div style={{ position: 'relative', height: 8, background: 'var(--paper-2)', marginTop: 4 }}>
        <div style={{ width: `${v}%`, height: '100%', background: tone }} />
        {target != null && <div title={`Target ${target}%`} style={{ position: 'absolute', left: `${target}%`, top: -3, bottom: -3, width: 2, background: C.ink }} />}
      </div>
    </div>
  );
}
