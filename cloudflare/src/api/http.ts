// JSON in and out. Unlike SM ERP, null fields are KEPT: CareDesk screens read row fields that may be null.
// Errors are {status, error, message, fieldErrors?, timestamp}.
import { ApiError, BillingError } from '../domain/errors';

const REASON: Record<number, string> = {
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  409: 'Conflict', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
};

/** Drops null / undefined object fields at every level (arrays keep their length). */
export function stripNulls(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== null && x !== undefined) out[k] = stripNulls(x);
    return out;
  }
  return v;
}

export const json = (body: unknown, status = 200) =>
  new Response(body instanceof RawJson ? body.text : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

/** Already-serialised JSON (report cache, or JSON built by Postgres): no second JSON.stringify on the Worker. */
export const jsonText = (text: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(text, { status, headers: { 'Content-Type': 'application/json', ...headers } });

/** A handler may return this when Postgres already built the JSON text (json_agg): sent as it is. */
export class RawJson { constructor(readonly text: string) {} }

export const noContent = () => new Response(null, { status: 204 });

export function errorBody(status: number, message: string, fieldErrors?: Record<string, string>) {
  return { status, error: REASON[status] ?? 'Error', message, fieldErrors, timestamp: new Date().toISOString() };
}

export const errorResponse = (status: number, message: string, fieldErrors?: Record<string, string>) =>
  json(errorBody(status, message, fieldErrors), status);

/** Maps anything thrown by a handler to the HTTP answer the frontend expects. */
export function toResponse(e: unknown): Response {
  if (e instanceof BillingError) return errorResponse(400, e.message);
  if (e instanceof ApiError) return errorResponse(e.status, e.message, e.fieldErrors);
  const pg = e as { code?: string; message?: string };
  if (pg && typeof pg.code === 'string') {
    // Postgres: 23xxx = constraint violation (duplicate, foreign key, check).
    if (pg.code === '23505') {
      const msg = String(pg.message || '');
      if (msg.includes('mobile')) return errorResponse(409, 'A patient with this mobile number already exists.');
      if (msg.includes('case_no')) return errorResponse(409, 'Case number already exists. Please submit again.');
      return errorResponse(409, 'That record already exists.');
    }
    if (pg.code.startsWith('23')) return errorResponse(409, 'Record conflicts with existing data');
    console.error('Database error', pg.code, pg.message);
    return errorResponse(503, 'Database is unavailable');
  }
  console.error('Unhandled error', e);
  const msg = String((e as Error)?.message ?? e);
  if (/connect|ECONN|timeout|socket|getaddrinfo|password authentication/i.test(msg)) return errorResponse(503, 'Database is unavailable');
  return errorResponse(500, 'Something went wrong. Try again.');
}

export async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (!text.trim()) throw new ApiError(400, 'Malformed JSON request');
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, 'Malformed JSON request');
  }
}
