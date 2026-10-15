import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { dateTime } from '../lib/fmt.js';
import { sendWhatsAppChat, sendMessage } from '../lib/api.js';
import { db, q, rpc } from '../lib/db.js';
import { useLoad } from '../lib/hooks.js';
import { Button, Input, Select, Segmented, Badge, Skeleton, Empty, useAction } from './ui.jsx';
import Icon from './icons.jsx';

const DASH = '–';

export function WhatsAppChat({ c, rows = [], loading = false, canAct = false, templates = [] }) {
  const nav = useNavigate();
  const [run, busy] = useAction();
  const [mode, setMode] = useState('reply'); // 'reply' | 'template'
  const [text, setText] = useState('');
  const [tplId, setTplId] = useState('');
  const [preview, setPreview] = useState('');
  const [previewing, setPreviewing] = useState(false);

  // Load approved templates if not supplied via props
  const dbTemplates = useLoad(() => (!templates.length ? q(db.from('templates').select('*').eq('kind', 'whatsapp').eq('status', 'approved').order('code')) : null), []);
  const allTemplates = useMemo(() => {
    const list = templates.length ? templates : (dbTemplates.data || []);
    return list.filter((t) => t.kind === 'whatsapp' && t.status === 'approved');
  }, [templates, dbTemplates.data]);

  // Set default template when templates load
  useEffect(() => {
    if (!tplId && allTemplates.length > 0) {
      setTplId(allTemplates[0].id);
    }
  }, [allTemplates, tplId]);

  // Render preview whenever template or case changes
  useEffect(() => {
    if (mode !== 'template' || !tplId || !c?.id) {
      setPreview('');
      return;
    }
    let active = true;
    setPreviewing(true);
    rpc('render_template', { p_template: tplId, p_case: c.id })
      .then((res) => {
        if (active) setPreview(res || '');
      })
      .catch(() => {
        if (active) {
          const t = allTemplates.find((x) => x.id === tplId);
          setPreview(t?.body || '');
        }
      })
      .finally(() => {
        if (active) setPreviewing(false);
      });
    return () => { active = false; };
  }, [mode, tplId, c?.id, allTemplates]);

  const ordered = useMemo(() => {
    return [...rows].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  }, [rows]);

  const sendReply = async (e) => {
    if (e) e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    const r = await run(() => sendWhatsAppChat({ case_id: c.id, patient_id: c.patient_id, text: trimmed }), 'WhatsApp reply sent');
    if (r !== undefined) setText('');
  };

  const sendTpl = async (e) => {
    if (e) e.preventDefault();
    if (!tplId || busy) return;
    const t = allTemplates.find((x) => x.id === tplId);
    const r = await run(() => sendMessage(c.id, tplId), `${t?.title || 'Template'} sent · ${t?.code || ''}`);
    if (r !== undefined) setMode('reply');
  };

  const pickTemplate = (code) => {
    const found = allTemplates.find((t) => t.code === code);
    if (found) {
      setTplId(found.id);
      setMode('template');
    }
  };

  return (
    <div className="col gap-12">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="tiny muted">WhatsApp Business (WABA) thread for {c.patient_name} · <span className="mono">{c.case_no}</span></span>
        <Button size="xs" icon="chat" onClick={() => nav(`/whatsapp?patient=${c.patient_id}`)}>Open full WhatsApp inbox</Button>
      </div>

      {loading ? <Skeleton lines={4} /> : ordered.length ? (
        <div className="wa-messages" style={{ maxHeight: 320, border: '1px solid var(--line)', borderRadius: 3 }}>
          {ordered.map((m) => {
            const outbound = m.direction === 'outbound';
            return (
              <div key={m.id} className={`wa-bubble-row ${outbound ? 'outbound' : 'inbound'}`}>
                <div className={`wa-bubble ${outbound ? 'outbound' : 'inbound'}`}>
                  <div className="wa-bubble-meta">
                    <span className="strong">{outbound ? (m.actor_label || 'CareDesk') : (c.patient_name || 'Patient')}</span>
                    {m.template_id && <Badge kind="info">Template</Badge>}
                    <span className="mono">{dateTime(m.occurred_at)}</span>
                  </div>
                  <div className="wa-bubble-body">{m.body || m.summary || DASH}</div>
                </div>
              </div>
            );
          })}
        </div>
      ) : <Empty title="No WhatsApp messages on this case yet" />}

      {canAct && (
        <div className="col gap-8" style={{ borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <div className="row wrap gap-8" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
            <Segmented
              value={mode}
              onChange={setMode}
              options={[['reply', 'Direct reply'], ['template', `Approved template (${allTemplates.length})`]]}
            />
            {allTemplates.length > 0 && (
              <div className="row wrap gap-4">
                {allTemplates.some((t) => t.code === 'T-09') && (
                  <Button size="xs" kind={mode === 'template' && allTemplates.find((t) => t.id === tplId)?.code === 'T-09' ? 'primary' : 'ghost'} onClick={() => pickTemplate('T-09')}>T-09 Assessment</Button>
                )}
                {allTemplates.some((t) => t.code === 'T-10') && (
                  <Button size="xs" kind={mode === 'template' && allTemplates.find((t) => t.id === tplId)?.code === 'T-10' ? 'primary' : 'ghost'} onClick={() => pickTemplate('T-10')}>T-10 Final Bill</Button>
                )}
                {allTemplates.some((t) => t.code === 'T-04') && (
                  <Button size="xs" kind={mode === 'template' && allTemplates.find((t) => t.id === tplId)?.code === 'T-04' ? 'primary' : 'ghost'} onClick={() => pickTemplate('T-04')}>T-04 Booking</Button>
                )}
              </div>
            )}
          </div>

          {mode === 'reply' ? (
            <form className="row gap-8" onSubmit={sendReply}>
              <Input
                className="grow"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={`Reply to ${c.patient_name} on WhatsApp…`}
              />
              <Button kind="primary" type="submit" icon="send" disabled={busy || !text.trim()}>
                {busy ? 'Sending…' : 'Send WhatsApp'}
              </Button>
            </form>
          ) : (
            <form className="col gap-8" onSubmit={sendTpl}>
              <div className="row gap-8">
                <Select
                  className="grow"
                  value={tplId}
                  onChange={(e) => setTplId(e.target.value)}
                  options={allTemplates.map((t) => [t.id, `${t.code} · ${t.title}`])}
                />
                <Button kind="primary" type="submit" icon="send" disabled={busy || !tplId}>
                  {busy ? 'Sending…' : 'Send template'}
                </Button>
              </div>
              {previewing ? (
                <Skeleton lines={2} />
              ) : preview ? (
                <pre className="wa-tpl-preview">{preview}</pre>
              ) : null}
            </form>
          )}
        </div>
      )}
    </div>
  );
}

export default WhatsAppChat;
