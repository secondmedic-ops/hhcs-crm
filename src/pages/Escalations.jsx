// Three-level escalation matrix (slide 13): who is called, how fast, and what happened.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, q } from '../lib/db.js';
import { useLoad, useNow, useDebounced } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { ago, time, dateTime } from '../lib/fmt.js';
import {
  PageHead, Panel, Badge, Button, Modal, Field as F, Input, Select, Textarea, Segmented, Countdown, Empty, TableSkeleton, Skeleton, Confirm, useAction,
} from '../components/ui.jsx';

const TYPES = ['clinical', 'emergency', 'delay', 'complaint', 'privacy', 'sla'];
const TYPE_LABEL = { clinical: 'Clinical', emergency: 'Emergency', delay: 'Field delay', complaint: 'Complaint', privacy: 'Privacy', sla: 'SLA breach' };
const typeKind = (t) => (['clinical', 'emergency'].includes(t) ? 'danger' : t === 'privacy' ? 'plum' : 'warn');
const ACTORS = ['supervisor', 'coordinator', 'medical_desk', 'client_manager', 'client_clinical'];
const fmtTarget = (m) => (m == null ? 'per DPA' : m === 0 ? 'Immediate' : m < 120 ? `${m} min` : m < 1440 ? `${m / 60} h` : `${m / 1440} d`);

export default function Escalations() {
  const nav = useNavigate();
  const { can, profile } = useAuth();
  const actor = can(...ACTORS);
  const now = useNow(30000);
  const [status, setStatus] = useState('open');
  const [type, setType] = useState('');
  const [modal, setModal] = useState(null); // {kind, e}
  const [run, busy] = useAction();

  const matrix = useLoad(() => q(db.from('escalation_matrix').select('*').order('type').order('level')), [], []);
  const list = useLoad(() => {
    let x = db.from('v_escalations').select('*').order('raised_at', { ascending: false }).limit(300);
    if (status !== 'all') x = x.eq('status', status);
    if (type) x = x.eq('type', type);
    return q(x);
  }, [status, type], ['escalations']);
  const counts = useLoad(async () => {
    const rows = await q(db.from('escalations').select('status,type').neq('status', 'resolved'));
    return { open: rows.filter((r) => r.status === 'open').length, acknowledged: rows.filter((r) => r.status === 'acknowledged').length, clinical: rows.filter((r) => ['clinical', 'emergency'].includes(r.type)).length };
  }, [], ['escalations']);

  const mx = useMemo(() => {
    const m = {};
    (matrix.data || []).forEach((r) => { m[`${r.type}:${r.level}`] = r; });
    return m;
  }, [matrix.data]);
  const matrixTypes = [...new Set((matrix.data || []).map((r) => r.type))].sort((a, b) => TYPES.indexOf(a) - TYPES.indexOf(b));

  const patch = (id, body, msg) => run(async () => { await q(db.from('escalations').update(body).eq('id', id)); setModal(null); list.reload(); }, msg);
  const escalate = (e) => patch(e.id, { level: Math.min(3, e.level + 1), status: 'open' }, `Escalated to L${Math.min(3, e.level + 1)} · ${mx[`${e.type}:${Math.min(3, e.level + 1)}`]?.owner_label || 'next owner'}`);

  return (
    <>
      <PageHead title="Escalations" sub="Three levels per type, each with an owner and a response target. Unanswered escalations move up automatically.">
        {actor && <Button kind="primary" icon="flag" onClick={() => setModal({ kind: 'raise' })}>Raise escalation</Button>}
      </PageHead>

      <div className="guard mb-16">
        <strong>Guardrail.</strong> Agents never give clinical advice beyond approved scripts. Any symptom, critical value or emergency is escalated to the SecondMedic medical desk and Hinduja clinical at once; in an emergency the family is told to call 108 first.
      </div>

      <Panel title="Escalation matrix" sub="Owner, named contact and response target by level" tight className="mb-16">
        {matrix.loading ? <TableSkeleton rows={5} cols={4} /> : matrixTypes.length ? (
          <div className="table-wrap"><table className="t es-matrix">
            <thead><tr><th>Type</th><th>Level 1</th><th>Level 2</th><th>Level 3</th></tr></thead>
            <tbody>{matrixTypes.map((t) => (
              <tr key={t}>
                <td><Badge kind={typeKind(t)}>{TYPE_LABEL[t] || t}</Badge></td>
                {[1, 2, 3].map((l) => {
                  const r = mx[`${t}:${l}`];
                  return (
                    <td key={l}>
                      {r ? <>
                        <div className="small">{r.owner_label}</div>
                        <div className="tiny muted">{r.contact_name || 'Contact to be named'} · <span className="mono">{fmtTarget(r.target_minutes)}</span></div>
                      </> : <span className="faint">–</span>}
                    </td>
                  );
                })}
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No matrix configured">Set owners and targets in Settings.</Empty>}
      </Panel>

      <div className="row wrap between mb-12">
        <Segmented value={status} onChange={setStatus} options={[
          ['open', `Open${counts.data ? ` · ${counts.data.open}` : ''}`], ['acknowledged', `Acknowledged${counts.data ? ` · ${counts.data.acknowledged}` : ''}`], ['resolved', 'Resolved'], ['all', 'All']]} />
        <div style={{ width: 180 }}><Select value={type} onChange={(e) => setType(e.target.value)} placeholder="All types" options={TYPES.map((t) => [t, TYPE_LABEL[t]])} /></div>
      </div>

      <Panel tight>
        {list.loading ? <div className="panel-body"><Skeleton lines={6} /></div> : list.data?.length ? list.data.map((e) => {
          const target = mx[`${e.type}:${e.level}`]?.target_minutes;
          const due = target && e.status === 'open' ? new Date(new Date(e.raised_at).getTime() + target * 60000 * e.level).toISOString() : null;
          return (
            <div key={e.id} className="es-row">
              <div className="col" style={{ gap: 4, minWidth: 0 }}>
                <div className="row wrap gap-4">
                  <Badge kind={typeKind(e.type)}>{TYPE_LABEL[e.type] || e.type}</Badge>
                  <Badge kind="solid">L{e.level}</Badge>
                  <Badge kind={e.status === 'resolved' ? 'ok' : e.status === 'acknowledged' ? 'info' : 'outline'}>{e.status}</Badge>
                  {e.auto_raised && <Badge kind="outline">Auto-raised</Badge>}
                  {due && <Countdown due={due} compact />}{target === 0 && e.status === 'open' && <Badge kind="danger">Immediate</Badge>}
                </div>
                <div className="strong">{e.trigger_text}</div>
                <div className="small muted">
                  {e.case_id ? <a className="mono" href={`/cases/${e.case_id}`} onClick={(ev) => { ev.preventDefault(); nav(`/cases/${e.case_id}`); }}>{e.case_no}</a> : 'No case'}
                  {e.patient_name ? ` · ${e.patient_name}` : ''} · raised by {e.raised_by_name || 'SLA engine'} · {ago(e.raised_at, now)}
                </div>
                <div className="small">
                  <span className="muted">{e.status === 'resolved' ? 'Owner at close: ' : 'Owner now: '}</span>{mx[`${e.type}:${e.level}`]?.owner_label || '–'}
                  {e.contacted_name && <><span className="muted"> · contacted </span>{e.contacted_name}<span className="muted"> at </span><span className="mono">{time(e.contacted_at)}</span></>}
                </div>
                {e.outcome && <div className="small"><span className="muted">Outcome: </span>{e.outcome}{e.resolved_at && <span className="muted"> · resolved {dateTime(e.resolved_at)}</span>}</div>}
              </div>
              {actor && e.status !== 'resolved' && (
                <div className="es-actions">
                  {e.status === 'open' && <Button size="sm" onClick={() => setModal({ kind: 'ack', e })}>Acknowledge</Button>}
                  {e.level < 3 && <Button size="sm" onClick={() => setModal({ kind: 'up', e })}>Escalate to L{e.level + 1}</Button>}
                  <Button size="sm" kind="primary" onClick={() => setModal({ kind: 'resolve', e })}>Resolve</Button>
                </div>
              )}
            </div>
          );
        }) : <Empty title={status === 'open' ? 'No open escalations' : 'Nothing in this view'}>Escalations raised by staff or the SLA engine appear here instantly.</Empty>}
      </Panel>

      {modal?.kind === 'ack' && <AckModal e={modal.e} m={mx[`${modal.e.type}:${modal.e.level}`]} busy={busy} onClose={() => setModal(null)}
        onSave={(name) => patch(modal.e.id, { status: 'acknowledged', acknowledged_by: profile.id, acknowledged_at: new Date().toISOString(), contacted_name: name, contacted_at: new Date().toISOString() }, 'Acknowledged · contact logged')} />}
      {modal?.kind === 'up' && (
        <Confirm title={`Escalate to level ${modal.e.level + 1}`} confirmLabel="Escalate" busy={busy} onClose={() => setModal(null)} onConfirm={() => escalate(modal.e)}>
          <div className="small">Next owner: <strong>{mx[`${modal.e.type}:${modal.e.level + 1}`]?.owner_label || 'not configured'}</strong>
            {mx[`${modal.e.type}:${modal.e.level + 1}`]?.target_minutes != null && <> · respond within {fmtTarget(mx[`${modal.e.type}:${modal.e.level + 1}`].target_minutes)}</>}</div>
          <div className="small muted mt-8">{modal.e.trigger_text}</div>
        </Confirm>
      )}
      {modal?.kind === 'resolve' && (
        <Confirm title="Resolve escalation" confirmLabel="Resolve" needReason reasonLabel="Outcome (what was done, who confirmed)" busy={busy} onClose={() => setModal(null)}
          onConfirm={(outcome) => patch(modal.e.id, { status: 'resolved', resolved_at: new Date().toISOString(), outcome, ...(modal.e.acknowledged_at ? {} : { acknowledged_by: profile.id, acknowledged_at: new Date().toISOString() }) }, 'Resolved and logged')}>
          <div className="small">{modal.e.trigger_text}</div>
        </Confirm>
      )}
      {modal?.kind === 'raise' && <RaiseModal profile={profile} matrix={mx} onClose={() => setModal(null)} onDone={() => { setModal(null); list.reload(); }} />}
    </>
  );
}

function AckModal({ e, m, busy, onClose, onSave }) {
  const [name, setName] = useState(e.contacted_name || m?.contact_name || m?.owner_label || '');
  return (
    <Modal title="Acknowledge escalation" onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" disabled={busy || !name.trim()} onClick={() => onSave(name.trim())}>Acknowledge</Button>
    </>}>
      <div className="small mb-12">{e.trigger_text}</div>
      <F label="Who was contacted" hint={`L${e.level} owner: ${m?.owner_label || 'not set'}`}><Input value={name} onChange={(ev) => setName(ev.target.value)} autoFocus /></F>
      <div className="tiny muted mt-8">Contact time is stamped now and kept in the audit trail.</div>
    </Modal>
  );
}

// Case lookup by case number (also used by Complaints)
export function CaseLookup({ value, onPick }) {
  const [text, setText] = useState(value?.case_no || '');
  const t = useDebounced(text.trim().replace(/[,.()*]/g, ''), 250);
  const res = useLoad(() => (t.length < 3 || t === value?.case_no ? Promise.resolve([])
    : q(db.from('v_cases').select('id,case_no,patient_id,patient_name,stage,zone_name').or(`case_no.ilike.*${t}*,patient_name.ilike.*${t}*`).order('created_at', { ascending: false }).limit(6))), [t], []);
  return (
    <div className="col gap-4">
      <Input value={text} onChange={(e) => { setText(e.target.value); if (value) onPick(null); }} placeholder="Case number or patient name, e.g. 00125" className="mono" autoFocus />
      {value ? <div className="small ok-text">{value.case_no} · {value.patient_name} · {value.stage}</div>
        : res.loading && t.length >= 3 ? <Skeleton lines={2} />
          : (res.data || []).length > 0 && (
            <div className="panel">{res.data.map((c) => (
              <button key={c.id} type="button" className="list-row click" style={{ width: '100%', background: 'none', border: 0, borderBottom: '1px solid var(--line-2)', font: 'inherit', textAlign: 'left' }}
                onClick={() => { setText(c.case_no); onPick(c); }}>
                <span className="mono small">{c.case_no}</span><span className="grow small truncate">{c.patient_name}</span><span className="tiny muted">{c.zone_name || ''}</span>
              </button>
            ))}</div>
          )}
      {!value && t.length >= 3 && !res.loading && !(res.data || []).length && <div className="tiny muted">No matching case</div>}
    </div>
  );
}

function RaiseModal({ profile, matrix, onClose, onDone }) {
  const [run, busy] = useAction();
  const [c, setC] = useState(null);
  const [type, setType] = useState('clinical');
  const [level, setLevel] = useState('1');
  const [text, setText] = useState('');
  const owner = matrix[`${type}:${level}`];
  const submit = () => run(async () => {
    await q(db.from('escalations').insert({ workspace_id: profile.workspace_id, case_id: c?.id || null, type, level: Number(level), trigger_text: text.trim(), raised_by: profile.id }));
    onDone();
  }, 'Escalation raised · owners notified');
  return (
    <Modal title="Raise escalation" onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" disabled={busy || !text.trim() || (type !== 'privacy' && !c)} onClick={submit}>Raise</Button>
    </>}>
      <div className="col gap-12">
        <F label="Case" hint={type === 'privacy' ? 'optional for privacy incidents' : 'required'}><CaseLookup value={c} onPick={setC} /></F>
        <div className="form-grid">
          <F label="Type"><Select value={type} onChange={(e) => setType(e.target.value)} options={TYPES.filter((t) => t !== 'sla').map((t) => [t, TYPE_LABEL[t]])} /></F>
          <F label="Level"><Select value={level} onChange={(e) => setLevel(e.target.value)} options={[['1', 'L1'], ['2', 'L2'], ['3', 'L3']]} /></F>
        </div>
        <div className="small muted">Goes to: <span className="strong" style={{ color: 'var(--ink)' }}>{owner?.owner_label || 'not configured'}</span>{owner ? ` · respond ${fmtTarget(owner.target_minutes).toLowerCase()}` : ''}</div>
        <F label="What triggered it" hint="facts only, no clinical advice"><Textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} /></F>
        {type === 'emergency' && <div className="small danger-text">If the patient is at risk now, the family must call 108 first.</div>}
      </div>
    </Modal>
  );
}
