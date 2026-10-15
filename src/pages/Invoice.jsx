// Final Tax Invoice & Bill printable page (mounted at /invoice?case=:id).
// Formal hospital billing and insurance claim documentation for delivered equipment, serial numbers,
// nursing shifts, and reconciled receipts.
import { useEffect } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { PageHead, Button, Skeleton, Empty, useAction } from '../components/ui.jsx';
import { InvoiceDocument } from '../components/FinalInvoiceModal.jsx';

export default function Invoice() {
  const { id: paramId } = useParams();
  const [sp] = useSearchParams();
  const caseId = sp.get('case') || paramId;
  const { can } = useAuth();
  const [run, busy] = useAction();

  const cs = useLoad(() => (caseId ? q(db.from('v_cases').select('*').eq('id', caseId).maybeSingle()) : null), [caseId], ['cases']);
  const k = cs.data;
  const patientId = k?.patient_id;

  const pt = useLoad(() => (patientId ? q(db.from('patients').select('id,mrn,full_name,age,gender,mobile,address,landmark,locality,city,pincode').eq('id', patientId).maybeSingle()) : null), [patientId], ['patients']);
  const it = useLoad(() => (caseId ? q(db.from('case_items').select('*').eq('case_id', caseId).order('created_at')) : []), [caseId], ['case_items']);
  const dp = useLoad(() => (caseId ? q(db.from('v_deployments').select('*').eq('case_id', caseId).order('created_at')) : []), [caseId], ['partner_deployments']);
  const py = useLoad(() => (caseId ? q(db.from('payments').select('*').eq('case_id', caseId).order('collected_at')) : []), [caseId], ['payments']);

  const loading = cs.loading || pt.loading || it.loading || dp.loading || py.loading;
  const activeItems = (it.data || []).filter((i) => !i.excluded);

  const print = () => run(async () => {
    if (caseId) await rpc('log_access', { p_action: 'export', p_entity: 'case', p_entity_id: caseId, p_meta: { what: 'tax_invoice' } }).catch(() => {});
    setTimeout(() => window.print(), 50);
  });

  useEffect(() => {
    if (sp.get('print') === '1' && !loading && k) {
      const t = setTimeout(() => { window.print(); }, 400);
      return () => clearTimeout(t);
    }
  }, [sp, loading, !k]);

  if (!caseId) {
    return (
      <div className="page">
        <Empty title="No case selected">
          Please provide a case ID to view the final bill, e.g. <span className="mono">/invoice?case=&lt;id&gt;</span>.
          <div className="mt-12"><Link to="/cases" className="btn">Go to cases</Link></div>
        </Empty>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="no-print">
        <PageHead
          title="Tax Invoice & Final Bill"
          sub={`Case ${k?.case_no || ''} · Hinduja Home Health Care Services · Final bill of supply`}
        >
          <div className="row gap-8 wrap">
            <Link className="btn" to={`/cases/${caseId}`}>Back to case</Link>
            <Button kind="primary" icon="print" disabled={busy || loading} onClick={print}>Print Invoice</Button>
          </div>
        </PageHead>
      </div>

      {loading ? (
        <Skeleton lines={12} />
      ) : !k ? (
        <Empty title="Case not found">This case does not exist or is outside your queue.</Empty>
      ) : (
        <InvoiceDocument
          k={k}
          patient={pt.data}
          items={activeItems}
          deployments={dp.data || []}
          payments={py.data || []}
        />
      )}
    </div>
  );
}

