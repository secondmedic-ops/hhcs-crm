// Product knowledge: the full service catalogue for agent training, with notes per service and per category.
// Supervisors / admin edit notes and import them from Excel; every staff role (not providers) can read.
import { useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { db, q, rpc } from '../lib/db.js';
import { useAuth, roleAllows } from '../lib/auth.jsx';
import { inr, num, ago } from '../lib/fmt.js';
import { PageHead, Panel, Kpi, Tabs, Segmented, Button, Input, Field, Textarea, Drawer, Empty, ErrorNote, TableSkeleton, useAction, useToast } from '../components/ui.jsx';
import { useCatalogue, matches, KnowledgeBody, KB_FIELDS, CAT_LABEL, kbBadge } from '../components/ProductKnowledge.jsx';

// Standard interaction reasons (cases.intake_disposition) with when to use each, for agent training.
const DISPOSITION_GUIDE = [
  ['Requirement captured', 'The caller needs a service and you recorded patient, need, dates and decision maker. The case moves to the coordinator.'],
  ['Information only', 'The caller only wanted information (timings, process, what a service includes). No booking now.'],
  ['Price enquiry', 'The caller asked prices only. Share the rate-card price; offer a quote on WhatsApp.'],
  ['Follow-up requested', 'The caller will decide later or asked to be called back. Set the follow-up time.'],
  ['Not interested', 'The caller does not want the service. Record the reason in notes (price, already managing, other).'],
  ['Already arranged elsewhere', 'The family has arranged care through another provider.'],
  ['Wrong number', 'Not a patient or family member, or a misdial.'],
  ['Duplicate enquiry', 'The same need is already an open case. Add notes to that case instead.'],
];

const HEAD = ['Service Code', 'Service Name', 'Summary', 'Who needs it', 'Ask the caller', 'Includes', 'Excludes', 'Preparation', 'FAQ'];
const KEY_OF = { servicecode: 'service_code', code: 'service_code', summary: 'summary', whatitis: 'summary', whoneedsit: 'who_needs', whoneeds: 'who_needs',
  askthecaller: 'ask_caller', askcaller: 'ask_caller', includes: 'includes', included: 'includes', excludes: 'excludes', notincluded: 'excludes',
  preparation: 'prep', prep: 'prep', faq: 'faq', commonquestions: 'faq' };
const normHead = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export default function Knowledge() {
  const { profile } = useAuth();
  const canEdit = roleAllows(['supervisor', 'admin'], profile.role);
  const cat = useCatalogue();
  const [tab, setTab] = useState('services');
  const [term, setTerm] = useState('');
  const [catF, setCatF] = useState('');
  const [gap, setGap] = useState(false);
  const [open, setOpen] = useState(null);         // { kind: 'service', row } | { kind: 'category', category }
  const rows = cat.data?.rows || [];
  const active = rows.filter((r) => r.active);
  const cats = [...new Set(active.map((r) => r.category))];
  const list = useMemo(() => active.filter((r) => (!catF || r.category === catF) && (!gap || r.kbSource !== 'service') && matches(r, term)), [active, catF, gap, term]);
  const own = active.filter((r) => r.kbSource === 'service').length;
  const none = active.filter((r) => r.kbSource === 'none').length;

  return (
    <>
      <PageHead title="Product knowledge" sub="Every service on the rate card: price, who delivers it, and what the agent should ask and say">
        {canEdit && <ImportKnowledge rows={rows} />}
      </PageHead>
      {cat.error && <ErrorNote error={cat.error} />}

      <div className="kpis">
        <Kpi label="Active services" value={cat.data && num(active.length)} detail="on the rate card today" />
        <Kpi label="With service notes" value={cat.data && num(own)} detail="written for that exact service" onClick={() => { setTab('services'); setGap(false); }} />
        <Kpi label="Using category notes" value={cat.data && num(active.length - own - none)} detail="general notes until service notes are added" onClick={() => { setTab('services'); setGap(true); }} />
        <Kpi label="No notes" value={cat.data && num(none)} tone={none ? 'warn' : undefined} detail="add a category default or service notes" onClick={() => { setTab('services'); setGap(true); }} />
      </div>

      <Tabs tabs={[['services', 'Services', active.length], ['categories', 'Category defaults'], ['dispositions', 'Call dispositions']]} value={tab} onChange={setTab} />

      {tab === 'services' && (
        <Panel tight title={<Segmented value={catF} onChange={setCatF} options={[['', 'All'], ...cats.map((c) => [c, CAT_LABEL[c] || c])]} />}
          actions={<div className="row gap-12">
            <Button size="sm" kind={gap ? 'primary' : 'ghost'} onClick={() => setGap(!gap)}>{gap ? 'Showing gaps only' : 'Show gaps only'}</Button>
            <Input style={{ width: 220 }} value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search services" aria-label="Search services" />
          </div>}>
          {cat.loading ? <TableSkeleton rows={8} cols={5} /> : !list.length ? <Empty title="No service matches" /> : (
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Service</th><th>Category</th><th className="num">Price</th><th>Delivered by</th><th>Notes</th></tr></thead>
              <tbody>{list.map((r) => (
                <tr key={r.id} className="click" onClick={() => setOpen({ kind: 'service', row: r })}>
                  <td><span className="mono small">{r.code}</span><div>{r.name}</div></td>
                  <td className="small">{CAT_LABEL[r.category] || r.category}</td>
                  <td className="num">{inr(r.price)}<div className="tiny muted">per {r.unit || 'unit'}</div></td>
                  <td className="small">{r.delivered.join(', ') || <span className="muted">not routed</span>}</td>
                  <td>{kbBadge(r.kbSource)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </Panel>
      )}

      {tab === 'categories' && (
        <Panel tight title="Category defaults" sub="Shown for every service in the category until service notes are added">
          {cat.loading ? <TableSkeleton rows={6} cols={3} /> : (
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Category</th><th>Services</th><th>Summary</th><th>Updated</th></tr></thead>
              <tbody>{Object.keys(CAT_LABEL).filter((c) => cats.includes(c) || cat.data?.byCat[c]).map((c) => {
                const k = cat.data?.byCat[c];
                return (
                  <tr key={c} className="click" onClick={() => setOpen({ kind: 'category', category: c })}>
                    <td>{CAT_LABEL[c]}</td>
                    <td className="num">{num(active.filter((r) => r.category === c).length)}</td>
                    <td className="small">{k?.summary || <span className="muted">Not written</span>}</td>
                    <td className="tiny muted">{k ? ago(k.updated_at) : '–'}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          )}
        </Panel>
      )}

      {tab === 'dispositions' && (
        <Panel tight title="Call dispositions" sub="Set one interaction reason on every enquiry before ending the call">
          <div className="table-wrap"><table className="t">
            <thead><tr><th style={{ width: '26%' }}>Disposition</th><th>When to use it</th></tr></thead>
            <tbody>{DISPOSITION_GUIDE.map(([d, w]) => <tr key={d}><td><strong>{d}</strong></td><td className="small">{w}</td></tr>)}</tbody>
          </table></div>
        </Panel>
      )}

      {open && <KnowledgeDrawer key={open.kind === "service" ? open.row.id : open.category} open={open} canEdit={canEdit} cat={cat.data} onClose={() => setOpen(null)} />}
    </>
  );
}

function KnowledgeDrawer({ open, canEdit, cat, onClose }) {
  const [run, busy] = useAction();
  const row = open.kind === 'service' ? cat.rows.find((r) => r.id === open.row.id) || open.row : null;
  const current = open.kind === 'service' ? row.own : cat.byCat[open.category];
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState(() => Object.fromEntries(KB_FIELDS.map(([k]) => [k, current?.[k] || (open.kind === 'service' ? '' : '')])));
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const startFromCategory = () => setF(Object.fromEntries(KB_FIELDS.map(([k]) => [k, f[k] || cat.byCat[row.category]?.[k] || ''])));
  const save = () => run(async () => {
    await rpc('save_service_knowledge', { p: { ...(open.kind === 'service' ? { service_id: row.id } : { category: open.category }), ...f } });
    setEditing(false);
  }, 'Product knowledge saved');
  const title = open.kind === 'service' ? `${row.code} · ${row.name}` : `${CAT_LABEL[open.category]} · category default`;

  return (
    <Drawer title={title} onClose={onClose} footer={canEdit && (editing
      ? <><Button onClick={() => setEditing(false)} disabled={busy}>Cancel</Button><Button kind="primary" onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button></>
      : <Button kind="primary" icon="edit" onClick={() => setEditing(true)}>{current ? 'Edit notes' : 'Write notes'}</Button>)}>
      {!editing ? (
        open.kind === 'service' ? <KnowledgeBody row={row} />
          : current ? <KnowledgeBody row={{ price: null, unit: '', delivered: [], kb: current, kbSource: 'own', category: open.category }} />
          : <Empty title="No category notes yet" />
      ) : (
        <div className="col gap-12">
          {open.kind === 'service' && !current && cat.byCat[row.category] && (
            <Button size="sm" kind="ghost" onClick={startFromCategory}>Start from the {CAT_LABEL[row.category]} category notes</Button>
          )}
          {KB_FIELDS.map(([k, label]) => (
            <Field key={k} label={label} hint={k === 'ask_caller' ? 'one question per line' : undefined}>
              <Textarea rows={k === 'summary' ? 2 : 4} value={f[k]} onChange={set(k)} maxLength={4000} />
            </Field>
          ))}
          <div className="tiny muted">No clinical advice in these notes. Hinduja's clinical team reviews the final text.</div>
        </div>
      )}
    </Drawer>
  );
}

function ImportKnowledge({ rows }) {
  const [run, busy] = useAction();
  const toast = useToast();
  const [result, setResult] = useState(null);

  const template = () => {
    const wb = XLSX.utils.book_new();
    const data = rows.filter((r) => r.active).map((r) => [r.code, r.name, r.own?.summary || '', r.own?.who_needs || '', r.own?.ask_caller || '',
      r.own?.includes || '', r.own?.excludes || '', r.own?.prep || '', r.own?.faq || '']);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEAD, ...data]), 'Knowledge');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Column', 'What to enter'],
      ['Service Code', 'Rate-card code. Rows are matched by code only. Import new services through Settings > Rate card first.'],
      ['Summary', 'What the service is, in one or two lines the agent can say on the call.'],
      ['Who needs it', 'Typical patients or situations.'],
      ['Ask the caller', 'Questions to ask before quoting, one per line.'],
      ['Includes / Excludes', 'What the price covers and what is charged separately.'],
      ['Preparation', 'What the family must arrange at home (fasting, space, power, documents).'],
      ['FAQ', 'Common questions with the approved answer.'],
      ['Blank cells', 'Keep what is already saved. No clinical advice.'],
    ]), 'Instructions');
    XLSX.writeFile(wb, 'CareDesk-product-knowledge.xlsx');
  };

  const importFile = (file) => run(async () => {
    setResult(null);
    if (!file) return;
    if (!/\.(xlsx|csv)$/i.test(file.name)) throw new Error('Choose an .xlsx or .csv file');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames.find((n) => /knowledge/i.test(n)) || wb.SheetNames[0]];
    const grid = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    const headAt = grid.findIndex((r) => r.some((c) => KEY_OF[normHead(c)] === 'service_code'));
    if (headAt < 0) throw new Error('No "Service Code" column found. Use the downloaded template.');
    const keys = grid[headAt].map((h) => KEY_OF[normHead(h)] || null);
    const out = grid.slice(headAt + 1).map((r, i) => {
      const o = { row: headAt + i + 2 };
      keys.forEach((k, j) => { if (k) o[k] = String(r[j] ?? '').trim(); });
      return o;
    }).filter((o) => o.service_code);
    if (!out.length) throw new Error('The sheet has no rows with a service code');
    const r = await rpc('import_service_knowledge', { p_rows: out });
    setResult(r);
    toast.ok(`${r.saved} service${r.saved === 1 ? '' : 's'} updated`);
  });

  return (
    <div className="col" style={{ alignItems: 'flex-end', gap: 6 }}>
      <div className="row gap-12">
        <Button size="sm" kind="ghost" icon="download" onClick={template}>Download sheet</Button>
        <label className="btn sm">
          {busy ? 'Importing…' : 'Import sheet'}
          <input type="file" accept=".xlsx,.csv" hidden disabled={busy} onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ''; }} />
        </label>
      </div>
      {result?.skipped?.length > 0 && (
        <div className="tiny muted" style={{ maxWidth: 420, textAlign: 'right' }}>
          Skipped {result.skipped.length}: {result.skipped.slice(0, 5).map((s) => `row ${s.row} ${s.code || ''} (${s.reason})`).join('; ')}{result.skipped.length > 5 ? ' …' : ''}
        </div>
      )}
    </div>
  );
}
