// Final Tax Invoice & Bill modal and document generator.
// Renders formal hospital billing and insurance claim documentation for delivered equipment, serial numbers,
// nursing shifts, and reconciled receipts.
import { Link } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad } from '../lib/hooks.js';
import { inr, dateLong, dateTime, num } from '../lib/fmt.js';
import Icon from './icons.jsx';
import { Modal, Button, Skeleton, Empty, useAction } from './ui.jsx';

const CAT_LABEL = {
  lab: 'Sample collection', xray: 'Portable X-ray', ecg: 'ECG at home', visit: 'Visit charge',
  nursing: 'Nursing', physio: 'Physiotherapy', beds: 'Hospital beds', eldercare: 'Elder care',
  homecare: 'Home care', equipment: 'Equipment', icu: 'ICU setup', consumables: 'Consumables', other: 'Other',
  caretaker_attendant: 'Caretaker / Attendant', ambulance: 'Ambulance',
};

export function getDeploymentInfo(item, allDeployments) {
  let matches = (allDeployments || []).filter((d) => d.case_item_id === item.id);
  if (!matches.length && item.service_code) {
    matches = (allDeployments || []).filter((d) => d.service_code === item.service_code);
  }
  if (!matches.length) return '–';

  return matches.map((d) => {
    const parts = [];
    if (d.equipment_serial) {
      parts.push(`SN: ${d.equipment_serial}${d.equipment_model ? ` (${d.equipment_model})` : ''}`);
    }
    if (d.staff_name) {
      parts.push(`Staff: ${d.staff_name}${d.staff_ref ? ` [${d.staff_ref}]` : ''}`);
    }
    if (d.shift) {
      parts.push(`Shift: ${d.shift}`);
    }
    return parts.join(' · ');
  }).filter(Boolean).join('\n') || '–';
}

export function InvoiceDocument({ k, patient, items = [], deployments = [], payments = [] }) {
  const addressParts = [
    k?.address || patient?.address,
    patient?.landmark,
    patient?.locality || k?.patient_locality,
    patient?.city || 'Mumbai',
    k?.pincode || patient?.pincode ? `PIN: ${k?.pincode || patient?.pincode}` : null,
  ].filter(Boolean);
  const billingAddress = addressParts.length ? addressParts.join(', ') : '–';

  const uhid = patient?.mrn || k?.external_ref || '–';
  const invoiceNo = k?.case_no ? `HHCS-INV-${k.case_no.replace(/^HHC-/, '')}` : '–';
  const invoiceDate = k?.closed_at ? dateLong(k.closed_at) : k?.updated_at ? dateLong(k.updated_at) : dateLong(new Date().toISOString());
  const doctor = k?.treating_doctor || '–';
  const dischargeDate = k?.expected_discharge_on ? dateLong(k.expected_discharge_on) : '–';
  const coordinator = k?.coordinator_name || '–';
  const hospital = [k?.hospital_name || 'P. D. Hinduja Hospital', k?.branch, k?.hospital_ward, k?.hospital_room].filter(Boolean).join(' · ') || 'P. D. Hinduja Hospital';

  const subtotal = k?.subtotal ?? 0;
  const discountAmount = k?.discount_amount ?? 0;
  const discountPct = k?.discount_pct ?? 0;
  const totalBilled = k?.total ?? 0;
  const totalCollected = k?.amount_collected ?? 0;
  const balanceDue = Math.max(0, Number(totalBilled) - Number(totalCollected));

  return (
    <article className="inv-wrap">
      {/* Header */}
      <header className="inv-head">
        <div>
          <div className="inv-brand-org">HINDUJA HOME HEALTH CARE SERVICES</div>
          <div className="inv-brand-sub">In partnership with SecondMedic · P. D. Hinduja National Hospital & Medical Research Centre</div>
          <div className="inv-brand-meta">
            Registered Address: Veer Savarkar Marg, Mahim, Mumbai - 400016, Maharashtra, India<br />
            GSTIN: 27AAACH0123M1Z8 · Care Helpline: +91 80493 68621 · care@hindujahomecare.com
          </div>
        </div>
        <div className="inv-title-box">
          <div className="inv-badge">Original For Recipient</div>
          <h1 className="inv-title">Tax Invoice / Final Bill</h1>
          <div className="inv-data-row"><span className="inv-data-lbl">Invoice No:</span> <strong className="mono">{invoiceNo}</strong></div>
          <div className="inv-data-row"><span className="inv-data-lbl">Date:</span> <span>{invoiceDate}</span></div>
          <div className="inv-data-row"><span className="inv-data-lbl">Case Ref:</span> <span className="mono">{k?.case_no || '–'}</span></div>
          <div className="inv-data-row"><span className="inv-data-lbl">Branch:</span> <span>{k?.branch || 'Mahim'}</span></div>
        </div>
      </header>

      {/* Bill To & Patient Info */}
      <div className="inv-meta-grid">
        <div>
          <div className="inv-block-title">Bill To (Patient Information)</div>
          <div className="inv-data-row"><span className="inv-data-lbl">Patient Name</span><span className="inv-data-val"><strong>{k?.patient_name || '–'}</strong></span></div>
          <div className="inv-data-row"><span className="inv-data-lbl">UHID / MRN</span><span className="inv-data-val mono">{uhid}</span></div>
          <div className="inv-data-row"><span className="inv-data-lbl">Age / Sex</span><span className="inv-data-val">{[k?.patient_age, k?.patient_gender].filter(Boolean).join(' / ') || '–'}</span></div>
          <div className="inv-data-row"><span className="inv-data-lbl">Contact Phone</span><span className="inv-data-val mono">{k?.patient_mobile || k?.caller_mobile_display || patient?.mobile || '–'}</span></div>
          <div className="inv-data-row"><span className="inv-data-lbl">Billing Address</span><span className="inv-data-val" style={{ maxWidth: '65%', textAlign: 'right' }}>{billingAddress}</span></div>
        </div>

        <div>
          <div className="inv-block-title">Clinical & Care Administration</div>
          <div className="inv-data-row"><span className="inv-data-lbl">Treating Doctor</span><span className="inv-data-val">{doctor}</span></div>
          <div className="inv-data-row"><span className="inv-data-lbl">Hospital / Ward / Bed</span><span className="inv-data-val">{hospital}</span></div>
          <div className="inv-data-row"><span className="inv-data-lbl">Discharge Date</span><span className="inv-data-val">{dischargeDate}</span></div>
          <div className="inv-data-row"><span className="inv-data-lbl">Care Coordinator</span><span className="inv-data-val">{coordinator}</span></div>
          <div className="inv-data-row"><span className="inv-data-lbl">Care Plan Duration</span><span className="inv-data-val">{k?.plan_days || 30} Days</span></div>
          <div className="inv-data-row"><span className="inv-data-lbl">Payment Status</span><span className="inv-data-val mono">{String(k?.payment_status || '–').toUpperCase()}</span></div>
        </div>
      </div>

      {/* Itemized Services and Equipment */}
      <div className="inv-section-title">Itemized Services, Deployed Equipment & Nursing Shifts</div>
      <div className="table-wrap">
        <table className="inv-t">
          <thead>
            <tr>
              <th style={{ width: '12%' }}>Code</th>
              <th style={{ width: '32%' }}>Description of Service / Equipment</th>
              <th style={{ width: '26%' }}>Installed Serial No / Staff ID / Shift</th>
              <th className="num" style={{ width: '10%' }}>Duration/Qty</th>
              <th className="num" style={{ width: '10%' }}>Rate</th>
              <th className="num" style={{ width: '10%' }}>Line Total</th>
            </tr>
          </thead>
          <tbody>
            {items.length > 0 ? (
              items.map((item) => (
                <tr key={item.id}>
                  <td className="mono">{item.service_code || '–'}</td>
                  <td>
                    <strong>{item.service_name}</strong>
                    {item.category && <div className="sub-text">{CAT_LABEL[item.category] || item.category}</div>}
                  </td>
                  <td className="serial-tag">{getDeploymentInfo(item, deployments)}</td>
                  <td className="num">{num(item.qty)} {item.unit || ''}</td>
                  <td className="num">{inr(item.unit_price)}</td>
                  <td className="num">{inr(item.line_total)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="6" className="c muted" style={{ padding: '14px' }}>No active billable items recorded for this case.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Payment Receipts Table */}
      <div className="inv-section-title">Payment Receipts & Reconciliation Details</div>
      <div className="table-wrap">
        <table className="inv-t">
          <thead>
            <tr>
              <th style={{ width: '16%' }}>Receipt No</th>
              <th style={{ width: '20%' }}>Payment Date</th>
              <th style={{ width: '12%' }}>Mode</th>
              <th style={{ width: '22%' }}>Bank Txn Ref</th>
              <th style={{ width: '16%' }}>Reconciled Status</th>
              <th className="num" style={{ width: '14%' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {payments.length > 0 ? (
              payments.map((p) => (
                <tr key={p.id}>
                  <td className="mono font-bold">{p.receipt_no || '–'}</td>
                  <td>{dateTime(p.collected_at)}</td>
                  <td><span className="mono">{String(p.mode || '–').toUpperCase()}</span></td>
                  <td className="mono">{p.txn_ref || '–'}</td>
                  <td>
                    {p.reconciled ? (
                      <span className="badge ok">Reconciled</span>
                    ) : p.exception ? (
                      <span className="badge danger" title={p.exception}>Exception</span>
                    ) : (
                      <span className="badge warn">Pending</span>
                    )}
                  </td>
                  <td className="num">{inr(p.amount)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="6" className="c muted" style={{ padding: '10px' }}>No payment receipts recorded yet for this case.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Summary Box */}
      <div className="inv-summary-grid">
        <div className="inv-bank-box">
          <div style={{ fontWeight: 700, textTransform: 'uppercase', marginBottom: 4, letterSpacing: '0.04em' }}>Bank Remittance & Tax Information</div>
          <div>Beneficiary: <strong>Hinduja Home Health Care Services</strong></div>
          <div>Bank: HDFC Bank · Branch: Mahim West, Mumbai</div>
          <div>Account No: <span className="mono">50200088921134</span> (Current Account) · IFSC: <span className="mono">HDFC0000060</span></div>
          <div>UPI ID: <span className="mono">hindujahomecare@hdfcbank</span></div>
          <div className="sub-text mt-8" style={{ fontSize: '10px', color: 'var(--ink-2)' }}>
            * Healthcare services provided by clinical establishments, doctors and paramedics are exempt from GST under Notification No. 12/2017-Central Tax (Rate), Heading 9993.
          </div>
        </div>

        <div>
          <table className="inv-sum-table">
            <tbody>
              <tr>
                <td>Total Gross Amount (Subtotal)</td>
                <td className="num">{inr(subtotal)}</td>
              </tr>
              {Number(discountAmount) > 0 && (
                <tr>
                  <td>Approved Discount ({num(discountPct)}%)</td>
                  <td className="num">-{inr(discountAmount)}</td>
                </tr>
              )}
              <tr>
                <td>Taxable Amount</td>
                <td className="num">{inr(totalBilled)}</td>
              </tr>
              <tr>
                <td>GST (Healthcare Services Exempt)</td>
                <td className="num">₹0.00</td>
              </tr>
              <tr className="total-row">
                <td>Total Billed Amount</td>
                <td className="num">{inr(totalBilled)}</td>
              </tr>
              <tr>
                <td>Total Amount Collected</td>
                <td className="num">{inr(totalCollected)}</td>
              </tr>
              <tr className="balance-row">
                <td>Net Balance Outstanding</td>
                <td className="num" style={{ color: balanceDue > 0 ? 'var(--warn-text, #965300)' : 'var(--ok-text, #1f5a33)' }}>{inr(balanceDue)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Signatures */}
      <div className="inv-sign-block">
        <div className="inv-sign-box">
          <div className="inv-sign-lbl">Prepared & Verified By</div>
          <div>
            <div><strong>{coordinator}</strong></div>
            <div className="sub-text">Care Coordinator / Billing Desk · Hinduja Home Care</div>
            <div className="sig-line" />
            <div className="sub-text mt-4">Date & Time: {dateTime(new Date().toISOString())}</div>
          </div>
        </div>

        <div className="inv-sign-box">
          <div className="inv-sign-lbl">Authorized Signatory / Hospital Accounts</div>
          <div>
            <div><strong>For Hinduja Home Health Care Services</strong></div>
            <div className="sub-text">P. D. Hinduja Hospital & Medical Research Centre / SecondMedic</div>
            <div className="sig-line" />
            <div className="sub-text mt-4">Authorized Stamp & Signature</div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <footer className="inv-foot">
        HHCS-INV-01 · This is a computer-generated tax invoice and final bill of supply. Certified valid for medical insurance claims and patient reimbursement under the DPDP Act 2023. Hinduja Hospital is the Data Fiduciary; SecondMedic is the Data Processor.
      </footer>
    </article>
  );
}

export default function FinalInvoiceModal({ c: initialCase, caseId: propCaseId, onClose }) {
  const caseId = initialCase?.id || propCaseId;
  const [run, busy] = useAction();

  const cs = useLoad(() => (!initialCase && caseId ? q(db.from('v_cases').select('*').eq('id', caseId).maybeSingle()) : null), [caseId, !initialCase], ['cases']);
  const k = initialCase || cs.data;
  const patientId = k?.patient_id;

  const pt = useLoad(() => (patientId ? q(db.from('patients').select('id,mrn,full_name,age,gender,mobile,address,landmark,locality,city,pincode').eq('id', patientId).maybeSingle()) : null), [patientId], ['patients']);
  const it = useLoad(() => (caseId ? q(db.from('case_items').select('*').eq('case_id', caseId).order('created_at')) : []), [caseId], ['case_items']);
  const dp = useLoad(() => (caseId ? q(db.from('v_deployments').select('*').eq('case_id', caseId).order('created_at')) : []), [caseId], ['partner_deployments']);
  const py = useLoad(() => (caseId ? q(db.from('payments').select('*').eq('case_id', caseId).order('collected_at')) : []), [caseId], ['payments']);

  const loading = (!initialCase && cs.loading) || pt.loading || it.loading || dp.loading || py.loading;
  const activeItems = (it.data || []).filter((i) => !i.excluded);

  const printBill = () => run(async () => {
    if (caseId) await rpc('log_access', { p_action: 'export', p_entity: 'case', p_entity_id: caseId, p_meta: { what: 'tax_invoice' } }).catch(() => {});
    window.open(`/invoice?case=${caseId}&print=1`, '_blank');
  });

  return (
    <Modal wide title={`Tax Invoice & Final Bill · ${k?.case_no || ''}`} onClose={onClose}
      footer={<>
        <Button onClick={onClose}>Close</Button>
        <Link to={`/invoice?case=${caseId}`} target="_blank" className="btn">
          <Icon name="link" />Open Full Print View
        </Link>
        <Button kind="primary" icon="print" disabled={busy || loading} onClick={printBill}>
          Print Bill
        </Button>
      </>}>
      {loading ? <Skeleton lines={10} /> : !k ? <Empty title="Case not found">Cannot generate invoice for this case.</Empty> : (
        <div style={{ maxHeight: '70vh', overflowY: 'auto', paddingRight: '4px' }}>
          <InvoiceDocument
            k={k}
            patient={pt.data}
            items={activeItems}
            deployments={dp.data || []}
            payments={py.data || []}
          />
        </div>
      )}
    </Modal>
  );
}

