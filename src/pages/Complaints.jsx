// Complaint handling with SLA: acknowledge within 15 minutes, resolve within 48 hours, root cause on record.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, q } from '../lib/db.js';
import { useLoad, useNow } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { ago, dateTime } from '../lib/fmt.js';
import {
  PageHead, Panel, Badge, Button, Tabs, Modal, Field as F, Select, Textarea, Countdown, Empty, TableSkeleton, useAction,
} from '../components/ui.jsx';
import { HBars } from '../components/charts.jsx';
import { CaseLookup } from './Escalations.jsx';

const CATS = [['service', 'Service'], ['behaviour', 'Staff behaviour'], ['billing', 'Billing'], ['report_delay', 'Report delay'], ['other', 'Other']];
const CAT = Object.fromEntries(CATS);
const SEV = { routine: '', high: 'warn', critical: 'danger' };
const ACK_MIN = 15;
const fmtMin = (m) => (m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.round(m / 1440)} d`);
const ackMins = (k) => (k.acknowledged_at ? Math.round((new Date(k.acknowledged_at) - new Date(k.opened_at)) / 60000) : null);

export default function Complaints() {
  const nav = useNavigate();
  const { can, profile } = useAuth();
  const manage = can('supervisor', 'coordinator', 'client_manager');
  const canLog = can('agent', 'coordinator', 'supervisor', 'medical_desk', 'client_manager');
  const now = useNow(30000);
  const [tab, setTab] = useState('open');
  const [modal, setModal] = useState(null);
  const [run, busy] = useAction();

  const { data, loading, error, reload } = useLoad(() => q(db.from('v_complaints').select('*').order('opened_at', { ascending: false }).limit(300)), [], ['complaints']);
  const owners = useLoad(() => (manage ? q(db.from('profiles').select('id,full_name,role').in('role', ['supervisor', 'coordinator']).is('active', true).order('full_name')) : Promise.resolve([])), [manage], []);

  const all = data || [];
  const groups = {
    open: all.filter((k) => k.status === 'open'),
    acknowledged: all.filter((k) => k.status === 'acknowledged'),
    resolved: all.filter((k) => ['resolved', 'closed'].includes(k.status)),
  };
  const rows = groups[tab];
  const stats = useMemo(() => {
    const acked = all.filter((k) => k.acknowledged_at);
    const within = acked.filter((k) => ackMins(k) <= ACK_MIN).length;
    const res = all.filter((k) => k.resolved_at);
    const resWithin = res.filter((k) => (new Date(k.resolved_at) - new Date(k.opened_at)) <= 48 * 3600e3).length;
    const byCat = CATS.map(([c, l]) => ({ c: l, n: all.filter((k) => k.category === c).length })).filter((x) => x.n);
    return { ackPct: acked.length ? Math.round((100 * within) / acked.length) : null, resPct: res.length ? Math.round((100 * resWithin) / res.length) : null, byCat };
  }, [all]);

  const patch = (id, body, msg) => run(async () => { await q(db.from('complaints').update(body).eq('id', id)); setModal(null); reload(); }, msg);
  const caseLink = (k) => (k.case_id ? <a className="mono" href={`/cases/${k.case_id}`} onClick={(e) => { e.preventDefault(); nav(`/cases/${k.case_id}`); }}>{k.case_no}</a> : '–');

  return (
    <>
      <PageHead title="Complaints" sub={<>Acknowledge within {ACK_MIN} minutes · resolve within 48 hours · root cause recorded on every closure</>}>
        {canLog && <Button kind="primary" icon="plus" onClick={() => setModal({ kind: 'log' })}>Log complaint</Button>}
      </PageHead>

      <div className="kpis mb-16">
        <div className="kpi"><div className="l">Open, not acknowledged</div><div className="v" style={{ color: groups.open.length ? 'var(--danger)' : undefined }}>{loading ? '…' : groups.open.length}</div><div className="d">target ≤ 15 min</div></div>
        <div className="kpi"><div className="l">Acknowledged, in progress</div><div className="v">{loading ? '…' : groups.acknowledged.length}</div><div className="d">resolve ≤ 48 h</div></div>
        <div className="kpi"><div className="l">Acknowledged on time</div><div className="v">{stats.ackPct == null ? '–' : `${stats.ackPct}%`}</div><div className="d">all complaints</div></div>
        <div className="kpi"><div className="l">Resolved within 48 h</div><div className="v">{stats.resPct == null ? '–' : `${stats.resPct}%`}</div><div className="d">{groups.resolved.length} resolved</div></div>
      </div>

      <div className="grid g-main-side">
        <div style={{ minWidth: 0 }}>
          <Tabs value={tab} onChange={setTab} tabs={[['open', 'Open', groups.open.length], ['acknowledged', 'Acknowledged', groups.acknowledged.length], ['resolved', 'Resolved', groups.resolved.length]]} />
          {error && <div className="badge danger mb-12">{error}</div>}
          <Panel tight>
            {loading ? <TableSkeleton rows={5} cols={4} /> : rows.length ? rows.map((k) => {
              const am = ackMins(k);
              return (
                <div key={k.id} className="es-row">
                  <div className="col" style={{ gap: 4, minWidth: 0 }}>
                    <div className="row wrap gap-4">
                      <span className="mono small strong">{k.ref_no}</span>
                      <Badge kind="outline">{CAT[k.category] || k.category}</Badge>
                      {k.severity !== 'routine' && <Badge kind={SEV[k.severity]}>{k.severity}</Badge>}
                      {am == null
                        ? <Countdown due={new Date(new Date(k.opened_at).getTime() + ACK_MIN * 60000).toISOString()} label="complaint_ack" />
                        : <Badge kind={am <= ACK_MIN ? 'ok' : 'danger'}>Acknowledged in {fmtMin(am)}</Badge>}
                      {tab !== 'resolved' && k.resolve_due && <Countdown due={k.resolve_due} label="complaint_resolve" />}
                    </div>
                    <div>{k.description}</div>
                    <div className="small muted">{caseLink(k)}{k.patient_name ? ` · ${k.patient_name}` : ''} · opened {ago(k.opened_at, now)} · owner {k.owner_name || <span className="warn-text">unassigned</span>}</div>
                    {tab === 'resolved' && <div className="small"><span className="muted">Resolution: </span>{k.resolution || '–'}<span className="muted"> · root cause: </span>{k.root_cause || '–'}<span className="muted"> · {dateTime(k.resolved_at)}</span></div>}
                  </div>
                  {manage && tab !== 'resolved' && (
                    <div className="es-actions">
                      {k.status === 'open' && <Button size="sm" kind="primary" disabled={busy} onClick={() => patch(k.id, { status: 'acknowledged', owner_id: k.owner_id || profile.id }, `Acknowledged in ${fmtMin(Math.max(0, Math.round((Date.now() - new Date(k.opened_at)) / 60000)))}`)}>Acknowledge</Button>}
                      <Button size="sm" onClick={() => setModal({ kind: 'resolve', k })}>Resolve</Button>
                      <Button size="sm" kind="ghost" onClick={() => setModal({ kind: 'owner', k })}>Assign owner</Button>
                    </div>
                  )}
                </div>
              );
            }) : <Empty title={{ open: 'No unacknowledged complaints', acknowledged: 'Nothing in progress', resolved: 'No resolved complaints yet' }[tab]} />}
          </Panel>
        </div>

        <div className="col gap-12">
          <Panel title="By category" sub="All complaints on record">
            {loading ? <TableSkeleton rows={4} cols={1} /> : stats.byCat.length ? <HBars data={stats.byCat} label="c" value="n" /> : <Empty title="No complaints logged" />}
          </Panel>
          <Panel title="Root causes" sub="From resolved complaints" tight>
            {loading ? <div className="panel-body"><TableSkeleton rows={3} cols={1} /></div> : groups.resolved.length ? groups.resolved.slice(0, 8).map((k) => (
              <div key={k.id} className="list-row">
                <div className="grow">
                  <div className="small">{k.root_cause || 'Not recorded'}</div>
                  <div className="tiny muted">{CAT[k.category]} · {k.ref_no} · fix: {k.resolution || '–'}</div>
                </div>
              </div>
            )) : <Empty title="No resolved complaints yet" />}
          </Panel>
        </div>
      </div>

      {modal?.kind === 'resolve' && <ResolveModal k={modal.k} busy={busy} onClose={() => setModal(null)}
        onSave={(rc, res) => patch(modal.k.id, { status: 'resolved', root_cause: rc, resolution: res, owner_id: modal.k.owner_id || profile.id }, 'Resolved · root cause recorded')} />}
      {modal?.kind === 'owner' && <OwnerModal k={modal.k} owners={owners.data || []} busy={busy} onClose={() => setModal(null)}
        onSave={(id) => patch(modal.k.id, { owner_id: id }, 'Owner updated')} />}
      {modal?.kind === 'log' && <LogModal profile={profile} onClose={() => setModal(null)} onDone={() => { setModal(null); setTab('open'); reload(); }} />}
    </>
  );
}

function ResolveModal({ k, busy, onClose, onSave }) {
  const [rc, setRc] = useState(k.root_cause || '');
  const [res, setRes] = useState(k.resolution || '');
  return (
    <Modal title={`Resolve ${k.ref_no}`} onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" disabled={busy || !rc.trim() || !res.trim()} onClick={() => onSave(rc.trim(), res.trim())}>Resolve</Button>
    </>}>
      <div className="small mb-12">{k.description}</div>
      <div className="col gap-12">
        <F label="Root cause" hint="what actually went wrong"><Textarea value={rc} onChange={(e) => setRc(e.target.value)} rows={2} autoFocus /></F>
        <F label="Resolution" hint="what was done for the patient and to stop a repeat"><Textarea value={res} onChange={(e) => setRes(e.target.value)} rows={3} /></F>
      </div>
    </Modal>
  );
}

function OwnerModal({ k, owners, busy, onClose, onSave }) {
  const [id, setId] = useState(k.owner_id || '');
  return (
    <Modal title={`Owner for ${k.ref_no}`} onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" disabled={busy || !id} onClick={() => onSave(id)}>Save</Button>
    </>}>
      <F label="Owner"><Select value={id} onChange={(e) => setId(e.target.value)} placeholder="Choose owner" options={owners.map((o) => [o.id, `${o.full_name} · ${o.role}`])} /></F>
    </Modal>
  );
}

function LogModal({ profile, onClose, onDone }) {
  const [run, busy] = useAction();
  const [c, setC] = useState(null);
  const [category, setCategory] = useState('service');
  const [severity, setSeverity] = useState('routine');
  const [desc, setDesc] = useState('');
  const submit = () => run(async () => {
    await q(db.from('complaints').insert({ workspace_id: profile.workspace_id, case_id: c.id, patient_id: c.patient_id, category, severity, description: desc.trim(), opened_by: profile.id }));
    onDone();
  }, 'Complaint logged · supervisor notified, 15 minute acknowledgement clock started');
  return (
    <Modal title="Log complaint" onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" disabled={busy || !c || !desc.trim()} onClick={submit}>Log complaint</Button>
    </>}>
      <div className="col gap-12">
        <F label="Case"><CaseLookup value={c} onPick={setC} /></F>
        <div className="form-grid">
          <F label="Category"><Select value={category} onChange={(e) => setCategory(e.target.value)} options={CATS} /></F>
          <F label="Severity" hint="high and critical alert Hinduja management"><Select value={severity} onChange={(e) => setSeverity(e.target.value)} options={[['routine', 'Routine'], ['high', 'High'], ['critical', 'Critical']]} /></F>
        </div>
        <F label="What the patient or family said"><Textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={3} /></F>
      </div>
    </Modal>
  );
}
