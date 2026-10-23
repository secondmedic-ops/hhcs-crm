// Field app (slides 16-17): today's visits, geo-tagged check-in, visit checklist, barcoded samples
// (chain of custody starts here), payment and patient sign-off. Built for a phone held in one hand.
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { db, q, rpc, isDemo } from '../lib/db.js';
import { useLoad, useNow } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { ago, time, date, inr, istDayRange, toLocalInput, fromLocalInput } from '../lib/fmt.js';
import { Badge, Button, Tabs, Modal, Field as F, Input, Select, Textarea, Check, Segmented, Empty, Skeleton, useAction, useToast } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';

const TASK_LABEL = {
  visit: 'Home visit',
  phlebotomy: 'Sample collection (Phlebo)',
  nursing: 'Nursing visit',
  physio: 'Physiotherapy session',
  icu_care: 'ICU care',
  eldercare: 'Elder-care shift',
  delivery: 'Delivery',
  pickup: 'Pickup',
  doctor_visit: 'Doctor visit',
  ecg: 'ECG at home',
  xray: 'Portable X-ray',
};
const KIND_FOR = { phlebotomy: 'blood', ecg: 'ecg', xray: 'xray', visit: 'other', nursing: 'other', physio: 'other', icu_care: 'other', eldercare: 'other', delivery: 'other', pickup: 'other', doctor_visit: 'other' };
const CODE_LABEL = { phlebotomy: 'Sample tube barcode', ecg: 'ECG capture ID', xray: 'X-ray image ID', visit: 'Reference code' };
const STATUS = {
  assigned: ['Assigned', 'info'], en_route: ['Started', 'warn'], started: ['Started', 'warn'],
  checked_in: ['Reached', 'accent'], reached: ['Reached', 'accent'],
  collected: ['Collected', 'warn'], handed_to_lab: ['Handed to lab', 'ok'], completed: ['Completed', 'ok'],
};
const DELAY_REASONS = ['Traffic', 'Previous visit overran', 'Patient not reachable', 'Address hard to find', 'Vehicle issue', 'Equipment pickup'];
const EMERGENCY_SIGNS = ['Chest pain', 'Breathlessness', 'Collapsed or unconscious', 'Heavy bleeding', 'Fainted during collection'];

const mapsUrl = (a) => (a.patient_lat != null
  ? `https://www.google.com/maps/dir/?api=1&destination=${a.patient_lat},${a.patient_lng}`
  : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${a.address || ''} ${a.pincode || ''}`)}`);

function useFieldStaffTracking(activeAssignment, reload) {
  const [gpsState, setGpsState] = useState({ active: false, accuracy: null, error: null, lastSent: null });

  useEffect(() => {
    if (isDemo || !navigator.geolocation) {
      if (!navigator.geolocation) setGpsState({ active: false, accuracy: null, error: 'Geolocation not supported', lastSent: null });
      return;
    }

    let lastSent = 0;
    const intervalMs = activeAssignment?.status === 'en_route' ? 12000 : 55000;

    const ping = async (coords) => {
      const now = Date.now();
      if (now - lastSent < intervalMs) return;
      lastSent = now;

      let batteryPct = null;
      try {
        if (typeof navigator.getBattery === 'function') {
          const b = await navigator.getBattery();
          batteryPct = Math.round(b.level * 100);
        }
      } catch { /* battery API unavailable */ }

      try {
        const res = await api.pingLocation({
          lat: coords.latitude,
          lng: coords.longitude,
          accuracy: coords.accuracy,
          speed: coords.speed,
          heading: coords.heading,
          battery_pct: batteryPct,
          assignment_id: activeAssignment?.id || null,
          case_id: activeAssignment?.case_id || null,
        });
        setGpsState({
          active: true,
          accuracy: coords.accuracy,
          error: null,
          lastSent: res?.recorded_at || new Date().toISOString(),
        });
        if (res?.auto_arrived && reload) reload();
      } catch (err) {
        setGpsState((prev) => ({ ...prev, error: err?.message || 'Could not send GPS' }));
      }
    };

    const watchId = navigator.geolocation.watchPosition(
      (pos) => ping(pos.coords),
      (err) => {
        setGpsState({
          active: false,
          accuracy: null,
          error: err.code === 1 ? 'Location permission denied' : 'Location unavailable',
          lastSent: null,
        });
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 10000 }
    );

    return () => {
      navigator.geolocation.clearWatch(watchId);
    };
  }, [activeAssignment?.id, activeAssignment?.case_id, activeAssignment?.status, reload]);

  const requestPermission = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGpsState((prev) => ({ ...prev, active: true, error: null, accuracy: pos.coords.accuracy }));
      },
      (err) => {
        setGpsState({
          active: false,
          accuracy: null,
          error: err.code === 1 ? 'Location permission denied' : 'Location unavailable',
          lastSent: null,
        });
      },
      { enableHighAccuracy: true, timeout: 15000 }
    );
  };

  return { ...gpsState, requestPermission };
}

export default function MyVisits() {
  const { profile } = useAuth();
  const now = useNow(30000);
  const [tab, setTab] = useState('today');
  const [openId, setOpenId] = useState(null);
  const visits = useLoad(() => q(db.from('v_assignments').select('*').eq('staff_id', profile.id)
    .not('status', 'in', '(cancelled,reassigned)').order('booked_slot', { ascending: true }).limit(200)), [profile.id], ['assignments', 'cases']);

  const [, tomorrow] = istDayRange(0);
  const groups = useMemo(() => {
    const all = visits.data || [];
    return {
      today: all.filter((a) => !['completed', 'handed_to_lab'].includes(a.status) && (!a.booked_slot || new Date(a.booked_slot) < new Date(tomorrow))),
      upcoming: all.filter((a) => !['completed', 'handed_to_lab'].includes(a.status) && a.booked_slot && new Date(a.booked_slot) >= new Date(tomorrow)),
      done: all.filter((a) => ['completed', 'handed_to_lab'].includes(a.status)).reverse(),
    };
  }, [visits.data, tomorrow]);

  const open = (visits.data || []).find((a) => a.id === openId);
  const activeJob = open || groups.today.find((a) => ['en_route', 'started'].includes(a.status)) || groups.today.find((a) => ['checked_in', 'reached', 'collected'].includes(a.status)) || groups.today[0];
  const gps = useFieldStaffTracking(activeJob, visits.reload);

  if (open) return <div className="mobile-frame"><VisitDetail a={open} now={now} onBack={() => setOpenId(null)} reload={visits.reload} gps={gps} /></div>;

  const list = groups[tab];
  const next = groups.today.find((a) => !['completed', 'handed_to_lab'].includes(a.status));
  return (
    <div className="mobile-frame">
      <div className="mv-head">
        <div>
          <h1>My visits</h1>
          <div className="small muted">{profile.full_name} · {date(now)} · {groups.today.length} open today</div>
        </div>
        {next && <Button kind="primary" className="tap" onClick={() => setOpenId(next.id)}>Next visit</Button>}
      </div>
      {gps.error ? (
        <div className="badge danger mb-12 row between align-center wrap gap-8" style={{ height: 'auto', padding: '8px 12px', whiteSpace: 'normal' }}>
          <span>
            {gps.error === 'Location permission denied'
              ? '⚠️ Location access is required for Field Staff to track visit arrival and route updates.'
              : `⚠️ ${gps.error}`}
          </span>
          <Button size="xs" kind="primary" onClick={gps.requestPermission}>Enable Location</Button>
        </div>
      ) : gps.active ? (
        <div className="row gap-4 tiny muted mb-8 font-mono">
          <span className="dot" style={{ background: 'var(--ok)' }} />
          <span>Live GPS active{gps.accuracy != null ? ` (±${Math.round(gps.accuracy)}m)` : ''}</span>
          {gps.lastSent && <span>· Ping: {time(gps.lastSent)}</span>}
        </div>
      ) : null}
      <Tabs value={tab} onChange={setTab} tabs={[['today', 'Today', groups.today.length], ['upcoming', 'Upcoming', groups.upcoming.length], ['done', 'Done', groups.done.length]]} />
      {visits.error && <div className="badge danger mb-12">{visits.error}</div>}
      {visits.loading ? <div className="col gap-12">{[0, 1, 2].map((i) => <div key={i} className="mv-card"><Skeleton lines={4} /></div>)}</div>
        : list.length ? <div className="col gap-12">{list.map((a) => <VisitCard key={a.id} a={a} now={now} onOpen={() => setOpenId(a.id)} />)}</div>
          : <div className="panel"><Empty title={{ today: 'No open visits today', upcoming: 'Nothing scheduled yet', done: 'No completed visits yet' }[tab]}>
            {tab === 'upcoming' ? 'Visits appear here up to 12 hours before the slot, with the patient address.' : 'New assignments arrive here with a notification.'}
          </Empty></div>}
      <div className="tiny faint mt-16 center">Patient phone numbers are not shown in the field app. Call the HHCS desk for anything you need.</div>
    </div>
  );
}

function VisitCard({ a, now, onOpen }) {
  const [l, k] = STATUS[a.status] || [a.status, ''];
  const late = a.booked_slot && !a.checkin_at && ['assigned', 'en_route', 'started'].includes(a.status) && now > new Date(a.booked_slot).getTime() + 15 * 60000;
  return (
    <button type="button" className="mv-card click" onClick={onOpen}>
      <div className="row between">
        <span className="mv-slot mono">{time(a.booked_slot)}<span className="tiny muted"> {date(a.booked_slot)}</span></span>
        <span className="row gap-4">
          {a.fasting_required && <Badge kind="warn">Fasting</Badge>}
          {late && <Badge kind="danger">Late</Badge>}
          <Badge kind={k}>{l}</Badge>
        </span>
      </div>
      <div className="strong mt-4">{a.patient_name} <span className="muted small">{a.patient_age ?? '–'}{a.patient_gender || ''}</span></div>
      <div className="small muted">{a.address || '–'}{a.landmark ? ` · ${a.landmark}` : ''} · <span className="mono">{a.pincode}</span></div>
      <div className="row between mt-8 small">
        <span>{TASK_LABEL[a.task]}<span className="muted"> · {a.service_names || '–'}</span></span>
        <span className="mono faint nowrap">{a.case_no}</span>
      </div>
      {['completed', 'handed_to_lab'].includes(a.status) && (
        <div className="tiny muted mt-4">
          {a.status === 'handed_to_lab' ? `Handed to lab ${ago(a.lab_handover_at || a.checkout_at, now)}` : `Completed ${ago(a.checkout_at, now)}`}
          {a.tube_count ? ` · ${a.tube_count} tubes` : ''}
        </div>
      )}
    </button>
  );
}

function VisitDetail({ a, now, onBack, reload, gps }) {
  const { workspace, profile } = useAuth();
  const toast = useToast();
  const [run, busy] = useAction();
  const cs = useLoad(() => q(db.from('v_cases').select('id,total,amount_collected,payment_status,patient_locality,consent_digital_at').eq('id', a.case_id).maybeSingle()), [a.case_id], ['cases']);
  const samples = useLoad(() => q(db.from('samples').select('id,barcode,kind,collected_at').eq('case_id', a.case_id).order('collected_at', { ascending: true })), [a.case_id], ['samples']);

  const isPhlebo = a.task === 'phlebotomy';
  const [eta, setEta] = useState(toLocalInput(a.eta || new Date(Date.now() + 20 * 60000)));
  const [checkin, setCheckin] = useState(null); // {distance, demo}
  const [checks, setChecks] = useState({
    consent: !!a.checklist?.consent,
    id_check: !!a.checklist?.id_check,
    procedure: !!a.checklist?.procedure,
    tubes_labelled: !!a.checklist?.tubes_labelled,
    cold_chain: !!a.checklist?.cold_chain,
  });
  const [tubeCount, setTubeCount] = useState(a.tube_count || 1);
  const [labHandoverAt, setLabHandoverAt] = useState(toLocalInput(a.lab_handover_at || new Date()));
  const [labName, setLabName] = useState('Hinduja Hospital Main Lab, Mahim');
  const [barcode, setBarcode] = useState('');
  const codeRef = useRef(null);
  const due = cs.data ? Math.max(0, Number(cs.data.total) - Number(cs.data.amount_collected)) : null;
  const [pay, setPay] = useState({ mode: 'upi', txn: '', amount: '' });
  const [signoff, setSignoff] = useState(!!a.patient_signoff);
  const [modal, setModal] = useState(null);

  useEffect(() => { if (due != null) setPay((p) => ({ ...p, amount: p.amount === '' ? String(due) : p.amount })); }, [due]);

  const status = a.status;
  const travelled = !['assigned'].includes(status);
  const onSite = ['checked_in', 'reached', 'collected', 'handed_to_lab', 'completed'].includes(status);
  const collected = ['collected', 'handed_to_lab', 'completed'].includes(status);
  const handedToLab = ['handed_to_lab', 'completed'].includes(status);
  const done = status === 'completed' || status === 'handed_to_lab';
  const codes = samples.data || [];
  const needCode = isPhlebo;
  const checklistOk = checks.consent && checks.id_check && checks.procedure && (!needCode || codes.length > 0);
  const canComplete = onSite && !done && checklistOk && signoff;

  const startTravel = () => run(async () => {
    await rpc('field_update', { p_assignment: a.id, p_action: isPhlebo ? 'started' : 'en_route', p: { eta: fromLocalInput(eta) } });
    reload();
  }, isPhlebo ? 'Journey started · patient notified' : 'Marked en route · patient gets your ETA');

  const getPosition = () => new Promise((resolve) => {
    const fallback = () => resolve({
      lat: Number(a.patient_lat) + (Math.random() - 0.5) * 0.0006, lng: Number(a.patient_lng) + (Math.random() - 0.5) * 0.0006, demo: true,
    });
    if (isDemo || !navigator.geolocation) { fallback(); return; }
    navigator.geolocation.getCurrentPosition((p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, demo: false }), fallback, { timeout: 8000, enableHighAccuracy: true, maximumAge: 30000 });
  });

  const doCheckin = () => run(async () => {
    const pos = await getPosition();
    if (pos.lat == null || Number.isNaN(pos.lat)) throw new Error('Location unavailable. Turn on GPS and try again.');
    const r = await rpc('field_update', { p_assignment: a.id, p_action: isPhlebo ? 'reached' : 'checkin', p: { lat: pos.lat, lng: pos.lng } });
    setCheckin({ distance: r?.distance_m, demo: pos.demo });
    reload();
  }, isPhlebo ? 'Reached patient location · geo-tagged check-in' : 'Checked in at patient address');

  const saveCode = () => run(async () => {
    const code = barcode.trim().toUpperCase();
    if (code.length < 4) throw new Error('Enter the full code printed on the label');
    await rpc('upsert_sample', { p: { case_id: a.case_id, barcode: code, kind: KIND_FOR[a.task] || 'blood_sample', collected_at: new Date().toISOString() } });
    setBarcode(''); samples.reload();
  }, 'Saved to chain of custody');

  const markCollected = () => run(async () => {
    if (codes.length === 0) throw new Error('Please scan and save at least one barcode before completing collection');
    const tubes = Math.max(1, Number(tubeCount) || codes.length);
    await rpc('field_update', {
      p_assignment: a.id,
      p_action: 'collected',
      p: {
        tube_count: tubes,
        sample_barcodes: codes.map((c) => c.barcode),
        checklist: checks,
      },
    });
    reload();
  }, 'Samples marked as collected');

  const markHandover = () => run(async () => {
    await rpc('field_update', {
      p_assignment: a.id,
      p_action: 'handed_to_lab',
      p: {
        lab_handover_at: fromLocalInput(labHandoverAt),
        lab_notes: labName,
        signoff,
      },
    });
    reload();
  }, 'Handed over to lab · task closed');

  const collect = () => run(async () => {
    const amt = Number(pay.amount);
    if (!(amt > 0)) throw new Error('Enter the amount collected');
    if (amt > due) throw new Error(`Amount is more than the ${inr(due)} due`);
    if (pay.mode !== 'link' && !pay.txn.trim()) throw new Error('Enter the transaction reference from the UPI or card slip');
    await rpc('record_payment', { p_case: a.case_id, p_amount: amt, p_mode: pay.mode, p_txn: pay.txn.trim() || null });
    setPay({ mode: pay.mode, txn: '', amount: '' }); cs.reload();
  }, 'Payment recorded · receipt generated');

  const complete = () => run(async () => {
    await rpc('field_update', { p_assignment: a.id, p_action: 'complete', p: { checklist: checks, signoff } });
    reload();
  }, 'Visit completed');

  const dist = checkin?.distance ?? a.checkin_distance_m;
  const step = (n, title, state, children) => (
    <div className={`mv-step ${state}`}>
      <div className="n">{state === 'done' ? <Icon name="check" size={13} /> : n}</div>
      <div className="col" style={{ gap: 10, minWidth: 0 }}>
        <div className="strong">{title}</div>
        {children}
      </div>
    </div>
  );
  const st = (isDone, isCur) => (isDone ? 'done' : isCur ? 'cur' : 'locked');

  return (
    <>
      <button type="button" className="btn ghost sm mb-8" onClick={onBack}><Icon name="chevron" size={12} className="flip" /> All visits</button>
      <div className="panel">
        <div className="mv-detail-head">
          <div className="row between">
            <span className="mv-slot mono">{time(a.booked_slot)} <span className="small muted">{date(a.booked_slot)}</span></span>
            <Badge kind={(STATUS[status] || [])[1]}>{(STATUS[status] || [status])[0]}</Badge>
          </div>
          <div className="mt-8" style={{ fontSize: 17, fontWeight: 600 }}>{a.patient_name} <span className="muted small">{a.patient_age ?? '–'}{a.patient_gender || ''}</span></div>
          <div className="mt-4">{a.address || '–'}</div>
          <div className="small muted">{a.landmark ? `${a.landmark} · ` : ''}<span className="mono">{a.pincode}</span>{a.zone_name ? ` · ${a.zone_name}` : ''}</div>
          <div className="small mt-8"><span className="strong">{TASK_LABEL[a.task]}</span> · {a.service_names || '–'}</div>
          <div className="tiny faint mono mt-4">{a.case_no}{a.priority === 'urgent' ? ' · URGENT' : ''}</div>
          <div className="mv-actions mt-12">
            <a className="btn lg tap" href={mapsUrl(a)} target="_blank" rel="noreferrer"><Icon name="pin" /> Navigate</a>
            {workspace?.support_number && <a className="btn lg tap" href={`tel:${workspace.support_number.replace(/\s+/g, '')}`}><Icon name="phone" /> HHCS desk</a>}
          </div>
          <div className="tiny muted mt-8">Calling the patient is not available in the field app. The HHCS desk ({workspace?.support_number || '–'}) can reach the family for you.</div>
        </div>

        {step(1, isPhlebo ? 'Start journey' : 'Start travel', st(travelled, !travelled), travelled
          ? <div className="small muted">{status === 'en_route' || status === 'started' ? (isPhlebo ? 'Started journey' : 'En route') : 'Travelled'}{a.eta ? ` · ETA ${time(a.eta)}` : ''}</div>
          : <>
            <F label="Your ETA at the patient" hint="IST"><Input type="datetime-local" value={eta} onChange={(e) => setEta(e.target.value)} /></F>
            <Button kind="primary" className="tap block" disabled={busy} onClick={startTravel}>{isPhlebo ? 'Start journey' : 'Start travel'}</Button>
          </>)}

        {step(2, isPhlebo ? 'Reached patient location' : 'Check in at address', st(onSite, travelled && !onSite), onSite
          ? <div className="small">
            <div><strong>ATA: {time(a.actual_arrival_at || a.checkin_at)}</strong> <span className="muted">· Checked in {time(a.checkin_at)}</span></div>
            {a.eta_vs_ata_variance_min != null && <div className={Math.abs(a.eta_vs_ata_variance_min) > 15 ? 'tiny warn-text mt-4' : 'tiny muted mt-4'}>ETA vs ATA variance: {a.eta_vs_ata_variance_min > 0 ? `+${a.eta_vs_ata_variance_min}` : a.eta_vs_ata_variance_min} min</div>}
            {dist != null && <div className="mt-4"><Badge kind={dist <= 200 ? 'ok' : 'warn'}>{dist <= 200 ? `Checked in within ${dist}m of pin` : `Off-site check-in (${dist}m)`}</Badge></div>}
            {checkin?.demo && <div className="tiny muted mt-4">demo location</div>}
            {dist > 200 && <div className="tiny warn-text mt-4">More than 200 m from the registered pin. Confirm the address with the desk.</div>}
          </div>
          : <>
            <div className="small muted">Your GPS position streams automatically while en route, and is recorded on arrival as proof.</div>
            <Button kind="primary" className="tap block" disabled={busy || !travelled} onClick={doCheckin}><Icon name="pin" /> {isPhlebo ? 'Reached address' : 'Check in here'}</Button>
          </>)}

        {isPhlebo ? (
          step(3, 'Sample collection & barcodes', st(collected, onSite && !collected), <>
            <div className="col gap-8 mb-8">
              {a.fasting_required ? (
                <div className="badge warn" style={{ height: 'auto', padding: '6px 10px' }}>⚠️ Patient must be fasting (8–10 hours). Confirm before drawing sample.</div>
              ) : (
                <div className="badge info" style={{ height: 'auto', padding: '6px 10px' }}>ℹ️ Non-fasting / Random blood collection.</div>
              )}
              <div className="small"><strong>Required tests:</strong> {a.tests_list && a.tests_list.length ? a.tests_list.join(', ') : a.service_names || 'Standard lab panel'}</div>
            </div>
            <div className="mv-checks">
              <Check label="Consent taken (digital)" checked={checks.consent} disabled={!onSite || collected} onChange={(e) => setChecks({ ...checks, consent: e.target.checked })} />
              <Check label="Patient ID verified" checked={checks.id_check} disabled={!onSite || collected} onChange={(e) => setChecks({ ...checks, id_check: e.target.checked })} />
              <Check label="Sample drawn as per Hinduja protocol" checked={checks.procedure} disabled={!onSite || collected} onChange={(e) => setChecks({ ...checks, procedure: e.target.checked })} />
              <Check label="Barcodes labelled on tubes" checked={checks.tubes_labelled} disabled={!onSite || collected} onChange={(e) => setChecks({ ...checks, tubes_labelled: e.target.checked })} />
            </div>
            <div className="row gap-8">
              <F label="Tubes collected"><Input type="number" min="1" value={tubeCount} onChange={(e) => setTubeCount(e.target.value)} disabled={!onSite || collected} className="mono" style={{ width: 100 }} /></F>
            </div>
            <F label="Sample barcodes" hint="Scan each tube label">
              <div className="row">
                <input ref={codeRef} value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="e.g. HHC-SAMP-102" disabled={!onSite || collected}
                  inputMode="text" autoCapitalize="characters" onKeyDown={(e) => e.key === 'Enter' && barcode && saveCode()} className="input mono" />
                <Button className="tap" disabled={!onSite || collected} onClick={() => codeRef.current?.focus()} aria-label="Scan"><Icon name="barcode" /> Scan</Button>
              </div>
            </F>
            {barcode && <Button className="tap block" disabled={busy} onClick={saveCode}>Save barcode {barcode.trim().toUpperCase()}</Button>}
            {samples.loading ? <Skeleton lines={1} /> : codes.length > 0 && (
              <div className="col gap-4">{codes.map((s) => (
                <div key={s.id} className="row between small"><span className="mono strong">{s.barcode}</span><span className="muted">{s.kind} · {time(s.collected_at)}</span></div>
              ))}</div>
            )}
            {!collected && onSite && (
              <Button kind="primary" className="tap block mt-8" disabled={busy || codes.length === 0 || !checks.consent || !checks.id_check || !checks.procedure} onClick={markCollected}>
                Mark samples collected ({codes.length} {codes.length === 1 ? 'tube' : 'tubes'})
              </Button>
            )}
            {collected && <div className="small ok-text">Collected {a.tube_count || codes.length} tubes · Ready for lab handover</div>}
          </>)
        ) : (
          step(3, 'Visit checklist', st(done || (onSite && checklistOk), onSite && !done), <>
            <div className="mv-checks">
              <Check label="Consent taken (digital)" checked={checks.consent} disabled={!onSite || done} onChange={(e) => setChecks({ ...checks, consent: e.target.checked })} />
              <Check label="Patient ID verified" checked={checks.id_check} disabled={!onSite || done} onChange={(e) => setChecks({ ...checks, id_check: e.target.checked })} />
              <Check label={`${TASK_LABEL[a.task]} done`} checked={checks.procedure} disabled={!onSite || done} onChange={(e) => setChecks({ ...checks, procedure: e.target.checked })} />
            </div>
            <F label={CODE_LABEL[a.task]} hint={needCode ? 'required, one per tube' : 'optional'}>
              <div className="row">
                <input ref={codeRef} value={barcode} onChange={(e) => setBarcode(e.target.value)} placeholder="e.g. HHC24871032" disabled={!onSite || done}
                  inputMode="text" autoCapitalize="characters" onKeyDown={(e) => e.key === 'Enter' && barcode && saveCode()} className="input mono" />
                <Button className="tap" disabled={!onSite || done} onClick={() => codeRef.current?.focus()} aria-label="Scan"><Icon name="barcode" /> Scan</Button>
              </div>
            </F>
            {barcode && <Button className="tap block" disabled={busy} onClick={saveCode}>Save {barcode.trim().toUpperCase()}</Button>}
            {samples.loading ? <Skeleton lines={1} /> : codes.length > 0 && (
              <div className="col gap-4">{codes.map((s) => (
                <div key={s.id} className="row between small"><span className="mono strong">{s.barcode}</span><span className="muted">{s.kind} · {time(s.collected_at)}</span></div>
              ))}</div>
            )}
          </>)
        )}

        {step(4, 'Payment', st(due === 0, onSite && !done && due > 0), cs.loading ? <Skeleton lines={2} /> : due === 0
          ? <div className="small ok-text">Nothing due · {inr(cs.data?.amount_collected)} collected ({cs.data?.payment_status})</div>
          : <>
            <div className="row between"><span className="muted small">Amount due</span><span className="mono" style={{ fontSize: 20 }}>{inr(due)}</span></div>
            <Segmented value={pay.mode} onChange={(m) => setPay({ ...pay, mode: m })} options={[['upi', 'UPI'], ['link', 'Payment link'], ['card', 'Card']]} />
            <div className="form-grid">
              <F label="Amount"><Input type="number" inputMode="decimal" value={pay.amount} onChange={(e) => setPay({ ...pay, amount: e.target.value })} className="mono" /></F>
              <F label="Txn reference" hint={pay.mode === 'link' ? 'optional' : 'UTR or slip no.'}><Input value={pay.txn} onChange={(e) => setPay({ ...pay, txn: e.target.value })} className="mono" /></F>
            </div>
            <Button className="tap block" disabled={busy || !onSite || done} onClick={collect}><Icon name="rupee" /> Record payment</Button>
            <div className="tiny muted">Cash is not accepted. If the family prefers to pay later, the desk sends a payment link.</div>
          </>)}

        {isPhlebo ? (
          step(5, 'Handover to lab', st(handedToLab, collected && !handedToLab), handedToLab
            ? <div className="small ok-text">Handed to lab at {time(a.lab_handover_at || a.checkout_at)} · {a.tube_count || codes.length} tubes</div>
            : <>
              <F label="Lab destination"><Input value={labName} onChange={(e) => setLabName(e.target.value)} disabled={!collected} /></F>
              <F label="Handover time" hint="IST"><Input type="datetime-local" value={labHandoverAt} onChange={(e) => setLabHandoverAt(e.target.value)} disabled={!collected} /></F>
              <Check label="Patient or family confirmed blood draw completed" checked={signoff} disabled={!collected} onChange={(e) => setSignoff(e.target.checked)} />
              <Button kind="primary" className="tap block" disabled={busy || !collected || !signoff} onClick={markHandover}>Confirm handover to lab</Button>
            </>)
        ) : (
          step(5, 'Patient sign-off and complete', st(done, onSite && !done), done
            ? <div className="small ok-text">Completed {time(a.checkout_at)} · sign-off {a.patient_signoff ? 'yes' : 'no'}</div>
            : <>
              <Check label="Patient or family confirmed the visit was completed" checked={signoff} disabled={!onSite} onChange={(e) => setSignoff(e.target.checked)} />
              {onSite && !checklistOk && <div className="tiny warn-text">Tick all checklist items to complete.</div>}
              <Button kind="primary" className="tap block" disabled={busy || !canComplete} onClick={complete}>Complete visit</Button>
            </>)
        )}

        {!done && (
          <div className="mv-foot">
            <Button className="tap" icon="clock" onClick={() => setModal('delay')}>Report delay</Button>
            <Button kind="danger" className="tap" icon="alert" onClick={() => setModal('emergency')}>Emergency at home</Button>
          </div>
        )}
      </div>

      {modal === 'delay' && <DelayModal a={a} onClose={() => setModal(null)} onDone={() => { setModal(null); reload(); }} />}
      {modal === 'emergency' && <EmergencyModal a={a} profile={profile} workspace={workspace} onClose={() => setModal(null)} toast={toast} />}
    </>
  );
}

function DelayModal({ a, onClose, onDone }) {
  const [run, busy] = useAction();
  const [reason, setReason] = useState(DELAY_REASONS[0]);
  const [other, setOther] = useState('');
  const [eta, setEta] = useState(toLocalInput(new Date(Math.max(Date.now(), new Date(a.eta || a.booked_slot || Date.now()).getTime()) + 20 * 60000)));
  const text = reason === 'Other' ? other.trim() : reason;
  const submit = () => run(async () => {
    await rpc('field_update', { p_assignment: a.id, p_action: 'delay', p: { reason: text, eta: fromLocalInput(eta) } });
    onDone();
  }, 'Delay reported · coordinator alerted');
  return (
    <Modal title="Report delay" onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" disabled={busy || !text} onClick={submit}>Report delay</Button>
    </>}>
      <div className="col gap-12">
        <F label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value)} options={[...DELAY_REASONS, 'Other']} /></F>
        {reason === 'Other' && <F label="Describe"><Input value={other} onChange={(e) => setOther(e.target.value)} autoFocus /></F>}
        <F label="New ETA" hint="IST"><Input type="datetime-local" value={eta} onChange={(e) => setEta(e.target.value)} /></F>
        <div className="small muted">The coordinator sees this immediately and can send a backup. The family is informed on the approved delay template.</div>
      </div>
    </Modal>
  );
}

function EmergencyModal({ a, profile, workspace, onClose, toast }) {
  const [run, busy] = useAction();
  const [sign, setSign] = useState('');
  const [note, setNote] = useState('');
  const [raised, setRaised] = useState(false);
  const trigger = [sign, note.trim()].filter(Boolean).join(': ');
  const raise = () => run(async () => {
    await q(db.from('escalations').insert({
      workspace_id: profile.workspace_id, case_id: a.case_id, type: 'emergency', level: 1, raised_by: profile.id,
      trigger_text: `Emergency at home (${a.case_no}): ${trigger || 'reported by field staff'}`,
    }));
    setRaised(true);
    toast.ok('Emergency escalation raised · Hinduja clinical and medical desk notified');
  });
  return (
    <Modal title="Emergency at home" onClose={onClose} footer={<Button onClick={onClose}>{raised ? 'Close' : 'Cancel'}</Button>}>
      <a className="btn danger lg block tap mv-108" href="tel:108"><Icon name="phone" /> Call 108 now</a>
      <ol className="mv-script">
        <li>Do not give clinical advice. Ask the family to dial 108, or dial it yourself.</li>
        <li>Stay with the patient. Keep the airway clear; do not give food, water or medicines.</li>
        <li>Give the ambulance the full address: {a.address}{a.landmark ? `, ${a.landmark}` : ''}, {a.pincode}.</li>
        <li>Raise the escalation below so Hinduja clinical and the medical desk are notified.</li>
        <li>Call the HHCS desk {workspace?.support_number ? `(${workspace.support_number}) ` : ''}and stay until help arrives.</li>
      </ol>
      {raised ? (
        <div className="badge ok" style={{ height: 'auto', padding: '8px 10px', whiteSpace: 'normal' }}>Escalation raised at {time(new Date())}. The medical desk will call you back.</div>
      ) : (
        <div className="col gap-12">
          <div className="row wrap gap-4">{EMERGENCY_SIGNS.map((s) => (
            <button key={s} type="button" className={`pill-filter ${sign === s ? 'on' : ''}`} onClick={() => setSign(sign === s ? '' : s)}>{s}</button>
          ))}</div>
          <F label="What you see" hint="short"><Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} /></F>
          <Button kind="danger" className="tap block" disabled={busy || (!sign && !note.trim())} onClick={raise}>Raise emergency escalation</Button>
        </div>
      )}
    </Modal>
  );
}
