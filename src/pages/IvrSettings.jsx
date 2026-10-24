import { useState } from 'react';
import { ivrSettings, saveIvrSettings } from '../lib/api.js';
import { useLoad } from '../lib/hooks.js';
import { Badge, Button, Check, ErrorNote, Field, Input, Panel, Skeleton, useAction } from '../components/ui.jsx';

const NODES = {
  main_menu: 'Office menu: 1 Information, 2 Billing, 5 Homecare',
  after_hours: 'After hours: 1 On-call emergency, 2 Next-opening callback',
  information: 'Information department', billing: 'Billing department', homecare: 'SecondMedic homecare department',
  emergency: 'On-call emergency team', hold: 'Hold message / music, then recheck queue',
  callback_offer: 'Callback menu: 1 Callback, 2 Leave voicemail',
  callback_confirm: 'Callback confirmation, SMS automation, disconnect', voicemail: 'Record voicemail and disconnect',
};

export default function IvrSettings() {
  const [form, setForm] = useState(null);
  const [run, busy] = useAction();
  const s = useLoad(async () => { const d = await ivrSettings(); setForm({ enabled: d.enabled, flow_id: d.flow_id, nodes: Object.fromEntries(Object.keys(NODES).map(k => [k, d.nodes[k] || ''])) }); return d; }, []);
  const save = () => run(async () => { await saveIvrSettings(form); s.reload(); }, 'IVR mapping saved');
  return <Panel title="Hinduja inbound IVR" sub="Office hours: 8 AM to 8 PM IST, every day. Offer a callback after 3 minutes in the homecare queue."
    actions={<Button size="sm" onClick={save} disabled={!form || busy || s.data?.demo}>Save IVR mapping</Button>}>
    <ErrorNote error={s.error} />
    {s.loading || !form ? <Skeleton lines={4} /> : <div className="col gap-12">
      <div><Badge kind={form.enabled ? 'info' : 'warn'}>{form.enabled ? 'Adapter enabled' : 'Disabled'}</Badge></div>
      <div className="small">Create and publish the corresponding nodes in MyOperator before enabling. Saving here does not publish a phone menu or verify transfers, voicemail or SMS delivery.</div>
      {s.data?.url && <div className="small">Input-node webhook: <span className="mono">{s.data.url}</span>. Use the saved MyOperator webhook key in the x-webhook-key header.</div>}
      <Field label="MyOperator flow ID"><Input value={form.flow_id} onChange={e => setForm({ ...form, flow_id: e.target.value })} /></Field>
      <div className="grid2">{Object.entries(NODES).map(([k, label]) => <Field key={k} label={label}><Input value={form.nodes[k]} onChange={e => setForm({ ...form, nodes: { ...form.nodes, [k]: e.target.value } })} /></Field>)}</div>
      <Check checked={form.enabled} onChange={e => setForm({ ...form, enabled: e.target.checked })} label="Enable the mapped input-node adapter" />
      <div className="small muted">After-hours callbacks are scheduled from the next 8 AM opening. Callback confirmation does not mean the provider delivered its SMS. Withheld numbers use the provider's voicemail fallback.</div>
    </div>}
  </Panel>;
}
