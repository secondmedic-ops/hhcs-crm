// Discount and rate-card governance (slide 14). Hinduja management decides; everyone else sees status.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad, useNow } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { ago, dateTime, dateLong, inr, pct } from '../lib/fmt.js';
import { PageHead, Panel, Badge, Button, Tabs, Textarea, Empty, TableSkeleton, Skeleton, useAction } from '../components/ui.jsx';

const GST_LABEL = { incl_gst: 'includes GST', excl_gst: 'GST extra', no_gst: 'no GST charged' };
const KIND = { discount: ['Discount', 'warn'], rate_change: ['Rate change', 'plum'], rate_import: ['Rate import', 'plum'], template: ['Template', 'info'], export: ['Export', 'outline'] };
const STATUS = { approved: 'ok', rejected: 'danger', withdrawn: '', pending: 'warn' };
const FLOW = [
  ['Agent applies discount', 'On the quote, with a reason'],
  ['CRM blocks the quote', 'Anything above the approved band'],
  ['Hinduja decides', 'Approve or reject in this queue'],
  ['Saved to audit', 'Who, when, old and new value'],
  ['Quote released', 'Only an approved quote can be sent'],
];

const mins = (a, b) => (a && b ? Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000)) : null);
const fmtMins = (m) => (m == null ? '–' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} d`);

export default function Approvals() {
  const nav = useNavigate();
  const { can, workspace } = useAuth();
  const decider = can('client_manager');
  const now = useNow(30000);
  const [tab, setTab] = useState('pending');
  const { data, loading, error, reload } = useLoad(() => q(db.from('v_approvals').select('*').order('requested_at', { ascending: false }).limit(300)), [], ['approvals']);

  const all = data || [];
  const pending = all.filter((a) => a.status === 'pending');
  const decided = all.filter((a) => a.status !== 'pending');
  const stats = useMemo(() => {
    const d = decided.filter((a) => a.decided_at);
    const times = d.map((a) => mins(a.requested_at, a.decided_at)).sort((x, y) => x - y);
    return {
      median: times.length ? times[Math.floor(times.length / 2)] : null,
      approved: d.length ? (100 * d.filter((a) => a.status === 'approved').length) / d.length : null,
      oldest: pending.length ? pending[pending.length - 1].requested_at : null,
    };
  }, [decided, pending]);

  const openCase = (id) => (e) => { e.preventDefault(); nav(`/cases/${id}`); };

  return (
    <>
      <PageHead title="Approvals" sub={<>Discounts above the {pct(workspace?.discount_band_pct)} band, rate-card changes and message templates need a Hinduja decision{decider ? '' : ' · view only for your role'}</>} />

      <div className="flow5 mb-16" aria-label="Discount approval flow">
        {FLOW.map(([t, d], i) => (
          <div key={t}>
            <div className="mono tiny faint">{String(i + 1).padStart(2, '0')}</div>
            <div className="strong small">{t}</div>
            <div className="tiny muted">{d}</div>
          </div>
        ))}
      </div>

      <div className="row wrap gap-16 small muted mb-12">
        <span><span className="mono strong" style={{ color: 'var(--ink)' }}>{loading ? '…' : pending.length}</span> waiting</span>
        <span>Oldest waiting <span className="mono">{stats.oldest ? ago(stats.oldest, now) : '–'}</span></span>
        <span>Median decision time <span className="mono">{fmtMins(stats.median)}</span></span>
        <span>Approval rate <span className="mono">{pct(stats.approved)}</span></span>
      </div>

      <Tabs value={tab} onChange={setTab} tabs={[['pending', 'Pending', pending.length], ['decided', 'Decided', decided.length]]} />
      {error && <div className="badge danger mb-12">{error}</div>}

      {tab === 'pending' ? (
        loading ? <div className="col gap-12">{[0, 1].map((i) => <Panel key={i}><Skeleton lines={4} /></Panel>)}</div>
          : pending.length ? <div className="col gap-12">{pending.map((a) => <PendingItem key={a.id} a={a} now={now} decider={decider} onCase={openCase} onDone={reload} />)}</div>
            : <Panel><Empty title="Nothing waiting for a decision">Quotes within the approved band go out without approval.</Empty></Panel>
      ) : (
        <Panel tight>
          {loading ? <TableSkeleton rows={6} cols={7} /> : decided.length ? (
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Kind</th><th>Request</th><th>Case</th><th>Requested by</th><th>Decision</th><th>Decided by</th><th>When</th><th className="num">Took</th><th>Note</th></tr></thead>
              <tbody>{decided.map((a) => (
                <tr key={a.id}>
                  <td><Badge kind={KIND[a.kind]?.[1]}>{KIND[a.kind]?.[0] || a.kind}</Badge></td>
                  <td className="truncate" style={{ maxWidth: 260 }}>{a.title}</td>
                  <td className="mono">{a.case_id ? <a href={`/cases/${a.case_id}`} onClick={openCase(a.case_id)}>{a.case_no}</a> : '–'}</td>
                  <td>{a.requested_by_name || '–'}</td>
                  <td><Badge kind={STATUS[a.status]}>{a.status}</Badge></td>
                  <td>{a.decided_by_name || '–'}</td>
                  <td className="mono nowrap small">{dateTime(a.decided_at)}</td>
                  <td className="num small">{fmtMins(mins(a.requested_at, a.decided_at))}</td>
                  <td className="small muted truncate" style={{ maxWidth: 220 }}>{a.decision_note || '–'}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty title="No decisions yet" />}
        </Panel>
      )}
    </>
  );
}

function PendingItem({ a, now, decider, onCase, onDone }) {
  const [run, busy] = useAction();
  const [note, setNote] = useState('');
  const [k, kk] = KIND[a.kind] || [a.kind, ''];
  const p = a.payload || {};
  const decide = (approve) => run(async () => {
    await rpc('decide_approval', { p_id: a.id, p_approve: approve, p_note: note.trim() || null });
    onDone();
  }, approve ? 'Approved · quote released and logged' : 'Rejected · agent notified');
  return (
    <section className="panel">
      <div className="panel-head">
        <div className="row wrap">
          <Badge kind={kk}>{k}</Badge>
          <h3>{a.title}</h3>
          {a.case_id && <a className="mono small" href={`/cases/${a.case_id}`} onClick={onCase(a.case_id)}>{a.case_no}</a>}
        </div>
        <span className="small muted nowrap">{a.requested_by_name || '–'} · {ago(a.requested_at, now)}</span>
      </div>
      <div className="panel-body">
        <div className="ap-grid">
          <div className="grow">
            {a.kind === 'discount' && (
              <dl className="ap-facts">
                <div><dt>Requested</dt><dd className="mono warn-text">{pct(p.requested_pct, 1)}</dd></div>
                <div><dt>Approved band</dt><dd className="mono">{pct(p.band_pct, 0)}</dd></div>
                <div><dt>Subtotal</dt><dd className="mono">{inr(p.subtotal)}</dd></div>
                <div><dt>Discount</dt><dd className="mono">{inr(p.discount_amount)}</dd></div>
                <div><dt>Patient pays</dt><dd className="mono">{p.subtotal != null ? inr(Number(p.subtotal) - Number(p.discount_amount || 0)) : '–'}</dd></div>
              </dl>
            )}
            {a.kind === 'rate_change' && (
              <dl className="ap-facts">
                <div><dt>Current price</dt><dd className="mono">{inr(p.old_price)}</dd></div>
                <div><dt>New price</dt><dd className="mono strong">{inr(p.new_price)}</dd></div>
                <div><dt>Change</dt><dd className="mono">{p.old_price ? pct((100 * (Number(p.new_price) - Number(p.old_price))) / Number(p.old_price), 1) : '–'}</dd></div>
              </dl>
            )}
            {a.kind === 'rate_import' && (
              <>
                <div className="tiny muted mb-8">{p.count} selling price change(s){p.file_name ? ` from ${p.file_name}` : ''} · GST basis: {GST_LABEL[p.tax_basis] || p.tax_basis || 'unchanged'} · approved together; prices apply from their date</div>
                <div className="table-wrap"><table className="t compact">
                  <thead><tr><th>Service</th><th>Unit</th><th className="num">Current</th><th className="num">New</th><th className="num">Change</th><th>From</th></tr></thead>
                  <tbody>{(p.changes || []).map((x) => (
                    <tr key={x.service_id}>
                      <td><span className="mono small">{x.code}</span> {x.name}{x.new_service && <> <Badge kind="info">New service</Badge></>}</td>
                      <td className="small nowrap">per {x.unit}</td>
                      <td className="num">{Number(x.old_price) > 0 ? inr(x.old_price) : <span className="faint">not priced</span>}</td>
                      <td className="num strong">{inr(x.new_price)}</td>
                      <td className="num small">{Number(x.old_price) > 0 ? pct((100 * (Number(x.new_price) - Number(x.old_price))) / Number(x.old_price), 1) : '–'}</td>
                      <td className="small nowrap">{x.effective_from ? dateLong(`${x.effective_from}T00:00:00+05:30`) : '–'}</td>
                    </tr>
                  ))}</tbody>
                </table></div>
              </>
            )}
            {a.kind === 'template' && (
              <>
                <div className="tiny muted mb-8">Channel: {p.kind || '–'} · the approved version goes live for every agent once you approve</div>
                <div className="ap-body">{p.body || 'No preview available'}</div>
              </>
            )}
            {a.kind === 'export' && (
              <dl className="ap-facts">{Object.entries(p).map(([key, v]) => <div key={key}><dt>{key.replace(/_/g, ' ')}</dt><dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></div>)}</dl>
            )}
            {p.reason && <div className="small mt-12"><span className="muted">Reason given: </span>{p.reason}</div>}
          </div>
          <div className="ap-decide">
            {decider ? (
              <>
                <Textarea placeholder="Note for the audit trail (required to reject)" value={note} onChange={(e) => setNote(e.target.value)} rows={2} />
                <div className="row mt-8">
                  <Button kind="primary" icon="check" disabled={busy} onClick={() => decide(true)}>Approve</Button>
                  <Button icon="x" disabled={busy || !note.trim()} onClick={() => decide(false)}>Reject</Button>
                </div>
              </>
            ) : (
              <div className="small muted"><Badge kind="warn" dot>Waiting for Hinduja approver</Badge><div className="mt-8">The quote stays blocked until Hinduja management decides. Every decision is logged.</div></div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
