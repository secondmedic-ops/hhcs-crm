// BMM workspace: Book My Medicare's own tab in CareDesk (decision 20-21 Oct 2026: BMM works in our app with its own
// logins, no separate app). Leads | Jobs | Products | Team, reusing the Provider leads, Provider fulfilment and Product
// knowledge screens filtered to the provider. Provider logins (BMM coordinators) see everything of their own provider;
// field staff linked to BMM see their jobs and products; SecondMedic supervisors / coordinators and Hinduja
// management open the same view of BMM to follow its work. What each login may read is still decided by the API and
// the database (RLS), not by this page.
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.ts';
import { db, q, rpc } from '../lib/db.js';
import { useAuth } from '../lib/auth.jsx';
import { useLoad } from '../lib/hooks.js';
import { ROLE_LABEL, time, ago } from '../lib/fmt.js';
import { PageHead, Panel, Tabs, Badge, Empty, ErrorNote, Skeleton, TableSkeleton, Button, Modal, Field as F, Input, useAction } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';
import StaffMap from '../components/StaffMap.jsx';
import Leads from './Leads.jsx';
import ProviderFulfilment from './ProviderFulfilment.jsx';
import Knowledge from './Knowledge.jsx';

const LOGIN = { provider: 'Coordinator (provider login)', field_staff: 'Field / delivery staff' };

const TASK_LABEL = {
  visit: 'Doctor visit',
  sample: 'Sample collection',
  ecg: 'ECG at home',
  xray: 'Portable X-ray',
  nursing: 'Nursing procedure',
  physio: 'Physiotherapy',
  delivery: 'Equipment delivery',
  pickup: 'Equipment pickup',
};

function slotLabel(s) {
  if (!s) return '–';
  const d = new Date(s);
  const end = new Date(d.getTime() + 60 * 60000);
  return `${time(d)} - ${time(end)}`;
}

export default function BmmWorkspace() {
  const { profile } = useAuth();
  const partner = ['provider', 'field_staff'].includes(profile.role) && !!profile.provider_id;
  const field = profile.role === 'field_staff';
  const prov = useLoad(() => q(db.from('providers').select('id,code,name,active')), [], ['providers']);
  const provider = (prov.data || []).find((p) => (partner ? p.id === profile.provider_id : p.code === 'BMM'));
  const tabs = [...(field ? [] : [['leads', 'Leads']]), ['jobs', field ? 'My jobs' : 'Jobs'], ['products', 'Products'], ...(field ? [] : [['team', 'Team']])];
  const [tab, setTab] = useState(field ? 'jobs' : 'leads');
  // staff viewing BMM: filter the shared screens to BMM; a partner login is already limited to its own provider
  const only = partner ? null : provider?.id;

  if (prov.loading) return <div className="page"><Skeleton lines={6} /></div>;
  if (prov.error) return <ErrorNote error={prov.error} />;
  if (!provider) return <Empty title="Book My Medicare is not set up">Add the provider with code BMM, then link BMM logins to it in Settings &gt; Users.</Empty>;

  return (
    <>
      <PageHead title={`${provider.name} workspace`}
        sub={partner
          ? 'Your leads from the Hinduja call centre, your jobs in the field, the products you deliver and your team. Updates are live.'
          : `What ${provider.name} staff work on: their leads, jobs, products and team. Updates are live.`}>
        {!provider.active && <Badge kind="warn">Provider inactive</Badge>}
      </PageHead>
      <div className="mb-16"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>
      {tab === 'leads' && <Leads embedded providerId={only} />}
      {tab === 'jobs' && <ProviderFulfilment embedded providerId={only} />}
      {tab === 'products' && <Knowledge embedded providerId={provider.id} />}
      {tab === 'team' && <Team provider={provider} />}
    </>
  );
}

function Team({ provider }) {
  const nav = useNavigate();
  const { profile } = useAuth();
  const canAddStaff = ['provider', 'admin', 'supervisor'].includes(profile.role);
  const [trackerMode, setTrackerMode] = useState('split');
  const [showAddModal, setShowAddModal] = useState(false);
  const [run, busy] = useAction();
  const setSharing = (p, on) => run(async () => { await rpc('set_location_sharing', { p_staff: p.id, p_on: on }); team.reload(); },
    on ? `Live location on for ${p.full_name}` : `Live location off for ${p.full_name}`);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const team = useLoad(() => q(db.from('profiles').select('id,full_name,role,email,phone,active,available,skills,location_sharing')
    .eq('provider_id', provider.id).order('full_name')), [provider.id], ['profiles']);
  const locs = useLoad(() => q(db.from('v_staff_locations').select('*')), [], ['staff_locations']);
  const board = useLoad(() => q(db.from('v_assignments').select('*').in('status', ['assigned', 'en_route', 'on_site', 'completed']).order('booked_slot')), [], ['assignments']);

  const rows = team.data || [];
  const fieldStaff = rows.filter((p) => p.role === 'field_staff');
  const locByStaff = Object.fromEntries((locs.data || []).map((l) => [l.staff_id, l]));
  const asgByStaff = {};
  for (const a of (board.data || [])) {
    if (!asgByStaff[a.staff_id] || ['en_route', 'on_site'].includes(a.status)) {
      asgByStaff[a.staff_id] = a;
    }
  }

  return (
    <div className="col gap-16">
      <Panel tight title="Live field staff tracker" sub="Live GPS breadcrumbs, actual time of arrival (ATA), and geofence verification for on-duty delivery staff."
        actions={<>
          <div className="row gap-4">
            <Button size="xs" kind={trackerMode === 'map' ? 'primary' : 'ghost'} onClick={() => setTrackerMode('map')}>Map</Button>
            <Button size="xs" kind={trackerMode === 'table' ? 'primary' : 'ghost'} onClick={() => setTrackerMode('table')}>Table</Button>
            <Button size="xs" kind={trackerMode === 'split' ? 'primary' : 'ghost'} onClick={() => setTrackerMode('split')}>Split</Button>
          </div>
          <Button size="sm" icon="refresh" onClick={() => { locs.reload(); board.reload(); team.reload(); }}>Refresh</Button>
        </>}>
        {(locs.error || board.error) && <ErrorNote error={locs.error || board.error} />}
        {team.loading || locs.loading ? <TableSkeleton rows={3} cols={6} /> : !fieldStaff.length ? (
          <Empty title="No field staff registered">No field or delivery staff assigned to {provider.name}.</Empty>
        ) : (
          <div className="col">
            {['map', 'split'].includes(trackerMode) && (
              <div style={{ padding: '12px 14px', borderBottom: trackerMode === 'split' ? '1px solid var(--line-2)' : 'none' }}>
                <StaffMap
                  staffLocations={locs.data || []}
                  visits={board.data || []}
                  now={now}
                  onOpenCase={(id) => nav(`/cases/${id}`)}
                  height={320}
                />
              </div>
            )}
            {['table', 'split'].includes(trackerMode) && (
              <div className="table-wrap"><table className="t">
                <thead>
                  <tr>
                    <th>Field personnel</th>
                    <th>Active case / task</th>
                    <th>Status &amp; distance</th>
                    <th>Scheduled · ETA · ATA</th>
                    <th>Geofence</th>
                    <th>Last GPS ping</th>
                  </tr>
                </thead>
                <tbody>
                  {fieldStaff.map((s) => {
                    const a = asgByStaff[s.id];
                    const loc = locByStaff[s.id];
                    const ata = a?.actual_arrival_at || a?.checkin_at;
                    const liveDist = a?.status === 'en_route' && loc?.distance_to_patient_m != null ? loc.distance_to_patient_m : null;
                    const dist = a?.checkin_distance_m;
                    return (
                      <tr key={s.id}>
                        <td>
                          <div className="small strong">{s.full_name}</div>
                          <div className="tiny muted">{s.phone || '–'}{s.skills?.length ? ` · ${(s.skills || []).map((k) => TASK_LABEL[k] || k).join(', ')}` : ''}</div>
                        </td>
                        <td>
                          {a ? (
                            <>
                              <div className="mono small">
                                <a href={`/cases/${a.case_id}`}>{a.case_no}</a>
                                {a.priority === 'urgent' && <Badge kind="danger" className="ml-4">Urgent</Badge>}
                              </div>
                              <div className="tiny muted truncate" style={{ maxWidth: 160 }}>{a.patient_name} · {TASK_LABEL[a.task] || a.task}</div>
                              {a.zone_name && <div className="tiny faint">{a.zone_name}</div>}
                            </>
                          ) : (
                            <span className="tiny faint">No active visit</span>
                          )}
                        </td>
                        <td>
                          <div className="row gap-4 wrap">
                            {a?.delay_reason ? (
                              <Badge kind="danger">Delayed</Badge>
                            ) : a?.status === 'en_route' ? (
                              <Badge kind="warn">En route</Badge>
                            ) : a?.status === 'on_site' || a?.status === 'checked_in' ? (
                              <Badge kind="ok">On site</Badge>
                            ) : a?.status === 'assigned' ? (
                              <Badge kind="info">Assigned</Badge>
                            ) : a?.status === 'completed' ? (
                              <Badge kind="ok">Completed</Badge>
                            ) : s.available ? (
                              <Badge kind="outline">Available</Badge>
                            ) : (
                              <Badge>Idle</Badge>
                            )}
                            {liveDist != null && <span className="tiny warn-text font-mono">{liveDist}m away</span>}
                          </div>
                          {a?.delay_reason && <div className="tiny danger-text mt-2">{a.delay_reason}</div>}
                        </td>
                        <td>
                          {a ? (
                            <div className="tiny col gap-2">
                              <div><span className="faint">Slot:</span> <span className="mono">{slotLabel(a.booked_slot)}</span></div>
                              <div><span className="faint">ETA:</span> <span className="mono">{time(a.eta)}</span></div>
                              <div>
                                <span className="faint">ATA:</span> <span className="mono strong">{ata ? time(ata) : '–'}</span>
                                {a.eta_vs_ata_variance_min != null && (
                                  <span className={`ml-4 mono ${Math.abs(a.eta_vs_ata_variance_min) > 15 ? 'warn-text' : 'muted'}`}>
                                    ({a.eta_vs_ata_variance_min > 0 ? `+${a.eta_vs_ata_variance_min}` : a.eta_vs_ata_variance_min}m)
                                  </span>
                                )}
                              </div>
                            </div>
                          ) : (
                            <span className="tiny faint">–</span>
                          )}
                        </td>
                        <td>
                          {dist != null ? (
                            <Badge kind={dist <= 200 ? 'ok' : 'warn'}>
                              {dist <= 200 ? `Within pin (${dist}m)` : `Off-site (${dist}m)`}
                            </Badge>
                          ) : a?.status === 'en_route' && loc?.distance_to_patient_m != null ? (
                            <span className="tiny muted">{loc.distance_to_patient_m <= 200 ? 'Inside 200m geofence' : `${loc.distance_to_patient_m}m to pin`}</span>
                          ) : (
                            <span className="tiny faint">–</span>
                          )}
                        </td>
                        <td>
                          {loc ? (
                            <div className="tiny">
                              <div className="muted">{ago(loc.recorded_at, now)}</div>
                              <div className="faint font-mono">
                                {loc.battery_pct != null && `${loc.battery_pct}% batt`}
                                {loc.accuracy != null && ` · ±${Math.round(loc.accuracy)}m`}
                                {loc.speed > 0 && ` · ${Math.round(loc.speed * 3.6)}km/h`}
                              </div>
                              {loc.lat != null && loc.lng != null && (
                                <div className="mt-4">
                                  <a
                                    href={`https://www.google.com/maps?q=${loc.lat},${loc.lng}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="btn xs ghost"
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}
                                    title="Open exact live GPS location in Google Maps"
                                  >
                                    <Icon name="pin" /> View on map
                                  </a>
                                </div>
                              )}
                            </div>
                          ) : (
                            <span className="tiny faint">No telemetry</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table></div>
            )}
          </div>
        )}
      </Panel>

      <Panel
        tight
        title={`${provider.name} team roster`}
        sub="Logins linked to this provider. Coordinators and administrators can add and manage field delivery personnel. Live location: when on, that field login shares GPS once a minute while one of its jobs is under way."
        actions={
          canAddStaff ? (
            <Button size="sm" kind="primary" icon="plus" onClick={() => setShowAddModal(true)}>
              Add field staff
            </Button>
          ) : null
        }
      >
        <ErrorNote error={team.error} />
        {team.loading ? <TableSkeleton rows={4} cols={4} /> : !rows.length ? <Empty title="No logins linked yet">No staff added yet. Click &quot;Add field staff&quot; to create a field delivery login.</Empty> : (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Name</th><th>Login</th><th>Contact</th><th>Status</th><th>Live location</th></tr></thead>
            <tbody>{rows.map((p) => (
              <tr key={p.id}>
                <td className="small strong">{p.full_name}</td>
                <td className="small">{LOGIN[p.role] || ROLE_LABEL[p.role] || p.role}</td>
                <td className="small">{p.email || <span className="faint">–</span>}{p.phone && <div className="tiny muted">{p.phone}</div>}</td>
                <td>{p.active ? <Badge kind="ok">Active</Badge> : <Badge>Disabled</Badge>}{p.active && p.role === 'field_staff' && p.available && <div className="tiny muted">available</div>}</td>
                <td>{p.role !== 'field_staff' ? <span className="tiny faint">–</span> : (
                  <div className="row gap-8">
                    {p.location_sharing ? <Badge kind="ok">On</Badge> : <Badge>Off</Badge>}
                    {canAddStaff && <Button size="sm" kind="ghost" disabled={busy} onClick={() => setSharing(p, !p.location_sharing)}>{p.location_sharing ? 'Turn off' : 'Turn on'}</Button>}
                  </div>
                )}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </Panel>

      {showAddModal && (
        <AddFieldStaffModal
          provider={provider}
          onClose={() => setShowAddModal(false)}
          onCreated={() => {
            setShowAddModal(false);
            team.reload();
          }}
        />
      )}
    </div>
  );
}

function AddFieldStaffModal({ provider, onClose, onCreated }) {
  const [f, setF] = useState({
    full_name: '',
    phone: '',
    email: '',
    password: `BmmStaff@${Math.floor(1000 + Math.random() * 9000)}!`,
    skills: ['delivery'],
  });
  const [run, busy, err] = useAction();

  const toggleSkill = (s) => {
    setF((prev) => ({
      ...prev,
      skills: prev.skills.includes(s)
        ? prev.skills.filter((x) => x !== s)
        : [...prev.skills, s],
    }));
  };

  const submit = () => run(async () => {
    if (!f.full_name.trim()) throw new Error('Full name is required');
    if (!f.phone.trim()) throw new Error('Mobile number is required');
    if (!f.email.trim()) throw new Error('Email address is required');
    if (!f.password || f.password.length < 10) throw new Error('Password must be at least 10 characters');

    await api.createUser({
      full_name: f.full_name.trim(),
      phone: f.phone.trim(),
      email: f.email.trim(),
      password: f.password,
      role: 'field_staff',
      provider_id: provider.id,
      skills: f.skills,
    });
    onCreated();
  }, 'Field staff login created successfully');

  const BMM_SKILL_OPTIONS = [
    ['delivery', 'Equipment delivery'],
    ['nursing', 'Nursing care'],
    ['physio', 'Physiotherapy'],
    ['icu', 'ICU setup'],
    ['eldercare', 'Elder care'],
    ['pickup', 'Equipment return/pickup'],
  ];

  return (
    <Modal
      title={`Add field staff · ${provider.name}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" disabled={busy || !f.full_name.trim() || !f.email.trim() || !f.phone.trim()} onClick={submit}>
            {busy ? 'Creating...' : 'Create field staff'}
          </Button>
        </>
      }
    >
      <ErrorNote error={err} />
      <div className="form-grid">
        <F label="Full name" className="span2" hint="as shown on ID">
          <Input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} placeholder="e.g. Ramesh Patil" />
        </F>
        <F label="Mobile number" hint="10-digit Indian mobile">
          <Input type="tel" className="mono" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="98XXXXXXXX" />
        </F>
        <F label="Email address" hint="for system sign-in">
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="field.staff@domain.com" />
        </F>
        <F label="Temporary password" className="span2" hint="10+ characters, share securely with staff member">
          <Input className="mono" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </F>
        <F label="Skills &amp; capabilities" className="span2" hint="Types of tasks this field technician can perform">
          <div className="row wrap gap-8 mt-4">
            {BMM_SKILL_OPTIONS.map(([val, lbl]) => (
              <label key={val} className="row gap-4 pointer small">
                <input
                  type="checkbox"
                  checked={f.skills.includes(val)}
                  onChange={() => toggleSkill(val)}
                />
                <span>{lbl}</span>
              </label>
            ))}
          </div>
        </F>
      </div>
      <div className="tiny faint mt-12">
        Field staff login will be locked to {provider.name}. Delivery staff use this login to sign in to the mobile field app (/visits) to accept jobs, stream GPS breadcrumbs, and check in.
      </div>
    </Modal>
  );
}
