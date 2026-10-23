// Dispatch board (slide 16): dedicated field teams tracked live from assignment to check-out, with backup.
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad, useNow } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { ago, time, date, dateLong, istDayRange, toLocalInput, fromLocalInput } from '../lib/fmt.js';
import {
  PageHead, Panel, Kpi, Badge, Button, Modal, Field as F, Select, Input, Empty, TableSkeleton, Skeleton, Avatar, useAction,
} from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import StaffMap from '../components/StaffMap.jsx';

const ACTIVE = ['assigned', 'en_route', 'checked_in'];
const TASK_FOR = { lab: 'phlebotomy', ecg: 'ecg', xray: 'xray' };
const TASK_LABEL = { phlebotomy: 'Sample collection', ecg: 'ECG', xray: 'Portable X-ray', visit: 'Visit' };
const STATUS = {
  assigned: ['Assigned', 'info'], en_route: ['En route', 'warn'], checked_in: ['On site', 'accent'],
  completed: ['Completed', 'ok'], cancelled: ['Cancelled', ''], reassigned: ['Reassigned', ''],
};
const DOT = { assigned: 'var(--info)', en_route: 'var(--warn)', checked_in: 'var(--accent)', completed: 'var(--ok)', late: 'var(--danger)' };
const GRACE = 15 * 60000;
const ms = (d) => new Date(d).getTime();
const slotLabel = (d) => (!d ? '–' : date(d) === date(Date.now()) ? time(d) : `${date(d)} ${time(d)}`);

export const isLate = (a, now = Date.now()) => {
  if (!a.booked_slot) return false;
  const due = new Date(a.booked_slot).getTime() + GRACE;
  if (a.checkin_at) return new Date(a.checkin_at).getTime() > due;
  return ['assigned', 'en_route'].includes(a.status) && now > due;
};

export function StatusBadge({ status, late }) {
  const [l, k] = STATUS[status] || [status, ''];
  return <>{<Badge kind={k}>{l}</Badge>}{late && <> <Badge kind="danger">Late</Badge></>}</>;
}

const neededTasks = (cats) => [...new Set(String(cats || '').split(',').map((c) => TASK_FOR[c.trim()]).filter(Boolean))];

export default function Field() {
  const nav = useNavigate();
  const { can } = useAuth();
  const canAssign = can('coordinator', 'supervisor');
  const now = useNow(30000);
  const [from, to] = istDayRange(0);
  const [assignFor, setAssignFor] = useState(null);
  const [backupFor, setBackupFor] = useState(null);
  const live = ['assignments', 'cases', 'escalations', 'staff_locations'];

  const board = useLoad(async () => {
    const cols = 'id,visit_id,case_id,order_id,staff_id,staff_name,task,status,role,assignment_role,eta,checkin_at,actual_arrival_at,eta_vs_ata_variance_min,checkin_distance_m,checkout_at,delay_reason,backup_for,backup_staff_name,backup_status,backup_eta,case_no,booked_slot,priority,stage,order_status,patient_name,zone_name,patient_lat,patient_lng,service_names,pincode,latest_log_text';
    const [today, active] = await Promise.all([
      q(db.from('v_assignments').select(cols).gte('booked_slot', from).lt('booked_slot', to).limit(400)),
      q(db.from('v_assignments').select(cols).in('status', ACTIVE).limit(400)),
    ]);
    const map = new Map();
    [...today, ...active].forEach((a) => {
      const vid = a.visit_id || a.id;
      if (!map.has(vid)) map.set(vid, a);
    });
    return [...map.values()].filter((a) => !['cancelled', 'reassigned'].includes(a.status))
      .sort((a, b) => new Date(a.booked_slot || 0) - new Date(b.booked_slot || 0));
  }, [from], live);

  const staff = useLoad(() => q(db.from('profiles').select('id,full_name,skills,on_duty,phone,active').eq('role', 'field_staff').is('active', true).order('full_name')), [], []);

  const needs = useLoad(async () => {
    const cases = await q(db.from('v_cases').select('id,case_no,patient_name,patient_age,patient_gender,zone_name,booked_slot,priority,stage,order_status,service_names,service_categories,pincode')
      .in('stage', ['booking', 'deployment']).not('booking_confirmed_at', 'is', null).order('booked_slot', { ascending: true }).limit(200));
    if (!cases.length) return [];
    const asg = await q(db.from('v_assignments').select('id,visit_id,case_id,task,status,role,assignment_role').in('case_id', cases.map((c) => c.id)).not('status', 'in', '(cancelled,reassigned)'));
    return cases.map((c) => {
      const activeAsg = asg.filter((a) => a.case_id === c.id);
      const have = new Set(activeAsg.map((a) => a.task));
      const req = neededTasks(c.service_categories);
      const missing = req.length ? req.filter((t) => !have.has(t)) : (have.size ? [] : ['visit']);
      const hasActive = activeAsg.some((a) => (a.role || a.assignment_role) === 'primary' || (!a.role && !a.assignment_role));
      return { ...c, missing, hasActive };
    }).filter((c) => c.missing.length && c.order_status !== 'assigned');
  }, [], live);

  const delays = useLoad(() => q(db.from('v_escalations').select('id,case_id,case_no,patient_name,level,trigger_text,raised_at,status,contacted_name,auto_raised')
    .eq('type', 'delay').neq('status', 'resolved').order('raised_at', { ascending: false }).limit(20)), [], live);

  const locs = useLoad(() => q(db.from('v_staff_locations').select('*')), [], ['staff_locations']);
  const locByStaff = useMemo(() => Object.fromEntries((locs.data || []).map((l) => [l.staff_id, l])), [locs.data]);

  const rows = board.data || [];
  const load = useMemo(() => {
    const m = {};
    rows.forEach((a) => { m[a.staff_id] = (m[a.staff_id] || 0) + 1; });
    return m;
  }, [rows]);
  const k = useMemo(() => ({
    scheduled: rows.filter((a) => a.booked_slot && ms(a.booked_slot) >= ms(from) && ms(a.booked_slot) < ms(to)).length,
    en_route: rows.filter((a) => a.status === 'en_route').length,
    on_site: rows.filter((a) => a.status === 'checked_in').length,
    completed: rows.filter((a) => a.status === 'completed').length,
    late: rows.filter((a) => isLate(a, now)).length,
  }), [rows, now, from, to]);

  const byStaff = useMemo(() => {
    const list = (staff.data || []).map((s) => {
      const staffRows = rows.filter((a) => a.staff_id === s.id);
      const visitMap = new Map();
      staffRows.forEach((a) => {
        const vid = a.visit_id || a.id;
        if (!visitMap.has(vid)) visitMap.set(vid, a);
      });
      const visits = [...visitMap.values()];
      return { ...s, visits };
    });
    return list.sort((a, b) => b.visits.length - a.visits.length || a.full_name.localeCompare(b.full_name));
  }, [staff.data, rows]);

  const loaded = !board.loading && !staff.loading;

  return (
    <>
      <PageHead title="Dispatch board" sub={<>{dateLong(now)} · dedicated field teams, live from assignment to check-out · slot grace 15 min</>}>
        <Button icon="refresh" size="sm" onClick={() => { board.reload(); needs.reload(); delays.reload(); }}>Refresh</Button>
      </PageHead>
      {(board.error || staff.error) && <div className="badge danger mb-12">{board.error || staff.error}</div>}

      <div className="kpis">
        <Kpi label="Visits today" value={loaded ? k.scheduled : null} detail="slots booked for today" />
        <Kpi label="En route" value={loaded ? k.en_route : null} detail="travelling with ETA" tone={k.en_route ? 'warn' : ''} />
        <Kpi label="On site" value={loaded ? k.on_site : null} detail="geo-tagged check-in" />
        <Kpi label="Completed" value={loaded ? k.completed : null} detail="with patient sign-off" tone="ok" />
        <Kpi label="Late" value={loaded ? k.late : null} detail="past slot + 15 min" tone={k.late ? 'danger' : 'ok'} />
        <Kpi label="Unassigned" value={needs.data ? needs.data.length : null} detail="booked, no technician" tone={needs.data?.length ? 'warn' : 'ok'} />
      </div>

      <div className="grid g-main-side mt-16">
        <div className="col gap-12">
          <Panel title="Needs assignment" sub="Booking confirmed, no active technician for a required task" tight
            actions={needs.data?.length ? <Badge kind="warn">{needs.data.length}</Badge> : null}>
            {needs.loading ? <div className="panel-body"><TableSkeleton rows={3} cols={5} /></div> : needs.data?.length ? (
              <div className="table-wrap"><table className="t">
                <thead><tr><th>Case</th><th>Patient</th><th>Zone</th><th>Slot</th><th>Needs</th><th /></tr></thead>
                <tbody>{needs.data.map((c) => (
                  <tr key={c.id}>
                    <td className="mono"><a href={`/cases/${c.id}`} onClick={(e) => { e.preventDefault(); nav(`/cases/${c.id}`); }}>{c.case_no}</a>{c.priority === 'urgent' && <> <Badge kind="danger">Urgent</Badge></>}</td>
                    <td className="truncate" style={{ maxWidth: 170 }}>{c.patient_name}<div className="tiny muted truncate">{c.service_names || '–'}</div></td>
                    <td className="nowrap">{c.zone_name || '–'}<div className="tiny faint mono">{c.pincode}</div></td>
                    <td className="mono nowrap">{slotLabel(c.booked_slot)}<div className="tiny faint">{c.booked_slot ? ago(c.booked_slot, now) : ''}</div></td>
                    <td><div className="row wrap gap-4">{c.missing.map((t) => <Badge key={t} kind="outline">{TASK_LABEL[t]}</Badge>)}</div></td>
                    <td className="right">{canAssign ? (
                      <Button size="sm" kind={c.hasActive ? 'outline' : 'primary'} icon={c.hasActive ? 'swap' : 'plus'} onClick={() => setAssignFor(c)}>
                        {c.hasActive ? 'Reassign' : 'Assign'}
                      </Button>
                    ) : <span className="tiny muted">Coordinator</span>}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            ) : <Empty title="Every confirmed booking has a technician">New bookings appear here the moment the slot is confirmed.</Empty>}
          </Panel>

          <Panel title="Field teams" sub="Today's visits by technician, earliest slot first" tight>
            {!loaded ? <div className="panel-body"><Skeleton lines={8} /></div> : byStaff.length ? byStaff.map((s) => (
              <div key={s.id} className="fd-staff">
                <div className="row between wrap">
                  <div className="row">
                    <Avatar name={s.full_name} />
                    <div className="col" style={{ gap: 0 }}>
                      <span className="strong">{s.full_name}</span>
                      <span className="tiny muted">{(s.skills || []).map((x) => TASK_LABEL[x] || x).join(' · ') || 'No skills set'}</span>
                    </div>
                  </div>
                  <div className="row small muted">
                    <span className="mono">{s.visits.length}</span> today
                    {s.visits.some((a) => isLate(a, now)) && <Badge kind="danger">Running late</Badge>}
                  </div>
                </div>
                {s.visits.length ? (
                  <div className="fd-cards">
                    {s.visits.map((a) => <VisitCard key={a.id} a={a} now={now} loc={locByStaff[s.id]} canAssign={canAssign} onBackup={() => setBackupFor(a)} onOpen={() => nav(`/cases/${a.case_id}`)} />)}
                  </div>
                ) : <div className="tiny faint mt-8">No visits today · available for assignment</div>}
              </div>
            )) : <Empty title="No field staff set up">Add field staff with skills in Settings.</Empty>}
          </Panel>
        </div>

        <div className="col gap-12">
          <Panel
            title="Zone map"
            sub="Today's visits across MMR with live field staff GPS locations"
            tight
            actions={<Badge kind="ok">Live GPS</Badge>}
          >
            {!loaded ? (
              <Skeleton height={380} />
            ) : (
              <StaffMap
                staffLocations={locs.data || []}
                visits={rows}
                now={now}
                onOpenCase={(id) => nav(`/cases/${id}`)}
                height={380}
              />
            )}
          </Panel>
          <Panel title="Delay alerts" sub="Open delay escalations" tight
            actions={<a href="/escalations" className="small" onClick={(e) => { e.preventDefault(); nav('/escalations'); }}>All escalations</a>}>
            {delays.loading ? <div className="panel-body"><TableSkeleton rows={3} cols={1} /></div> : delays.data?.length ? delays.data.map((e) => (
              <div key={e.id} className="list-row click" onClick={() => nav(e.case_id ? `/cases/${e.case_id}` : '/escalations')}>
                <Badge kind="warn">L{e.level}</Badge>
                <div className="grow">
                  <div className="small">{e.trigger_text}</div>
                  <div className="tiny muted">{e.case_no || '–'}{e.patient_name ? ` · ${e.patient_name}` : ''} · {ago(e.raised_at, now)}{e.contacted_name ? ` · contacted ${e.contacted_name}` : ' · not yet contacted'}</div>
                </div>
                {e.auto_raised && <Badge kind="outline">Auto</Badge>}
              </div>
            )) : <Empty title="No open delays" />}
          </Panel>
        </div>
      </div>

      {assignFor && <AssignModal c={assignFor} staff={staff.data || []} load={load} onClose={() => setAssignFor(null)} onDone={() => { setAssignFor(null); board.reload(); needs.reload(); }} />}
      {backupFor && <AssignModal backup={backupFor} staff={staff.data || []} load={load} onClose={() => setBackupFor(null)} onDone={() => { setBackupFor(null); board.reload(); needs.reload(); }} />}
    </>
  );
}

function VisitCard({ a, now, loc, canAssign, onBackup, onOpen }) {
  const late = isLate(a, now);
  const ata = a.actual_arrival_at || a.checkin_at;
  const dist = a.checkin_distance_m;
  const liveDist = a.status === 'en_route' && loc?.distance_to_patient_m != null ? loc.distance_to_patient_m : null;
  const isBackup = a.role === 'backup' || a.assignment_role === 'backup' || !!a.backup_for;
  return (
    <div className={`fd-card ${late ? 'late' : ''} ${a.status === 'completed' ? 'done' : ''}`}>
      <div className="row between wrap gap-4">
        <span className="mono strong nowrap">{a.case_no}</span>
        <span className="row gap-4">
          <StatusBadge status={a.status} late={late} />
          {isBackup && <Badge kind="outline">Backup</Badge>}
          {a.backup_staff_name && <Badge kind="warn">Backup: {a.backup_staff_name}</Badge>}
          {liveDist != null && <Badge kind="warn">{liveDist}m away</Badge>}
        </span>
      </div>
      <div className="truncate">{a.patient_name}{a.priority === 'urgent' && <span className="danger-text"> · urgent</span>}</div>
      <div className="tiny muted">{a.zone_name || '–'} · {TASK_LABEL[a.task]}</div>
      <div className="fd-times">
        <span><span className="faint">Slot</span> <span className="mono">{slotLabel(a.booked_slot)}</span></span>
        <span><span className="faint">ETA</span> <span className="mono">{time(a.eta)}</span></span>
        <span><span className="faint">ATA</span> <span className="mono">{ata ? time(ata) : '–'}</span></span>
        {a.eta_vs_ata_variance_min != null && <span className={Math.abs(a.eta_vs_ata_variance_min) > 15 ? 'warn-text' : 'muted'}><span className="mono">{a.eta_vs_ata_variance_min > 0 ? `+${a.eta_vs_ata_variance_min}` : a.eta_vs_ata_variance_min}m</span> <span className="faint">var</span></span>}
        {dist != null && (
          <Badge kind={dist <= 200 ? 'ok' : 'warn'}>
            {dist <= 200 ? `Checked in within ${dist}m of pin` : `Off-site check-in (${dist}m)`}
          </Badge>
        )}
      </div>
      {a.delay_reason && <div className="tiny warn-text">Delay: {a.delay_reason}</div>}
      <div className="row mt-4 wrap gap-6">
        {canAssign && ['assigned', 'en_route'].includes(a.status) && !isBackup && <Button size="xs" icon="swap" onClick={onBackup}>Backup</Button>}
        <Button size="xs" kind="ghost" onClick={onOpen}>Open case</Button>
        {loc?.lat != null && loc?.lng != null && (
          <a className="btn xs ghost" href={`https://www.google.com/maps?q=${loc.lat},${loc.lng}`} target="_blank" rel="noreferrer" title="Open staff live GPS in Google Maps" style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
            <Icon name="pin" /> Staff on map
          </a>
        )}
      </div>
    </div>
  );
}

function AssignModal({ c, backup, staff, load, onClose, onDone }) {
  const [run, busy] = useAction();
  const slot = backup ? backup.booked_slot : c.booked_slot;
  const tasks = backup ? [backup.task] : (c.missing?.length ? c.missing : ['visit']);
  const [task, setTask] = useState(tasks[0] || 'visit');
  const eligible = staff.filter((s) => (task === 'visit' || (s.skills || []).includes(task)) && (!backup || s.id !== backup.staff_id))
    .sort((a, b) => (load[a.id] || 0) - (load[b.id] || 0));
  const [who, setWho] = useState('');
  const pickDefault = who || eligible[0]?.id || '';
  const base = slot ? new Date(slot).getTime() - 10 * 60000 : Date.now() + 45 * 60000;
  const [eta, setEta] = useState(toLocalInput(new Date(Math.max(base, Date.now() + 20 * 60000))));
  const submit = () => run(async () => {
    await rpc('assign_staff', { p_case: backup ? backup.case_id : c.id, p_staff: pickDefault, p_task: task, p_eta: fromLocalInput(eta), p_backup_for: backup ? backup.id : null });
    onDone();
  }, backup ? 'Backup technician assigned' : (c?.hasActive ? 'Technician reassigned and notified' : 'Technician assigned and notified'));
  const head = backup || c;
  const isReassign = !backup && !!c?.hasActive;
  return (
    <Modal title={backup ? `Assign backup · ${backup.case_no}` : isReassign ? `Reassign technician · ${c.case_no}` : `Assign technician · ${c.case_no}`} onClose={onClose} footer={<>
      <Button onClick={onClose} disabled={busy}>Cancel</Button>
      <Button kind="primary" disabled={busy || !pickDefault} onClick={submit}>{backup ? 'Assign backup' : isReassign ? 'Reassign' : 'Assign'}</Button>
    </>}>
      <dl className="kv mb-16">
        <dt>Patient</dt><dd>{head.patient_name}</dd>
        <dt>Zone</dt><dd>{head.zone_name || '–'} <span className="mono faint">{head.pincode}</span></dd>
        <dt>Slot</dt><dd className="mono">{slot ? `${dateLong(slot)} · ${time(slot)}` : '–'}</dd>
        <dt>Services</dt><dd>{head.service_names || '–'}</dd>
        {backup && <><dt>Replacing</dt><dd>{backup.staff_name} · <StatusBadge status={backup.status} /></dd></>}
      </dl>
      <div className="form-grid">
        <F label="Task" hint={!backup && tasks.length > 1 ? 'each task needs its own technician' : null}>
          <Select value={task} onChange={(e) => { setTask(e.target.value); setWho(''); }} options={(tasks.length ? tasks : ['visit']).map((t) => [t, TASK_LABEL[t]])} disabled={!!backup} />
        </F>
        <F label="ETA at patient" hint="IST">
          <Input type="datetime-local" value={eta} onChange={(e) => setEta(e.target.value)} />
        </F>
        <F label="Technician" hint="skilled for this task, lightest load first" className="span2">
          {eligible.length ? (
            <Select value={pickDefault} onChange={(e) => setWho(e.target.value)}
              options={eligible.map((s) => [s.id, `${s.full_name} · ${load[s.id] || 0} visit${(load[s.id] || 0) === 1 ? '' : 's'} today${s.on_duty ? ' · on duty' : ''}`])} />
          ) : <div className="small danger-text">No field staff with the {TASK_LABEL[task]} skill. Add the skill in Settings.</div>}
        </F>
      </div>
      <div className="tiny muted mt-12">The technician is notified in the field app and the patient receives the ETA on approved template T-05.</div>
    </Modal>
  );
}
