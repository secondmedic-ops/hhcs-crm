import { useState } from 'react';
import { api } from '../api.ts';
import { db, q, isDemo } from '../lib/db.js';
import { useLoad } from '../lib/hooks.js';
import { dateTime } from '../lib/fmt.js';
import { Panel, Button, Empty, TableSkeleton, ErrorNote, Input, Textarea, useAction } from './ui.jsx';

export default function FeedbackRequests({ patientId }) {
  const [page, setPage] = useState(0);
  const [link, setLink] = useState(null);
  const [run, busy] = useAction();
  const load = useLoad(() => q(db.from('v_customer_feedback').select('*').eq('patient_id',patientId).eq('status','pending')
    .order('requested_at',{ ascending:false }).range(page*20,page*20+19)),[patientId,page],['feedback_requests']);
  const generate = r => run(async () => {
    if (isDemo) throw new Error('Feedback links are available on the live site or local test server');
    const result = await api.feedbackLink(r.id); setLink(result); load.reload();
  });
  return <Panel title="Feedback requests" sub="Separate requests for calls and delivered services. A new link replaces the previous link.">
    <ErrorNote error={load.error} />
    {load.loading ? <TableSkeleton rows={2} cols={2} /> : load.data?.length ? load.data.map(r => <div key={r.id} className="list-row wrap">
      <div className="grow small">{r.experience === 'service' ? 'Delivered service' : 'Call'} {dateTime(r.call_started_at)}<div className="tiny muted">{r.delivery_status === 'unconfigured' ? 'Automatic email needs a configured sender and a valid customer email' : `Email/link: ${r.delivery_status}`} · expires {dateTime(r.expires_at)}</div>{r.delivery_error && <div className="small feedback-error">{r.delivery_error}</div>}</div>
      <Button size="sm" disabled={busy || r.delivery_status === 'sending'} onClick={() => generate(r)}>Generate new link</Button>
    </div>) : !load.error && <Empty title="No pending feedback requests" />}
    {link && <div className="mt-12"><div className="small">Copy this private request to WhatsApp or email. Expires {dateTime(link.expires_at)}.</div><Input aria-label="Private feedback link" value={link.url} readOnly onFocus={e => e.target.select()} /><Button size="sm" onClick={() => run(() => navigator.clipboard.writeText(link.url),'Link copied')}>Copy link</Button><Textarea aria-label="Feedback request message" value={link.message} readOnly rows={7} /><Button size="sm" onClick={() => run(() => navigator.clipboard.writeText(link.message),'Message copied')}>Copy request message</Button></div>}
    {(page > 0 || load.data?.length === 20) && <div className="row mt-12"><Button disabled={!page} onClick={() => setPage(page-1)}>Previous</Button><Button disabled={load.data?.length !== 20} onClick={() => setPage(page+1)}>Next</Button></div>}
  </Panel>;
}
