import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useAuth } from '../lib/auth.jsx';
import { useLoad } from '../lib/hooks.js';
import { ago, dateTime as dt } from '../lib/fmt.js';
import { aiExtract, dial, sendWhatsAppChat, whatsappSession } from '../lib/api.js';
import Icon from '../components/icons.jsx';
import { Badge, Button, Countdown, Empty, Field, Input, Modal, PageHead, PriorityBadge, Segmented, TableSkeleton, SlaBadge, StageBadge, useToast } from '../components/ui.jsx';

const QUICK_REPLIES = [
  { label: 'Acknowledge enquiry', text: 'Namaste, thank you for contacting Hinduja Home Care. Our care desk is reviewing your request and will share the rate-card estimate shortly.' },
  { label: 'Ask address & pincode', text: 'Please share the complete patient address with flat/building name, nearest landmark, and 6-digit Mumbai pincode so we can check slot availability.' },
  { label: 'Ask prescription', text: 'Please reply here with a clear photo of the doctor prescription or test list so our team can add the exact services.' },
  { label: 'Confirm morning slot', text: 'We have noted your preference for the morning slot. Our coordinator will assign the field technician and share the ETA shortly.' },
];

export default function Whatsapp() {
  const { profile, can } = useAuth();
  const isOps = can('agent', 'coordinator', 'supervisor', 'medical_desk', 'client_manager', 'admin');
  const toast = useToast();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();

  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [mode, setMode] = useState('reply'); // 'reply' | 'template'
  const [text, setText] = useState('');
  const [tplId, setTplId] = useState('');
  const [preview, setPreview] = useState('');
  const [sending, setSending] = useState(false);
  const [dialing, setDialing] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [extractedModal, setExtractedModal] = useState(null);
  const [newChatModal, setNewChatModal] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearBusy, setClearBusy] = useState(false);
  const threadEndRef = useRef(null);

  const { data, loading, reload } = useLoad(async () => {
    const [chats, templates, services, session] = await Promise.all([
      q(db.from('v_whatsapp_chats').select('*').order('last_message_at', { ascending: false }).limit(200)),
      q(db.from('templates').select('*').eq('kind', 'whatsapp').eq('status', 'approved').order('code')),
      q(db.from('services').select('id,code,name,category,price').eq('active', true).order('category')),
      whatsappSession().catch(() => null),
    ]);
    return { chats: chats || [], templates: templates || [], services: services || [], session };
  }, [profile?.id], ['interactions', 'cases', 'patients', 'sla_timers', 'integration_settings']);

  const chats = data?.chats || [];
  const templates = data?.templates || [];
  const services = data?.services || [];
  const waSession = data?.session || null;

  const filtered = useMemo(() => {
    return chats.filter((c) => {
      if (filter === 'needs_reply' && !c.needs_reply) return false;
      if (filter === 'open' && (!c.case_id || ['closed', 'cancelled'].includes(c.case_stage))) return false;
      if (filter === 'mine' && c.owner_id !== profile?.id) return false;
      if (search) {
        const s = search.toLowerCase();
        const hay = `${c.patient_name || ''} ${c.case_no || ''} ${c.patient_mrn || ''} ${c.patient_mobile || ''} ${c.last_body || ''} ${c.patient_locality || ''}`.toLowerCase();
        if (!hay.includes(s)) return false;
      }
      return true;
    });
  }, [chats, filter, search, profile?.id]);

  const selectedPatientId = params.get('patient') || filtered[0]?.patient_id || chats[0]?.patient_id || null;
  const activeChat = useMemo(
    () => chats.find((c) => c.patient_id === selectedPatientId) || filtered[0] || null,
    [chats, filtered, selectedPatientId]
  );

  const selectChat = (patientId) => {
    const next = new URLSearchParams(params);
    next.set('patient', patientId);
    setParams(next, { replace: true });
  };

  // Load full WhatsApp message history for the selected patient
  const { data: messages, loading: msgLoading, reload: reloadMsgs } = useLoad(async () => {
    if (!activeChat?.patient_id) return [];
    const rows = await q(
      db.from('interactions')
        .select('*')
        .eq('channel', 'whatsapp')
        .eq('patient_id', activeChat.patient_id)
        .order('occurred_at', { ascending: true })
        .limit(200)
    );
    return rows || [];
  }, [activeChat?.patient_id, activeChat?.last_message_id], ['interactions']);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages?.length, activeChat?.patient_id]);

  useEffect(() => {
    if (!tplId && templates.length) setTplId(templates[0].id);
  }, [templates, tplId]);

  useEffect(() => {
    if (!tplId || !activeChat) { setPreview(''); return; }
    const t = templates.find((x) => x.id === tplId);
    if (activeChat.case_id) {
      rpc('render_template', { p_template: tplId, p_case: activeChat.case_id })
        .then((r) => setPreview(r || t?.body || ''))
        .catch(() => setPreview(t?.body || ''));
    } else {
      setPreview((t?.body || '').replace(/\{\{patient_name\}\}/g, activeChat.patient_name || '').replace(/\{\{caller_name\}\}/g, activeChat.patient_name || ''));
    }
  }, [tplId, activeChat?.case_id, activeChat?.patient_id, templates]);

  const send = async (e) => {
    if (e) e.preventDefault();
    if (!activeChat || sending) return;
    if (mode === 'reply' && !text.trim()) {
      toast.error('Write a WhatsApp reply first');
      return;
    }
    if (mode === 'template' && !tplId) {
      toast.error('Pick an approved WhatsApp template');
      return;
    }
    setSending(true);
    try {
      const res = await sendWhatsAppChat({
        case_id: activeChat.case_id || null,
        patient_id: activeChat.patient_id,
        template_id: mode === 'template' ? tplId : null,
        text: mode === 'reply' ? text.trim() : null,
      });
      if (mode === 'reply') setText('');
      if (res?.delivery?.error) toast(`Logged in CRM; WhatsApp gateway reported: ${res.delivery.error}`, 'error');
      else if (res?.delivery?.queued) toast('WhatsApp message queued for instant delivery');
      else if (res?.delivery?.skipped) toast(`Reply logged (${res.delivery.skipped})`);
      else toast('WhatsApp message sent');
      reload();
      reloadMsgs();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setSending(false);
    }
  };

  const callPatient = async () => {
    if (!activeChat || dialing) return;
    setDialing(true);
    try {
      await dial(activeChat.case_id ? { case_id: activeChat.case_id } : { patient_id: activeChat.patient_id });
      toast('Ringing your phone via MyOperator. Answer to connect to the patient.');
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDialing(false);
    }
  };

  const extractFromThread = async () => {
    if (!activeChat || extracting) return;
    const inboundText = (messages || [])
      .filter((m) => m.direction === 'inbound')
      .map((m) => m.body || m.summary)
      .filter(Boolean)
      .join('\n');
    if (!inboundText) {
      toast('No inbound patient messages to extract from');
      return;
    }
    setExtracting(true);
    try {
      const ex = await aiExtract(inboundText);
      setExtractedModal({
        patient_id: activeChat.patient_id,
        case_id: activeChat.case_id,
        patient_name: ex.patient?.full_name || activeChat.patient_name || '',
        age: ex.patient?.age || '',
        gender: ex.patient?.gender || '',
        locality: ex.patient?.locality || activeChat.patient_locality || '',
        pincode: ex.patient?.pincode || activeChat.patient_pincode || '',
        address: ex.patient?.address || activeChat.patient_address || '',
        landmark: ex.patient?.landmark || '',
        priority: ex.priority || activeChat.priority || 'routine',
        services_requested: (ex.service_codes || []).join(', ') || inboundText.slice(0, 240),
        service_ids: ex.service_ids || [],
        clinical_red_flag: ex.clinical_red_flag || null,
      });
    } catch (err) {
      toast.error(err.message);
    } finally {
      setExtracting(false);
    }
  };
  const doClear = async () => {
    setClearBusy(true);
    try {
      await rpc('cleanup_whatsapp_autogen', {});
      setConfirmClear(false);
      toast('Autogenerated WhatsApp contacts and chats removed');
      reload();
    } catch (e) {
      toast.error(e.message);
    } finally {
      setClearBusy(false);
    }
  };

  const waitingCount = chats.filter((c) => c.needs_reply).length;

  const connLabel = waSession?.waba_configured ? 'WABA configured' : 'Missing WABA credentials';

  return (
    <>
      <PageHead
        title="WhatsApp chats"
        sub={`Two-way WhatsApp inbox · ${connLabel} · ${waitingCount} awaiting reply · 5-minute SLA acknowledgement`}
      >
        <div className="row gap-8 wrap">
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search patient, Case ID, locality, message…" aria-label="Search conversations" />
          <Segmented
            value={filter}
            onChange={setFilter}
            options={[
              ['all', `All (${chats.length})`],
              ['needs_reply', `Awaiting reply (${waitingCount})`],
              ['open', 'Open case'],
              ['mine', 'My queue'],
            ]}
          />
          {isOps && (
            <Button onClick={() => setNewChatModal(true)}>
              <Icon name="plus" /> New chat
            </Button>
          )}
          {isOps && <Badge kind={waSession?.waba_configured ? 'info' : 'warn'}>{connLabel}</Badge>}
          {can('admin', 'supervisor') && (
            <Button kind="ghost" onClick={() => setConfirmClear(true)} disabled={clearBusy} title="Remove autogenerated WhatsApp contacts and chats">
              Clear WhatsApp data
            </Button>
          )}
        </div>
      </PageHead>

      {confirmClear && (
        <Modal
          title="Clear autogenerated WhatsApp data?"
          onClose={() => setConfirmClear(false)}
          footer={
            <>
              <Button kind="ghost" onClick={() => setConfirmClear(false)} disabled={clearBusy}>Cancel</Button>
              <Button kind="danger" onClick={doClear} disabled={clearBusy}>
                {clearBusy ? 'Removing…' : 'Yes, remove WhatsApp data'}
              </Button>
            </>
          }
        >
          <p>This will remove all autogenerated WhatsApp chat threads and the patient profiles that were auto-created from WhatsApp chat history.</p>
          <p style={{ marginTop: 8 }}>Legitimate clinical cases, phone calls, and manual patient records will NOT be affected.</p>
        </Modal>
      )}

      {isOps && <div className="banner mb-12"><span>QR scanning is disabled for enterprise compliance. Use MyOperator WABA; an administrator can configure and test it in Settings &gt; Telephony.</span></div>}

      <div className="wa-shell">
        {/* Left pane: conversation list */}
        <div className="panel wa-list-pane">
          <div className="panel-head">
            <h3>Conversations</h3>
            <span className="tiny muted">{filtered.length} shown</span>
          </div>
          <div className="wa-conv-list">
            {loading && <div className="panel-body"><TableSkeleton rows={6} cols={2} /></div>}
            {!loading && filtered.length === 0 && (
              <Empty
                icon="chat"
                title="No WhatsApp conversations match"
                detail="Inbound WhatsApp enquiries and template messages sent from cases appear here automatically."
              />
            )}
            {filtered.map((c) => {
              const active = activeChat?.patient_id === c.patient_id;
              return (
                <div
                  key={c.patient_id}
                  className={`wa-conv-item ${active ? 'active' : ''} ${c.needs_reply ? 'unread' : ''}`}
                  onClick={() => selectChat(c.patient_id)}
                >
                  <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div className="row gap-6" style={{ minWidth: 0 }}>
                      {c.needs_reply && <span className="dot" style={{ color: 'var(--warn)' }} title="Awaiting reply" />}
                      <span className="strong truncate">{c.patient_name}</span>
                    </div>
                    <span className="tiny faint nowrap">{ago(c.last_message_at)}</span>
                  </div>

                  <div className="row gap-6 mt-4 wrap">
                    <span className="mono tiny muted">{c.patient_mobile || c.patient_mrn}</span>
                    {c.case_no && <span className="mono tiny strong">{c.case_no}</span>}
                    {c.case_stage && <StageBadge stage={c.case_stage} />}
                    {c.priority === 'urgent' && <PriorityBadge priority="urgent" />}
                    {c.needs_reply ? (
                      <Badge kind="warn">Needs reply</Badge>
                    ) : (
                      <Badge kind="neutral">Replied</Badge>
                    )}
                  </div>

                  <div className="small muted truncate mt-4">
                    {c.last_direction === 'outbound' ? <span className="faint">You: </span> : null}
                    {c.last_body || c.last_summary || '–'}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right pane: active chat thread & composer */}
        <div className="panel wa-thread-pane">
          {!activeChat ? (
            <Empty icon="chat" title="Select a WhatsApp conversation" detail="Choose a patient on the left to read the thread or send an approved template." />
          ) : (
            <>
              <div className="wa-thread-head">
                <div className="col" style={{ gap: 2, minWidth: 0 }}>
                  <div className="row gap-8 wrap">
                    <Link to={`/patients/${activeChat.patient_id}`} className="strong" style={{ fontSize: 14 }}>
                      {activeChat.patient_name}
                    </Link>
                    <span className="mono tiny muted">{activeChat.patient_mrn}</span>
                    <span className="mono small">{activeChat.patient_mobile || '–'}</span>
                    {activeChat.patient_locality && (
                      <span className="tiny muted">· {activeChat.patient_locality}{activeChat.patient_pincode ? ` (${activeChat.patient_pincode})` : ''}</span>
                    )}
                    {activeChat.window_open ? (
                      <Badge kind="ok" title="Patient messaged within the last 24 hours; free-text session replies are open">24h session open</Badge>
                    ) : (
                      <Badge kind="neutral" title="More than 24 hours since last inbound message; use an approved WABA template to re-open">Template window</Badge>
                    )}
                  </div>
                  <div className="row gap-8 wrap small">
                    {activeChat.case_id ? (
                      <>
                        <span>Active case: <Link to={`/cases/${activeChat.case_id}`} className="mono strong">{activeChat.case_no}</Link></span>
                        <StageBadge stage={activeChat.case_stage} />
                        <SlaBadge state={activeChat.sla_state} />
                        {activeChat.next_sla_due && (
                          <span className="tiny muted">SLA ({activeChat.next_sla_key}): <Countdown due={activeChat.next_sla_due} /></span>
                        )}
                        {activeChat.services_requested && (
                          <span className="tiny muted truncate" style={{ maxWidth: 320 }}>· {activeChat.services_requested}</span>
                        )}
                      </>
                    ) : (
                      <span className="tiny muted">No open case linked to this patient</span>
                    )}
                  </div>
                </div>

                <div className="row gap-6 wrap">
                  {isOps && (
                    <Button size="sm" onClick={callPatient} disabled={dialing}>
                      <Icon name="phone" /> {dialing ? 'Dialing…' : 'Call'}
                    </Button>
                  )}
                  {isOps && (
                    <Button size="sm" onClick={extractFromThread} disabled={extracting}>
                      <Icon name="ai" /> {extracting ? 'Extracting…' : 'AI extract'}
                    </Button>
                  )}
                  {activeChat.case_id ? (
                    <Button size="sm" onClick={() => nav(`/cases/${activeChat.case_id}`)}>
                      <Icon name="folder" /> Open case
                    </Button>
                  ) : (
                    isOps && (
                      <Button size="sm" kind="primary" onClick={() => nav('/console')}>
                        <Icon name="plus" /> New enquiry
                      </Button>
                    )
                  )}
                </div>
              </div>

              <div className="wa-messages">
                {msgLoading && <TableSkeleton rows={4} cols={1} />}
                {!msgLoading && (messages || []).length === 0 && (
                  <Empty icon="chat" title="No messages in this thread yet" detail="Send an approved WhatsApp template or reply below." />
                )}
                {(messages || []).map((m) => {
                  const outbound = m.direction === 'outbound';
                  const status = m.meta?.delivery_status || (outbound ? 'sent' : 'received');
                  return (
                    <div key={m.id} className={`wa-bubble-row ${outbound ? 'outbound' : 'inbound'}`}>
                      <div className={`wa-bubble ${outbound ? 'outbound' : 'inbound'}`}>
                        <div className="wa-bubble-meta">
                          <span className="strong">{outbound ? (m.actor_label || 'CareDesk') : (activeChat.patient_name || 'Patient')}</span>
                          {m.template_id && <Badge kind="info">Template</Badge>}
                          <span className="mono">{dt(m.occurred_at)}</span>
                        </div>
                        {m.summary && m.body && m.summary !== 'WhatsApp message received' && m.summary !== 'WhatsApp reply sent' && (
                          <div className="tiny muted" style={{ marginBottom: 3 }}>{m.summary}</div>
                        )}
                        <div className="wa-bubble-body">{m.body || m.summary || '–'}</div>
                        {outbound && (
                          <div className="wa-bubble-foot">
                            <span className="tiny faint">
                              {status === 'read' ? 'Read' : status === 'delivered' ? 'Delivered' : status === 'queued' ? 'Sending…' : status === 'failed' ? 'Delivery failed' : 'Sent via WhatsApp'}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div ref={threadEndRef} />
              </div>

              {isOps ? (
                <form className="wa-composer" onSubmit={send}>
                  <div className="row gap-8 wrap" style={{ justifyContent: 'space-between' }}>
                    <div className="row gap-8 wrap">
                      <Segmented
                        value={mode}
                        onChange={setMode}
                        options={[
                          ['reply', 'Free-text reply'],
                          ['template', `Approved template (${templates.length})`],
                        ]}
                      />
                      {mode === 'reply' && (
                        <div className="row gap-4 wrap">
                          {QUICK_REPLIES.map((qr) => (
                            <button
                              key={qr.label}
                              type="button"
                              className="chip"
                              onClick={() => setText((prev) => (prev ? `${prev}\n${qr.text}` : qr.text))}
                            >
                              + {qr.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                    {!activeChat.window_open && mode === 'reply' && !waSession?.connected && (
                      <span className="tiny warn-text">Last inbound message was over 24h ago · use an approved template if session is expired</span>
                    )}
                  </div>

                  {mode === 'reply' ? (
                    <div className="row gap-8 mt-8" style={{ alignItems: 'flex-end' }}>
                      <textarea
                        rows={2}
                        className="grow"
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            send();
                          }
                        }}
                        placeholder={`Reply to ${activeChat.patient_name} on WhatsApp (Enter to send, Shift+Enter for new line)…`}
                      />
                      <Button kind="primary" type="submit" disabled={sending || !text.trim()}>
                        <Icon name="send" /> {sending ? 'Sending…' : 'Send'}
                      </Button>
                    </div>
                  ) : (
                    <div className="col gap-8 mt-8">
                      <div className="row gap-8">
                        <select className="grow" value={tplId} onChange={(e) => setTplId(e.target.value)}>
                          {templates.map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.code} · {t.title} ({t.category})
                            </option>
                          ))}
                        </select>
                        <Button kind="primary" type="submit" disabled={sending || !tplId}>
                          <Icon name="send" /> {sending ? 'Sending…' : 'Send template'}
                        </Button>
                      </div>
                      <pre className="wa-tpl-preview">{preview || '–'}</pre>
                    </div>
                  )}
                </form>
              ) : (
                <div className="wa-composer tiny muted">Read-only view for your role. Operations staff reply from this bar.</div>
              )}
            </>
          )}
        </div>
      </div>

      {newChatModal && (
        <NewWhatsAppChatModal
          templates={templates}
          onClose={() => setNewChatModal(false)}
          onSent={(patientId) => {
            setNewChatModal(false);
            reload();
            if (patientId) selectChat(patientId);
          }}
        />
      )}

      {extractedModal && (
        <ExtractedEnquiryModal
          initial={extractedModal}
          services={services}
          onClose={() => setExtractedModal(null)}
          onSaved={(caseId) => {
            setExtractedModal(null);
            reload();
            if (caseId) nav(`/cases/${caseId}`);
          }}
        />
      )}
    </>
  );
}

function ExtractedEnquiryModal({ initial, services, onClose, onSaved }) {
  const [f, setF] = useState(initial);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (k, v) => setF((prev) => ({ ...prev, [k]: v }));
  const toggleSvc = (id) =>
    setF((prev) => ({
      ...prev,
      service_ids: prev.service_ids.includes(id) ? prev.service_ids.filter((x) => x !== id) : [...prev.service_ids, id],
    }));

  const save = async () => {
    setBusy(true);
    try {
      await db.from('patients').update({
        full_name: f.patient_name || undefined,
        age: f.age ? Number(f.age) : undefined,
        gender: f.gender || undefined,
        locality: f.locality || undefined,
        pincode: f.pincode || undefined,
        address: f.address || undefined,
        landmark: f.landmark || undefined,
      }).eq('id', f.patient_id);

      if (f.case_id) {
        await db.from('cases').update({
          address: f.address || undefined,
          pincode: f.pincode || undefined,
          priority: f.priority,
          services_requested: f.services_requested,
        }).eq('id', f.case_id);
        for (const sid of f.service_ids) {
          await db.from('case_items').insert({ case_id: f.case_id, service_id: sid }).catch(() => {});
        }
        toast('Patient and case updated from WhatsApp chat');
        onSaved(f.case_id);
      } else {
        const r = await rpc('create_enquiry', {
          p: {
            source_channel: 'whatsapp',
            priority: f.priority,
            services_requested: f.services_requested,
            service_ids: f.service_ids,
            consent: true,
            patient: {
              patient_id: f.patient_id,
              full_name: f.patient_name,
              age: f.age,
              gender: f.gender,
              address: f.address,
              locality: f.locality,
              pincode: f.pincode,
              landmark: f.landmark,
            },
          },
        });
        toast(`Case ${r.case_no} created from WhatsApp thread`);
        onSaved(r.case_id);
      }
    } catch (e) {
      toast.error(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={f.case_id ? 'Update case from WhatsApp messages' : 'Create enquiry from WhatsApp messages'}
      onClose={onClose}
      wide
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : f.case_id ? 'Update case & patient' : 'Create case'}
          </Button>
        </>
      }
    >
      {f.clinical_red_flag && (
        <div className="banner danger mb-12">
          <Icon name="alert" /> <strong>{f.clinical_red_flag}</strong>
        </div>
      )}
      <div className="form-grid">
        <Field label="Patient name"><input value={f.patient_name} onChange={(e) => set('patient_name', e.target.value)} /></Field>
        <Field label="Age"><input type="number" value={f.age} onChange={(e) => set('age', e.target.value)} /></Field>
        <Field label="Gender">
          <select value={f.gender} onChange={(e) => set('gender', e.target.value)}>
            <option value="">–</option><option value="M">M</option><option value="F">F</option><option value="O">O</option>
          </select>
        </Field>
        <Field label="Priority">
          <select value={f.priority} onChange={(e) => set('priority', e.target.value)}>
            <option value="routine">Routine</option><option value="urgent">Urgent</option>
          </select>
        </Field>
        <Field label="Locality"><input value={f.locality} onChange={(e) => set('locality', e.target.value)} /></Field>
        <Field label="Pincode"><input value={f.pincode} onChange={(e) => set('pincode', e.target.value)} /></Field>
        <Field label="Address" span={2}><input value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
        <Field label="Landmark" span={2}><input value={f.landmark} onChange={(e) => set('landmark', e.target.value)} /></Field>
        <Field label="Services requested" span={2}><input value={f.services_requested} onChange={(e) => set('services_requested', e.target.value)} /></Field>
      </div>
      <div className="mt-12">
        <div className="tiny muted upper" style={{ fontWeight: 600, marginBottom: 6 }}>Rate-card services detected</div>
        <div className="row gap-6 wrap">
          {services.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`chip ${f.service_ids.includes(s.id) ? 'active' : ''}`}
              onClick={() => toggleSvc(s.id)}
            >
              {s.name} {Number(s.price) > 0 ? `· ₹${s.price}` : ''}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function NewWhatsAppChatModal({ templates, onClose, onSent }) {
  const [mobile, setMobile] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState('reply');
  const [text, setText] = useState(QUICK_REPLIES[0].text);
  const [tplId, setTplId] = useState(templates[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async (e) => {
    if (e) e.preventDefault();
    if (!mobile.trim()) {
      toast.error('Enter the 10-digit WhatsApp mobile number');
      return;
    }
    if (mode === 'reply' && !text.trim()) {
      toast.error('Enter a message to send');
      return;
    }
    setBusy(true);
    try {
      const res = await sendWhatsAppChat({
        mobile: mobile.trim(),
        patient_name: name.trim() || null,
        template_id: mode === 'template' ? tplId : null,
        text: mode === 'reply' ? text.trim() : null,
      });
      toast('WhatsApp conversation started');
      onSent(res?.patient_id || null);
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Start new WhatsApp chat"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button kind="primary" onClick={submit} disabled={busy}>
            <Icon name="send" /> {busy ? 'Sending…' : 'Send WhatsApp message'}
          </Button>
        </>
      }
    >
      <form className="col gap-12" onSubmit={submit}>
        <div className="form-grid">
          <Field label="WhatsApp mobile number" hint="10-digit mobile or +91 format">
            <input
              className="mono"
              value={mobile}
              onChange={(e) => setMobile(e.target.value)}
              placeholder="+91 98200 XXXXX"
              autoFocus
            />
          </Field>
          <Field label="Patient / contact name" hint="Optional">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Mr. Rajesh Mehta"
            />
          </Field>
        </div>

        <div className="row gap-8 wrap" style={{ justifyContent: 'space-between' }}>
          <Segmented
            value={mode}
            onChange={setMode}
            options={[
              ['reply', 'Direct message'],
              ['template', `Approved template (${templates.length})`],
            ]}
          />
          {mode === 'reply' && (
            <div className="row gap-4 wrap">
              {QUICK_REPLIES.map((qr) => (
                <button
                  key={qr.label}
                  type="button"
                  className="chip"
                  onClick={() => setText(qr.text)}
                >
                  {qr.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {mode === 'reply' ? (
          <Field label="Message">
            <textarea
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Write your WhatsApp message…"
            />
          </Field>
        ) : (
          <Field label="Approved WhatsApp template">
            <select value={tplId} onChange={(e) => setTplId(e.target.value)}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} · {t.title} ({t.category})
                </option>
              ))}
            </select>
          </Field>
        )}
      </form>
    </Modal>
  );
}

