import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { db, q } from '../lib/db.js';
import { useDebounced, useLoad } from '../lib/hooks.js';
import { dateTime } from '../lib/fmt.js';
import { PageHead, Panel, Input, Select, Field, Button, TableSkeleton, Empty, ErrorNote } from '../components/ui.jsx';

export function FeedbackHistory({ patientId, initialExperience = '' }) {
  const [search, setSearch] = useState('');
  const query = useDebounced(search);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rating, setRating] = useState('');
  const [page, setPage] = useState(0);
  const [experience, setExperience] = useState(initialExperience);
  const load = useLoad(() => {
    let s = db.from('v_customer_feedback').select('*').eq('status','submitted');
    if (patientId) s = s.eq('patient_id',patientId);
    if (experience) s = s.eq('experience',experience);
    // The builder binds values. Strip filter grammar; names are searched as literal substrings.
    const term = query.replace(/[%,()*\\]/g,'').slice(0,100);
    if (term) s = s.ilike('patient_name',`%${term}%`);
    if (from) s = s.gte('submitted_at',`${from}T00:00:00+05:30`);
    if (to) s = s.lte('submitted_at',`${to}T23:59:59.999999+05:30`);
    if (rating) s = s.eq('rating',Number(rating));
    return q(s.order('submitted_at',{ ascending:false }).range(page*50,page*50+49));
  }, [patientId,query,from,to,rating,page,experience], ['feedback_requests','feedback_responses']);
  const change = setter => e => { setter(e.target.value); setPage(0); };
  return <Panel title="Customer feedback" sub="Separate call and delivered-service ratings · times in IST">
    <div className="row wrap gap-12 mb-12">
      {!patientId && <Field label="Customer search"><Input value={search} onChange={change(setSearch)} placeholder="Customer name" /></Field>}
      <Field label="From"><Input type="date" value={from} onChange={change(setFrom)} /></Field>
      <Field label="To"><Input type="date" value={to} min={from} onChange={change(setTo)} /></Field>
      <Field label="Rating"><Select value={rating} onChange={change(setRating)} options={[["",'All ratings'], ...[1,2,3,4,5].map(n => [String(n),`${n} / 5`])]} /></Field>
      <Field label="Experience"><Select value={experience} onChange={change(setExperience)} options={[["",'All experiences'],['call','Call'],['service','Delivered service']]} /></Field>
    </div>
    <ErrorNote error={load.error} />
    {load.loading ? <TableSkeleton rows={5} cols={5} /> : load.data?.length ? <div className="table-wrap"><table className="t">
      <thead><tr><th>Customer</th><th>Rating</th><th>Feedback</th><th>Submitted (IST)</th><th>Interaction</th></tr></thead>
      <tbody>{load.data.map(r => <tr key={r.id}>
        <td><Link to={`/patients/${r.patient_id}`}>{r.patient_name}</Link><div className="mono small muted">{r.mrn}</div></td>
        <td className="mono nowrap">{r.rating} / 5<div className="tiny muted">{r.source_channel || 'form'}</div></td><td className="feedback-comment">{r.comment || 'No written feedback'}</td>
        <td className="small nowrap">{dateTime(r.submitted_at)}</td><td className="small">{r.experience === 'service' ? 'Delivered service' : 'Call'} {dateTime(r.call_started_at)}<div className="mono tiny">{r.call_id}</div>{r.case_id && <Link to={`/cases/${r.case_id}`}>{r.case_no}</Link>}</td>
      </tr>)}</tbody>
    </table></div> : !load.error && <Empty title="No feedback submitted">Submitted ratings will appear here. Unanswered requests do not count towards the average.</Empty>}
    <div className="row mt-12"><Button disabled={!page} onClick={() => setPage(page-1)}>Previous</Button><span className="small">Page {page+1}</span><Button disabled={load.data?.length !== 50} onClick={() => setPage(page+1)}>Next</Button></div>
  </Panel>;
}
export default function Feedback() {
  const [params] = useSearchParams();
  const experience = ['call','service'].includes(params.get('experience')) ? params.get('experience') : '';
  return <><PageHead title="Customer Feedback" sub="Customer replies and secure-form submissions, separated by experience" /><FeedbackHistory key={experience} initialExperience={experience} /></>;
}
