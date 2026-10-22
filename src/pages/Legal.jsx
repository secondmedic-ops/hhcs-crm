// Terms of use and privacy notice for the CareDesk platform.
// These are working drafts aligned with the proposal (slides 19-21) and must be reviewed by both legal teams.
import { Link } from 'react-router-dom';

const Head = ({ title, updated }) => (
  <>
    <div className="row mb-16"><div className="brand-mark" style={{ borderColor: 'var(--ink)' }}>HC</div><Link to="/">CareDesk · Hinduja Home Care Services</Link></div>
    <h1>{title}</h1>
    <p className="muted">Last updated {updated} · Draft for review by Hinduja and SecondMedic legal teams</p>
  </>
);

export function Terms() {
  return (
    <div className="legal">
      <Head title="Terms of Use" updated="7 October 2026" />
      <h2>1. Who these terms cover</h2>
      <p>CareDesk is the patient-service platform used to run Hinduja Home Care Services (HHCS). It is operated by Remote Healthcare Technologies Pvt. Ltd. (“SecondMedic”) on behalf of Hinduja Home Care Services (“Hinduja”). These terms apply to every person given a login: SecondMedic agents, coordinators, supervisors, field staff and medical desk, and Hinduja management and clinical users.</p>
      <h2>2. Purpose limitation</h2>
      <p>You may use CareDesk and the information in it only to deliver HHCS services as instructed by Hinduja. Use for SecondMedic marketing, analytics products, independent business, cross-selling or the solicitation or migration of Hinduja patients is prohibited.</p>
      <h2>3. Your account</h2>
      <ul>
        <li>Accounts are personal. Do not share credentials. Enable multi-factor authentication when asked.</li>
        <li>You see only what your role requires. Attempts to access records outside your role are logged and reviewed.</li>
        <li>Sessions end automatically after inactivity.</li>
      </ul>
      <h2>4. Approved commitments only</h2>
      <p>Prices, discounts, scripts, message templates and service commitments must come from the Hinduja-approved versions in CareDesk. The system enforces this; working around it (for example quoting off-system or sending custom commercial messages) is a breach of these terms.</p>
      <h2>5. Clinical boundaries</h2>
      <p>Contact-centre staff do not give clinical advice beyond approved scripts. Clinical concerns, critical values and emergencies must be escalated through CareDesk immediately. AI-generated summaries, scores and suggestions are aids and must be checked by a person before acting.</p>
      <h2>6. Records and audit</h2>
      <p>Calls are recorded. Messages, edits, logins, record views, recording playback and exports are logged with user and time. Hinduja may review, audit and download any record at any time.</p>
      <h2>7. Exports</h2>
      <p>Bulk export is limited to roles that hold export rights. Every export is logged. Exported data must be stored and shared only as Hinduja permits.</p>
      <h2>8. Suspension</h2>
      <p>Access may be suspended immediately for misuse, a suspected security incident, or at Hinduja’s request.</p>
      <h2>9. Contact</h2>
      <p>Questions about these terms: the SecondMedic account lead or the Hinduja programme owner named in the service agreement.</p>
    </div>
  );
}

export function Privacy() {
  return (
    <div className="legal">
      <Head title="Privacy Notice" updated="7 October 2026" />
      <h2>Roles under the DPDP Act, 2023</h2>
      <p>Hinduja Home Care Services is the <strong>Data Fiduciary</strong> and owner of all HHCS records. SecondMedic is the <strong>Data Processor</strong> and processes personal data only on Hinduja’s documented instructions under a Data Processing Agreement.</p>
      <h2>What we collect</h2>
      <ul>
        <li>Patient and caller details: name, age, gender, mobile, email, address, pincode and location for the visit.</li>
        <li>Service details: tests and procedures requested, booking slots, sample barcodes, reports, payments and receipts.</li>
        <li>Communications: call recordings (inbound and outbound), WhatsApp, SMS, email and chat messages linked to the patient.</li>
        <li>Consent records: verbal consent on the recorded call and digital consent at the visit.</li>
        <li>Staff activity: logins, record views, edits, recording playback and exports.</li>
      </ul>
      <h2>Why we use it</h2>
      <p>Customer feedback: you may give separate call and delivered-service ratings and comments through a private link or by replying to our feedback message on WhatsApp or email. Responses are linked to the relevant interaction and reviewed by authorized HHCS and SecondMedic staff. Please keep medical details and personal information out of comments. Each request expires and accepts one response.</p>
      <p>Only to deliver HHCS home services: responding to enquiries, quoting from the approved rate card, booking and deploying field staff, collecting samples and performing ECG and X-ray at home, delivering reports, collecting payments, handling complaints and escalations, and producing MIS for Hinduja. Data is not used for SecondMedic marketing or any independent purpose.</p>
      <h2>AI processing</h2>
      <p>Call recordings and case notes may be processed by an AI model to produce transcripts, summaries, quality scores and suggested next steps. Outputs are reviewed by staff, are not used to make clinical decisions, and are stored with the case. The AI provider is listed as a sub-processor in the DPA.</p>
      <h2>Sharing</h2>
      <p>Only with Hinduja and with sub-processors approved by Hinduja and listed in the DPA (cloud hosting, database, telephony, messaging, AI). Each is bound by equivalent obligations. No other third-party sharing.</p>
      <h2>Security</h2>
      <ul>
        <li>Data hosted in India; encrypted in transit and at rest.</li>
        <li>Role-based access with row-level security in the database; agents see masked mobile numbers.</li>
        <li>Multi-factor authentication, automatic logout, quarterly access reviews and periodic vulnerability assessments.</li>
      </ul>
      <h2>Retention and exit</h2>
      <p>Records are kept for the period set in the contract and by law. If the engagement ends, all records are exported to Hinduja (CRM data in Excel/CSV, recordings in standard audio, reports in PDF), the number, mailbox and WhatsApp ID transfer to Hinduja, and SecondMedic deletes its copies with a written certificate, except where law requires retention.</p>
      <h2>Your rights</h2>
      <p>Patients may ask Hinduja to access, correct or erase their data, withdraw consent, or raise a grievance. Requests received by SecondMedic are passed to Hinduja the same day.</p>
      <h2>Grievance contact</h2>
      <p>Hinduja’s Data Protection Officer, as named in the service agreement, or the HHCS support number and mailbox.</p>
    </div>
  );
}
