// Settings > Rate card: selling rates (B2C, Hinduja-approved), buying rates (B2B, what SecondMedic pays each provider)
// and Import rates (Excel / CSV: map columns, server check and preview, then submit). Buying rates are confidential:
// the database returns them only to SecondMedic supervisors, coordinators and the platform admin.
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { db, q, rpc } from '../lib/db.js';
import { useLoad } from '../lib/hooks.js';
import { roleAllows, useAuth } from '../lib/auth.jsx';
import { inr, dateTime, dateLong, ago, istDateStr } from '../lib/fmt.js';
import {
  Panel, Badge, Button, Modal, Field, Input, Select, Textarea, Segmented, Kpi, TableSkeleton, Skeleton, Empty, ErrorNote, useAction,
} from '../components/ui.jsx';

export const RATE_MANAGERS = ['supervisor', 'admin'];
const BUYING_VIEWERS = ['supervisor', 'coordinator', 'admin'];
const CAT = { lab: 'Sample collection', xray: 'Portable X-ray', ecg: 'ECG at home', visit: 'Visit charges', nursing: 'Nursing', physio: 'Physiotherapy',
  beds: 'Hospital beds', eldercare: 'Elder care', homecare: 'Other home care', equipment: 'Equipment', icu: 'ICU setup', consumables: 'Consumables', other: 'Other' };
const GST = { incl_gst: 'Includes GST', excl_gst: 'GST extra', no_gst: 'No GST charged' };
const GST_OPTS = Object.entries(GST);
const day = (d) => (d ? dateLong(`${String(d).slice(0, 10)}T00:00:00+05:30`) : '–');
const STATUS = { new: ['info', 'New'], changed: ['warn', 'Changed'], unchanged: ['', 'Unchanged'] };
const BY_CATEGORY = '*category';

export function RatesTab() {
  const { profile } = useAuth();
  const [sp, setSp] = useSearchParams();
  const views = [['selling', 'Selling rates (B2C)', null], ['buying', 'Buying rates (B2B)', BUYING_VIEWERS], ['import', 'Import rates', RATE_MANAGERS]]
    .filter(([, , roles]) => !roles || roleAllows(roles, profile.role));
  const view = views.some(([k]) => k === sp.get('view')) ? sp.get('view') : 'selling';
  return (
    <div className="col gap-12">
      {views.length > 1 && <div className="row"><Segmented value={view} onChange={(v) => setSp({ tab: 'rates', view: v }, { replace: true })} options={views.map(([k, l]) => [k, l])} /></div>}
      {view === 'selling' && <SellingRates />}
      {view === 'buying' && <BuyingRates />}
      {view === 'import' && <ImportRates />}
    </div>
  );
}

// ------------------------------------------------------------------ selling (B2C)
function SellingRates() {
  const { can } = useAuth();
  const editor = can('supervisor', 'admin');
  const [cat, setCat] = useState('');
  const [req, setReq] = useState(null);
  const svc = useLoad(() => q(db.from('services').select('*').order('category').order('code')), [], ['services']);
  const sched = useLoad(() => q(db.from('service_price_history').select('id,service_id,price,tax_basis,effective_from').eq('status', 'scheduled').order('effective_from')), [], ['service_price_history']);
  const pend = useLoad(() => (can('supervisor', 'coordinator', 'client_manager', 'admin')
    ? q(db.from('v_approvals').select('id,kind,title,payload,status,requested_at,requested_by_name,decided_at,decision_note').in('kind', ['rate_change', 'rate_import']).order('requested_at', { ascending: false }).limit(10))
    : Promise.resolve([])), [], ['approvals']);
  const cats = [...new Set((svc.data || []).map((s) => s.category))];
  const rows = (svc.data || []).filter((s) => !cat || s.category === cat);
  const byId = Object.fromEntries((svc.data || []).map((s) => [s.id, s]));
  return (
    <div className="grid g-main-side">
      <Panel tight title={<Segmented value={cat} onChange={setCat} options={[['', 'All'], ...cats.map((c) => [c, CAT[c] || c])]} />}
        actions={<span className="small muted">{rows.length} services</span>}>
        <ErrorNote error={svc.error} />
        {svc.loading ? <TableSkeleton rows={10} cols={8} /> : rows.length ? (
          <div className="table-wrap"><table className="t">
            <thead><tr><th>Code</th><th>Service</th><th>Unit</th><th className="num">Price</th><th>GST</th><th className="num">TAT</th><th className="num">Ver.</th><th>Approved</th>{editor && <th />}</tr></thead>
            <tbody>{rows.map((s) => (
              <tr key={s.id} className={s.active ? '' : 'muted'}>
                <td className="mono small">{s.code}</td>
                <td>{s.name}{!s.active && <> <Badge>inactive</Badge></>}{s.description && <div className="tiny muted">{s.description}</div>}<div className="tiny muted">{CAT[s.category] || s.category}</div></td>
                <td className="small nowrap">per {s.unit}</td>
                <td className="num">{Number(s.price) > 0 ? inr(s.price) : <span className="warn-text tiny">Not priced</span>}</td>
                <td className="small nowrap">{GST[s.tax_basis] || <span className="faint">Not confirmed</span>}</td>
                <td className="num">{s.tat_hours ? `${s.tat_hours} h` : '–'}</td>
                <td className="num">v{s.version}</td>
                <td className="nowrap small">{s.approved_at ? dateTime(s.approved_at) : <Badge kind="warn">Not approved</Badge>}</td>
                {editor && <td className="right"><Button size="xs" onClick={() => setReq(s)}>Request change</Button></td>}
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No services in this category" />}
      </Panel>
      <div className="col gap-12">
        <Panel title="Locked rate card">
          <div className="small">Selling prices change only after Hinduja approval; there is no free-text price field anywhere in the CRM. A quote copies the price, version, unit and GST basis at the moment a service is added, and keeps them when the rate card changes later. A draft quote can be refreshed on purpose from the case.</div>
          {editor && <div className="tiny faint mt-8">Use Request change on a row, or Import rates for a whole sheet. Hinduja management approves or rejects in Approvals.</div>}
        </Panel>
        <Panel title="Approved, starting later" tight>
          {sched.loading ? <div className="panel-body"><Skeleton lines={2} /></div> : sched.data?.length ? sched.data.map((h) => (
            <div key={h.id} className="list-row">
              <div className="grow small"><span className="mono">{byId[h.service_id]?.code}</span> {byId[h.service_id]?.name}<div className="tiny muted">{GST[h.tax_basis] || 'GST basis kept'}</div></div>
              <div className="right small"><div className="mono strong">{inr(h.price)}</div><div className="tiny muted">from {day(h.effective_from)}</div></div>
            </div>
          )) : <Empty title="No scheduled selling prices" />}
        </Panel>
        <Panel title="Price change requests" tight>
          {pend.loading ? <div className="panel-body"><Skeleton lines={3} /></div> : pend.data?.length ? pend.data.map((a) => (
            <div key={a.id} className="list-row" style={{ alignItems: 'flex-start' }}>
              <div className="grow">
                <div className="small">{a.title}</div>
                <div className="tiny muted">{a.requested_by_name || '–'} · {ago(a.requested_at)}{a.payload?.reason ? ` · ${a.payload.reason}` : ''}</div>
              </div>
              <Badge kind={a.status === 'approved' ? 'ok' : a.status === 'pending' ? 'warn' : a.status === 'rejected' ? 'danger' : ''}>{a.status}</Badge>
            </div>
          )) : <Empty title="No price change requests" />}
        </Panel>
      </div>
      {req && <RateChange s={req} onClose={() => setReq(null)} onDone={() => { setReq(null); pend.reload(); }} />}
    </div>
  );
}

function RateChange({ s, onClose, onDone }) {
  const [price, setPrice] = useState(String(s.price));
  const [reason, setReason] = useState('');
  const [run, busy] = useAction();
  const n = Number(price);
  const ok = price !== '' && n >= 0 && n !== Number(s.price) && reason.trim().length >= 5;
  const send = () => run(async () => { await rpc('request_rate_change', { p_service: s.id, p_new_price: n, p_reason: reason.trim() }); onDone(); }, 'Sent to Hinduja management for approval');
  return (
    <Modal title={`Request price change · ${s.code}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" onClick={send} disabled={!ok || busy}>Send for approval</Button></>}>
      <div className="small mb-12">{s.name} · per {s.unit} · current price <span className="mono strong">{inr(s.price)}</span> · v{s.version}</div>
      <div className="form-grid">
        <Field label="Proposed price (₹)"><Input type="number" min="0" step="1" className="mono" value={price} onChange={(e) => setPrice(e.target.value)} autoFocus /></Field>
        <Field label="Change"><Input disabled className="mono" value={price === '' ? '–' : `${n >= s.price ? '+' : ''}${inr(n - s.price)} (${s.price ? (((n - s.price) / s.price) * 100).toFixed(1) : '–'}%)`} /></Field>
        <Field label="Reason" className="span2" hint="seen by the approver"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Lab partner revised reagent cost from 1 November" /></Field>
      </div>
      <div className="tiny faint mt-8">The price stays unchanged until Hinduja approves. Open quotes keep the price they were created with.</div>
    </Modal>
  );
}

// ------------------------------------------------------------------ buying (B2B)
function BuyingRates() {
  const { can } = useAuth();
  const manager = can('supervisor', 'admin');
  const today = istDateStr(0);
  const [prov, setProv] = useState('');
  const [find, setFind] = useState('');
  const [hist, setHist] = useState(false);
  const [edit, setEdit] = useState(null);
  const [ending, setEnding] = useState(null);
  const rates = useLoad(() => q(db.from('provider_rates').select('*').order('effective_from', { ascending: false }).range(0, 4999)), [], ['provider_rates']);
  const svcs = useLoad(() => q(db.from('services').select('id,code,name,category,unit,price,tax_basis,active').order('code')), [], ['services']);
  const provs = useLoad(() => q(db.from('providers').select('id,code,name,active').order('code')), [], ['providers']);
  const S = Object.fromEntries((svcs.data || []).map((s) => [s.id, s]));
  const P = Object.fromEntries((provs.data || []).map((p) => [p.id, p]));
  const stateOf = (r) => (r.status === 'replaced' ? ['', 'Replaced'] : r.effective_from > today ? ['info', 'Starts later']
    : r.effective_to && r.effective_to <= today ? ['', 'Ended'] : ['ok', 'In force']);
  const f = find.trim().toLowerCase();
  const rows = (rates.data || []).filter((r) => (hist || (r.status === 'valid' && !(r.effective_to && r.effective_to <= today)))
    && (!prov || r.provider_id === prov)
    && (!f || `${S[r.service_id]?.code} ${S[r.service_id]?.name}`.toLowerCase().includes(f)))
    .sort((a, b) => (`${P[a.provider_id]?.code}${S[a.service_id]?.code}${a.effective_from}` < `${P[b.provider_id]?.code}${S[b.service_id]?.code}${b.effective_from}` ? -1 : 1));
  return (
    <div className="col gap-12">
      <Panel tight title={<div className="row wrap" style={{ gap: 8 }}>
          <Segmented value={prov} onChange={setProv} options={[['', 'All providers'], ...(provs.data || []).map((p) => [p.id, p.code])]} />
          <Input placeholder="Find service" value={find} onChange={(e) => setFind(e.target.value)} style={{ width: 180 }} aria-label="Find service" />
          <label className="check small"><input type="checkbox" checked={hist} onChange={(e) => setHist(e.target.checked)} />Show ended and replaced</label>
        </div>}
        actions={manager && <Button size="sm" kind="primary" icon="plus" onClick={() => setEdit({})}>Set buying rate</Button>}
        sub="What SecondMedic pays each provider per rate-card unit. Confidential: not shown to Hinduja, agents, field staff, medical desk or partners.">
        <ErrorNote error={rates.error} />
        {rates.loading || svcs.loading ? <TableSkeleton rows={8} cols={9} /> : rows.length ? (
          <div className="table-wrap"><table className="t compact">
            <thead><tr><th>Provider</th><th>Service</th><th>Unit</th><th className="num">B2B rate</th><th>GST</th><th>From</th><th>To</th><th>State</th><th className="num">B2C now</th>{manager && <th />}</tr></thead>
            <tbody>{rows.map((r) => {
              const s = S[r.service_id] || {}; const [k, l] = stateOf(r);
              return (
                <tr key={r.id} className={r.status === 'replaced' ? 'muted' : ''}>
                  <td className="mono small">{P[r.provider_id]?.code || '–'}</td>
                  <td><span className="mono small">{s.code}</span> {s.name}{r.note && <div className="tiny muted">{r.note}</div>}</td>
                  <td className="small nowrap">per {r.unit}{s.unit && s.unit !== r.unit && <div className="tiny danger-text">rate card is now per {s.unit}</div>}</td>
                  <td className="num">{inr(r.rate)}</td>
                  <td className="small nowrap">{GST[r.tax_basis]}</td>
                  <td className="small nowrap">{day(r.effective_from)}</td>
                  <td className="small nowrap">{r.effective_to ? day(r.effective_to) : <span className="faint">open</span>}</td>
                  <td><Badge kind={k}>{l}</Badge></td>
                  <td className="num small">{Number(s.price) > 0 ? inr(s.price) : <span className="faint">not priced</span>}</td>
                  {manager && <td className="right nowrap">{r.status === 'valid' && !(r.effective_to && r.effective_to <= today) && <>
                    <Button size="xs" kind="ghost" onClick={() => setEdit({ provider_id: r.provider_id, service_id: r.service_id })}>New rate</Button>
                    <Button size="xs" kind="ghost" onClick={() => setEnding(r)}>End</Button></>}</td>}
                </tr>
              );
            })}</tbody>
          </table></div>
        ) : <Empty title="No buying rates yet">Set them one by one, or import a sheet under Import rates.</Empty>}
      </Panel>
      {edit && <SetBuyingRate init={edit} services={svcs.data || []} providers={(provs.data || []).filter((p) => p.active)} rates={rates.data || []} onClose={() => setEdit(null)} />}
      {ending && <EndRate r={ending} label={`${P[ending.provider_id]?.code} · ${S[ending.service_id]?.code}`} onClose={() => setEnding(null)} />}
    </div>
  );
}

function SetBuyingRate({ init, services, providers, rates, onClose }) {
  const [run, busy] = useAction();
  const today = istDateStr(0);
  const [f, setF] = useState({ provider_id: init.provider_id || '', service_id: init.service_id || '', rate: '', from: today, gst: '', note: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const s = services.find((x) => x.id === f.service_id);
  const cur = rates.find((r) => r.status === 'valid' && r.provider_id === f.provider_id && r.service_id === f.service_id && s && r.unit === s.unit
    && r.effective_from <= f.from && (!r.effective_to || r.effective_to > f.from));
  const ok = f.provider_id && f.service_id && /^\d+(\.\d{1,2})?$/.test(f.rate.trim()) && f.from && f.gst;
  const save = () => run(async () => {
    await rpc('set_provider_rate', { p_provider: f.provider_id, p_service: f.service_id, p_rate: Number(f.rate), p_effective_from: f.from, p_tax_basis: f.gst, p_note: f.note.trim() || null });
    onClose();
  }, 'Buying rate saved');
  return (
    <Modal title="Set buying rate" onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={!ok || busy} onClick={save}>Save</Button></>}>
      <div className="form-grid">
        <Field label="Provider"><Select value={f.provider_id} onChange={set('provider_id')} placeholder="Choose" options={providers.map((p) => [p.id, `${p.code} · ${p.name}`])} /></Field>
        <Field label="Service"><Select value={f.service_id} onChange={set('service_id')} placeholder="Choose" options={services.map((x) => [x.id, `${x.code} · ${x.name} · per ${x.unit}`])} /></Field>
        <Field label={`B2B rate (₹)${s ? ` per ${s.unit}` : ''}`}><Input className="mono" inputMode="decimal" value={f.rate} onChange={set('rate')} placeholder="0.00" /></Field>
        <Field label="Applies from"><Input type="date" value={f.from} onChange={set('from')} /></Field>
        <Field label="GST basis"><Select value={f.gst} onChange={set('gst')} placeholder="Choose" options={GST_OPTS} /></Field>
        <Field label="Note" hint="optional"><Input value={f.note} onChange={set('note')} placeholder="e.g. BMM letter of 12 Oct" /></Field>
      </div>
      <div className="tiny faint mt-8">{cur ? `In force on that date: ${inr(cur.rate)} (${GST[cur.tax_basis]}) from ${day(cur.effective_from)}. The new rate ends it the day before.` : 'No rate in force for this provider and service on that date.'} The unit is the rate-card unit and is never converted. Bookings already made keep the cost they captured.</div>
    </Modal>
  );
}

function EndRate({ r, label, onClose }) {
  const [run, busy] = useAction();
  const [end, setEnd] = useState(istDateStr(1));
  return (
    <Modal title={`End buying rate · ${label}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button kind="danger" disabled={busy || !end} onClick={() => run(async () => { await rpc('end_provider_rate', { p_rate: r.id, p_end: end }); onClose(); }, 'Rate ended')}>End rate</Button></>}>
      <div className="small mb-12">{inr(r.rate)} per {r.unit}, in force from {day(r.effective_from)}. From the end date new quotes find no rate for this provider and show the cost as missing.</div>
      <Field label="Last day + 1 (first day without this rate)"><Input type="date" value={end} min={String(r.effective_from).slice(0, 10)} onChange={(e) => setEnd(e.target.value)} /></Field>
    </Modal>
  );
}

// ------------------------------------------------------------------ import
const FIELDS = [
  ['service_code', 'Service Code', ['servicecode', 'code']],
  ['service_name', 'Service Name', ['servicename', 'service', 'name', 'serviceequipmentdiagnostics', 'serviceequipment', 'item']],
  ['provider_code', 'Provider Code', ['providercode', 'provider', 'suppliercode', 'supplier']],
  ['category', 'Category', ['category']],
  ['unit', 'Unit', ['unit', 'uom']],
  ['b2b', 'B2B Rate', ['b2brate', 'b2b', 'buyingrate']],
  // never "BMM B2C / Listed Tariff": that is a provider's own customer price, not ours
  ['b2c', 'B2C Rate', ['b2crate', 'b2c', 'sellingrate', 'proposedhindujapatientprice', 'hindujapatientprice', 'patientprice']],
  ['effective_from', 'Effective From', ['effectivefrom', 'effectivedate']],
];
const CAT_IN = { lab: 'lab', 'sample collection': 'lab', 'blood test': 'lab', 'blood tests': 'lab', xray: 'xray', 'x-ray': 'xray', 'portable x-ray': 'xray',
  ecg: 'ecg', 'ecg at home': 'ecg', visit: 'visit', 'visit charges': 'visit', nursing: 'nursing', physio: 'physio', physiotherapy: 'physio', beds: 'beds',
  'hospital beds': 'beds', eldercare: 'eldercare', 'elder care': 'eldercare', homecare: 'homecare', 'home care': 'homecare', 'other home care': 'homecare',
  equipment: 'equipment', icu: 'icu', 'icu setup': 'icu', consumables: 'consumables', other: 'other' };
const normHead = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pad = (n) => String(n).padStart(2, '0');
// rate-card codes: letters and digits joined by hyphens, at most 30, cut at a word where it can be
const codeWords = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
function fitCode(s, n) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n + 1).lastIndexOf('-');
  return (cut >= n / 2 ? s.slice(0, cut) : s.slice(0, n)).replace(/-+$/, '');
}
/** Code for a name; with a unit (the same name sold in several units) the unit's first words stay on the end. */
function suggestCode(name, unit) {
  if (!unit) return fitCode(codeWords(name), 30);
  const u = fitCode(codeWords(unit), 10);
  return `${fitCode(codeWords(name), 29 - u.length)}-${u}`;
}
const unitWords = (u) => String(u || '').trim().replace(/^per\s+/i, '');
/** A starting category for a new service, from its name. Shown for review; the person confirming decides. */
function guessCategory(name) {
  const n = String(name || '').toLowerCase();
  const rules = [[/telemonitor|holter|abpm/, 'homecare'], [/x[- ]?ray/, 'xray'], [/\becg\b/, 'ecg'], [/physio/, 'physio'],
    [/nurs|dressing|picc/, 'nursing'], [/attendant|caretaker|care taker|elder/, 'eldercare'], [/ambulance/, 'other'], [/doctor/, 'homecare'],
    [/\bbeds?\b/, 'beds'], [/oxygen|concentrator|cylinder|airvo|hfnc|monitor|ventilator|bipap|cpap|stellar|lumis|pump|suction|mattress|wheelchair|walker|commode/, 'equipment'],
    [/blood|\blab\b|sample/, 'lab']];
  return (rules.find(([re]) => re.test(n)) || [])[1] || '';
}

/** Cell text as the sheet shows it: numbers unformatted, date cells as YYYY-MM-DD, spreadsheet errors as #N/A etc. */
function cellText(c) {
  if (!c) return '';
  if (c.t === 'e') return c.w || '#ERROR';
  if (c.t === 'n') {
    if (c.z && XLSX.SSF.is_date(c.z)) { const d = XLSX.SSF.parse_date_code(c.v); if (d) return `${d.y}-${pad(d.m)}-${pad(d.d)}`; }
    return String(c.v);
  }
  if (c.t === 'd' && c.v instanceof Date) return `${c.v.getFullYear()}-${pad(c.v.getMonth() + 1)}-${pad(c.v.getDate())}`;
  if (c.t === 'b') return c.v ? 'TRUE' : 'FALSE';
  return String(c.v ?? c.w ?? '').trim();
}
function sheetGrid(ws) {
  if (!ws || !ws['!ref']) return { cols: [], rows: [] };
  const r = XLSX.utils.decode_range(ws['!ref']);
  const cols = []; for (let C = r.s.c; C <= r.e.c; C++) cols.push(XLSX.utils.encode_col(C));
  const rows = [];
  for (let R = r.s.r; R <= r.e.r; R++) {
    const cells = []; for (let C = r.s.c; C <= r.e.c; C++) cells.push(cellText(ws[XLSX.utils.encode_cell({ r: R, c: C })]));
    rows.push({ n: R + 1, cells });
  }
  return { cols, rows };
}
const firstHeader = (rows) => Math.max(0, rows.findIndex((r) => r.cells.filter(Boolean).length >= 2));
function autoMap(headers) {
  const map = {};
  for (const [k, , aliases] of FIELDS) {
    const i = headers.findIndex((h, j) => aliases.includes(normHead(h)) && !Object.values(map).includes(String(j)));
    map[k] = i >= 0 ? String(i) : '';
  }
  return map;
}

function ImportRates() {
  const [run, busy] = useAction();
  const [file, setFile] = useState(null);        // { name, wb, sheet, grid, head }
  const [map, setMap] = useState({});
  const [opts, setOpts] = useState({ buy_tax_basis: '', sell_tax_basis: '', effective_from: '', provider_code: '', buy_pct_of_sell: '' });
  const [resolve, setResolve] = useState({});    // file row -> { service_id } | { new_service } | { provider_id }
  const [check, setCheck] = useState(null);      // server preview
  const [stale, setStale] = useState(false);
  const [filter, setFilter] = useState('all');
  const [fixing, setFixing] = useState(null);
  const [reviewing, setReviewing] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [done, setDone] = useState(null);
  const svcs = useLoad(() => q(db.from('services').select('id,code,name,category,unit,price,tax_basis,active').order('code')), [], ['services']);
  const provs = useLoad(() => q(db.from('providers').select('id,code,name,active,categories').order('code')), []);
  const hist = useLoad(() => q(db.from('rate_imports').select('id,file_name,sheet_name,summary,buy_status,sell_status,created_at,approval_id').order('created_at', { ascending: false }).limit(15)), [], ['rate_imports', 'approvals']);

  const touch = () => { setStale(true); setDone(null); };
  const openFile = async (f) => {
    setCheck(null); setDone(null); setResolve({}); setStale(false);
    if (!f) return;
    if (!/\.(xlsx|csv)$/i.test(f.name)) throw new Error('Choose an .xlsx or .csv file');
    const csv = /\.csv$/i.test(f.name);
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: false, raw: csv });
    const sheet = wb.SheetNames.find((n) => wb.Sheets[n]?.['!ref']) || wb.SheetNames[0];
    pickSheet({ name: f.name, wb }, sheet);
  };
  const pickSheet = (base, sheet, headAt) => {
    const grid = sheetGrid(base.wb.Sheets[sheet]);
    const head = headAt ?? firstHeader(grid.rows);
    setFile({ ...base, sheet, grid, head });
    setMap(autoMap(grid.rows[head]?.cells || []));
    setCheck(null); setResolve({}); setStale(false);
  };
  const headers = file ? (file.grid.rows[file.head]?.cells || []) : [];
  const dataRows = useMemo(() => (file ? file.grid.rows.slice(file.head + 1).filter((g) => FIELDS.some(([k]) => map[k] !== '' && map[k] != null && g.cells[Number(map[k])])) : []), [file, map]);
  const sent = useMemo(() => dataRows.map((g) => {
    const o = { row: g.n };
    for (const [k] of FIELDS) if (map[k] !== '' && map[k] != null) o[k] = g.cells[Number(map[k])] ?? '';
    return { ...o, ...(resolve[g.n] || {}) };
  }), [dataRows, map, resolve]);
  const sentBy = useMemo(() => Object.fromEntries(sent.map((o) => [o.row, o])), [sent]);
  // "By category" in the Provider choice = the provider_by_routing option (the server picks by the case-routing categories)
  const options = () => {
    const o = Object.fromEntries(Object.entries(opts).filter(([, v]) => v));
    if (o.provider_code === BY_CATEGORY) { delete o.provider_code; o.provider_by_routing = true; }
    return o;
  };
  const runCheck = () => run(async () => {
    const r = await rpc('rate_import_check', { p_rows: sent, p_options: options() });
    setCheck(r); setStale(false); setFilter(r.ok ? 'changes' : 'errors');
  });
  const submit = () => run(async () => {
    const r = await rpc('submit_rate_import', { p_rows: sent, p_options: options(), p_file_name: file.name, p_sheet: file.sheet });
    setDone(r); setConfirm(false); hist.reload();
  }, null);

  const rowsOut = check?.rows || [];
  const shown = rowsOut.filter((r) => filter === 'all' || (filter === 'errors' ? r.errors.length : filter === 'warnings' ? r.warnings.length
    : ['new', 'changed'].includes(r.buy?.status) || ['new', 'changed'].includes(r.sell?.status)));
  // rows whose service is not on the rate card (unknown code, or a sheet without codes) and not resolved yet
  const unknownCodes = rowsOut.filter((r) => !r.service_id && !resolve[Number(r.row)]?.new_service
    && r.errors.some((e) => e.startsWith('Unknown service code') || e.startsWith('No service code')));
  const confirmNew = (defs) => {
    const next = { ...resolve };
    for (const [row, ns] of Object.entries(defs)) next[row] = { ...(next[row] || {}), new_service: ns };
    setResolve(next); setReviewing(false); touch();
  };
  const s = check?.summary;
  const changes = s ? s.buy_new + s.buy_changed + s.sell_new + s.sell_changed : 0;
  const hasB2b = (map.b2b !== '' && map.b2b != null) || opts.buy_pct_of_sell.trim() !== '';
  const routing = (provs.data || []).filter((p) => p.active && p.categories?.length).map((p) => `${p.code}: ${p.categories.map((c) => CAT[c] || c).join(', ')}`).join(' · ');
  const hasB2c = map.b2c !== '' && map.b2c != null;

  const template = async () => {
    const [svc, prov] = await Promise.all([q(db.from('services').select('code,name,category,unit,price,tax_basis,active').order('code')), q(db.from('providers').select('code,name,active').order('code'))]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([FIELDS.map((x) => x[1])]), 'Rates');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
      ['Column', 'What to enter'],
      ['Service Code', 'The rate-card code (sheet "Rate card"). A new code is added only when you confirm it as a new service in the preview.'],
      ['Service Name', 'For reading and for new services. Existing services are found by code, never by name.'],
      ['Provider Code', 'Who SecondMedic pays (sheet "Providers"). Needed on every row with a B2B rate.'],
      ['Category', 'For new services: ' + Object.values(CAT).join(', ') + '.'],
      ['Unit', 'Must equal the rate-card unit of the service (e.g. shift, day, visit, test). "Per day" and "day" are the same; nothing is converted.'],
      ['B2B Rate', 'What SecondMedic pays this provider per unit, in rupees. Blank = no change, or the share of B2C set in the import screen (B2B = % of B2C). 0 = free. One row per provider.'],
      ['B2C Rate', 'What the patient pays per unit, in rupees. Must be the same on every row of the service. Goes to Hinduja management for approval.'],
      ['Effective From', 'YYYY-MM-DD or DD-MM-YYYY. Can be set for the whole file in the import screen instead.'],
      ['GST', 'Chosen in the import screen for all B2B and all B2C rates: includes GST, GST extra, or no GST charged.'],
    ]), 'Instructions');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(svc.map((x) => ({ 'Service Code': x.code, 'Service Name': x.name, Category: x.category, Unit: x.unit,
      'B2C Rate now': Number(x.price), GST: GST[x.tax_basis] || 'not confirmed', Active: x.active ? 'yes' : 'no' }))), 'Rate card');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(prov.map((x) => ({ 'Provider Code': x.code, Provider: x.name, Active: x.active ? 'yes' : 'no' }))), 'Providers');
    XLSX.writeFile(wb, 'CareDesk-rate-import-template.xlsx');
  };
  const report = () => {
    const aoa = [['File row', 'Service Code', 'Service', 'Provider', 'Unit', 'Effective From', 'B2B old', 'B2B new', 'B2B', 'B2C old', 'B2C new', 'B2C', 'Errors', 'Warnings'],
      ...rowsOut.map((r) => [r.row, r.service_code || '', r.service_name || '', r.provider_code || '', r.unit || '', r.effective_from || '',
        r.buy?.old ?? '', r.buy?.new ?? '', r.buy?.derived ? `${r.buy.status} (${r.buy.pct}% of B2C)` : (r.buy?.status || ''), r.sell?.old ?? '', r.sell?.new ?? '', r.sell?.status || '', r.errors.join('; '), r.warnings.join('; ')])];
    if (check.file_errors?.length) aoa.push([], ['File', ...check.file_errors]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Check');
    const stamp = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '');
    XLSX.writeFile(wb, `rate-import-check-${stamp}.xlsx`);
  };

  return (
    <div className="col gap-12">
      <Panel title="Import rates" sub="Excel (.xlsx) or CSV: buying rates per provider and selling rates per service"
        actions={<Button size="sm" kind="ghost" icon="download" onClick={() => run(template)}>Download template</Button>}>
        <ol className="st-steps small">
          <li>Choose the file, the worksheet and the header row, then match each column. Nothing changes yet.</li>
          <li>Check: the server validates every row and shows old and new prices. Resolve unknown services or providers explicitly.</li>
          <li>Submit: buying rates take effect at once (their own dates); selling changes go to Hinduja management as one approval and apply only when approved, on their date.</li>
        </ol>
        <div className="row mt-12 wrap" style={{ gap: 8 }}>
          <input type="file" accept=".xlsx,.csv" aria-label="Rate file" onChange={(e) => run(() => openFile(e.target.files?.[0]))} />
          {file && file.wb.SheetNames.length > 1 && <Field label="Worksheet"><Select value={file.sheet} onChange={(e) => pickSheet(file, e.target.value)} options={file.wb.SheetNames} /></Field>}
          {file && <Field label="Header row"><Select value={String(file.head)} onChange={(e) => pickSheet(file, file.sheet, Number(e.target.value))}
            options={file.grid.rows.slice(0, 15).map((g, i) => [String(i), `Row ${g.n}: ${g.cells.filter(Boolean).slice(0, 3).join(', ').slice(0, 50) || '(empty)'}`])} /></Field>}
        </div>
      </Panel>

      {file && (
        <Panel title={`${file.name} · ${file.sheet} · ${dataRows.length} rows`} sub="Match each field to a column. Only exact template headings are matched for you."
          actions={<Button kind="primary" disabled={busy || !dataRows.length} onClick={runCheck}>{check ? 'Check again' : 'Check file'}</Button>}>
          <div className="grid g4" style={{ gap: 10 }}>
            {FIELDS.map(([k, label]) => (
              <Field key={k} label={label}>
                <Select value={map[k] ?? ''} onChange={(e) => { setMap({ ...map, [k]: e.target.value }); touch(); }} placeholder="Not in this file"
                  options={headers.map((h, i) => [String(i), `${file.grid.cols[i]}: ${h || '(no heading)'}`])} />
              </Field>
            ))}
          </div>
          <div className="grid g4 mt-12" style={{ gap: 10 }}>
            <Field label="B2B rates" hint={hasB2b ? 'required' : 'no B2B column or %'}><Select value={opts.buy_tax_basis} disabled={!hasB2b} onChange={(e) => { setOpts({ ...opts, buy_tax_basis: e.target.value }); touch(); }} placeholder="GST basis?" options={GST_OPTS} /></Field>
            <Field label="B2C rates" hint={hasB2c ? 'required' : 'no B2C column'}><Select value={opts.sell_tax_basis} disabled={!hasB2c} onChange={(e) => { setOpts({ ...opts, sell_tax_basis: e.target.value }); touch(); }} placeholder="GST basis?" options={GST_OPTS} /></Field>
            <Field label="Effective From" hint="rows without a date"><Input type="date" value={opts.effective_from} onChange={(e) => { setOpts({ ...opts, effective_from: e.target.value }); touch(); }} /></Field>
            <Field label="Provider" hint="rows without a provider code"><Select value={opts.provider_code} onChange={(e) => { setOpts({ ...opts, provider_code: e.target.value }); touch(); }} placeholder="None"
              options={[[BY_CATEGORY, 'By category (as case routing)'], ...(provs.data || []).filter((p) => p.active).map((p) => [p.code, `${p.code} · ${p.name}`])]} /></Field>
            <Field label="B2B = % of B2C" hint="rows with an empty B2B"><Input className="mono" inputMode="decimal" placeholder="e.g. 70" value={opts.buy_pct_of_sell}
              onChange={(e) => { setOpts({ ...opts, buy_pct_of_sell: e.target.value }); touch(); }} /></Field>
          </div>
          <div className="tiny faint mt-8">The GST basis is never assumed. Margins are shown only where the buying and selling rates have the same basis.
            {opts.buy_pct_of_sell.trim() !== '' && ` B2B on rows without one = ${opts.buy_pct_of_sell.trim()}% of their B2C, computed by the server to the paisa (SecondMedic keeps the rest).`}
            {opts.provider_code === BY_CATEGORY && routing && ` By category: ${routing}.`}</div>
          {stale && check && <div className="small warn-text mt-8">Changed since the last check. Check again before submitting.</div>}
        </Panel>
      )}

      {check && (
        <Panel tight title={check.ok ? 'Ready to submit' : 'Fix these before submitting'}
          sub={check.already_submitted ? `This exact content was already submitted ${ago(check.already_submitted.created_at)} (selling: ${check.already_submitted.sell_status.replace('_', ' ')}). Submitting again changes nothing.` : `Checked against today's rate card (${day(check.today)})`}
          actions={<>
            <Button size="sm" icon="download" onClick={report}>Download check report</Button>
            <Button size="sm" kind="primary" disabled={busy || stale || !check.ok || (!changes && !check.already_submitted) || !!done} onClick={() => setConfirm(true)}>Submit</Button>
          </>}>
          <div className="panel-body">
            <div className="kpis">
              <Kpi label="Rows" value={s.rows} detail={`${s.error_rows} with errors · ${s.warning_rows} with warnings`} tone={s.error_rows ? 'warn' : 'ok'} />
              <Kpi label="B2B rates" value={s.buy_new + s.buy_changed} detail={`${s.buy_new} new · ${s.buy_changed} changed · ${s.buy_unchanged} unchanged`} />
              <Kpi label="B2C rates" value={s.sell_new + s.sell_changed} detail={`${s.sell_new} new · ${s.sell_changed} changed · ${s.sell_unchanged} unchanged`} />
              <Kpi label="New services" value={s.new_services} detail="added off the quotable card until priced" />
            </div>
            {check.file_errors?.length > 0 && <div className="small danger-text mt-8">{check.file_errors.join(' · ')}</div>}
            {unknownCodes.length > 0 && (
              <div className="cd-banner warn mt-12"><div className="grow small">
                <strong>{unknownCodes.length} row(s) are not on the rate card.</strong> Review them as new services in one list (code, name, unit, category), or use Resolve on a row to choose an existing service sold in the same unit.
              </div><Button size="sm" onClick={() => setReviewing(true)}>Review {unknownCodes.length} as new services</Button></div>
            )}
            <div className="row mt-12"><Segmented value={filter} onChange={setFilter} options={[['changes', 'Changes'], ['errors', `Errors (${s.error_rows})`], ['warnings', `Warnings (${s.warning_rows})`], ['all', 'All rows']]} /></div>
          </div>
          {shown.length ? (
            <div className="table-wrap"><table className="t compact">
              <thead><tr><th>Row</th><th>Service</th><th>Provider</th><th>Unit</th><th>From</th><th className="num">B2B old → new</th><th className="num">B2C old → new</th><th>Problems</th><th /></tr></thead>
              <tbody>{shown.slice(0, 500).map((r) => (
                <tr key={r.i}>
                  <td className="mono small">{r.row}</td>
                  <td><span className="mono small">{r.service_code || '–'}</span> {r.service_name}{r.new_service && <> <Badge kind="info">New service</Badge></>}</td>
                  <td className="mono small">{r.provider_code || '–'}</td>
                  <td className="small nowrap">{r.unit ? `per ${r.unit}` : '–'}</td>
                  <td className="small nowrap">{r.effective_from ? day(r.effective_from) : '–'}</td>
                  <td className="num nowrap">{r.buy?.new != null ? <>{r.buy.old != null ? inr(r.buy.old) : '–'} → <strong>{inr(r.buy.new)}</strong> {STATUS[r.buy.status] && <Badge kind={STATUS[r.buy.status][0]}>{STATUS[r.buy.status][1]}</Badge>}{r.buy.derived && <div className="tiny muted">{r.buy.pct}% of B2C</div>}</> : <span className="faint">blank</span>}</td>
                  <td className="num nowrap">{r.sell?.new != null ? <>{r.sell.old != null ? inr(r.sell.old) : '–'} → <strong>{inr(r.sell.new)}</strong> {STATUS[r.sell.status] && <Badge kind={STATUS[r.sell.status][0]}>{STATUS[r.sell.status][1]}</Badge>}</> : <span className="faint">blank</span>}</td>
                  <td className="small">{r.errors.map((e) => <div key={e} className="danger-text">{e}</div>)}{r.warnings.map((w) => <div key={w} className="warn-text">{w}</div>)}</td>
                  <td className="right">{(r.errors.length > 0 || resolve[Number(r.row)]) && <Button size="xs" kind="ghost" onClick={() => setFixing(r)}>Resolve</Button>}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <Empty title="No rows in this view" />}
          {shown.length > 500 && <div className="tiny faint panel-body">First 500 of {shown.length} rows shown. The check report has every row.</div>}
        </Panel>
      )}

      {done && (
        <Panel title={done.duplicate ? 'Already submitted' : 'Submitted'}>
          <div className="small">{done.duplicate
            ? `This content was submitted before (buying: ${done.buy_status}, selling: ${done.sell_status.replace('_', ' ')}). Nothing was applied twice.`
            : <>{done.buying_applied} buying rate(s) saved{done.new_services ? `, ${done.new_services} new service(s) added off the quotable card` : ''}. {done.selling_changes
              ? <>{done.selling_changes} selling price change(s) sent to Hinduja management in one approval. Selling prices change only when it is approved, from their effective date.</>
              : 'No selling prices changed.'}</>}</div>
        </Panel>
      )}

      <Panel title="Recent imports" tight>
        {hist.loading ? <div className="panel-body"><Skeleton lines={3} /></div> : hist.data?.length ? (
          <div className="table-wrap"><table className="t compact">
            <thead><tr><th>When</th><th>File</th><th className="num">Rows</th><th>Buying rates</th><th>Selling rates</th></tr></thead>
            <tbody>{hist.data.map((h) => (
              <tr key={h.id}>
                <td className="small nowrap">{dateTime(h.created_at)}</td>
                <td className="small">{h.file_name || '–'}{h.sheet_name && <span className="muted"> · {h.sheet_name}</span>}</td>
                <td className="num">{h.summary?.rows ?? '–'}</td>
                <td>{h.buy_status === 'applied' ? <Badge kind="ok">Applied ({(h.summary?.buy_new || 0) + (h.summary?.buy_changed || 0)})</Badge> : <span className="faint small">none</span>}</td>
                <td>{{ none: <span className="faint small">none</span>, awaiting_approval: <Badge kind="warn">Awaiting approval</Badge>, approved: <Badge kind="ok">Approved</Badge>, rejected: <Badge kind="danger">Rejected</Badge> }[h.sell_status]}</td>
              </tr>
            ))}</tbody>
          </table></div>
        ) : <Empty title="No imports yet" />}
      </Panel>

      {reviewing && <NewServices rows={unknownCodes.map((r) => sentBy[Number(r.row)]).filter(Boolean)} existing={svcs.data || []}
        onClose={() => setReviewing(false)} onSave={confirmNew} />}
      {fixing && <ResolveRow r={fixing} current={resolve[Number(fixing.row)]} row={sentBy[Number(fixing.row)]} services={svcs.data || []} providers={(provs.data || []).filter((p) => p.active)}
        onClose={() => setFixing(null)} onSave={(v) => { setResolve({ ...resolve, [Number(fixing.row)]: v }); setFixing(null); touch(); }} />}
      {confirm && (
        <Modal title="Submit this import?" onClose={() => setConfirm(false)} footer={<><Button onClick={() => setConfirm(false)}>Cancel</Button><Button kind="primary" disabled={busy} onClick={submit}>Submit</Button></>}>
          <ul className="small">
            <li>{s.buy_new + s.buy_changed} buying rate(s) are saved now, each from its effective date. Quotes and bookings already made keep their cost.</li>
            <li>{s.sell_new + s.sell_changed} selling price(s) go to Hinduja management as one approval. Nothing changes for patients until it is approved.</li>
            {s.new_services > 0 && <li>{s.new_services} new service(s) are added, not quotable until a selling price is approved.</li>}
            <li>The server checks the whole file again; if anything fails, nothing is imported.</li>
          </ul>
        </Modal>
      )}
    </div>
  );
}

/** Every not-yet-known service of the sheet in one list: one line per service (rows of the same code, or the same name and
 *  unit, share it). Codes and categories are suggestions to review; nothing is added until the import is submitted. */
function NewServices({ rows, existing, onClose, onSave }) {
  const [list, setList] = useState(() => {
    const taken = new Set(existing.map((s) => String(s.code).toUpperCase()));
    const unitsOf = {};
    for (const o of rows) { const k = String(o.service_name || '').trim().toLowerCase(); (unitsOf[k] = unitsOf[k] || new Set()).add(unitWords(o.unit).toLowerCase()); }
    const groups = new Map();
    for (const o of rows) {
      const fileCode = String(o.service_code || '').trim().toUpperCase();
      const name = String(o.service_name || '').trim();
      const key = fileCode || `${name.toLowerCase()}|${unitWords(o.unit).toLowerCase()}`;
      if (!groups.has(key)) {
        const fileCat = CAT_IN[String(o.category || '').trim().toLowerCase()];
        let code = fileCode;
        if (!code) {
          const base = suggestCode(name, (unitsOf[name.toLowerCase()]?.size || 0) > 1 ? unitWords(o.unit) : null);
          code = base; for (let i = 2; taken.has(code); i++) code = `${base.slice(0, 27).replace(/-+$/, '')}-${i}`;
        }
        taken.add(code);
        groups.set(key, { key, rows: [], code, suggested: !fileCode, name, unit: String(o.unit || '').trim(), category: fileCat || guessCategory(name), guessed: !fileCat });
      }
      groups.get(key).rows.push(o.row);
    }
    return [...groups.values()];
  });
  const onCard = new Set(existing.map((s) => String(s.code).toUpperCase()));
  const count = {}; list.forEach((g) => { count[g.code] = (count[g.code] || 0) + 1; });
  const problem = (g) => (!/^[A-Z0-9][A-Z0-9-]{1,29}$/.test(g.code) ? '2-30 letters, digits or hyphens'
    : count[g.code] > 1 ? 'used twice in this list' : onCard.has(g.code) ? 'already on the rate card: use Resolve on the row instead'
    : !g.name ? 'needs a name' : !g.unit ? 'needs a unit' : !g.category ? 'choose a category' : null);
  const bad = list.filter(problem).length;
  const set = (key, k, v) => setList(list.map((g) => (g.key === key ? { ...g, [k]: v, ...(k === 'category' ? { guessed: false } : {}) } : g)));
  const save = () => {
    const defs = {};
    for (const g of list) for (const row of g.rows) defs[row] = { code: g.code, name: g.name, category: g.category, unit: g.unit };
    onSave(defs);
  };
  return (
    <Modal wide title={`Review ${list.length} new service${list.length === 1 ? '' : 's'}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={bad > 0} onClick={save}>Use these {list.length} services</Button></>}>
      <div className="small muted mb-8">Check each code and category. The category decides which provider a case is routed to (X-ray, ECG and lab to SecondMedic; nursing, physiotherapy, beds, equipment, elder care and other home care to Book My Medicare). Units are kept as written and never converted. The services are added only when you submit the import, off the quotable card until Hinduja approves their price.</div>
      {bad > 0 && <div className="small danger-text mb-8">{bad} line(s) need attention.</div>}
      <div className="table-wrap"><table className="t compact">
        <thead><tr><th>File rows</th><th>Service</th><th>Unit</th><th>Code</th><th>Category</th></tr></thead>
        <tbody>{list.map((g) => {
          const p = problem(g);
          return (
            <tr key={g.key}>
              <td className="mono small">{g.rows.join(', ')}</td>
              <td className="small">{g.name || <span className="danger-text">no name</span>}</td>
              <td className="small nowrap">{g.unit || <span className="danger-text">no unit</span>}</td>
              <td><Input className="mono sm" style={{ width: 210 }} value={g.code} aria-label={`Code for ${g.name}`} onChange={(e) => set(g.key, 'code', e.target.value.toUpperCase().trim())} />
                {p && <div className="tiny danger-text">{p}</div>}</td>
              <td><Select className="sm" value={g.category} aria-label={`Category for ${g.name}`} onChange={(e) => set(g.key, 'category', e.target.value)} placeholder="Choose" options={Object.entries(CAT)} />
                {g.guessed && g.category && <div className="tiny faint">suggested from the name</div>}</td>
            </tr>
          );
        })}</tbody>
      </table></div>
    </Modal>
  );
}

function ResolveRow({ r, current, row, services, providers, onClose, onSave }) {
  const [mode, setMode] = useState(current?.new_service ? 'new' : 'existing');
  const [sid, setSid] = useState(current?.service_id || r.service_id || '');
  const [ns, setNs] = useState(current?.new_service || { code: String(row?.service_code || '').trim().toUpperCase() || suggestCode(row?.service_name), name: row?.service_name || '',
    category: CAT_IN[String(row?.category || '').trim().toLowerCase()] || '', unit: row?.unit || '' });
  const [pid, setPid] = useState(current?.provider_id || r.provider_id || '');
  const needsProvider = r.errors.some((e) => e.includes('provider'));
  const sameUnit = services.filter((x) => !row?.unit || x.unit.toLowerCase().replace(/^per\s+/, '') === String(row.unit).trim().toLowerCase().replace(/^per\s+/, ''));
  const ok = (mode === 'existing' ? sid : ns.code && ns.name && ns.category && ns.unit) && (!needsProvider || pid);
  const save = () => onSave({ ...(mode === 'existing' ? { service_id: sid } : { new_service: ns }), ...(pid ? { provider_id: pid } : {}) });
  return (
    <Modal title={`Resolve row ${r.row}`} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button>{current && <Button onClick={() => onSave(undefined)}>Clear</Button>}<Button kind="primary" disabled={!ok} onClick={save}>Use this</Button></>}>
      <div className="small muted mb-8">In the file: {row?.service_code || 'no code'} · {row?.service_name || 'no name'} · per {row?.unit || '?'}{row?.provider_code ? ` · ${row.provider_code}` : ''}</div>
      {r.errors.map((e) => <div key={e} className="small danger-text">{e}</div>)}
      <div className="row mt-12"><Segmented value={mode} onChange={setMode} options={[['existing', 'Rate-card service'], ['new', 'New service']]} /></div>
      {mode === 'existing' ? (
        <Field label={`Service${row?.unit ? ` (sold per ${row.unit})` : ''}`} className="mt-12">
          <Select value={sid} onChange={(e) => setSid(e.target.value)} placeholder="Choose" options={(sameUnit.length ? sameUnit : services).map((x) => [x.id, `${x.code} · ${x.name} · per ${x.unit}`])} />
          {!sameUnit.length && <div className="tiny warn-text mt-4">No rate-card service is sold per {row?.unit}. Choosing another unit will fail the check: units are never converted.</div>}
        </Field>
      ) : (
        <div className="form-grid mt-12">
          <Field label="New code" hint="2-30 letters, digits, hyphens"><Input className="mono" value={ns.code} onChange={(e) => setNs({ ...ns, code: e.target.value.toUpperCase() })} /></Field>
          <Field label="Name"><Input value={ns.name} onChange={(e) => setNs({ ...ns, name: e.target.value })} /></Field>
          <Field label="Category"><Select value={ns.category} onChange={(e) => setNs({ ...ns, category: e.target.value })} placeholder="Choose" options={Object.entries(CAT)} /></Field>
          <Field label="Unit"><Input value={ns.unit} onChange={(e) => setNs({ ...ns, unit: e.target.value })} /></Field>
        </div>
      )}
      {(needsProvider || pid) && <Field label="Provider" className="mt-12"><Select value={pid} onChange={(e) => setPid(e.target.value)} placeholder="Choose" options={providers.map((p) => [p.id, `${p.code} · ${p.name}`])} /></Field>}
      <div className="tiny faint mt-8">The category decides which provider a case is routed to. A new service is added off the quotable card until its selling price is approved.</div>
    </Modal>
  );
}
