// Formatting helpers (IST, INR, durations, labels)
const TZ = 'Asia/Kolkata';

export const inr = (n, opts = {}) => n == null || n === '' ? '–'
  : '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: opts.decimals ?? (Number(n) % 1 ? 2 : 0), minimumFractionDigits: opts.decimals ?? (Number(n) % 1 ? 2 : 0) });

export const num = (n) => (n == null ? '–' : Number(n).toLocaleString('en-IN'));
export const pct = (n, d = 0) => (n == null || isNaN(n) ? '–' : `${Number(n).toFixed(d)}%`);

export const time = (d) => d ? new Date(d).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }) : '–';
export const date = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: TZ }) : '–';
export const dateLong = (d) => d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ }) : '–';
export const dateTime = (d) => d ? `${date(d)} · ${time(d)}` : '–';

export function ago(d, now = Date.now()) {
  if (!d) return '–';
  let s = Math.round((now - new Date(d).getTime()) / 1000);
  if (s < 0 && s > -60) s = 0;
  if (s < 5 && s >= 0) return 'just now';
  const a = Math.abs(s);
  const str = a < 60 ? `${a}s` : a < 3600 ? `${Math.round(a / 60)}m` : a < 86400 ? `${Math.floor(a / 3600)}h ${Math.round((a % 3600) / 60)}m` : `${Math.round(a / 86400)}d`;
  return s >= 0 ? `${str} ago` : `in ${str}`;
}

// "04:31"
export const dur = (sec) => sec == null ? '–' : `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

// countdown to a deadline: "07:42" or "-02:10" when overdue
export function countdown(due, now = Date.now()) {
  if (!due) return null;
  const s = Math.round((new Date(due).getTime() - now) / 1000);
  const a = Math.abs(s);
  const h = Math.floor(a / 3600), m = Math.floor((a % 3600) / 60), sec = a % 60;
  const body = h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return { text: (s < 0 ? '−' : '') + body, overdue: s < 0, seconds: s };
}

export const STAGES = ['enquiry', 'pricing', 'booking', 'deployment', 'completion', 'payment', 'closure'];
export const STAGE_LABEL = {
  enquiry: 'Enquiry', pricing: 'Pricing', booking: 'Booking', deployment: 'Deployment', completion: 'Completion',
  payment: 'Payment', closure: 'Closure', closed: 'Closed', cancelled: 'Cancelled',
};
export const SLA_LABEL = {
  call_answer: 'Call answer', missed_callback: 'Missed-call callback', ack: 'Acknowledgement', quote: 'Quote shared', provider_accept: 'Provider accepts lead',
  booking: 'Booking confirmation', arrival_urgent: 'Arrival (urgent)', arrival_slot: 'Arrival (slot)',
  complaint_ack: 'Complaint ack', complaint_resolve: 'Complaint resolution', critical_finding: 'Critical finding',
};
export const ROLE_LABEL = {
  agent: 'Contact centre agent', coordinator: 'Coordinator', supervisor: 'Supervisor', field_staff: 'Field staff',
  medical_desk: 'Medical desk', client_manager: 'Hinduja management', client_clinical: 'Hinduja clinical', admin: 'Platform admin', provider: 'Service provider',
  administrator: 'Administrator',
};
export const DEPARTMENTS = [
  ['administrator', 'Administration', 'Full access: everything supervisors, Hinduja management and the platform admin can do; creates staff of any role.'],
  ['agent', 'Contact centre', 'Calls and WhatsApp, new enquiries, quotes, the callback queue. Sees masked phone numbers.'],
  ['coordinator', 'Coordination', 'All active cases, booking, field and hospital-visit assignment, reconciliation.'],
  ['supervisor', 'Supervision', 'Everything operational: recordings, QA, MIS, audit, controlled export.'],
  ['field_staff', 'Field team', 'Only their assigned visits: check-in, samples, payment collection, hospital validation visits.'],
  ['medical_desk', 'Medical desk', 'Clinical triage and escalations.'],
  ['client_manager', 'Hinduja management', 'Full visibility, approvals (discounts, rate card, templates), export.'],
  ['client_clinical', 'Hinduja clinical', 'Clinical records, escalations, MIS.'],
  ['admin', 'Platform admin', 'SecondMedic configuration and users only; no patient data.'],
  ['provider', 'Service partners', 'Partner staff (for example Book My Medicare): only the leads sent to their partner, never calls or recordings.'],
];
export const CHANNEL_LABEL = { phone: 'Phone', whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', chat: 'Chat', note: 'Note', system: 'System', crm_edit: 'CRM edit', field: 'Field', lab: 'Lab', payment: 'Payment', walkin: 'Walk-in', referral: 'Referral' };

export const initials = (name = '') => name.replace(/^(Mr\.|Mrs\.|Ms\.|Dr\.)\s*/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

// IST day range helpers → ISO strings
export function istDayRange(offsetDays = 0, spanDays = 1) {
  const now = new Date(Date.now() + 5.5 * 3600e3);
  now.setUTCHours(0, 0, 0, 0);
  const start = new Date(now.getTime() - 5.5 * 3600e3 + offsetDays * 86400e3);
  const end = new Date(start.getTime() + spanDays * 86400e3);
  return [start.toISOString(), end.toISOString()];
}
export const istDateStr = (offsetDays = 0) => new Date(Date.now() + 5.5 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);

export const toLocalInput = (d) => {
  if (!d) return '';
  const x = new Date(new Date(d).getTime() + 5.5 * 3600e3);
  return x.toISOString().slice(0, 16);
};
export const fromLocalInput = (s) => (s ? new Date(s + ':00+05:30').toISOString() : null);
