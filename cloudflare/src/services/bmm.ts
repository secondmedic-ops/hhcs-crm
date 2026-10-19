// HHCS-side contract for BMM to confirm. Reuses authenticated BMM provider logins and SQL workflow rules.
import type { Ctx } from '../api/context';
import { asUser } from '../db';
import { ApiError } from '../domain/errors';
import { dbMessage } from './data';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES = ['new','accepted','scheduled','dispatched','in_progress','completed','declined','cancelled'];
const state = (v: unknown): string => typeof v !== 'string' ? '' : v === 'deployed' ? 'in_progress' : v;
export function bmmUpdate(body: any, id: string) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400,'Send one status update');
  const fields = ['event_id','expected_status','status','note','scheduled_at'];
  if (Object.keys(body).some(key => !fields.includes(key))) throw new ApiError(400,'Unsupported status update field');
  if (!UUID.test(id) || typeof body.event_id !== 'string' || !UUID.test(body.event_id)) throw new ApiError(400,'Lead ID and event ID must be UUIDs');
  if (!STATES.filter(s => s !== 'new' && s !== 'cancelled').includes(state(body.status)) || !STATES.includes(state(body.expected_status))) throw new ApiError(400,'Choose valid current and next statuses');
  if (body.note != null && (typeof body.note !== 'string' || body.note.length > 2000)) throw new ApiError(400,'Progress note must be at most 2000 characters');
  if (body.scheduled_at != null && (typeof body.scheduled_at !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(body.scheduled_at) || !Number.isFinite(Date.parse(body.scheduled_at)))) {
    throw new ApiError(400,'Visit time must be an ISO timestamp with a timezone');
  }
  if (body.scheduled_at && new Date(body.scheduled_at.slice(0,10) + 'T00:00:00Z').toISOString().slice(0,10) !== body.scheduled_at.slice(0,10)) {
    throw new ApiError(400,'Visit time must be a valid calendar date');
  }
  if (body.status === 'scheduled' && !body.scheduled_at) throw new ApiError(400,'Scheduling requires a visit date');
  if (body.status === 'declined' && !body.note?.trim()) throw new ApiError(400,'Declining requires a reason');
  return {eventId:body.event_id,status:state(body.status),expected:state(body.expected_status),note:body.note?.trim() || null,when:body.scheduled_at || null};
}
export async function bmmLeads(c: Ctx) {
  const integer = (key: string, fallback: number, min: number, max: number) => {
    const v = c.url.searchParams.get(key);
    if (v != null && !/^\d+$/.test(v)) throw new ApiError(400,'Invalid pagination');
    const n = v == null ? fallback : Number(v);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new ApiError(400,'Invalid pagination');
    return n;
  };
  const limit = integer('limit',50,1,100), offset = integer('offset',0,0,1000000);
  try {
    const {result,changed} = await asUser(c.sql,c.user.id,async tx => {
      const [r] = await tx`select bmm_leads(${limit},${offset}) as data`;
      return r.data;
    });
    c.changed.push(...changed);return result;
  } catch (e) {throw dbMessage(e) ?? e;}
}
export async function bmmStatus(c: Ctx, body: any) {
  const p = bmmUpdate(body,c.params.id);
  try {
    const {result,changed} = await asUser(c.sql,c.user.id,async tx => {
      const [r] = await tx`select bmm_apply_status(${c.params.id}::uuid,${p.eventId}::uuid,${p.expected},${p.status},${p.note},${p.when}::timestamptz) as data`;
      return r.data;
    });
    c.changed.push(...changed);return result;
  } catch (e) {throw dbMessage(e) ?? e;}
}
