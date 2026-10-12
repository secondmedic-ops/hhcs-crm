// /find?phone=98xxxxxxxx opens the matching patient for a permitted CRM user.
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { db, q } from '../lib/db.js';
import { useAuth } from '../lib/auth.jsx';
import { PageHead, Panel, Empty, Skeleton, ErrorNote } from '../components/ui.jsx';

export default function Find() {
  const nav = useNavigate();
  const { isOps } = useAuth();
  const [sp] = useSearchParams();
  const digits = String(sp.get('phone') || '').replace(/\D/g, '').slice(-10);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (digits.length < 6) { setRows([]); return; }
    q(db.from('v_patients').select('id,full_name,mrn,mobile,case_count').ilike('mobile', `%${digits}%`).limit(10))
      .then((r) => { if (r.length === 1) nav(`/patients/${r[0].id}`, { replace: true }); else setRows(r); })
      .catch(setErr);
  }, [digits]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="page">
      <PageHead title="Find by phone" sub={digits ? `Number ending ${digits}` : 'No number given'} />
      <Panel>
        <ErrorNote error={err} />
        {!rows && !err ? <Skeleton lines={3} /> : rows?.length ? (
          <table className="t"><tbody>{rows.map((r) => (
            <tr key={r.id} className="click" onClick={() => nav(`/patients/${r.id}`)}><td className="strong">{r.full_name}</td><td className="mono">{r.mrn}</td><td className="mono">{r.mobile}</td><td>{r.case_count} cases</td></tr>
          ))}</tbody></table>
        ) : rows && (
          <Empty title="No patient with this number">
            {isOps ? <>Register them from the <Link to="/console">agent console</Link>.</> : 'No patient on file yet.'}
          </Empty>
        )}
      </Panel>
    </div>
  );
}
