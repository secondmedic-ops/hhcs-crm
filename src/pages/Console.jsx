// Agent console (slides 5-7): one screen while handling a call. Capture the enquiry against the live call,
// quote only from the locked rate card, follow the approved scripts, and work the personal queue.
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad, useNow } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { dial, aiExtract } from '../lib/api.js';
import { inr, num, pct, dur, time, ago, istDayRange, istDateStr, toLocalInput, fromLocalInput } from '../lib/fmt.js';
import {
  PageHead, Panel, Kpi, Button, Badge, StageBadge, PriorityBadge, Countdown, TableSkeleton, Skeleton, Empty, AiTag,
  Field, Input, Select, Textarea, Tabs, useToast, useAction,
} from '../components/ui.jsx';
import { LiveCallBar, useCalls } from '../components/CallCenter.jsx';
import Icon from '../components/icons.jsx';

const BLANK = {
  caller_name: '', caller_relation: '', caller_mobile: '',
  full_name: '', age: '', gender: '', mobile: '', email: '',
  address: '', landmark: '', locality: '', pincode: '',
  services_requested: '', preferred_slot: '', priority: 'routine', source_channel: 'phone', clinical_notes: '',
  service_ids: [], consent: false, confirm_mobile: '', branch: '', additional_info: '',
};
const RELATIONS = [['self', 'Self'], ['son', 'Son'], ['daughter', 'Daughter'], ['wife', 'Wife'], ['husband', 'Husband'], ['parent', 'Parent'], ['relative', 'Relative'], ['caregiver', 'Caregiver'], ['doctor', 'Doctor / clinic'], ['other', 'Other']];
const GENDERS = [['M', 'Male'], ['F', 'Female'], ['O', 'Other']];
const CHANNELS = [['phone', 'Phone'], ['whatsapp', 'WhatsApp'], ['email', 'Email'], ['chat', 'Chat'], ['walkin', 'Walk-in'], ['referral', 'Referral']];
const CATEGORY = { lab: 'Blood tests · sample collection', xray: 'Portable X-ray', ecg: 'ECG at home', visit: 'Visit charges', nursing: 'Nursing', physio: 'Physiotherapy',
  beds: 'Hospital beds', eldercare: 'Elder care', homecare: 'Other home healthcare', other: 'Other' };
const PATIENT_KEYS = ['full_name', 'age', 'gender', 'mobile'];
const FALLBACK_CONSENT = 'This call is recorded for quality and your records. May we record and use these details to arrange your service?';

const empty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0);
const greetingTime = () => {
  const h = Number(new Date().toLocaleString('en-IN', { hour: 'numeric', hour12: false, timeZone: 'Asia/Kolkata' }));
  return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
};
// "+919820012345" from what the agent typed
const normMobile = (s) => {
  const d = String(s || '').replace(/\D/g, '');
  if (d.length === 10) return '+91' + d;
  if (d.length === 12 && d.startsWith('91')) return '+' + d;
  if (d.length === 11 && d.startsWith('0')) return '+91' + d.slice(1);
  return null;
};
// masked numbers keep the first 5 and last 3 characters (mask_mobile in 0002_logic.sql)
const matchesMask = (typed, masked) => {
  const n = normMobile(typed);
  if (!n || !masked) return false;
  if (!/X/.test(masked)) return n === masked;
  return n.slice(0, 5) === masked.slice(0, 5) && n.slice(-3) === masked.slice(-3);
};
// "tomorrow 08:00" → datetime-local value in IST
function parsePreferred(s) {
  if (!s) return '';
  const m = String(s).toLowerCase().match(/(today|tomorrow)?\s*(\d{1,2})[:.](\d{2})/);
  if (!m) return '';
  const day = istDateStr(m[1] === 'tomorrow' ? 1 : 0);
  return `${day}T${m[2].padStart(2, '0')}:${m[3]}`;
}

// Both AI shapes (call ai_extracted is flat; /ai/extract-enquiry nests patient{}) → form fields
function normaliseAi(x, services) {
  if (!x) return null;
  const p = x.patient || {};
  const pick = (...v) => v.find((y) => !empty(y)) ?? null;
  const ids = (x.service_ids || []).filter(Boolean);
  const fromCodes = (x.service_codes || []).map((c) => services.find((s) => s.code === c)?.id).filter(Boolean);
  const slot = x.preferred_slot_iso ? toLocalInput(x.preferred_slot_iso) : parsePreferred(x.preferred);
  return {
    caller_name: pick(x.caller_name), caller_relation: pick(x.caller_relation),
    full_name: pick(p.full_name, x.patient_name), age: pick(p.age, x.age) != null ? String(pick(p.age, x.age)) : null,
    gender: pick(p.gender, x.gender), mobile: pick(p.mobile, x.mobile),
    address: pick(p.address, x.address), landmark: pick(p.landmark, x.landmark), locality: pick(p.locality, x.locality), pincode: pick(p.pincode, x.pincode),
    preferred_slot: slot || null,
    priority: x.priority === 'urgent' || x.urgent === true ? 'urgent' : null,
    service_ids: ids.length ? ids : fromCodes,
  };
}

const LABEL = {
  caller_name: 'caller name', caller_relation: 'relation', full_name: 'patient name', age: 'age', gender: 'gender', mobile: 'mobile',
  address: 'address', landmark: 'landmark', locality: 'locality', pincode: 'pincode', preferred_slot: 'preferred slot', priority: 'priority', service_ids: 'services',
};

export default function Console() {
  const nav = useNavigate();
  const toast = useToast();
  const now = useNow(30000);
  const { profile, workspace } = useAuth();
  const { active } = useCalls();
  const [sp, setSp] = useSearchParams();
  const callParam = sp.get('call');
  const linkedId = callParam || active?.id || null;
  const isAgent = profile.role === 'agent';

  // ---------- data
  const call = useLoad(() => (linkedId ? q(db.from('v_calls').select('*').eq('id', linkedId).maybeSingle()) : Promise.resolve(null)), [linkedId], ['calls']);
  const c = call.data;
  const known = useLoad(() => (c?.patient_id
    ? q(db.from('v_patients').select('id,full_name,age,gender,mobile,email,address,landmark,locality,pincode,zone_name,case_count,last_case_at,consent_verbal_at').eq('id', c.patient_id).maybeSingle())
    : Promise.resolve(null)), [c?.patient_id]);
  const services = useLoad(() => q(db.from('services').select('id,code,name,category,price,tat_hours').is('active', true).order('category').order('name')), []);
  const providers = useLoad(() => q(db.from('providers').select('id,code,name,categories').is('active', true)), []);
  const providerFor = (cat) => (providers.data || []).find((p) => (p.categories || []).includes(cat))?.name;
  const branches = workspace?.settings?.branches || [];
  // the IVR department of the call names the branch (Press 1 Khar, 2 Mahim): pre-select it
  useEffect(() => {
    const d = (c?.department || '').toLowerCase();
    const b = branches.find((x) => d && d.includes(x.toLowerCase()));
    if (b) setF((x) => (x.branch ? x : { ...x, branch: b }));
  }, [c?.id, c?.department]); // eslint-disable-line react-hooks/exhaustive-deps
  const scripts = useLoad(() => q(db.from('templates').select('id,code,title,body,version').eq('kind', 'script').eq('status', 'approved').order('code')), []);
  const queue = useLoad(() => q(db.from('v_cases').select('id,case_no,patient_name,stage,priority,next_sla_due,next_sla_key,service_names,created_at')
    .eq('owner_id', profile.id).not('stage', 'in', '(closed,cancelled)').order('next_sla_due', { ascending: true }).limit(12)), [], ['cases']);
  const callbacks = useLoad(() => q(db.from('v_callbacks').select('id,number,patient_name,reason,due_at,status,attempts,created_at')
    .in('status', ['pending', 'in_progress']).order('due_at', { ascending: true }).limit(5)), [], ['callbacks', 'calls']);
  const stats = useLoad(async () => {
    const [from, to] = istDayRange(0);
    const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
    const [calls, qa] = await Promise.all([
      q(db.from('v_calls').select('id,status,talk_seconds,ring_seconds').eq('agent_id', profile.id).gte('started_at', from).lt('started_at', to)),
      q(db.from('qa_reviews').select('total_pct').eq('agent_id', profile.id).gte('created_at', weekAgo)),
    ]);
    const talked = calls.filter((x) => x.talk_seconds > 0);
    const scored = qa.filter((x) => x.total_pct != null);
    return {
      calls: calls.length,
      answered: calls.filter((x) => ['answered', 'completed'].includes(x.status)).length,
      avgTalk: talked.length ? talked.reduce((a, x) => a + x.talk_seconds, 0) / talked.length : null,
      qa: scored.length ? scored.reduce((a, x) => a + Number(x.total_pct), 0) / scored.length : null,
      qaN: scored.length,
    };
  }, [], ['calls']);

  // ---------- form
  const [f, setF] = useState(BLANK);
  const [aiKeys, setAiKeys] = useState({});
  const [mode, setMode] = useState('known'); // known patient on file vs a different patient for this caller
  const [paste, setPaste] = useState('');
  const [extracted, setExtracted] = useState(null);
  const [scriptTab, setScriptTab] = useState(null);
  const [run, busy] = useAction();
  const [extracting, setExtracting] = useState(false);
  const firstRef = useRef(null);
  const formRef = useRef(null);

  const useKnown = !!known.data && mode === 'known';
  const set = (k) => (e) => {
    const v = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setF((x) => ({ ...x, [k]: v }));
    setAiKeys((a) => (a[k] ? { ...a, [k]: false } : a));
  };
  const cls = (k) => (aiKeys[k] ? 'ai-filled' : '');

  // fresh form per call
  useEffect(() => { setF(BLANK); setAiKeys({}); setExtracted(null); setPaste(''); setMode('known'); }, [linkedId]);
  // visit address defaults to the address on file
  useEffect(() => {
    const p = known.data;
    if (!p) return;
    setF((x) => ({ ...x, address: x.address || p.address || '', landmark: x.landmark || p.landmark || '', locality: x.locality || p.locality || '', pincode: x.pincode || p.pincode || '' }));
  }, [known.data?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (sp.get('new') === '1') { formRef.current?.scrollIntoView({ block: 'start' }); setTimeout(() => firstRef.current?.focus(), 50); }
  }, [sp]);
  useEffect(() => { if (!scriptTab && scripts.data?.length) setScriptTab(scripts.data[0].code); }, [scripts.data, scriptTab]);

  const applyAi = (raw) => {
    const n = normaliseAi(raw, services.data || []);
    if (!n) return 0;
    const next = { ...f }; const marks = {};
    Object.entries(n).forEach(([k, v]) => {
      if (empty(v)) return;
      if (useKnown && PATIENT_KEYS.includes(k)) return;
      if (k === 'priority') { if (v === 'urgent' && f.priority !== 'urgent') { next.priority = 'urgent'; marks.priority = true; } return; }
      if (k === 'service_ids') { if (!f.service_ids.length) { next.service_ids = v; marks.service_ids = true; } return; }
      if (empty(f[k])) { next[k] = v; marks[k] = true; }
    });
    setF(next); setAiKeys((a) => ({ ...a, ...marks }));
    return Object.keys(marks).length;
  };
  const doApply = (raw) => {
    const n = applyAi(raw);
    toast(n ? `${n} field${n > 1 ? 's' : ''} filled from AI. Check each before saving.` : 'Nothing new to fill: the form already has these details');
  };
  const doExtract = async () => {
    if (!paste.trim()) return;
    setExtracting(true);
    try { setExtracted(await aiExtract(paste)); } catch (e) { toast.error(e.message); } finally { setExtracting(false); }
  };

  const svcById = useMemo(() => Object.fromEntries((services.data || []).map((s) => [s.id, s])), [services.data]);
  const svcGroups = useMemo(() => {
    const g = {};
    (services.data || []).forEach((s) => { (g[s.category] = g[s.category] || []).push(s); });
    const order = ['ecg', 'xray', 'lab', 'nursing', 'physio', 'beds', 'eldercare', 'homecare', 'visit', 'other'];
    return Object.entries(g).sort(([a], [b]) => order.indexOf(a) - order.indexOf(b));
  }, [services.data]);
  const toggleSvc = (id) => setF((x) => ({ ...x, service_ids: x.service_ids.includes(id) ? x.service_ids.filter((i) => i !== id) : [...x.service_ids, id] }));
  const rateTotal = f.service_ids.reduce((a, id) => a + Number(svcById[id]?.price || 0), 0);

  const scriptVars = (body) => body
    .replaceAll('{{brand}}', workspace?.brand_name || 'Hinduja Home Care Services')
    .replaceAll('{{agent_name}}', (profile.full_name || '').split(' ')[0])
    .replaceAll('{{case_no}}', 'the case ID shown after you save')
    .replaceAll('{{greeting_time}}', greetingTime())
    .replaceAll('{{support_number}}', workspace?.support_number || '');
  const consentLine = useMemo(() => {
    const s01 = scripts.data?.find((s) => s.code === 'S-01');
    const m = s01?.body.match(/CONSENT:\s*"?([^"\n]+)"?/);
    return m ? m[1].trim() : FALLBACK_CONSENT;
  }, [scripts.data]);

  // what is still needed before this can be saved
  const problems = [];
  if (!useKnown) {
    if (!f.full_name.trim()) problems.push('patient name');
    if (!normMobile(f.mobile) && !f.email.trim() && !c) problems.push('patient mobile');
    else if (f.mobile && !normMobile(f.mobile)) problems.push('valid 10-digit mobile');
  }
  if (!f.address.trim()) problems.push('address');
  if (f.pincode && !/^\d{6}$/.test(f.pincode)) problems.push('6-digit pincode');
  if (!f.service_ids.length && !f.services_requested.trim()) problems.push('services');
  if (f.caller_mobile && !normMobile(f.caller_mobile)) problems.push('valid caller mobile');
  if (branches.length && !f.branch) problems.push('branch');
  if (!f.consent) problems.push('consent');

  const submit = async (e) => {
    e?.preventDefault();
    if (problems.length) { toast.error(`Still needed: ${problems.join(', ')}`); return; }
    const kp = known.data;
    const patient = useKnown
      ? {
        // the patient on file is referenced by id, so agents never handle the full number
        patient_id: kp.id,
        address: f.address, landmark: f.landmark, locality: f.locality, pincode: f.pincode,
      }
      : {
        full_name: f.full_name.trim(), age: f.age, gender: f.gender, mobile: normMobile(f.mobile) || '', email: f.email.trim(),
        address: f.address, landmark: f.landmark, locality: f.locality, pincode: f.pincode,
      };
    const out = await run(() => rpc('create_enquiry', {
      p: {
        patient,
        caller_name: f.caller_name, caller_relation: f.caller_relation, caller_mobile: normMobile(f.caller_mobile) || '',
        source_channel: c ? 'phone' : f.source_channel, priority: f.priority,
        services_requested: f.services_requested, clinical_notes: f.clinical_notes, branch: f.branch || null, additional_info: f.additional_info.trim() || null,
        preferred_slot: fromLocalInput(f.preferred_slot),
        consent: true, call_id: c?.id || null, service_ids: f.service_ids,
      },
    }));
    if (out?.case_id) {
      toast.ok(`Case ${out.case_no} created`);
      setF(BLANK); setAiKeys({});
      nav(`/cases/${out.case_id}`);
    }
  };

  const raiseEmergency = (text) => run(async () => {
    await q(db.from('escalations').insert({
      workspace_id: profile.workspace_id, type: 'emergency', level: 1, raised_by: profile.id, case_id: c?.case_id || null,
      trigger_text: `Emergency on call${c ? ` ${c.customer_number}` : ''}: ${text || 'caller reports an emergency at home'}. Script S-09 followed.`,
    }));
  }, 'Emergency escalation raised. Hinduja clinical notified.');

  const callAi = c?.ai_processed_at && c?.ai_extracted && Object.keys(c.ai_extracted).some((k) => !['consent_given', 'language'].includes(k)) ? c.ai_extracted : null;
  const callMissing = callAi ? Object.entries(normaliseAi(callAi, services.data || [])).filter(([k, v]) => empty(v) && !['priority', 'mobile'].includes(k) && !(useKnown && PATIENT_KEYS.includes(k))).map(([k]) => LABEL[k]) : [];
  const liveIsLinked = active && active.id === c?.id;

  return (
    <>
      <PageHead title="Agent console" sub={<>{workspace?.name || 'Hinduja Home Care Services'} · ECG, X-ray and blood tests by SecondMedic; nursing, physiotherapy, beds and elder care by Book My Medicare</>}>
        {(callParam || f !== BLANK) && <Button size="sm" icon="refresh" onClick={() => { setF(BLANK); setAiKeys({}); setExtracted(null); if (callParam) setSp({}); }}>Clear form</Button>}
      </PageHead>

      {active && <div className="mb-12"><LiveCallBar call={active} /></div>}

      <div className="kpis mb-16">
        <Kpi label="My calls today" value={stats.data && num(stats.data.calls)} detail={stats.data && `${stats.data.answered} answered`} to="/calls" />
        <Kpi label="Avg talk time" value={stats.data && dur(stats.data.avgTalk)} detail="answered calls today" />
        <Kpi label="My QA score" value={stats.data && pct(stats.data.qa)} detail={stats.data && `${stats.data.qaN} review${stats.data.qaN === 1 ? '' : 's'} · 7 days`} tone={stats.data?.qa != null ? (stats.data.qa < 75 ? 'warn' : 'ok') : ''} />
        <Kpi label="My open cases" value={queue.data && num(queue.data.length)} detail={queue.data && `${queue.data.filter((x) => x.next_sla_due && new Date(x.next_sla_due) < now).length} past SLA`} to="/cases" />
        <Kpi label="Callbacks waiting" value={callbacks.data && num(callbacks.data.length)} detail={callbacks.data && `${callbacks.data.filter((x) => new Date(x.due_at) < now).length} overdue`} tone={callbacks.data?.some((x) => new Date(x.due_at) < now) ? 'danger' : ''} to="/callbacks" />
      </div>

      <div className="grid g-main-side">
        <div className="col gap-12">
          {/* linked call strip */}
          {linkedId && (call.loading ? <Skeleton height={44} /> : c ? (
            <div className="panel console-link">
              <Icon name={c.direction === 'inbound' ? 'callin' : 'callout'} />
              <div className="grow">
                <div><span className="mono">{c.customer_number}</span> · {c.patient_name || 'New caller'} · {time(c.started_at)}</div>
                <div className="tiny muted">Linked call · {c.status}{c.talk_seconds ? ` · talk ${dur(c.talk_seconds)}` : ''}{liveIsLinked ? ' · live' : ''} · the enquiry will be attached to this call and its recording</div>
              </div>
              {c.case_no && <Button size="sm" icon="folder" onClick={() => nav(`/cases/${c.case_id}`)}>{c.case_no}</Button>}
              {callParam && <Button size="sm" kind="ghost" onClick={() => setSp({})}>Unlink</Button>}
            </div>
          ) : <div className="badge warn">This call is not visible to you</div>)}
          {c?.case_id && <div className="badge info" style={{ height: 'auto', padding: '6px 10px', whiteSpace: 'normal' }}>This call already has case {c.case_no}. Saving below creates a second case for the same call, only do that for a different patient.</div>}

          {/* AI assist */}
          <Panel title={<span className="row">AI assist <AiTag /></span>} sub="Suggestions only: nothing is saved until you submit the enquiry">
            <div className="col gap-12">
              {c && c.status === 'completed' && !c.ai_processed_at && (
                <div className="ai-box"><div className="row small"><span className="live-dot" style={{ background: 'var(--accent)' }} /> Analysing the call recording. Fields will be offered here in a few seconds.</div></div>
              )}
              {callAi && (
                <div className="ai-box">
                  <div className="ai-head">
                    <span className="row strong">AI filled from call <AiTag /></span>
                    <Button size="sm" kind="primary" icon="check" onClick={() => doApply(callAi)}>Apply</Button>
                  </div>
                  {c.ai_summary && <div className="small">{c.ai_summary}</div>}
                  <AiFields n={normaliseAi(callAi, services.data || [])} svcById={svcById} />
                  {callMissing.length > 0 && <div className="tiny mt-8"><span className="warn-text strong">Still to ask:</span> {callMissing.join(', ')}</div>}
                </div>
              )}
              <div>
                <Field label="Paste WhatsApp / email text" hint="patient details are extracted, you review them">
                  <Textarea rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="e.g. My mother is 68, needs blood tests and a chest X-ray at home in Bandra tomorrow morning. Pincode 400050." />
                </Field>
                <div className="row mt-8">
                  <Button size="sm" icon="ai" onClick={doExtract} disabled={!paste.trim() || extracting}>{extracting ? 'Extracting…' : 'Extract'}</Button>
                  {extracted && <Button size="sm" kind="ghost" onClick={() => { setExtracted(null); setPaste(''); }}>Discard</Button>}
                </div>
              </div>
              {extracting && <Skeleton lines={3} />}
              {extracted && !extracting && (
                <div className="ai-box">
                  <div className="ai-head">
                    <span className="row strong">Extracted from text <AiTag /></span>
                    <Button size="sm" kind="primary" icon="check" onClick={() => doApply(extracted)}>Apply</Button>
                  </div>
                  {extracted.clinical_red_flag && (
                    <div className="redflag mb-8">
                      <div className="row strong"><Icon name="alert" /> {extracted.clinical_red_flag}</div>
                      <div className="small mt-4">Do not give clinical advice. Ask the caller to dial 108 now.</div>
                      <div className="row wrap mt-8">
                        <Button size="sm" kind="danger" icon="flag" disabled={busy} onClick={() => raiseEmergency(extracted.clinical_red_flag)}>Raise emergency escalation</Button>
                        <Button size="sm" onClick={() => setScriptTab('S-09')}>Open script S-09</Button>
                      </div>
                    </div>
                  )}
                  <AiFields n={normaliseAi(extracted, services.data || [])} svcById={svcById} />
                  {extracted.missing?.length > 0 && <div className="tiny mt-8"><span className="warn-text strong">Missing:</span> {extracted.missing.join(', ')}</div>}
                </div>
              )}
            </div>
          </Panel>

          {/* enquiry form */}
          <form ref={formRef} onSubmit={submit}>
            <Panel title="New enquiry" sub={c ? 'Linked to the call above · case ID is generated on save' : 'Case ID is generated on save'}
              actions={f.priority === 'urgent' ? <PriorityBadge p="urgent" /> : null}>
              <div className="col gap-16">
                <section>
                  <div className="section-title mb-8">Caller</div>
                  <div className="form-grid">
                    <Field label="Caller name"><input ref={firstRef} className={`input ${cls('caller_name')}`} value={f.caller_name} onChange={set('caller_name')} autoComplete="off" /></Field>
                    <Field label="Relation to patient"><Select className={cls('caller_relation')} value={f.caller_relation} onChange={set('caller_relation')} options={RELATIONS} placeholder="Select" /></Field>
                    <Field label="Caller mobile" hint={c ? 'from call' : 'optional'}>
                      <Input inputMode="tel" value={f.caller_mobile} onChange={set('caller_mobile')} placeholder={c ? `On the call record (${c.customer_number})` : '98XXXXXXXX'} />
                    </Field>
                    {!c && <Field label="Source channel"><Select value={f.source_channel} onChange={set('source_channel')} options={CHANNELS} /></Field>}
                  </div>
                </section>

                <section>
                  <div className="row between mb-8">
                    <div className="section-title">Patient</div>
                    {known.data && <div className="btn-group">
                      <button type="button" className={`btn xs ${mode === 'known' ? 'on' : ''}`} onClick={() => setMode('known')}>On file</button>
                      <button type="button" className={`btn xs ${mode === 'other' ? 'on' : ''}`} onClick={() => setMode('other')}>Different patient</button>
                    </div>}
                  </div>
                  {c?.patient_id && known.loading ? <Skeleton lines={2} /> : useKnown ? (
                    <div className="known-patient">
                      <div className="row wrap">
                        <strong>{known.data.full_name}</strong>
                        <span className="muted">{known.data.age ? `${known.data.age}${known.data.gender || ''}` : ''}</span>
                        <Badge kind="ok">Known patient</Badge>
                        {known.data.consent_verbal_at && <Badge kind="outline">Consent on file</Badge>}
                        <a className="small" href={`/patients/${known.data.id}`} onClick={(e) => { e.preventDefault(); nav(`/patients/${known.data.id}`); }} style={{ marginLeft: 'auto' }}>History</a>
                      </div>
                      <div className="small muted mt-4"><span className="mono">{known.data.mobile}</span> · {known.data.locality || known.data.zone_name || 'locality not set'} · {known.data.case_count} previous case{known.data.case_count === 1 ? '' : 's'}{known.data.last_case_at ? `, last ${ago(known.data.last_case_at, now)}` : ''}</div>

                    </div>
                  ) : (
                    <div className="form-grid">
                      <Field label="Patient name" className="span2"><Input className={cls('full_name')} value={f.full_name} onChange={set('full_name')} autoComplete="off" /></Field>
                      <Field label="Age"><Input inputMode="numeric" className={cls('age')} value={f.age} onChange={set('age')} /></Field>
                      <Field label="Gender"><Select className={cls('gender')} value={f.gender} onChange={set('gender')} options={GENDERS} placeholder="Select" /></Field>
                      <Field label="Patient mobile" hint={c ? 'leave blank to use the calling number' : 'WhatsApp quote goes here'}>
                        <Input inputMode="tel" className={cls('mobile')} value={f.mobile} onChange={set('mobile')} placeholder="98XXXXXXXX" />
                      </Field>
                      <Field label="Email" hint="optional"><Input type="email" value={f.email} onChange={set('email')} /></Field>
                    </div>
                  )}
                </section>

                <section>
                  <div className="section-title mb-8">Visit address</div>
                  <div className="form-grid">
                    <Field label="Address" className="span2"><Input className={cls('address')} value={f.address} onChange={set('address')} placeholder="Flat, building, road" /></Field>
                    <Field label="Landmark"><Input className={cls('landmark')} value={f.landmark} onChange={set('landmark')} /></Field>
                    <Field label="Locality"><Input className={cls('locality')} value={f.locality} onChange={set('locality')} placeholder="e.g. Andheri West" /></Field>
                    <Field label="Pincode"><Input inputMode="numeric" maxLength={6} className={cls('pincode')} value={f.pincode} onChange={set('pincode')} /></Field>
                  </div>
                </section>

                <section>
                  <div className="row between mb-8">
                    <div className="section-title">Services · rate card {aiKeys.service_ids && <AiTag />}</div>
                    {f.service_ids.length > 0 && <span className="small">Rate card total <strong className="mono">{inr(rateTotal)}</strong></span>}
                  </div>
                  {services.loading ? <Skeleton lines={3} /> : services.error ? <div className="badge danger">{services.error}</div> : !services.data?.length ? <Empty title="No active services on the rate card" /> : (
                    <div className="col gap-12">
                      {svcGroups.map(([cat, list]) => (
                        <div key={cat}>
                          <div className="tiny muted mb-8">{CATEGORY[cat] || cat}{providerFor(cat) && <span className="faint"> · {providerFor(cat)}</span>}</div>
                          <div className="svc-chips">
                            {list.map((s) => (
                              <button key={s.id} type="button" className={`pill-filter svc-chip ${f.service_ids.includes(s.id) ? 'on' : ''}`} onClick={() => toggleSvc(s.id)} aria-pressed={f.service_ids.includes(s.id)} title={s.code}>
                                {f.service_ids.includes(s.id) && <Icon name="check" size={12} />}
                                {s.name} <span className="price">{Number(s.price) > 0 ? inr(s.price) : 'quote'}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                      <div className="tiny faint">Prices are locked to the approved rate card. "quote" = priced by the provider after assessment. Each service goes to its provider automatically.</div>
                    </div>
                  )}
                  <div className="form-grid mt-12">
                    {branches.length > 0 && (
                      <Field label="Hinduja branch">
                        <div className="btn-group">
                          {branches.map((b) => <button key={b} type="button" className={`btn ${f.branch === b ? 'on' : ''}`} onClick={() => set('branch')(b)}>{b}</button>)}
                        </div>
                      </Field>
                    )}
                    <Field label="Request note" hint="as the caller said it" className="span2"><Input value={f.services_requested} onChange={set('services_requested')} placeholder="e.g. Fasting blood sugar, doctor's prescription on WhatsApp" /></Field>
                    <Field label="Preferred slot" hint="IST"><Input type="datetime-local" className={cls('preferred_slot')} value={f.preferred_slot} onChange={set('preferred_slot')} /></Field>
                    <Field label="Priority">
                      <div className="btn-group">
                        {[['routine', 'Routine'], ['urgent', 'Urgent']].map(([v, l]) => (
                          <button key={v} type="button" className={`btn ${f.priority === v ? 'on' : ''} ${aiKeys.priority && f.priority === v ? 'ai-filled' : ''}`} onClick={() => set('priority')(v)}>{l}</button>
                        ))}
                      </div>
                    </Field>
                    <Field label="Clinical notes" hint="symptoms, prescriptions, mobility, fasting" className="span2"><Textarea rows={2} value={f.clinical_notes} onChange={set('clinical_notes')} /></Field>
                    <Field label="Additional information" hint="customer requirements, timings, preferences: shared with the provider" className="span2"><Textarea rows={2} value={f.additional_info} onChange={set('additional_info')} /></Field>
                  </div>
                </section>

                <div className={`consent-box ${f.consent ? 'on' : ''}`}>
                  <label className="check top">
                    <input type="checkbox" checked={f.consent} onChange={set('consent')} />
                    <span>
                      <span className="strong">Caller gave verbal consent</span> <span className="tiny muted">· mandatory · script S-01</span>
                      <span className="consent-line">"{consentLine}"</span>
                    </span>
                  </label>
                </div>

                <div className="row wrap between">
                  <span className="small muted">{problems.length ? <>Still needed: {problems.join(', ')}</> : <span className="ok-text">Ready to create the case</span>}</span>
                  <Button kind="primary" size="lg" icon="plus" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create enquiry'}</Button>
                </div>
              </div>
            </Panel>
          </form>
        </div>

        <div className="col gap-12">
          <Panel title="Call scripts" sub="Approved versions only" tight>
            {scripts.loading ? <div className="panel-body"><Skeleton lines={6} /></div> : !scripts.data?.length ? <Empty title="No approved scripts" /> : (
              <div className="panel-body" style={{ paddingTop: 4 }}>
                <Tabs tabs={scripts.data.map((s) => [s.code, `${s.code} ${s.code === 'S-09' ? 'Emergency' : s.title.split(' ')[0]}`])} value={scriptTab} onChange={setScriptTab} />
                {scripts.data.filter((s) => s.code === scriptTab).map((s) => (
                  <div key={s.id}>
                    <div className="row between mb-8"><strong>{s.title}</strong><span className="tiny faint mono">v{s.version}</span></div>
                    <div className={`script-body ${s.code === 'S-09' ? 'emergency' : ''}`}>{scriptVars(s.body)}</div>
                    {s.code === 'S-09' && <Button className="mt-12" kind="danger" size="sm" icon="flag" disabled={busy} onClick={() => raiseEmergency(null)}>Raise emergency escalation</Button>}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Callbacks due" sub="Missed and abandoned calls · 10 min target" actions={<a className="small" href="/callbacks" onClick={(e) => { e.preventDefault(); nav('/callbacks'); }}>Queue</a>} tight>
            {callbacks.loading ? <div className="panel-body"><TableSkeleton rows={3} cols={2} /></div> : !callbacks.data?.length ? <Empty title="No callbacks waiting" /> : callbacks.data.map((cb) => (
              <div key={cb.id} className="list-row">
                <div className="grow">
                  <div className="small"><span className="mono">{cb.number}</span>{cb.patient_name ? ` · ${cb.patient_name}` : ''}</div>
                  <div className="tiny muted">{cb.reason} · {ago(cb.created_at, now)}{cb.attempts ? ` · ${cb.attempts} attempt${cb.attempts > 1 ? 's' : ''}` : ''}{cb.status === 'in_progress' ? ' · dialling' : ''}</div>
                </div>
                <Countdown due={cb.due_at} compact />
                <Button size="xs" kind="call" icon="phone" disabled={busy} onClick={() => run(() => dial({ callback_id: cb.id }), 'Dialling via MyOperator. Pick up on your phone.')}>Call back</Button>
              </div>
            ))}
          </Panel>

          <Panel title="My queue" sub="Open cases you own · soonest deadline first" tight>
            {queue.loading ? <div className="panel-body"><TableSkeleton rows={4} cols={2} /></div> : !queue.data?.length ? <Empty title="No open cases">New enquiries you create are assigned to you.</Empty> : queue.data.map((r) => (
              <div key={r.id} className="list-row click" onClick={() => nav(`/cases/${r.id}`)}>
                <div className="grow">
                  <div className="small"><span className="mono">{r.case_no}</span> · {r.patient_name}{r.priority === 'urgent' && <> <Badge kind="danger">U</Badge></>}</div>
                  <div className="tiny muted truncate">{r.service_names || 'services pending'}</div>
                </div>
                <div className="col" style={{ gap: 4, alignItems: 'flex-end' }}>
                  <StageBadge stage={r.stage} />
                  {r.next_sla_due && <Countdown due={r.next_sla_due} label={r.next_sla_key} compact />}
                </div>
              </div>
            ))}
          </Panel>
        </div>
      </div>
    </>
  );
}

function AiFields({ n, svcById }) {
  if (!n) return null;
  const rows = [
    ['Caller', [n.caller_name, n.caller_relation].filter(Boolean).join(' · ')],
    ['Patient', [n.full_name, n.age && `${n.age}${n.gender || ''}`].filter(Boolean).join(', ')],
    ['Mobile', n.mobile],
    ['Address', [n.address, n.landmark, n.locality, n.pincode].filter(Boolean).join(', ')],
    ['Services', n.service_ids.map((id) => svcById[id]?.name).filter(Boolean).join(', ')],
    ['Preferred', n.preferred_slot ? n.preferred_slot.replace('T', ' ') : null],
    ['Priority', n.priority === 'urgent' ? 'Urgent' : null],
  ].filter(([, v]) => v);
  if (!rows.length) return <div className="small muted mt-4">No enquiry details found.</div>;
  return <dl className="kv mt-8 small">{rows.map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{v}</dd></Fragment>)}</dl>;
}
