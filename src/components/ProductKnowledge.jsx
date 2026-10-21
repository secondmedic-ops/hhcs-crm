// Product knowledge for agents: rate-card services with price, who delivers them and what to say.
// A service shows its own knowledge row when one exists, otherwise its category default (service_knowledge).
import { useMemo, useState } from 'react';
import { db, q } from '../lib/db.js';
import { useLoad, useDebounced } from '../lib/hooks.js';
import { inr } from '../lib/fmt.js';
import { Panel, Input, Badge, Empty, Skeleton } from './ui.jsx';

export const CAT_LABEL = { lab: 'Sample collection', xray: 'Portable X-ray', ecg: 'ECG at home', visit: 'Visit charges', nursing: 'Nursing',
  physio: 'Physiotherapy', beds: 'Hospital beds', eldercare: 'Elder care', homecare: 'Other home care', equipment: 'Equipment', icu: 'ICU setup',
  consumables: 'Consumables', other: 'Other' };

export const KB_FIELDS = [
  ['summary', 'What it is'],
  ['who_needs', 'Who needs it'],
  ['ask_caller', 'Ask the caller'],
  ['includes', 'Included'],
  ['excludes', 'Not included'],
  ['prep', 'Preparation at home'],
  ['faq', 'Common questions'],
];

/** Services + knowledge + providers, merged. Each row: service fields, kb (own or category default), kbSource, delivered. */
export function useCatalogue() {
  const res = useLoad(() => Promise.all([
    q(db.from('v_services').select('id,code,name,category,unit,price,b2b_rate,tat_hours,description,active').order('name')),
    q(db.from('service_knowledge').select('id,service_id,category,summary,who_needs,ask_caller,includes,excludes,prep,faq,updated_at')),
    q(db.from('providers').select('id,code,name,categories,active')),
  ]), [], ['services', 'service_knowledge', 'providers']);
  const data = useMemo(() => {
    if (!res.data) return null;
    const [svcs, kb, provs] = res.data;
    const bySvc = Object.fromEntries((kb || []).filter((k) => k.service_id).map((k) => [k.service_id, k]));
    const byCat = Object.fromEntries((kb || []).filter((k) => k.category).map((k) => [k.category, k]));
    const rows = (svcs || []).map((s) => {
      const own = bySvc[s.id];
      const kbRow = own || byCat[s.category] || null;
      const delivered = (provs || []).filter((p) => p.active && (p.categories || []).includes(s.category)).map((p) => p.name || p.code);
      return { ...s, own: own || null, kb: kbRow, kbSource: own ? 'service' : kbRow ? 'category' : 'none', delivered };
    });
    return { rows, byCat, providers: provs || [] };
  }, [res.data]);
  return { ...res, data };
}

const norm = (s) => String(s || '').toLowerCase();
/** Rate-card price for agents: a price of 0 is a placeholder, never a price to read out. */
export const priceText = (price) => (Number(price) > 0 ? inr(price) : 'Not priced, quote after assessment');
export function matches(row, term) {
  const t = norm(term).trim();
  if (!t) return true;
  const hay = [row.code, row.name, row.description, CAT_LABEL[row.category], row.category, row.kb?.summary, row.kb?.who_needs].map(norm).join(' ');
  return t.split(/\s+/).every((w) => hay.includes(w));
}

export function KnowledgeBody({ row, isPartner = false }) {
  const kb = row.kb;
  const showB2B = isPartner || row.price == null;
  return (
    <div className="col gap-12">
      {showB2B ? (
        <div className="row wrap gap-4 small">
          <strong>{row.b2b_rate != null ? inr(row.b2b_rate) : 'B2B rate not set'}</strong>
          <span className="muted">· B2B rate{row.unit ? ` per ${row.unit}` : ''}</span>
          {row.tat_hours ? <span className="muted">· report / start within {row.tat_hours} h</span> : null}
        </div>
      ) : row.price != null ? (
        <div className="row wrap gap-4 small">
        <strong>{priceText(row.price)}</strong>{Number(row.price) > 0 && <span className="muted">per {row.unit || 'unit'}</span>}
        {row.tat_hours ? <span className="muted">· report / start within {row.tat_hours} h</span> : null}
        <span className="muted">· delivered by {row.delivered.length ? row.delivered.join(', ') : 'not routed yet'}</span>
      </div>) : null}
      {row.description && <div className="small">{row.description}</div>}
      {!kb ? <div className="small muted">No product knowledge yet. Ask a supervisor to add it on the Product knowledge page.</div> : KB_FIELDS.map(([k, label]) => kb[k] ? (
        <div key={k}>
          <div className="tiny faint" style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
          <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{kb[k]}</div>
        </div>
      ) : null)}
      {row.kbSource === 'category' && <div className="tiny faint">General notes for {CAT_LABEL[row.category] || row.category}; service-specific notes not added yet.</div>}
    </div>
  );
}

/** Compact search panel for the agent console. */
export function KnowledgePanel({ onOpenAll }) {
  const cat = useCatalogue();
  const [term, setTerm] = useState('');
  const t = useDebounced(term, 150);
  const [open, setOpen] = useState(null);
  const list = useMemo(() => (cat.data?.rows || []).filter((r) => r.active && matches(r, t)).slice(0, t ? 12 : 6), [cat.data, t]);
  return (
    <Panel title="Product knowledge" sub="Price, who delivers it and what to say"
      actions={onOpenAll && <a className="small" href="/knowledge" onClick={(e) => { e.preventDefault(); onOpenAll(); }}>All services</a>} tight>
      <div className="panel-body" style={{ paddingBottom: 4 }}>
        <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search a service: nurse, X-ray, bed, CBC" aria-label="Search services" />
      </div>
      {cat.loading ? <div className="panel-body"><Skeleton lines={5} /></div>
        : !list.length ? <Empty title={t ? 'No service matches' : 'No services on the rate card'}>{t ? 'Try another word, or check the rate card.' : null}</Empty>
        : list.map((r) => (
          <div key={r.id} className="list-row click" style={{ display: 'block' }} onClick={() => setOpen(open === r.id ? null : r.id)}>
            <div className="row between gap-12">
              <div className="small grow"><span className="mono">{r.code}</span> · {r.name}</div>
              <span className="small">{r.price != null ? priceText(r.price) : (r.b2b_rate != null ? `${inr(r.b2b_rate)} (B2B)` : 'B2B not set')}{Number(r.price ?? r.b2b_rate) > 0 && <span className="tiny muted"> / {r.unit || 'unit'}</span>}</span>
            </div>
            <div className="tiny muted truncate">{CAT_LABEL[r.category] || r.category}{r.delivered.length ? ` · ${r.delivered.join(', ')}` : ''}{r.kbSource === 'none' ? ' · no notes yet' : ''}</div>
            {open === r.id && <div className="mt-12" onClick={(e) => e.stopPropagation()}><KnowledgeBody row={r} /></div>}
          </div>
        ))}
    </Panel>
  );
}

export const kbBadge = (src) => src === 'service' ? <Badge kind="ok">Service notes</Badge> : src === 'category' ? <Badge kind="outline">Category notes</Badge> : <Badge kind="warn">Missing</Badge>;
