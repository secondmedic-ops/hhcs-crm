// Patient register: every person who has called, booked or been visited, with consent status and lifetime value.
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { db, q } from '../lib/db.js';
import { useLoad, useDebounced } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { inr, num, ago, dateTime } from '../lib/fmt.js';
import { PageHead, Panel, Kpi, Badge, Button, Input, Select, TableSkeleton, Empty, ErrorNote } from '../components/ui.jsx';
import Icon from '../components/icons.jsx';

const COLS = 'id,mrn,full_name,age,gender,mobile,locality,pincode,zone_id,zone_name,case_count,last_case_at,lifetime_value,consent_verbal_at,consent_digital_at';
const GENDER = { M: 'M', F: 'F', O: 'O' };
const dash = (v) => (v == null || v === '' ? '–' : v);
// strip characters that would break a PostgREST or() expression
const clean = (s) => s.replace(/[,()*\\]/g, ' ').trim();

export default function Patients() {
  const nav = useNavigate();
  const { isOps } = useAuth();
  const [text, setText] = useState('');
  const [zone, setZone] = useState('');
  const term = useDebounced(clean(text), 250);

  const zones = useLoad(() => q(db.from('zones').select('id,name').eq('active', true).order('name')), []);
  const list = useLoad(() => {
    let x = db.from('v_patients').select(COLS);
    if (term) {
      const digits = term.replace(/\D/g, '');
      const ors = [`full_name.ilike.*${term}*`, `mrn.ilike.*${term}*`, `locality.ilike.*${term}*`, `pincode.ilike.*${term}*`];
      if (digits.length >= 3) ors.push(`mobile.ilike.*${digits}*`);
      x = x.or(ors.join(','));
    }
    if (zone === 'none') x = x.is('zone_id', null);
    else if (zone) x = x.eq('zone_id', zone);
    return q(x.order('last_case_at', { ascending: false, nullsFirst: false }).limit(300));
  }, [term, zone], ['patients', 'cases']);

  const rows = list.data || [];
  const repeat = rows.filter((r) => Number(r.case_count) > 1).length;
  const verbal = rows.filter((r) => r.consent_verbal_at).length;
  const ltv = rows.reduce((s, r) => s + Number(r.lifetime_value || 0), 0);

  return (
    <>
      <PageHead title="Patients" sub="One record per patient across every call, case and channel · open a patient for the full communication history">
        {isOps && <Button kind="primary" icon="plus" onClick={() => nav('/console?new=1')}>New enquiry</Button>}
      </PageHead>

      <div className="kpis mb-12">
        <Kpi label="Patients shown" value={list.data && num(rows.length)} detail={rows.length >= 300 ? 'first 300, refine the search' : 'matching filters'} />
        <Kpi label="Repeat patients" value={list.data && num(repeat)} detail="2 or more cases" />
        <Kpi label="Verbal consent on file" value={list.data && (rows.length ? `${Math.round((100 * verbal) / rows.length)}%` : '–')} detail={list.data && `${verbal} of ${rows.length}`} tone={rows.length && verbal < rows.length ? 'warn' : 'ok'} />
        <Kpi label="Lifetime value" value={list.data && inr(ltv)} detail="excludes cancelled cases" />
      </div>

      <Panel tight title={
        <div className="row wrap pt-filters">
          <div className="pt-search">
            <Icon name="search" size={14} />
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Name, MRN, mobile, locality or pincode" aria-label="Search patients" />
          </div>
          <Select value={zone} onChange={(e) => setZone(e.target.value)} placeholder="All zones" aria-label="Zone"
            options={[...(zones.data || []).map((z) => [z.id, z.name]), ['none', 'Unmapped pincode']]} style={{ width: 180 }} />
          {(text || zone) && <Button size="sm" kind="ghost" icon="x" onClick={() => { setText(''); setZone(''); }}>Clear</Button>}
        </div>
      }>
        <ErrorNote error={list.error} />
        {list.loading ? <TableSkeleton rows={10} cols={9} /> : rows.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr>
              <th>Patient</th><th>MRN</th><th>Age / sex</th><th>Mobile</th><th>Locality · zone</th>
              <th className="num">Cases</th><th>Last case</th><th className="num">Lifetime value</th><th>Consent</th>
            </tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className="click" onClick={() => nav(`/patients/${r.id}`)}>
                <td className="strong truncate" style={{ maxWidth: 220 }}>{r.full_name}</td>
                <td className="mono small">{dash(r.mrn)}</td>
                <td className="mono">{r.age ?? '–'}{r.gender ? ` · ${GENDER[r.gender] || r.gender}` : ''}</td>
                <td className="mono">{dash(r.mobile)}</td>
                <td><span className="truncate" style={{ display: 'inline-block', maxWidth: 200, verticalAlign: 'bottom' }}>{dash(r.locality)}{r.pincode ? <span className="muted"> {r.pincode}</span> : null}</span>
                  <div className="tiny muted">{r.zone_name || 'Unmapped'}</div></td>
                <td className="num">{num(r.case_count)}</td>
                <td className="nowrap small" title={dateTime(r.last_case_at)}>{r.last_case_at ? ago(r.last_case_at) : '–'}</td>
                <td className="num">{Number(r.lifetime_value) ? inr(r.lifetime_value) : '–'}</td>
                <td className="nowrap">
                  <Badge kind={r.consent_verbal_at ? 'ok' : 'outline'} title={r.consent_verbal_at ? `Verbal consent ${dateTime(r.consent_verbal_at)}` : 'No verbal consent recorded'}>Verbal</Badge>{' '}
                  <Badge kind={r.consent_digital_at ? 'ok' : 'outline'} title={r.consent_digital_at ? `Digital consent ${dateTime(r.consent_digital_at)}` : 'No digital consent recorded'}>Digital</Badge>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title={text || zone ? 'No patients match' : 'No patients yet'}>{text || zone ? 'Try a shorter name, the last 4 digits of the mobile, or another zone.' : 'Patients are created from the first enquiry on the agent console.'}</Empty>}
      </Panel>
    </>
  );
}
