// Patient 360: identity, address, consent, every case, and the complete communication history across channels.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { dial } from '../lib/api.js';
import { useLoad } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { inr, num, ago, dateLong, dateTime, time, dur, CHANNEL_LABEL } from '../lib/fmt.js';
import {
  PageHead, Panel, Badge, Button, StageBadge, SlaBadge, Tabs, Modal, Field, Input, Select, Skeleton, TableSkeleton, Empty, ErrorNote, AiTag, useAction, useToast,
} from '../components/ui.jsx';
import Icon, { channelIcon } from '../components/icons.jsx';

const dash = (v) => (v == null || v === '' ? '–' : v);
const GENDER = { M: 'Male', F: 'Female', O: 'Other' };
const CALL_KIND = { answered: 'info', completed: 'ok', missed: 'danger', abandoned: 'warn', failed: 'danger', ringing: 'warn' };
const PAY_MODE = { upi: 'UPI', link: 'Payment link', card: 'Card', cash: 'Cash', refund: 'Refund' };

export default function PatientDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { isOps, can } = useAuth();
  const [tab, setTab] = useState('timeline');
  const [edit, setEdit] = useState(false);
  const [run, busy] = useAction();
  const canPay = can('coordinator', 'supervisor', 'client_manager');

  useEffect(() => { rpc('log_access', { p_action: 'view_patient', p_entity: 'patient', p_entity_id: id, p_meta: {} }).catch(() => {}); }, [id]);

  const pat = useLoad(() => q(db.from('v_patients').select('*').eq('id', id).maybeSingle()), [id], ['patients']);
  const cases = useLoad(() => q(db.from('v_cases').select('id,case_no,stage,priority,sla_state,service_names,services_requested,total,amount_collected,payment_status,created_at,booked_slot,source_channel,owner_code,zone_name')
    .eq('patient_id', id).order('created_at', { ascending: false }).limit(200)), [id], ['cases']);
  const caseIds = (cases.data || []).map((c) => c.id);
  const caseNo = useMemo(() => Object.fromEntries((cases.data || []).map((c) => [c.id, c.case_no])), [cases.data]);

  const timeline = useLoad(async () => {
    if (!cases.data) return null;
    // by patient, plus anything logged only against one of the patient's cases; merged and de-duplicated
    const cols = 'id,case_id,channel,direction,actor_label,summary,body,evidence,call_id,occurred_at';
    const [a, b] = await Promise.all([
      q(db.from('interactions').select(cols).eq('patient_id', id).order('occurred_at', { ascending: false }).limit(400)),
      caseIds.length ? q(db.from('interactions').select(cols).in('case_id', caseIds).order('occurred_at', { ascending: false }).limit(400)) : [],
    ]);
    const seen = new Set();
    return [...a, ...b].filter((x) => !seen.has(x.id) && seen.add(x.id)).sort((x, y) => new Date(y.occurred_at) - new Date(x.occurred_at));
  }, [id, cases.data], ['interactions']);

  const calls = useLoad(() => q(db.from('v_calls').select('id,direction,status,started_at,talk_seconds,ring_seconds,agent_label,case_id,case_no,ai_summary,ai_sentiment,ai_intent,has_recording,qa_pct,disposition')
    .eq('patient_id', id).order('started_at', { ascending: false }).limit(200)), [id], ['calls']);

  const pays = useLoad(async () => {
    if (!cases.data) return null;
    if (!canPay || !caseIds.length) return [];
    return q(db.from('payments').select('id,case_id,amount,mode,txn_ref,receipt_no,collected_at,reconciled,exception,gateway_status').in('case_id', caseIds).order('collected_at', { ascending: false }));
  }, [cases.data], ['payments']);

  const p = pat.data;
  const aiCall = (calls.data || []).find((c) => c.ai_summary);

  if (pat.loading) return <><Skeleton height={44} /><div className="grid g-main-side mt-16"><Panel><TableSkeleton rows={8} cols={4} /></Panel><Panel><Skeleton lines={8} /></Panel></div></>;
  if (!p) return <><PageHead title="Patient" /><ErrorNote error={pat.error} /><Empty title="Patient not found">The record may be outside your access or the link is wrong. <a href="/patients" onClick={(e) => { e.preventDefault(); nav('/patients'); }}>Back to patients</a></Empty></>;

  const openCases = (cases.data || []).filter((c) => !['closed', 'cancelled'].includes(c.stage)).length;
  const ltv = Number(p.lifetime_value || 0);
  const callDial = () => run(async () => { const r = await dial({ patient_id: id }); if (r?.mode !== 'app') toast('Dialling through MyOperator · your phone rings first'); });
  const recordVerbal = () => run(() => rpc('record_consent', { p_patient: id, p_kind: 'verbal', p_call: aiCall?.id || null }), 'Verbal consent recorded').then(pat.reload);

  return (
    <>
      <div className="row small muted mb-8 no-print"><a href="/patients" onClick={(e) => { e.preventDefault(); nav('/patients'); }}>Patients</a><Icon name="chevron" size={12} /><span className="mono">{p.mrn}</span></div>
      <PageHead title={p.full_name} sub={<>
        <span className="mono">{p.mrn || '–'}</span> · {p.age ?? '–'} y · {GENDER[p.gender] || '–'} · {p.zone_name || 'Unmapped zone'} · patient since {dateLong(p.created_at)}
      </>}>
        {isOps && <Button kind="call" icon="phone" onClick={callDial} disabled={busy}>Call</Button>}
        {isOps && <Button icon="plus" onClick={() => nav('/console?new=1')}>New enquiry</Button>}
        {isOps && <Button icon="edit" onClick={() => setEdit(true)}>Edit details</Button>}
      </PageHead>

      <div className="kpis mb-12">
        <div className="kpi"><div className="l">Cases</div><div className="v">{cases.data ? num(cases.data.length) : <span className="sk" style={{ display: 'inline-block', width: 40, height: 22 }} />}</div><div className="d">{openCases} open</div></div>
        <div className="kpi"><div className="l">Lifetime value</div><div className="v">{ltv ? inr(ltv) : '–'}</div><div className="d">excludes cancelled</div></div>
        <div className="kpi"><div className="l">Calls</div><div className="v">{calls.data ? num(calls.data.length) : <span className="sk" style={{ display: 'inline-block', width: 40, height: 22 }} />}</div><div className="d">{calls.data?.[0] ? `last ${ago(calls.data[0].started_at)}` : 'none yet'}</div></div>
        <div className={`kpi ${p.consent_verbal_at ? 'ok' : 'warn'}`}><div className="l">Consent</div><div className="v" style={{ fontSize: 17, paddingTop: 4 }}>{p.consent_verbal_at && p.consent_digital_at ? 'Verbal + digital' : p.consent_verbal_at ? 'Verbal' : p.consent_digital_at ? 'Digital' : 'Not recorded'}</div><div className="d">DPDP Act 2023 notice</div></div>
      </div>

      <div className="grid g-main-side">
        <div className="col gap-12" style={{ minWidth: 0 }}>
          <Tabs value={tab} onChange={setTab} tabs={[
            ['timeline', 'Unified timeline', timeline.data?.length],
            ['cases', 'Cases', cases.data?.length],
            ['calls', 'Calls', calls.data?.length],
            ...(canPay ? [['payments', 'Payments', pays.data?.length]] : []),
          ]} />
          {tab === 'timeline' && <Timeline load={timeline} caseNo={caseNo} onCase={(cid) => nav(`/cases/${cid}`)} />}
          {tab === 'cases' && <CasesTab load={cases} onOpen={(cid) => nav(`/cases/${cid}`)} />}
          {tab === 'calls' && <CallsTab load={calls} onCase={(cid) => nav(`/cases/${cid}`)} />}
          {tab === 'payments' && canPay && <PaymentsTab load={pays} caseNo={caseNo} onCase={(cid) => nav(`/cases/${cid}`)} />}
        </div>

        <div className="col gap-12">
          <Panel title="AI note" actions={<AiTag>AI summary</AiTag>}>
            {calls.loading ? <Skeleton lines={3} /> : aiCall ? (
              <div className="ai-box">
                <div className="small">{aiCall.ai_summary}</div>
                <div className="tiny muted mt-8">From the {aiCall.direction} call {ago(aiCall.started_at)}{aiCall.case_no ? ` on ${aiCall.case_no}` : ''}{aiCall.ai_intent ? ` · intent ${aiCall.ai_intent.replace(/_/g, ' ')}` : ''}{aiCall.ai_sentiment ? ` · ${aiCall.ai_sentiment}` : ''}. Advisory; verify on the recording.</div>
              </div>
            ) : <Empty title="No AI call summary yet">Summaries appear a minute after a recorded call ends.</Empty>}
          </Panel>

          <Panel title="Contact & address">
            <dl className="kv">
              <dt>Mobile</dt><dd className="mono">{dash(p.mobile)}</dd>
              <dt>Alt. mobile</dt><dd className="mono">{dash(p.alt_mobile)}</dd>
              <dt>Email</dt><dd className="truncate">{dash(p.email)}</dd>
              <dt>Address</dt><dd>{dash(p.address)}</dd>
              <dt>Landmark</dt><dd>{dash(p.landmark)}</dd>
              <dt>Locality</dt><dd>{dash(p.locality)}</dd>
              <dt>Pincode</dt><dd className="mono">{dash(p.pincode)}</dd>
              <dt>Zone</dt><dd>{p.zone_name || <Badge kind="warn">Unmapped pincode</Badge>}</dd>
              <dt>City</dt><dd>{dash(p.city)}</dd>
            </dl>
            {p.tags?.length > 0 && <div className="row wrap mt-12">{p.tags.map((t) => <Badge key={t} kind="outline">{t}</Badge>)}</div>}
          </Panel>

          <Panel title="Consent log" sub="Recorded on the call and via the digital link">
            <div className="col gap-12">
              <div className="row between">
                <div><div className="small strong">Verbal consent</div><div className="tiny muted">{p.consent_verbal_at ? `${dateTime(p.consent_verbal_at)} · on recorded call` : 'Not recorded'}</div></div>
                {p.consent_verbal_at ? <Badge kind="ok" dot>On file</Badge> : <Badge kind="warn" dot>Missing</Badge>}
              </div>
              <div className="row between">
                <div><div className="small strong">Digital consent</div><div className="tiny muted">{p.consent_digital_at ? dateTime(p.consent_digital_at) : 'Not recorded'}</div></div>
                {p.consent_digital_at ? <Badge kind="ok" dot>On file</Badge> : <Badge kind="outline">Pending</Badge>}
              </div>
              {isOps && <Button size="sm" icon="check" onClick={recordVerbal} disabled={busy}>{p.consent_verbal_at ? 'Record verbal consent again' : 'Record verbal consent'}</Button>}
              <div className="tiny faint">Recording consent links to the latest call so the recording is the evidence.</div>
            </div>
          </Panel>
        </div>
      </div>

      {edit && <EditPatient p={p} onClose={() => setEdit(false)} onSaved={() => { setEdit(false); pat.reload(); }} />}
    </>
  );
}

function Timeline({ load, caseNo, onCase }) {
  const [ch, setCh] = useState('');
  if (load.error && !load.data) return <Panel><ErrorNote error={load.error} /></Panel>;
  if (load.loading || !load.data) return <Panel><TableSkeleton rows={8} cols={3} /></Panel>;
  const all = load.data;
  const channels = [...new Set(all.map((i) => i.channel))];
  const rows = ch ? all.filter((i) => i.channel === ch) : all;
  const groups = [];
  rows.forEach((i) => {
    const d = dateLong(i.occurred_at);
    if (!groups.length || groups[groups.length - 1].d !== d) groups.push({ d, items: [] });
    groups[groups.length - 1].items.push(i);
  });
  return (
    <Panel title="Complete communication history" sub="Calls, WhatsApp, SMS, email, notes, field and lab events across every case"
      actions={channels.length > 1 && (
        <div className="row wrap" style={{ gap: 4 }}>
          <button type="button" className={`pill-filter ${!ch ? 'on' : ''}`} onClick={() => setCh('')}>All</button>
          {channels.map((c) => <button key={c} type="button" className={`pill-filter ${ch === c ? 'on' : ''}`} onClick={() => setCh(c)}><Icon name={channelIcon(c)} size={12} />{CHANNEL_LABEL[c] || c}</button>)}
        </div>
      )}>
      <ErrorNote error={load.error} />
      {!rows.length ? <Empty title="No interactions yet">Every call, message and note on this patient will appear here.</Empty> : (
        <div className="tl">
          {groups.map((g) => (
            <div key={g.d}>
              <div className="upper pd-day">{g.d}</div>
              {g.items.map((i) => (
                <div key={i.id} className="tl-item">
                  <div className="tl-time">{time(i.occurred_at)}</div>
                  <div className="tl-rail"><span className="tl-node" title={CHANNEL_LABEL[i.channel]}><Icon name={channelIcon(i.channel)} size={11} /></span></div>
                  <div className="tl-body">
                    <div className="s">{i.summary}</div>
                    <div className="meta">
                      {CHANNEL_LABEL[i.channel] || i.channel}{i.direction !== 'internal' ? ` · ${i.direction}` : ''}{i.actor_label ? ` · ${i.actor_label}` : ''}
                      {i.case_id && <> · <a href={`/cases/${i.case_id}`} className="mono" onClick={(e) => { e.preventDefault(); onCase(i.case_id); }}>{caseNo[i.case_id] || 'case'}</a></>}
                      {i.evidence && <> · <Badge kind="outline">{i.evidence}</Badge></>}
                    </div>
                    {i.body && <div className="b">{i.body.length > 600 ? i.body.slice(0, 600) + '…' : i.body}</div>}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function CasesTab({ load, onOpen }) {
  return (
    <Panel tight>
      <ErrorNote error={load.error} />
      {load.loading ? <TableSkeleton rows={5} cols={6} /> : load.data?.length ? (
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Case</th><th>Opened</th><th>Services</th><th>Stage</th><th>SLA</th><th className="num">Total</th><th className="num">Collected</th><th>Owner</th></tr></thead>
          <tbody>{load.data.map((c) => (
            <tr key={c.id} className="click" onClick={() => onOpen(c.id)}>
              <td className="mono">{c.case_no}{c.priority === 'urgent' && <> <Badge kind="danger">U</Badge></>}</td>
              <td className="nowrap small">{dateTime(c.created_at)}<div className="tiny muted">{c.source_channel}</div></td>
              <td className="truncate" style={{ maxWidth: 240 }}>{c.service_names || c.services_requested || '–'}</td>
              <td><StageBadge stage={c.stage} /></td>
              <td>{['closed', 'cancelled'].includes(c.stage) ? <span className="muted small">–</span> : <SlaBadge state={c.sla_state} />}</td>
              <td className="num">{Number(c.total) ? inr(c.total) : '–'}</td>
              <td className="num">{Number(c.amount_collected) ? inr(c.amount_collected) : '–'}</td>
              <td className="mono small">{c.owner_code || '–'}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty title="No cases for this patient" />}
    </Panel>
  );
}

function CallsTab({ load, onCase }) {
  return (
    <Panel tight>
      <ErrorNote error={load.error} />
      {load.loading ? <TableSkeleton rows={5} cols={5} /> : load.data?.length ? load.data.map((c) => (
        <div key={c.id} className="list-row" style={{ alignItems: 'flex-start' }}>
          <span className="tl-node" style={{ marginTop: 2 }}><Icon name={c.direction === 'inbound' ? 'callin' : 'callout'} size={11} /></span>
          <div className="grow">
            <div className="row wrap" style={{ gap: 6 }}>
              <span className="small strong">{c.direction === 'inbound' ? 'Inbound' : 'Outbound'}</span>
              <Badge kind={CALL_KIND[c.status]}>{c.status}</Badge>
              <span className="small muted">{dateTime(c.started_at)} · {c.talk_seconds ? dur(c.talk_seconds) : 'no talk time'}{c.agent_label ? ` · ${c.agent_label}` : ''}</span>
              {c.case_no && <a href={`/cases/${c.case_id}`} className="mono small" onClick={(e) => { e.preventDefault(); onCase(c.case_id); }}>{c.case_no}</a>}
              {c.has_recording && <Badge kind="outline"><Icon name="wave" size={11} /> Recorded</Badge>}
              {c.qa_pct != null && <Badge kind={c.qa_pct >= 80 ? 'ok' : 'warn'}>QA {Math.round(c.qa_pct)}%</Badge>}
            </div>
            {c.ai_summary && <div className="small mt-4"><AiTag /> {c.ai_summary}</div>}
            {c.disposition && <div className="tiny muted mt-4">Disposition: {c.disposition}</div>}
          </div>
        </div>
      )) : <Empty title="No calls with this patient" />}
    </Panel>
  );
}

function PaymentsTab({ load, caseNo, onCase }) {
  const total = (load.data || []).reduce((s, x) => s + Number(x.amount || 0), 0);
  return (
    <Panel tight title={load.data?.length ? <span className="small muted">Total collected <span className="mono strong" style={{ color: 'var(--ink)' }}>{inr(total)}</span></span> : null}>
      <ErrorNote error={load.error} />
      {load.loading || !load.data ? <TableSkeleton rows={4} cols={6} /> : load.data.length ? (
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Collected</th><th>Case</th><th>Mode</th><th>Reference</th><th className="num">Amount</th><th>Reconciliation</th></tr></thead>
          <tbody>{load.data.map((x) => (
            <tr key={x.id}>
              <td className="nowrap small">{dateTime(x.collected_at)}</td>
              <td><a href={`/cases/${x.case_id}`} className="mono" onClick={(e) => { e.preventDefault(); onCase(x.case_id); }}>{caseNo[x.case_id] || '–'}</a></td>
              <td>{PAY_MODE[x.mode] || x.mode}</td>
              <td className="mono small">{x.txn_ref || x.receipt_no || '–'}</td>
              <td className="num">{inr(x.amount)}</td>
              <td>{x.exception ? <Badge kind="danger" title={x.exception}>Exception</Badge> : x.reconciled ? <Badge kind="ok">Reconciled</Badge> : <Badge kind="warn">Pending</Badge>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      ) : <Empty title="No payments recorded" />}
    </Panel>
  );
}

function EditPatient({ p, onClose, onSaved }) {
  const { profile } = useAuth();
  const masked = profile.role === 'agent';
  const [f, setF] = useState({
    full_name: p.full_name || '', age: p.age ?? '', gender: p.gender || '', email: p.email || '', alt_mobile: p.alt_mobile || '',
    address: p.address || '', landmark: p.landmark || '', locality: p.locality || '', pincode: p.pincode || '',
  });
  const [run, busy] = useAction();
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const pinOk = !f.pincode || /^\d{6}$/.test(f.pincode.trim());
  const save = () => run(async () => {
    const patch = {
      full_name: f.full_name.trim(), age: f.age === '' ? null : Number(f.age), gender: f.gender || null, email: f.email.trim() || null,
      address: f.address.trim() || null, landmark: f.landmark.trim() || null, locality: f.locality.trim() || null, pincode: f.pincode.trim() || null,
    };
    // never write back a masked number
    if (!masked && f.alt_mobile !== (p.alt_mobile || '')) patch.alt_mobile = f.alt_mobile.trim() || null;
    await q(db.from('patients').update(patch).eq('id', p.id));
    onSaved();
  }, 'Patient updated · change logged in the audit trail');
  return (
    <Modal title="Edit patient details" onClose={onClose} footer={<>
      <Button onClick={onClose}>Cancel</Button>
      <Button kind="primary" onClick={save} disabled={busy || !f.full_name.trim() || !pinOk}>Save changes</Button>
    </>}>
      <div className="form-grid">
        <Field label="Full name" className="span2"><Input value={f.full_name} onChange={set('full_name')} /></Field>
        <Field label="Age"><Input type="number" min="0" max="130" value={f.age} onChange={set('age')} /></Field>
        <Field label="Gender"><Select value={f.gender} onChange={set('gender')} placeholder="–" options={[['M', 'Male'], ['F', 'Female'], ['O', 'Other']]} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={set('email')} /></Field>
        <Field label="Alternate mobile" hint={masked ? 'masked for agents' : '10 digits'}><Input value={f.alt_mobile} onChange={set('alt_mobile')} disabled={masked} className="mono" /></Field>
        <Field label="Address" className="span2"><Input value={f.address} onChange={set('address')} placeholder="Flat, building, street" /></Field>
        <Field label="Landmark"><Input value={f.landmark} onChange={set('landmark')} /></Field>
        <Field label="Locality"><Input value={f.locality} onChange={set('locality')} /></Field>
        <Field label="Pincode" hint={pinOk ? 'sets the zone' : '6 digits'}><Input value={f.pincode} onChange={set('pincode')} className="mono" inputMode="numeric" maxLength={6} /></Field>
      </div>
      <div className="tiny faint mt-12">The primary mobile identifies the patient and is not edited here. Every field edit is recorded with old and new values.</div>
    </Modal>
  );
}
