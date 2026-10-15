import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { rpc } from '../lib/db.js';
import { useAuth, roleAllows } from '../lib/auth.jsx';
import { useLoad } from '../lib/hooks.js';
import { dateTime, toLocalInput, fromLocalInput } from '../lib/fmt.js';
import { PageHead, Panel, Button, Badge, Modal, Field, Input, Select, Textarea, Check, TableSkeleton, Empty, ErrorNote, useAction } from '../components/ui.jsx';
const LABEL = { scheduled: 'Scheduled', dispatched: 'Dispatched', arrived: 'On site', delivered: 'Delivered', installed: 'Installed', active: 'Service active', completed: 'Completed', returned: 'Returned', cancelled: 'Cancelled' };
const NEXT = { staff: { scheduled: 'dispatched', dispatched: 'arrived', arrived: 'active', active: 'completed' }, equipment: { scheduled: 'dispatched', dispatched: 'delivered', delivered: 'installed', installed: 'active', active: 'completed', completed: 'returned' } };
const ACTION = { dispatched: 'Dispatch / en route', arrived: 'Check in', delivered: 'Confirm delivery', installed: 'Confirm installation', active: 'Start service', completed: 'Complete service', returned: 'Confirm return', assign: 'Assign field staff', reschedule: 'Reschedule job', report_issue: 'Report a problem', resolve_issue: 'Resolve problem', cancelled: 'Cancel job' };
export default function ProviderFulfilment() {
 const { profile } = useAuth();
 const [sp,setSp] = useSearchParams(), referral = sp.get('referral') || '';
 const [filter,setFilter] = useState('open'), [dialog,setDialog] = useState(null);
 const [run,busy] = useAction();
 const board = useLoad(() => rpc('provider_portal',{p_referral:referral || null}),[referral],['partner_deployments','provider_fulfilment_events','case_referrals','case_items','cases','profiles']);
 useEffect(() => { const timer=setInterval(() => { if(document.visibilityState==='visible') board.reload(); },30000); return () => clearInterval(timer); },[referral]);
 const data=board.data || {}, leads=data.leads || [], all=data.jobs || [], staff=data.staff || [];
 const done=(j) => j.status==='returned' || j.status==='cancelled' || (j.status==='completed' && !j.return_required);
 const jobs=all.filter((j) => filter==='all' || (filter==='issues' ? j.issue_open : filter==='done' ? done(j) : !done(j)));
 const field=profile.role==='field_staff';
 const show=(job,action) => setDialog({job,action,eventId:crypto.randomUUID()});
 const finish=() => {setDialog(null);board.reload();};
 return <>
  <PageHead title={field ? 'My provider jobs' : 'Provider fulfilment'} sub="Field updates are shared live with Hinduja and SecondMedic. Each work order fulfils one agreed service unit." />
  <ErrorNote error={board.error} />
  <Panel title="Service plans" actions={<Button size="sm" onClick={board.reload}>Refresh</Button>}>
   <Field label="Provider lead"><Select value={referral} onChange={(e) => setSp(e.target.value ? {referral:e.target.value} : {})} placeholder="All visible leads" options={leads.map((r) => [r.id,r.case_no+' · '+r.provider_name])} /></Field>
   {board.loading ? <TableSkeleton rows={3} cols={4} /> : leads.length ? <div className="table-wrap"><table className="t compact">
    <thead><tr><th>Case / patient</th><th>Provider</th><th>Progress</th><th /></tr></thead><tbody>{leads.map((r) => <tr key={r.id}>
     <td><div className="mono small">{r.case_no}</div><div className="small">{r.patient_name}</div></td>
     <td className="small">{r.provider_name}<div><Badge>{r.status}</Badge>{r.on_hold && <Badge kind="warn">On hold</Badge>}</div></td>
     <td className="small">{r.completed} / {r.required} units completed</td>
     <td className="right">{r.can_manage && !r.on_hold && <>
      {r.status==='new' && roleAllows(['provider','supervisor'],profile.role) && <Button size="sm" disabled={busy} onClick={() => run(async () => {await rpc('accept_provider_lead',{p_id:r.id});board.reload();},'Lead accepted')}>Accept lead</Button>}
      {['accepted','scheduled','dispatched','in_progress'].includes(r.status) && <Button size="sm" onClick={() => setDialog({lead:r})}>Plan work order</Button>}
     </>}</td>
    </tr>)}</tbody></table></div> : <Empty title="No provider work assigned">{field ? 'Your provider manager assigns work orders to your login.' : 'Accept a provider lead, then plan its service units.'}</Empty>}
   <div className="tiny muted mt-8">Up to 100 recent visible leads. {data.job_count>500 ? 'Select a lead to narrow the first 500 jobs.' : ''}</div>
  </Panel>
  <Panel title={field ? 'My work orders' : 'Work orders'} actions={<Select value={filter} onChange={(e) => setFilter(e.target.value)} options={[['open','Open'],['issues','Problems'],['done','Completed / cancelled'],['all','All']]} />}>
   {board.loading ? <TableSkeleton rows={4} cols={4} /> : jobs.length ? <div className="col gap-12">{jobs.map((j) => {
    const next=j.on_hold && j.resource_type==='equipment' && j.return_required && ['delivered','installed','active'].includes(j.status) ? 'returned' : j.resource_type==='equipment' && j.status==='delivered' && !j.setup_required ? (j.return_required ? 'active' : 'completed') : NEXT[j.resource_type]?.[j.status];
    return <div key={j.id} className="panel" style={{padding:12}}>
     <div className="row between wrap gap-8"><strong>{j.service_name}</strong><div className="row gap-4"><Badge kind={done(j) ? 'ok' : 'info'}>{LABEL[j.status]}</Badge>{j.issue_open && <Badge kind="danger">Problem open</Badge>}{j.on_hold && <Badge kind="warn">On hold</Badge>}</div></div>
     <div className="small mt-8">{j.case_no} · {j.patient_name} · {j.provider_name}</div><div className="small muted">{j.address} {j.pincode}</div>
     <dl className="kv mt-8"><dt>Assigned to</dt><dd>{j.assigned_name || 'Not assigned'}</dd><dt>Scheduled (IST)</dt><dd>{dateTime(j.scheduled_at)}{j.scheduled_end ? ' to '+dateTime(j.scheduled_end) : ''}</dd>
      <dt>Unit</dt><dd>1 {j.unit || 'unit'} · {j.resource_type}{j.return_required ? ' · return required' : ''}</dd>
      {j.equipment_serial && <><dt>Serial</dt><dd>{j.equipment_serial}</dd></>}
      {j.arrived_at && <><dt>Arrival</dt><dd>{dateTime(j.arrived_at)}</dd></>}
      {j.active_from && <><dt>Started</dt><dd>{dateTime(j.active_from)}</dd></>}
      {j.completed_at && <><dt>Completed</dt><dd>{dateTime(j.completed_at)}</dd></>}
      {j.confirmed_by && <><dt>Handover confirmed by</dt><dd>{j.confirmed_by}</dd></>}{j.return_confirmed_by && <><dt>Return confirmed by</dt><dd>{j.return_confirmed_by}</dd></>}
     </dl>
     {j.issue_note && <div className="small mt-8">{j.issue_open ? 'Problem: ' : 'Resolution: '}{j.issue_note}</div>}
     {j.note && <div className="small muted mt-8">{j.note}</div>}
     {(j.can_manage || field) && <div className="row wrap gap-8 mt-12">
      {j.can_manage && j.status==='scheduled' && !j.on_hold && <Button size="sm" onClick={() => show(j,'assign')}>Assign field staff</Button>}{j.can_manage && j.status==='scheduled' && !j.on_hold && <Button size='sm' onClick={() => show(j,'reschedule')}>Reschedule</Button>}
      {next && !j.issue_open && (!j.on_hold || next==='returned') && (j.status!=='completed' || j.return_required) && <Button size="sm" kind="primary" disabled={!j.assigned_staff_id} onClick={() => show(j,next)}>{ACTION[next]}</Button>}
      {!done(j) && <Button size="sm" onClick={() => show(j,j.issue_open && j.can_manage ? 'resolve_issue' : 'report_issue')}>{j.issue_open && j.can_manage ? 'Resolve problem' : 'Report problem'}</Button>}
      {j.can_manage && !done(j) && (j.resource_type==='staff' || ['scheduled','dispatched'].includes(j.status)) && <Button size="sm" kind="ghost" onClick={() => show(j,'cancelled')}>Cancel / stop job</Button>}
     </div>}
    </div>;
   })}</div> : <Empty title="No work orders in this view" />}
  </Panel>
  <Panel title="Fulfilment history">{board.loading ? <TableSkeleton rows={3} cols={3} /> : (data.events || []).length ? <div className="table-wrap"><table className="t compact"><thead><tr><th>Time (IST)</th><th>Action / staff</th><th>Details</th></tr></thead><tbody>{data.events.map((e) => <tr key={e.id}>
   <td className="small nowrap">{dateTime(e.occurred_at)}</td><td className="small">{ACTION[e.action] || e.action}<div className="tiny muted">{e.actor_name}</div></td><td className="small">{e.from_status ? LABEL[e.from_status]+' → ' : ''}{LABEL[e.to_status]}{e.note && <div>{e.note}</div>}</td>
  </tr>)}</tbody></table></div> : <Empty title="No fulfilment events yet" />}</Panel>
  {dialog?.lead && <PlanForm lead={dialog.lead} staff={staff} onClose={() => setDialog(null)} onDone={finish} />}
  {dialog?.job && <JobAction {...dialog} staff={staff} onClose={() => setDialog(null)} onDone={finish} />}
 </>;
}
function PlanForm({lead,staff,onClose,onDone}) {
 const items=(lead.items || []).filter((i) => i.planned<i.qty);
 const [f,setF]=useState({request_id:crypto.randomUUID(),case_item_id:items[0]?.id || '',resource_type:['beds','equipment','consumables'].includes(items[0]?.category) ? 'equipment' : 'staff',assigned_staff_id:'',scheduled_at:toLocalInput(lead.scheduled_at || new Date()),scheduled_end:'',equipment_model:'',return_required:true,setup_required:true});
 const [run,busy]=useAction(), set=(key) => (e) => setF({...f,[key]:e.target.type==='checkbox' ? e.target.checked : e.target.value});
 const save=() => run(async () => {await rpc('plan_provider_job',{p_referral:lead.id,p:{...f,scheduled_at:fromLocalInput(f.scheduled_at),scheduled_end:f.scheduled_end ? fromLocalInput(f.scheduled_end) : null}});onDone();},'Work order planned');
 return <Modal title={'Plan one service unit · '+lead.case_no} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !f.case_item_id || !f.scheduled_at || (f.resource_type==='staff' && !f.scheduled_end)} onClick={save}>Plan work order</Button></>}>
  <div className="form-grid">
   <Field label="Included service" className="span2"><Select value={f.case_item_id} onChange={set('case_item_id')} options={items.map((i) => [i.id,i.name+' · '+i.planned+'/'+i.qty+' units planned · '+i.unit])} placeholder="All units already planned" /></Field>
   <Field label="Resource"><Select value={f.resource_type} onChange={set('resource_type')} options={[['staff','Staff / service visit'],['equipment','Product / equipment']]} /></Field>
   <Field label="Assigned field staff"><Select value={f.assigned_staff_id} onChange={set('assigned_staff_id')} placeholder="Assign later" options={staff.filter((s) => s.provider_id===lead.provider_id).map((s) => [s.id,s.name])} /></Field>
   <Field label="Scheduled start (IST)"><Input type="datetime-local" value={f.scheduled_at} onChange={set('scheduled_at')} /></Field>
   <Field label={f.resource_type==='staff' ? 'Shift / visit end (IST)' : 'Rental / service end (IST, optional)'}><Input type="datetime-local" value={f.scheduled_end} onChange={set('scheduled_end')} /></Field>
   {f.resource_type==='equipment' && <><Field label="Product / model"><Input value={f.equipment_model} onChange={set('equipment_model')} /></Field><Check label="Installation / setup required" checked={f.setup_required} onChange={set('setup_required')} /><Check label="Return / collection required" checked={f.return_required} onChange={set('return_required')} /></>}
  </div><p className="small muted">Plan each agreed shift, visit or product unit separately. Unassigned jobs wait for a field login.</p>
 </Modal>;
}
function JobAction({job,action,eventId,staff,onClose,onDone}) {
 const [f,setF]=useState({note:'',equipment_serial:job.equipment_serial || '',confirmed_by:'',handover_confirmed:false,assigned_staff_id:job.assigned_staff_id || '',scheduled_at:toLocalInput(job.scheduled_at),scheduled_end:toLocalInput(job.scheduled_end)});
 const [run,busy]=useAction(), confirmation=['completed','returned'].includes(action) || (action==='cancelled' && !['scheduled','dispatched'].includes(job.status)), reason=['report_issue','resolve_issue','cancelled'].includes(action);
 const set=(key) => (e) => setF({...f,[key]:e.target.type==='checkbox' ? e.target.checked : e.target.value});
 const ok=(!reason || f.note.trim()) && (!confirmation || (f.confirmed_by.trim() && f.handover_confirmed)) && (action!=='delivered' || f.equipment_serial.trim()) && (action!=='assign' || f.assigned_staff_id) && (action!=='reschedule' || (f.scheduled_at && (job.resource_type!=='staff' || f.scheduled_end)));
 const save=() => run(async () => {await rpc('update_provider_job',{p_id:job.id,p_event:eventId,p_version:job.version,p_action:action,p:{...f,scheduled_at:f.scheduled_at ? fromLocalInput(f.scheduled_at) : null,scheduled_end:f.scheduled_end ? fromLocalInput(f.scheduled_end) : null}});onDone();},'Fulfilment updated');
 return <Modal title={ACTION[action]+' · '+job.service_name} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !ok} onClick={save}>Save</Button></>}>
  {action==='assign' && <Field label="Provider field staff"><Select value={f.assigned_staff_id} onChange={set('assigned_staff_id')} options={staff.filter((s) => s.provider_id===job.provider_id).map((s) => [s.id,s.name])} placeholder="Choose" /></Field>}
  {action==='reschedule' && <div className='form-grid'><Field label='Start (IST)'><Input type='datetime-local' value={f.scheduled_at} onChange={set('scheduled_at')} /></Field><Field label='End (IST)'><Input type='datetime-local' value={f.scheduled_end} onChange={set('scheduled_end')} /></Field></div>}
  {action==='delivered' && <Field label="Equipment serial / batch reference"><Input value={f.equipment_serial} onChange={set('equipment_serial')} maxLength={200} /></Field>}
  {confirmation && <><Field label="Recipient / handover confirmation name"><Input value={f.confirmed_by} onChange={set('confirmed_by')} maxLength={200} /></Field><Check label={action==='returned' ? 'Return and collection confirmed' : action==='cancelled' ? 'Safe handover confirmed before stopping care' : 'Agreed work completed and handover confirmed'} checked={f.handover_confirmed} onChange={set('handover_confirmed')} /></>}
  <Field label={reason ? 'Problem, resolution or cancellation reason' : 'Progress note (optional)'}><Textarea rows={3} value={f.note} onChange={set('note')} maxLength={2000} /></Field>
  <div className="small muted mt-8">Your login and update time are recorded. Reload a changed job before saving.</div>
 </Modal>;
}
