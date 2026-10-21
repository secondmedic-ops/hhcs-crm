// Email: patient e-mail conversations, like WhatsApp chats. One thread per patient from the timeline's e-mail entries
// (v_email_threads): inbound mail (Cloudflare Email Routing -> services/email.ts) and mail sent from here (Gmail SMTP,
// POST /api/v1/email/send). Every message stays on the patient's timeline and case.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { db, q } from '../lib/db.js';
import { useAuth } from '../lib/auth.jsx';
import { useLoad, useDebounced } from '../lib/hooks.js';
import { ago, dateTime as dt } from '../lib/fmt.js';
import { sendEmail } from '../lib/api.js';
import Icon from '../components/icons.jsx';
import { Badge, Button, Empty, Field, Input, Modal, PageHead, PriorityBadge, Segmented, TableSkeleton, StageBadge, useToast } from '../components/ui.jsx';

const STATUS = { sent: 'Sent by e-mail', logged: 'Logged only (e-mail not configured)', failed: 'Sending failed', unknown: 'Not confirmed by the mail server' };
const reSubject = (s) => (!s ? '' : /^re:/i.test(s) ? s : `Re: ${s}`);

export default function Email() {
  const { profile, can } = useAuth();
  const isOps = can('agent', 'coordinator', 'supervisor', 'medical_desk', 'client_manager', 'admin');
  const toast = useToast();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [newMail, setNewMail] = useState(false);
  const endRef = useRef(null);

  const { data, loading, reload } = useLoad(() => q(db.from('v_email_threads').select('*').order('last_message_at', { ascending: false }).limit(200)),
    [profile?.id], ['interactions', 'cases', 'patients']);
  const threads = data || [];
  const waiting = threads.filter((t) => t.needs_reply).length;

  const filtered = useMemo(() => threads.filter((t) => {
    if (filter === 'needs_reply' && !t.needs_reply) return false;
    if (filter === 'open' && (!t.case_id || ['closed', 'cancelled'].includes(t.case_stage))) return false;
    if (filter === 'mine' && t.owner_id !== profile?.id) return false;
    if (search) {
      const hay = `${t.patient_name || ''} ${t.patient_email || ''} ${t.case_no || ''} ${t.patient_mrn || ''} ${t.last_subject || ''} ${t.last_body || ''}`.toLowerCase();
      if (!hay.includes(search.toLowerCase())) return false;
    }
    return true;
  }), [threads, filter, search, profile?.id]);

  const selectedId = params.get('patient') || filtered[0]?.patient_id || null;
  const active = threads.find((t) => t.patient_id === selectedId) || filtered[0] || null;
  const select = (patientId) => { const next = new URLSearchParams(params); next.set('patient', patientId); setParams(next, { replace: true }); };

  const { data: messages, loading: msgLoading } = useLoad(async () => {
    if (!active?.patient_id) return [];
    return (await q(db.from('interactions').select('*').eq('channel', 'email').eq('patient_id', active.patient_id).order('occurred_at', { ascending: true }).limit(200))) || [];
  }, [active?.patient_id, active?.last_message_id], ['interactions']);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [messages?.length, active?.patient_id]);
  // a reply keeps the thread's subject
  useEffect(() => { setSubject(reSubject(active?.last_subject)); setText(''); }, [active?.patient_id, active?.last_message_id]);

  const send = async (e) => {
    e?.preventDefault();
    if (!active || sending) return;
    if (!subject.trim() || !text.trim()) { toast.error('Write a subject and a message first'); return; }
    setSending(true);
    try {
      const r = await sendEmail({ case_id: active.case_id || null, patient_id: active.patient_id, subject: subject.trim(), text: text.trim() });
      if (r.delivery?.status === 'sent') toast(`E-mail sent to ${r.to}`);
      else toast.error(`${STATUS[r.delivery?.status] || 'Not sent'}${r.delivery?.error ? ': ' + r.delivery.error : ''}`);
      setText('');
      reload();
    } catch (err) { toast.error(err.message); }
    setSending(false);
  };

  return (
    <>
      <PageHead title="Email" sub={`Patient e-mail, with a copy on the timeline of every case · ${waiting} awaiting reply`}>
        <div className="row gap-8 wrap">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search patient, e-mail, Case ID, subject…" aria-label="Search e-mail" />
          <Segmented value={filter} onChange={setFilter} options={[['all', `All (${threads.length})`], ['needs_reply', `Awaiting reply (${waiting})`], ['open', 'Open case'], ['mine', 'My queue']]} />
          {isOps && <Button onClick={() => setNewMail(true)}><Icon name="plus" /> New e-mail</Button>}
        </div>
      </PageHead>

      <div className="wa-shell">
        <div className="panel wa-list-pane">
          <div className="panel-head"><h3>Conversations</h3><span className="tiny muted">{filtered.length} shown</span></div>
          <div className="wa-conv-list">
            {loading && <div className="panel-body"><TableSkeleton rows={6} cols={2} /></div>}
            {!loading && !filtered.length && <Empty title="No e-mail conversations match">E-mail sent from here and patient e-mail that reaches CareDesk appear here.</Empty>}
            {filtered.map((t) => (
              <div key={t.patient_id} className={`wa-conv-item ${active?.patient_id === t.patient_id ? 'active' : ''} ${t.needs_reply ? 'unread' : ''}`} onClick={() => select(t.patient_id)}>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <div className="row gap-6" style={{ minWidth: 0 }}>
                    {t.needs_reply && <span className="dot" style={{ color: 'var(--warn)' }} title="Awaiting reply" />}
                    <span className="strong truncate">{t.patient_name}</span>
                  </div>
                  <span className="tiny faint nowrap">{ago(t.last_message_at)}</span>
                </div>
                <div className="row gap-6 mt-4 wrap">
                  <span className="tiny muted truncate">{t.patient_email || t.patient_mrn}</span>
                  {t.case_no && <span className="mono tiny strong">{t.case_no}</span>}
                  {t.case_stage && <StageBadge stage={t.case_stage} />}
                  {t.priority === 'urgent' && <PriorityBadge priority="urgent" />}
                  {t.needs_reply ? <Badge kind="warn">Needs reply</Badge> : <Badge kind="neutral">Replied</Badge>}
                </div>
                <div className="small truncate mt-4">{t.last_subject || '(no subject)'}</div>
                <div className="small muted truncate">{t.last_direction === 'outbound' ? <span className="faint">You: </span> : null}{t.last_body || '–'}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="panel wa-thread-pane">
          {!active ? <Empty title="Select an e-mail conversation">Choose a patient on the left, or start a new e-mail.</Empty> : (
            <>
              <div className="wa-thread-head">
                <div className="col" style={{ gap: 2, minWidth: 0 }}>
                  <div className="row gap-8 wrap">
                    <Link to={`/patients/${active.patient_id}`} className="strong" style={{ fontSize: 14 }}>{active.patient_name}</Link>
                    <span className="mono tiny muted">{active.patient_mrn}</span>
                    <span className="small">{active.patient_email || <span className="warn-text">no e-mail on file</span>}</span>
                  </div>
                  <div className="row gap-8 wrap small">
                    {active.case_id ? <><span>Case: <Link to={`/cases/${active.case_id}`} className="mono strong">{active.case_no}</Link></span><StageBadge stage={active.case_stage} /></>
                      : <span className="tiny muted">No open case linked to this patient</span>}
                  </div>
                </div>
                {active.case_id && <Button size="sm" onClick={() => nav(`/cases/${active.case_id}`)}><Icon name="folder" /> Open case</Button>}
              </div>

              <div className="wa-messages">
                {msgLoading && <TableSkeleton rows={4} cols={1} />}
                {!msgLoading && !(messages || []).length && <Empty title="No e-mail in this thread yet" />}
                {(messages || []).map((m) => {
                  const out = m.direction === 'outbound';
                  const status = m.meta?.delivery_status || (out ? 'sent' : 'received');
                  return (
                    <div key={m.id} className={`wa-bubble-row ${out ? 'outbound' : 'inbound'}`}>
                      <div className={`wa-bubble ${out ? 'outbound' : 'inbound'}`}>
                        <div className="wa-bubble-meta">
                          <span className="strong">{out ? (m.actor_label || 'CareDesk') : (m.actor_label || active.patient_name || 'Patient')}</span>
                          {m.template_id && <Badge kind="info">Template</Badge>}
                          <span className="mono">{dt(m.occurred_at)}</span>
                        </div>
                        <div className="small strong" style={{ marginBottom: 3 }}>{m.meta?.subject || String(m.summary || '').replace(/^Email: /, '') || '(no subject)'}</div>
                        <div className="wa-bubble-body">{m.body || '–'}</div>
                        {out && <div className="wa-bubble-foot"><span className={`tiny ${status === 'failed' || status === 'unknown' ? 'warn-text' : 'faint'}`}>{STATUS[status] || status}{m.meta?.to ? ` · to ${m.meta.to}` : ''}</span></div>}
                      </div>
                    </div>
                  );
                })}
                <div ref={endRef} />
              </div>

              {isOps ? (
                <form className="wa-composer" onSubmit={send}>
                  {!active.patient_email && <div className="tiny warn-text mb-8">This patient has no e-mail address. Use New e-mail to type one; it is saved on the patient.</div>}
                  <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" aria-label="Subject" maxLength={200} />
                  <div className="row gap-8 mt-8" style={{ alignItems: 'flex-end' }}>
                    <textarea rows={4} className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder={`Write to ${active.patient_name}…`} maxLength={20000} />
                    <Button kind="primary" type="submit" disabled={sending || !text.trim() || !subject.trim() || !active.patient_email}><Icon name="send" /> {sending ? 'Sending…' : 'Send'}</Button>
                  </div>
                </form>
              ) : <div className="wa-composer tiny muted">Read-only view for your role. Operations staff reply from this bar.</div>}
            </>
          )}
        </div>
      </div>

      {newMail && <NewEmailModal onClose={() => setNewMail(false)} onSent={(patientId) => { setNewMail(false); reload(); if (patientId) select(patientId); }} />}
    </>
  );
}

function NewEmailModal({ onClose, onSent }) {
  const toast = useToast();
  const [term, setTerm] = useState('');
  const t = useDebounced(term.trim(), 300);
  const [patient, setPatient] = useState(null);
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const found = useLoad(async () => {
    if (t.length < 2) return [];
    const base = db.from('v_patients').select('id,full_name,mrn,email,locality');
    return (await q((t.includes('@') ? base.ilike('email', `%${t}%`) : base.ilike('full_name', `%${t}%`)).order('full_name').limit(8))) || [];
  }, [t]);

  const pick = (p) => { setPatient(p); setTo(p.email || ''); };
  const send = async () => {
    if (!patient) return;
    setSending(true);
    try {
      const r = await sendEmail({ patient_id: patient.id, to: to.trim() || null, subject: subject.trim(), text: text.trim() });
      if (r.delivery?.status === 'sent') toast(`E-mail sent to ${r.to}`);
      else toast.error(`${STATUS[r.delivery?.status] || 'Not sent'}${r.delivery?.error ? ': ' + r.delivery.error : ''}`);
      onSent(r.patient_id);
    } catch (err) { toast.error(err.message); }
    setSending(false);
  };

  return (
    <Modal title="New e-mail" onClose={onClose} footer={<><Button kind="ghost" onClick={onClose}>Cancel</Button>
      <Button kind="primary" onClick={send} disabled={sending || !patient || !to.trim() || !subject.trim() || !text.trim()}><Icon name="send" /> {sending ? 'Sending…' : 'Send'}</Button></>}>
      {!patient ? (
        <>
          <Field label="Patient" hint="name, or part of the e-mail address"><Input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Search patient" /></Field>
          {found.loading && t.length >= 2 ? <TableSkeleton rows={3} cols={2} /> : (found.data || []).map((p) => (
            <div key={p.id} className="list-row click" onClick={() => pick(p)}>
              <span className="strong">{p.full_name}</span> <span className="mono tiny muted">{p.mrn}</span>
              <span className="tiny muted"> · {p.email || 'no e-mail on file'}{p.locality ? ` · ${p.locality}` : ''}</span>
            </div>
          ))}
          {t.length >= 2 && !found.loading && !(found.data || []).length && <div className="small muted">No patient found. Register the patient on an enquiry first.</div>}
        </>
      ) : (
        <div className="col gap-12">
          <div className="row between"><span><span className="strong">{patient.full_name}</span> <span className="mono tiny muted">{patient.mrn}</span></span>
            <Button size="sm" kind="ghost" onClick={() => setPatient(null)}>Change</Button></div>
          <Field label="To" hint={patient.email ? undefined : 'saved on the patient'}><Input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@example.com" /></Field>
          <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} /></Field>
          <Field label="Message"><textarea rows={8} value={text} onChange={(e) => setText(e.target.value)} maxLength={20000} /></Field>
          <div className="tiny muted">Sent from the CareDesk support address. The case number is added to the subject so replies stay on the case.</div>
        </div>
      )}
    </Modal>
  );
}
