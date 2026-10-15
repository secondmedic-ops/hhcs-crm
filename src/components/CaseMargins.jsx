// Services & quote, commercial view: provider, buying and selling rates, totals and gross margin per line.
// SecondMedic supervisors and coordinators only; case_margins() refuses everyone else, so hiding this panel is not the guard.
// All money comes from the database (discount allocated to lines there); this screen only formats it.
import { useState } from 'react';
import { rpc } from '../lib/db.js';
import { useLoad } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { inr, pct, dateTime } from '../lib/fmt.js';
import { Panel, Badge, Button, Modal, Field, Select, Textarea, TableSkeleton, ErrorNote, useAction } from './ui.jsx';

const COST = {
  no_provider: 'Cost missing: choose the provider',
  missing: 'Cost missing: no B2B rate for this provider and unit',
  not_captured: 'Cost not captured',
  tax_basis: 'GST basis differs: margin not comparable',
  unit_mismatch: 'Unit differs: margin not comparable',
};
const SOURCE = { auto: 'set automatically', selected: 'chosen', refresh: 'refreshed', amendment: 'amended' };

export default function CaseMargins({ c }) {
  const { can } = useAuth();
  const supervisor = can('supervisor');
  const [run, busy] = useAction();
  const [amend, setAmend] = useState(null);
  const m = useLoad(() => rpc('case_margins', { p_case: c.id }), [c.id, c.total, c.stage, c.signoff_at], ['case_items', 'case_item_costs', 'cases', 'provider_rates']);
  const d = m.data;
  const t = d?.totals;
  const choose = (line, provider) => run(async () => { await rpc('set_item_provider', { p_item: line.item_id, p_provider: provider, p_reason: null }); m.reload(); }, 'Provider set · buying rate copied');
  const marginPct = (l) => (l.margin_pct != null ? pct(l.margin_pct, 2) : l.cost_status === 'ok' && Number(l.net_selling) === 0 ? 'n/a' : '–');

  return (
    <Panel tight title="Buying cost and margin" sub="SecondMedic only. Projected gross margin before collections and refunds; not profit or cash received.">
      <ErrorNote error={m.error} />
      {m.loading ? <TableSkeleton rows={3} cols={8} /> : d && (
        <>
          <div className="table-wrap"><table className="t compact">
            <thead><tr><th>Service</th><th>Provider</th><th>Unit</th><th className="num">Qty</th><th className="num">Buying rate</th><th className="num">Selling rate</th>
              <th className="num">Buying total</th><th className="num">Net selling</th><th className="num">Gross margin</th><th className="num">Margin %</th></tr></thead>
            <tbody>{d.lines.map((l) => {
              const canPick = l.included && l.cost_status !== 'not_captured' && !d.frozen;
              const opts = [...l.options.map((o) => [o.provider_id, `${o.code} · ${inr(o.rate)}`])];
              if (l.provider_id && !opts.some(([v]) => v === l.provider_id)) opts.push([l.provider_id, `${l.provider_code} · no rate`]);
              return (
                <tr key={l.item_id} className={l.included ? '' : 'muted'}>
                  <td><div style={l.included ? null : { textDecoration: 'line-through' }}>{l.service_name}</div>
                    <div className="tiny muted mono">{l.service_code}{l.price_version ? ` · v${l.price_version}` : ''}</div>
                    {!l.included ? <div className="tiny">Dropped: not in the totals</div> : COST[l.cost_status] && <div className="tiny warn-text">{COST[l.cost_status]}</div>}</td>
                  <td className="nowrap">{canPick
                    ? <Select className="sm" style={{ width: 'auto' }} value={l.provider_id || ''} disabled={busy} placeholder={opts.length ? 'Choose' : 'No provider has a rate'}
                        aria-label={`Provider for ${l.service_name}`} onChange={(e) => e.target.value && choose(l, e.target.value)} options={opts} />
                    : <span className="mono small">{l.provider_code || '–'}</span>}
                    {d.frozen && supervisor && l.included && l.cost_status !== 'not_captured' && <Button size="xs" kind="ghost" onClick={() => setAmend(l)}>Amend</Button>}
                    {l.cost_source && <div className="tiny faint">{SOURCE[l.cost_source]}</div>}</td>
                  <td className="small nowrap">{l.unit ? `per ${l.unit}` : '–'}</td>
                  <td className="num">{l.qty}</td>
                  <td className="num">{l.buy_rate != null ? inr(l.buy_rate) : '–'}</td>
                  <td className="num">{inr(l.sell_rate)}</td>
                  <td className="num">{l.buying_total != null ? inr(l.buying_total) : '–'}</td>
                  <td className="num">{l.included ? inr(l.net_selling) : '–'}</td>
                  <td className="num">{l.margin != null ? inr(l.margin) : '–'}</td>
                  <td className="num">{marginPct(l)}</td>
                </tr>
              );
            })}</tbody>
            <tfoot className="cd-totals">
              {t.status === 'complete' && (
                <tr className="grand"><td colSpan={6}>Booking ({t.lines} line{t.lines === 1 ? '' : 's'})</td><td className="num">{inr(t.buying)}</td><td className="num">{inr(t.net_selling)}</td>
                  <td className="num">{inr(t.margin)}</td><td className="num">{t.margin_pct != null ? pct(t.margin_pct, 2) : 'n/a'}</td></tr>
              )}
              {t.status === 'incomplete' && <>
                <tr><td colSpan={7}>Net selling, all included lines</td><td className="num">{inr(t.net_selling)}</td><td className="num" colSpan={2}><Badge kind="warn">Margin incomplete</Badge></td></tr>
                {t.costed_lines > 0 && <tr><td colSpan={6}>Costed lines only ({t.costed_lines} of {t.lines}), not the booking margin</td><td className="num">{inr(t.known_buying)}</td>
                  <td className="num">{inr(t.known_net)}</td><td className="num">{inr(t.known_margin)}</td><td /></tr>}
              </>}
              {t.status === 'not_captured' && <tr><td colSpan={10}><Badge>Cost not captured</Badge> <span className="small muted">Priced before buying costs were recorded. Costs are not filled in from today's rates.</span></td></tr>}
            </tfoot>
          </table></div>
          <div className="panel-body col gap-4">
            {Number(d.case_discount) > 0 && <div className="tiny muted">Discount of {inr(d.case_discount)} spread over the lines in proportion to their value, rounded so the lines add up to the booking total ({inr(d.case_total)}).</div>}
            {!d.reconciles && <div className="tiny danger-text">The lines do not add up to the booking total. Refresh the page; if it stays, tell the supervisor.</div>}
            {d.frozen
              ? <div className="tiny muted">Prices are agreed (signed off or booked). Rate-card changes do not touch this booking{supervisor ? '; a buying-cost amendment needs a reason and is recorded below' : ''}.</div>
              : <div className="tiny muted">Rates were copied when each line was added; later rate-card changes do not change them unless the draft is refreshed.</div>}
            {d.history.length > 0 && (
              <details className="mt-8"><summary className="small">Buying-cost changes ({d.history.length})</summary>
                <table className="t compact mt-8"><tbody>{d.history.map((h, i) => (
                  <tr key={i}><td className="small nowrap">{dateTime(h.at)}</td><td className="small">{h.service_name}</td>
                    <td className="small mono">{h.old_provider || '–'} {h.old_rate != null ? inr(h.old_rate) : '–'} → {h.new_provider || '–'} {h.new_rate != null ? inr(h.new_rate) : '–'}</td>
                    <td className="small">{SOURCE[h.source] || h.source}{h.reason ? `: ${h.reason}` : ''}</td><td className="small muted">{h.by || '–'}</td></tr>
                ))}</tbody></table>
              </details>
            )}
          </div>
        </>
      )}
      {amend && <AmendCost line={amend} onClose={() => setAmend(null)} onDone={() => { setAmend(null); m.reload(); }} />}
    </Panel>
  );
}

function AmendCost({ line, onClose, onDone }) {
  const [run, busy] = useAction();
  const [prov, setProv] = useState(line.provider_id || '');
  const [reason, setReason] = useState('');
  const save = () => run(async () => { await rpc('set_item_provider', { p_item: line.item_id, p_provider: prov, p_reason: reason.trim() }); onDone(); }, 'Buying cost amended · recorded');
  return (
    <Modal title={`Amend buying cost · ${line.service_name}`} onClose={onClose}
      footer={<><Button onClick={onClose}>Cancel</Button><Button kind="primary" disabled={busy || !prov || reason.trim().length < 5} onClick={save}>Amend</Button></>}>
      <div className="small muted mb-8">Now: {line.provider_code || 'no provider'} at {line.buy_rate != null ? inr(line.buy_rate) : 'no rate'} per {line.unit}. The provider's rate in force today is copied. The customer price and sign-off do not change.</div>
      <Field label="Provider"><Select value={prov} onChange={(e) => setProv(e.target.value)} placeholder="Choose" options={line.options.map((o) => [o.provider_id, `${o.code} · ${inr(o.rate)}`])} /></Field>
      <Field label="Reason" className="mt-12"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Partner changed after booking at the family's request" /></Field>
    </Modal>
  );
}
