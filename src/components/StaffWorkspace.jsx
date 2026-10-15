import { useState } from 'react';
import { api } from '../api.ts';
import { isDemo } from '../lib/db.js';
import { useAuth } from '../lib/auth.jsx';
import { useLoad } from '../lib/hooks.js';
import { DEPARTMENTS } from '../lib/fmt.js';
import { Panel, Select, Field, Button, Skeleton, ErrorNote, useAction } from './ui.jsx';

export const STAFF_ROLES = ['agent', 'coordinator', 'medical_desk', 'field_staff', 'provider'];

export default function StaffWorkspace() {
  const { switchUser } = useAuth();
  const [department, setDepartment] = useState('coordinator');
  const [staffId, setStaffId] = useState('');
  const [run, busy] = useAction();
  const staff = useLoad(() => isDemo ? [] : api.staffDirectory(), [], ['profiles']);
  const rows = (staff.data || []).filter((p) => p.role === department);
  const selected = rows.find((p) => p.id === staffId);
  return (
    <Panel title="Open staff workspace" sub="Select a department and staff member. Actions are recorded as Staff Name - Supervisor, with your name retained. Access lasts 30 minutes.">
      <ErrorNote error={staff.error} />
      {staff.loading ? <Skeleton lines={2} /> : isDemo ? <p className="small muted">Use the live site or local Worker test for audited supervisor access.</p> : (
        <div className="row wrap gap-12" style={{ alignItems: 'flex-end' }}>
          <Field label="Department"><Select aria-label="Staff department" value={department} onChange={(e) => { setDepartment(e.target.value); setStaffId(''); }} options={DEPARTMENTS.filter(([r]) => STAFF_ROLES.includes(r)).map(([r, label]) => [r, label])} /></Field>
          <Field label="Staff member"><Select aria-label="Staff member" value={selected ? staffId : ''} onChange={(e) => setStaffId(e.target.value)} placeholder={rows.length ? 'Select staff member' : 'No active staff in this department'} options={rows.map((p) => [p.id, `${p.full_name}${p.agent_code ? ` (${p.agent_code})` : ''}`])} /></Field>
          <Button kind="primary" disabled={busy || !selected} onClick={() => run(() => switchUser(selected.id))}>{busy ? 'Opening…' : 'Open staff workspace'}</Button>
        </div>
      )}
      <p className="tiny muted mt-8">Administration, management approvals and other supervisor accounts require their own login.</p>
    </Panel>
  );
}
