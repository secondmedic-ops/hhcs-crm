// BMM workspace: Book My Medicare's own tab in CareDesk (decision 20-21 Oct 2026: BMM works in our app with its own
// logins, no separate app). Leads | Jobs | Products | Team, reusing the Provider leads, Provider fulfilment and Product
// knowledge screens filtered to the provider. Provider logins (BMM coordinators) see everything of their own provider;
// field staff linked to BMM see their jobs and products; SecondMedic supervisors / coordinators and Hinduja
// management open the same view of BMM to follow its work. What each login may read is still decided by the API and
// the database (RLS), not by this page.
import { useState } from 'react';
import { db, q } from '../lib/db.js';
import { useAuth } from '../lib/auth.jsx';
import { useLoad } from '../lib/hooks.js';
import { ROLE_LABEL } from '../lib/fmt.js';
import { PageHead, Panel, Tabs, Badge, Empty, ErrorNote, Skeleton, TableSkeleton } from '../components/ui.jsx';
import Leads from './Leads.jsx';
import ProviderFulfilment from './ProviderFulfilment.jsx';
import Knowledge from './Knowledge.jsx';

const LOGIN = { provider: 'Coordinator (provider login)', field_staff: 'Field / delivery staff' };

export default function BmmWorkspace() {
  const { profile } = useAuth();
  const partner = ['provider', 'field_staff'].includes(profile.role) && !!profile.provider_id;
  const field = profile.role === 'field_staff';
  const prov = useLoad(() => q(db.from('providers').select('id,code,name,active')), [], ['providers']);
  const provider = (prov.data || []).find((p) => (partner ? p.id === profile.provider_id : p.code === 'BMM'));
  const tabs = [...(field ? [] : [['leads', 'Leads']]), ['jobs', field ? 'My jobs' : 'Jobs'], ['products', 'Products'], ...(field ? [] : [['team', 'Team']])];
  const [tab, setTab] = useState(field ? 'jobs' : 'leads');
  // staff viewing BMM: filter the shared screens to BMM; a partner login is already limited to its own provider
  const only = partner ? null : provider?.id;

  if (prov.loading) return <div className="page"><Skeleton lines={6} /></div>;
  if (prov.error) return <ErrorNote error={prov.error} />;
  if (!provider) return <Empty title="Book My Medicare is not set up">Add the provider with code BMM, then link BMM logins to it in Settings &gt; Users.</Empty>;

  return (
    <>
      <PageHead title={`${provider.name} workspace`}
        sub={partner
          ? 'Your leads from the Hinduja call centre, your jobs in the field, the products you deliver and your team. Updates are live.'
          : `What ${provider.name} staff work on: their leads, jobs, products and team. Updates are live.`}>
        {!provider.active && <Badge kind="warn">Provider inactive</Badge>}
      </PageHead>
      <div className="mb-16"><Tabs tabs={tabs} value={tab} onChange={setTab} /></div>
      {tab === 'leads' && <Leads embedded providerId={only} />}
      {tab === 'jobs' && <ProviderFulfilment embedded providerId={only} />}
      {tab === 'products' && <Knowledge embedded providerId={provider.id} />}
      {tab === 'team' && <Team provider={provider} />}
    </>
  );
}

function Team({ provider }) {
  const team = useLoad(() => q(db.from('profiles').select('id,full_name,role,email,phone,active,available')
    .eq('provider_id', provider.id).order('full_name')), [provider.id], ['profiles']);
  const rows = team.data || [];
  return (
    <Panel tight title={`${provider.name} team`} sub="Logins linked to this provider. The SecondMedic administrator adds or removes them in Settings > Users (Provider = coordinator, Field staff = delivery staff).">
      <ErrorNote error={team.error} />
      {team.loading ? <TableSkeleton rows={4} cols={4} /> : !rows.length ? <Empty title="No logins linked yet">Ask the SecondMedic administrator to add BMM staff in Settings &gt; Users and choose Book My Medicare as their provider.</Empty> : (
        <div className="table-wrap"><table className="t">
          <thead><tr><th>Name</th><th>Login</th><th>Contact</th><th>Status</th></tr></thead>
          <tbody>{rows.map((p) => (
            <tr key={p.id}>
              <td className="small strong">{p.full_name}</td>
              <td className="small">{LOGIN[p.role] || ROLE_LABEL[p.role] || p.role}</td>
              <td className="small">{p.email || <span className="faint">–</span>}{p.phone && <div className="tiny muted">{p.phone}</div>}</td>
              <td>{p.active ? <Badge kind="ok">Active</Badge> : <Badge>Disabled</Badge>}{p.active && p.role === 'field_staff' && p.available && <div className="tiny muted">available</div>}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </Panel>
  );
}
