import { useNavigate } from 'react-router-dom';
import { rpc } from '../lib/db.js';
import { useLoad } from '../lib/hooks.js';
import { Badge, Button, ErrorNote, Skeleton } from './ui.jsx';
export default function ProviderProgress({referralId}) {
 const nav=useNavigate();
 const result=useLoad(() => rpc('provider_portal',{p_referral:referralId}),[referralId],['partner_deployments','provider_fulfilment_events','case_items','case_referrals','cases']);
 const lead=result.data?.leads?.[0];
 return <div className="col gap-4 mt-8"><ErrorNote error={result.error} />{result.loading ? <Skeleton lines={1} /> : lead && <div className="row wrap gap-8">
  <Badge kind={lead.required>0 && lead.completed===lead.required ? 'ok' : 'info'}>{lead.completed} / {lead.required} units completed</Badge>
  {(result.data?.jobs || []).some((j) => j.issue_open) && <Badge kind="danger">Problem open</Badge>}
  <Button size="xs" onClick={() => nav('/fulfilment?referral='+referralId)}>Track fulfilment</Button>
 </div>}</div>;
}
