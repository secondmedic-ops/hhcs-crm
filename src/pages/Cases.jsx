// Case list (slide 8 entry point): filterable from the URL (AI command bar, dashboard drill-downs),
// quick views, list or stage board, CSV export for the roles allowed to export.
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { db, q, rpc } from '../lib/db.js';
import { useLoad, useNow, useDebounced } from '../lib/hooks.js';
import { useAuth } from '../lib/auth.jsx';
import { inr, ago, dateTime, STAGES, STAGE_LABEL, CHANNEL_LABEL } from '../lib/fmt.js';
import Icon from '../components/icons.jsx';
import {
  PageHead, Panel, Button, Badge, StageBadge, SlaBadge, PriorityBadge, Countdown, Segmented, Select, Input,
  TableSkeleton, Skeleton, Empty, ErrorNote, useToast,
} from '../components/ui.jsx';

const LIMIT = 200;
const COLS = 'id,case_no,patient_id,patient_name,patient_age,patient_gender,service_names,services_requested,stage,priority,zone_name,sla_state,next_sla_due,next_sla_key,total,owner_id,owner_code,owner_name,created_at,source_channel,referral_subtype,quote_status,payment_status,open_escalations,open_complaints,branch,provider_names';

const VIEWS = [
  ['open', 'All open'], ['mine', 'My cases'], ['attention', 'Needs attention'], ['urgent', 'Urgent'],
  ['approval', 'Awaiting approval'], ['closed', 'Closed'], ['cancelled', 'Cancelled'],
];
const FILTER_KEYS = ['stage', 'priority', 'sla_state', 'zone', 'channel', 'from', 'to', 'text'];
const SLA_TEXT = { ok: 'Within SLA', at_risk: 'At risk', breached: 'Breached' };
const OPEN = '(closed,cancelled)';

const istStart = (d) => new Date(`${d}T00:00:00+05:30`).toISOString();
const istEnd = (d) => new Date(new Date(`${d}T00:00:00+05:30`).getTime() + 86400e3).toISOString();
const clean = (s) => String(s || '').replace(/[,()*%\\]/g, ' ').trim();
const ageGender = (r) => [r.patient_age, r.patient_gender].filter((x) => x != null && x !== '').join('');

function applyFilters(query, f, view, me) {
  let x = query;
  const stages = f.stage ? f.stage.split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (stages.length) x = x.in('stage', stages);
  if (f.priority) x = x.eq('priority', f.priority);
  if (f.sla_state) x = x.eq('sla_state', f.sla_state);
  if (f.zone) x = x.ilike('zone_name', `%${clean(f.zone)}%`);
  if (f.channel) x = x.eq('source_channel', f.channel);
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.from || '')) x = x.gte('created_at', istStart(f.from));
  if (/^\d{4}-\d{2}-\d{2}$/.test(f.to || '')) x = x.lt('created_at', istEnd(f.to));
  const t = clean(f.text);
  if (t) x = x.or(`case_no.ilike.*${t}*,patient_name.ilike.*${t}*,service_names.ilike.*${t}*`);
  // quick views
  if (view === 'open') x = x.not('stage', 'in', OPEN);
  if (view === 'mine') x = x.eq('owner_id', me).not('stage', 'in', OPEN);
  if (view === 'attention') x = x.neq('sla_state', 'ok').not('stage', 'in', OPEN);
  if (view === 'urgent') x = x.eq('priority', 'urgent').not('stage', 'in', OPEN);
  if (view === 'approval') x = x.eq('quote_status', 'pending_approval');
  if (view === 'closed') x = x.eq('stage', 'closed');
  if (view === 'cancelled') x = x.eq('stage', 'cancelled');
  return x;
}

function csvCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function Cases() {
  const nav = useNavigate();
  const toast = useToast();
  const { profile, can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const now = useNow(30000);

  const f = Object.fromEntries(FILTER_KEYS.map((k) => [k, sp.get(k) || '']));
  const hasStage = !!f.stage;
  const view = sp.get('view') || (hasStage || f.sla_state || f.priority ? '' : 'open');
  const mode = sp.get('mode') === 'board' ? 'board' : 'list';
  const key = sp.toString();

  const [text, setText] = useState(f.text);
  const debounced = useDebounced(text, 350);
  useEffect(() => { setText(f.text); }, [f.text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (debounced !== f.text) setParam('text', debounced); }, [debounced]); // eslint-disable-line react-hooks/exhaustive-deps

  const setParam = (k, v) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v); else n.delete(k);
    setSp(n, { replace: true });
  };
  const setView = (v) => {
    const n = new URLSearchParams(sp);
    n.set('view', v);
    if (['closed', 'cancelled'].includes(v)) n.delete('stage');
    setSp(n, { replace: true });
  };
  const addStage = (s) => {
    if (!s) return;
    const list = f.stage ? f.stage.split(',') : [];
    if (!list.includes(s)) list.push(s);
    const n = new URLSearchParams(sp);
    n.set('stage', list.join(','));
    if (!sp.get('view')) n.set('view', 'all');
    setSp(n, { replace: true });
  };
  const removeStage = (s) => setParam('stage', f.stage.split(',').filter((x) => x !== s).join(','));
  const clearAll = () => { const n = new URLSearchParams(); if (mode === 'board') n.set('mode', 'board'); n.set('view', 'open'); setSp(n, { replace: true }); setText(''); };

  const zones = useLoad(() => q(db.from('zones').select('name').is('active', true).order('name')), []);
  const list = useLoad(async () => {
    const [rows, total] = await Promise.all([
      q(applyFilters(db.from('v_cases').select(COLS), f, view, profile.id).order('created_at', { ascending: false }).limit(LIMIT)),
      q(applyFilters(db.from('v_cases').select('id', { count: 'exact', head: true }), f, view, profile.id)),
    ]);
    return { rows, total };
  }, [key, profile.id], ['cases']);

  const rows = list.data?.rows || [];
  const total = list.data?.total ?? 0;
  const chips = [];
  if (f.stage) f.stage.split(',').filter(Boolean).forEach((s) => chips.push({ k: `stage:${s}`, label: `Stage: ${STAGE_LABEL[s] || s}`, off: () => removeStage(s) }));
  if (f.priority) chips.push({ k: 'priority', label: `Priority: ${f.priority}`, off: () => setParam('priority', '') });
  if (f.sla_state) chips.push({ k: 'sla', label: `SLA: ${SLA_TEXT[f.sla_state] || f.sla_state}`, off: () => setParam('sla_state', '') });
  if (f.zone) chips.push({ k: 'zone', label: `Zone: ${f.zone}`, off: () => setParam('zone', '') });
  if (f.channel) chips.push({ k: 'channel', label: `Channel: ${CHANNEL_LABEL[f.channel] || f.channel}`, off: () => setParam('channel', '') });
  if (f.from) chips.push({ k: 'from', label: `From ${f.from}`, off: () => setParam('from', '') });
  if (f.to) chips.push({ k: 'to', label: `To ${f.to}`, off: () => setParam('to', '') });
  if (f.text) chips.push({ k: 'text', label: `Search: "${f.text}"`, off: () => { setText(''); setParam('text', ''); } });

  const canExport = can('supervisor', 'client_manager', 'client_clinical');
  const canCreate = can('agent', 'coordinator', 'supervisor');

  const exportCsv = async () => {
    if (!rows.length) { toast('Nothing to export'); return; }
    const head = ['Case', 'Patient', 'Age/Gender', 'Services', 'Stage', 'Priority', 'Zone', 'Channel', 'SLA', 'Next SLA due', 'Quote', 'Payment', 'Total (INR)', 'Owner', 'Created (IST)'];
    const body = rows.map((r) => [r.case_no, r.patient_name, ageGender(r), r.service_names || r.services_requested, STAGE_LABEL[r.stage], r.priority, r.zone_name, r.source_channel,
      SLA_TEXT[r.sla_state], r.next_sla_due ? dateTime(r.next_sla_due) : '', r.quote_status, r.payment_status, r.total, r.owner_code || r.owner_name, dateTime(r.created_at)]);
    const csv = [head, ...body].map((l) => l.map(csvCell).join(',')).join('\r\n');
    const filters = Object.fromEntries(Object.entries({ ...f, view }).filter(([, v]) => v));
    try {
      await rpc('log_access', { p_action: 'export', p_entity: 'cases', p_entity_id: null, p_meta: { count: rows.length, filters } });
    } catch (e) { toast.error(e.message); return; }
    const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = `caredesk-cases-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast.ok(`Exported ${rows.length} cases · logged in access trail`);
  };

  return (
    <>
      <PageHead title="Cases" sub={list.data ? `Showing ${rows.length} of ${total}${total > LIMIT ? ` · first ${LIMIT}, refine filters to narrow` : ''} · newest first` : 'Loading cases'}>
        <Segmented options={[['list', <span key="l" className="row gap-4"><Icon name="list" size={13} />List</span>], ['board', <span key="b" className="row gap-4"><Icon name="board" size={13} />Board</span>]]}
          value={mode} onChange={(m) => setParam('mode', m === 'board' ? 'board' : '')} />
        {canExport && <Button icon="download" onClick={exportCsv} disabled={!rows.length}>Export CSV</Button>}
        {canCreate && <Button kind="primary" icon="plus" onClick={() => nav('/console?new=1')}>New enquiry</Button>}
      </PageHead>

      <div className="cs-views mb-12" role="tablist" aria-label="Quick views">
        {VIEWS.map(([v, l]) => (
          <button key={v} type="button" className={`pill-filter ${view === v ? 'on' : ''}`} onClick={() => setView(v)}>{l}</button>
        ))}
      </div>

      <div className="cs-filters mb-8">
        <div className="cs-search">
          <Icon name="search" size={14} />
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Case ID, patient or service" aria-label="Search cases" />
        </div>
        <Select value="" onChange={(e) => addStage(e.target.value)} placeholder="Stage" aria-label="Add stage filter"
          options={[...STAGES, 'closed', 'cancelled'].map((s) => [s, STAGE_LABEL[s]])} />
        <Select value={f.priority} onChange={(e) => setParam('priority', e.target.value)} placeholder="Priority" aria-label="Priority"
          options={[['urgent', 'Urgent'], ['routine', 'Routine']]} />
        <Select value={f.sla_state} onChange={(e) => setParam('sla_state', e.target.value)} placeholder="SLA state" aria-label="SLA state"
          options={[['breached', 'Breached'], ['at_risk', 'At risk'], ['ok', 'Within SLA']]} />
        <Select value={(zones.data || []).find((z) => z.name.toLowerCase() === f.zone.toLowerCase())?.name || ''} onChange={(e) => setParam('zone', e.target.value)} placeholder="Zone" aria-label="Zone"
          options={(zones.data || []).map((z) => z.name)} />
        <Select className="cs-chan" value={f.channel} onChange={(e) => setParam('channel', e.target.value)} placeholder="Channel" aria-label="Channel"
          options={['phone', 'whatsapp', 'email', 'chat', 'walkin', 'referral'].map((c) => [c, CHANNEL_LABEL[c]])} />
        <label className="cs-date"><span className="tiny muted">From</span><Input type="date" value={f.from} onChange={(e) => setParam('from', e.target.value)} /></label>
        <label className="cs-date"><span className="tiny muted">To</span><Input type="date" value={f.to} onChange={(e) => setParam('to', e.target.value)} /></label>
      </div>

      {chips.length > 0 && (
        <div className="row wrap mb-12 gap-4">
          {chips.map((c) => (
            <span key={c.k} className="cs-chip">{c.label}<button type="button" onClick={c.off} aria-label={`Remove ${c.label}`}><Icon name="x" size={11} /></button></span>
          ))}
          <Button kind="ghost" size="xs" onClick={clearAll}>Clear all</Button>
        </div>
      )}

      <ErrorNote error={list.error} />

      {mode === 'list' ? (
        <Panel tight>
          {list.loading ? <TableSkeleton rows={10} cols={9} /> : rows.length ? (
            <>
              <div className="table-wrap cs-table">
                <table className="t">
                  <thead><tr>
                    <th>Case</th><th>Patient</th><th>Services · provider</th><th>Stage</th><th>Branch · zone</th><th>SLA · next deadline</th><th className="num">Total</th><th>Owner</th><th>Created</th>
                  </tr></thead>
                  <tbody>{rows.map((r) => (
                    <tr key={r.id} className="click" onClick={() => nav(`/cases/${r.id}`)}>
                      <td className="mono">{r.case_no}</td>
                      <td style={{ maxWidth: 190 }}>
                        <div className="truncate strong">{r.patient_name}</div>
                        <div className="tiny muted">{ageGender(r) || '–'} · {CHANNEL_LABEL[r.source_channel] || r.source_channel}{r.source_channel === 'referral' && r.referral_subtype ? ` (${r.referral_subtype})` : ''}</div>
                      </td>
                      <td style={{ maxWidth: 210 }}><div className="truncate small" title={r.service_names || r.services_requested || ''}>{r.service_names || r.services_requested || <span className="faint">–</span>}</div>
                        {r.provider_names && <div className="tiny muted truncate">{r.provider_names}</div>}</td>
                      <td><div className="row wrap gap-4"><StageBadge stage={r.stage} /><PriorityBadge p={r.priority} />{r.quote_status === 'pending_approval' && <Badge kind="warn" title="Discount awaiting Hinduja approval">Approval</Badge>}</div></td>
                      <td className="nowrap">{r.branch && <div className="small">{r.branch}</div>}<div className={r.branch ? 'tiny muted' : ''}>{r.zone_name || <span className="faint">–</span>}</div></td>
                      <td><div className="cs-sla"><SlaBadge state={r.sla_state} />{r.next_sla_due && <Countdown due={r.next_sla_due} label={r.next_sla_key} />}</div></td>
                      <td className="num">{inr(r.total)}</td>
                      <td className="mono small" title={r.owner_name || ''}>{r.owner_code || r.owner_name || '–'}</td>
                      <td className="small muted nowrap" title={dateTime(r.created_at)}>{ago(r.created_at, now)}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div className="cs-cards">
                {rows.map((r) => <CaseCard key={r.id} r={r} now={now} onOpen={() => nav(`/cases/${r.id}`)} />)}
              </div>
            </>
          ) : <Empty title="No cases match these filters">{chips.length ? 'Remove a filter or switch quick view.' : 'New enquiries from calls, WhatsApp and email appear here.'}</Empty>}
        </Panel>
      ) : (
        <Board rows={rows} loading={list.loading} now={now} onOpen={(id) => nav(`/cases/${id}`)} view={view} />
      )}
    </>
  );
}

function CaseCard({ r, now, onOpen }) {
  return (
    <div className="card cs-card" onClick={onOpen} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen()}>
      <div className="row between">
        <span className="mono small strong">{r.case_no}</span>
        <span className="tiny muted">{ago(r.created_at, now)}</span>
      </div>
      <div className="mt-4 truncate"><strong>{r.patient_name}</strong> <span className="muted small">{ageGender(r)}</span></div>
      <div className="small muted truncate">{r.service_names || r.services_requested || 'Services not added yet'}</div>
      <div className="row wrap gap-4 mt-8">
        <StageBadge stage={r.stage} /><PriorityBadge p={r.priority} />
        {r.sla_state !== 'ok' && <SlaBadge state={r.sla_state} />}
        {r.next_sla_due && <Countdown due={r.next_sla_due} label={r.next_sla_key} compact />}
        {Number(r.open_escalations) > 0 && <Badge kind="danger">{r.open_escalations} esc</Badge>}
        <span className="grow" />
        <span className="mono small">{inr(r.total)}</span>
      </div>
      <div className="tiny muted mt-4">{r.zone_name || 'Zone not mapped'} · {r.owner_code || r.owner_name || 'Unassigned'}</div>
    </div>
  );
}

function Board({ rows, loading, now, onOpen, view }) {
  const cols = useMemo(() => {
    const showClosed = view === 'closed' || view === 'cancelled' || rows.some((r) => ['closed', 'cancelled'].includes(r.stage)) && !rows.some((r) => STAGES.includes(r.stage));
    const stages = showClosed ? [...STAGES, 'closed', 'cancelled'] : STAGES;
    return stages.map((s) => ({ s, items: rows.filter((r) => r.stage === s).sort((a, b) => (a.next_sla_due ? new Date(a.next_sla_due) : Infinity) - (b.next_sla_due ? new Date(b.next_sla_due) : Infinity)) }));
  }, [rows, view]);
  if (loading) return <div className="board">{STAGES.map((s) => <div key={s} className="board-col"><div className="board-col-head">{STAGE_LABEL[s]}</div><div style={{ padding: '0 8px' }}><Skeleton lines={4} /></div></div>)}</div>;
  if (!rows.length) return <Panel><Empty title="No cases match these filters" /></Panel>;
  return (
    <div className="board">
      {cols.map(({ s, items }) => (
        <div key={s} className="board-col">
          <div className="board-col-head"><span>{STAGE_LABEL[s]}</span><span className="mono muted">{items.length}</span></div>
          {items.length === 0 && <div className="tiny faint" style={{ padding: '4px 10px 10px' }}>No cases</div>}
          {items.map((r) => (
            <div key={r.id} className="card" onClick={() => onOpen(r.id)} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(r.id)}>
              <div className="row between"><span className="mono tiny strong">{r.case_no}</span><span className="tiny muted">{ago(r.created_at, now)}</span></div>
              <div className="small strong truncate mt-4">{r.patient_name} <span className="muted" style={{ fontWeight: 400 }}>{ageGender(r)}</span></div>
              <div className="tiny muted truncate">{r.service_names || r.services_requested || 'Services pending'}</div>
              <div className="row wrap gap-4 mt-8">
                <PriorityBadge p={r.priority} />
                {r.sla_state !== 'ok' && <SlaBadge state={r.sla_state} />}
                {r.next_sla_due && <Countdown due={r.next_sla_due} label={r.next_sla_key} compact />}
                {r.quote_status === 'pending_approval' && <Badge kind="warn">Approval</Badge>}
                <span className="grow" />
                <span className="mono tiny">{inr(r.total)}</span>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
