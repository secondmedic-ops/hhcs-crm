// The ONLY place the frontend calls the backend (/api/...). Every call attaches the Supabase login token (or, in the
// local test, the login picked on the start screen). The pipeline (scripts/check-api.mjs) checks each path and method
// below against the Worker's contract (docs/openapi.json) before anything is deployed.
import { accessToken } from './lib/supabase';

export interface ApiErrorBody { status?: number; message?: string; error?: string }
export class ApiCallError extends Error { constructor(public status: number, message: string) { super(message); } }

let localUser: string | null = null;
/** Local test only: the profile picked on the start screen (the local Worker trusts it because login is off there). */
export const setLocalUser = (id: string | null) => { localUser = id; };
const STAFF_SESSION_KEY = 'caredesk.staff-session';
export const getStaffSession = () => sessionStorage.getItem(STAFF_SESSION_KEY);
export const setStaffSession = (id: string | null) => { id ? sessionStorage.setItem(STAFF_SESSION_KEY, id) : sessionStorage.removeItem(STAFF_SESSION_KEY); };

async function headers(json: boolean): Promise<Record<string, string>> {
  const h: Record<string, string> = { Accept: 'application/json' };
  if (json) h['Content-Type'] = 'application/json';
  const token = await accessToken();
  if (token) h.Authorization = `Bearer ${token}`;
  else if (localUser) h['X-Local-User'] = localUser;
  const staffSession = getStaffSession();
  if (staffSession) h['X-Staff-Session'] = staffSession;
  return h;
}

async function request<T>(path: string, opts: { method?: 'GET' | 'POST'; body?: unknown; raw?: boolean } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: await headers(opts.body !== undefined),
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (opts.raw) {
    if (!res.ok) throw new ApiCallError(res.status, ((await res.json().catch(() => ({}))) as ApiErrorBody).message || 'Request failed');
    return res as unknown as T;
  }
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { message: text }; }
  if (!res.ok) {
    const b = (data || {}) as ApiErrorBody;
    if (res.status === 409 && b.message?.startsWith('Staff session has ended')) {
      setStaffSession(null);
      window.location.assign('/');
    }
    throw new ApiCallError(res.status, b.message || b.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export interface QueryResult { data: unknown; count: number | null; error: string | null }
export interface BatchOp { kind?: 'select' | 'rpc'; spec?: unknown; fn?: string; args?: Record<string, unknown> }

export const api = {
  health: () => request<{ status: string; database: string; auth: string }>('/api/v1/health'),
  me: () => request<{ userId: string; role: string; workspaceId: string; fullName: string; authMode: string; staffSession?: { id: string; staffName: string; supervisorName: string; expiresAt: string } | null }>('/api/v1/me'),
  staffDirectory: () => request<{ id: string; full_name: string; role: string; agent_code: string | null }[]>('/api/v1/staff-sessions/staff'),
  startStaffSession: (staff_id: string) => request<{ id: string; expires_at: string }>('/api/v1/staff-sessions/start', { method: 'POST', body: { staff_id } }),
  endStaffSession: () => request<{ ended: boolean }>('/api/v1/staff-sessions/end', { method: 'POST', body: {} }),
  localUsers: () => request<{ id: string; full_name: string; role: string; agent_code: string | null }[]>('/api/v1/local/users'),

  batch: (ops: BatchOp[]) => request<{ results: QueryResult[] }>('/api/v1/batch', { method: 'POST', body: { ops } }),
  data: (table: string, spec: unknown) => request<QueryResult>(`/api/v1/data/${encodeURIComponent(table)}`, { method: 'POST', body: spec }),
  rpc: (fn: string, args: Record<string, unknown>) => request<{ data: unknown }>(`/api/v1/rpc/${encodeURIComponent(fn)}`, { method: 'POST', body: args }),

  dial: (target: Record<string, unknown>) => request<{ ok: boolean; call_id: string; mode: 'api' }>('/api/v1/calls/dial', { method: 'POST', body: target }),
  recording: (callId: string) => request<Response>(`/api/v1/calls/${callId}/recording`, { raw: true }),
  sendQuote: (caseId: string, templateId: string) => request<Record<string, unknown>>(`/api/v1/cases/${caseId}/quote`, { method: 'POST', body: { template_id: templateId } }),
  sendMessage: (caseId: string, templateId: string) => request<Record<string, unknown>>(`/api/v1/cases/${caseId}/message`, { method: 'POST', body: { template_id: templateId } }),
  whatsappSession: () => request<Record<string, any>>('/api/v1/whatsapp/session'),
  whatsappSessionAction: (body: { action?: 'start' | 'logout' | 'sync'; phone_number?: string | null }) => request<Record<string, any>>('/api/v1/whatsapp/session', { method: 'POST', body }),
  sendWhatsAppChat: (body: { case_id?: string | null; patient_id?: string | null; mobile?: string | null; patient_name?: string | null; template_id?: string | null; text?: string | null }) => request<Record<string, unknown>>('/api/v1/whatsapp/send', { method: 'POST', body }),
  sendEmail: (body: { case_id?: string | null; patient_id?: string | null; to?: string | null; subject?: string | null; text?: string | null; template_id?: string | null }) => request<Record<string, any>>('/api/v1/email/send', { method: 'POST', body }),

  aiCall: (callId: string) => request<Record<string, unknown>>(`/api/v1/ai/calls/${callId}`, { method: 'POST', body: {} }),
  liveToken: (callId: string, handle = '') => request<{ token: string; setup: Record<string, unknown>; transcript: string }>(`/api/v1/ai/calls/${callId}/live-token`, { method: 'POST', body: { handle } }),
  saveLiveTranscript: (callId: string, transcript: string, final: boolean) => request<{ saved: boolean; ended: boolean }>(`/api/v1/ai/calls/${callId}/live-transcript`, { method: 'POST', body: { transcript, final } }),
  aiBrief: (caseId: string) => request<Record<string, unknown>>(`/api/v1/ai/cases/${caseId}/brief`, { method: 'POST', body: {} }),
  aiCommand: (q: string) => request<Record<string, unknown>>('/api/v1/ai/command', { method: 'POST', body: { q } }),
  aiExtract: (text: string) => request<Record<string, unknown>>('/api/v1/ai/extract-enquiry', { method: 'POST', body: { text } }),
  aiStatus: () => request<{ enabled: boolean; auto: boolean }>('/api/v1/ai/status'),

  createUser: (u: Record<string, unknown>) => request<Record<string, unknown>>('/api/v1/admin/users', { method: 'POST', body: u }),
  webhookEvents: () => request<Record<string, unknown>[]>('/api/v1/admin/webhooks'),
  webhookHealth: () => request<Record<string, any>>('/api/v1/admin/webhooks/health'),
  integrations: () => request<Record<string, unknown>>('/api/v1/admin/integrations'),
  setTelephony: (body: { profile_id: string; myoperator_user_id?: string | null; myoperator_extension?: string | null; phone?: string | null }) => request<Record<string, any>>('/api/v1/admin/users/telephony', { method: 'POST', body }),
  testWaba: () => request<Record<string, any>>('/api/v1/admin/myoperator/waba/test', { method: 'POST', body: {} }),
  moSettings: () => request<Record<string, any>>('/api/v1/admin/myoperator'),
  saveMoSettings: (body: { values?: Record<string, string>; generate_webhook_key?: boolean }) => request<Record<string, any>>('/api/v1/admin/myoperator', { method: 'POST', body }),
  syncMo: () => request<Record<string, any>>('/api/v1/admin/myoperator/sync', { method: 'POST', body: {} }),
  testMo: () => request<Record<string, { ok: boolean; message: string }>>('/api/v1/admin/myoperator/test', { method: 'POST', body: {} }),
  aiSettings: () => request<Record<string, any>>('/api/v1/admin/ai'),
  saveAiSettings: (body: { api_key?: string; model?: string; auto?: boolean; retry_failed?: boolean }) => request<Record<string, any>>('/api/v1/admin/ai', { method: 'POST', body }),
  testAi: () => request<{ ok: boolean; message: string }>('/api/v1/admin/ai/test', { method: 'POST', body: {} }),
  emailStatus: () => request<Record<string, any>>('/api/v1/admin/email'),
  testEmail: (debug?: 2) => request<{ ok: boolean; message: string; attempts?: number; transcript?: string[] }>('/api/v1/admin/email/test', { method: 'POST', body: debug ? { debug } : {} }),
  moUsers: () => request<{ users: Record<string, any>[]; profiles: Record<string, any>[] }>('/api/v1/admin/myoperator/users'),
  linkMoUsers: (body: { links?: { profile_id: string; myoperator_user_id: string | null }[]; auto?: boolean }) => request<{ linked: number; unlinked: number }>('/api/v1/admin/myoperator/users', { method: 'POST', body }),
};

/** Live updates: one WebSocket; the server pushes {"tables": [...]} after any change. Reconnects by itself. */
export function openLive(onTables: (tables: string[]) => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const connect = async () => {
    if (stopped) return;
    const token = await accessToken();
    const proto = token ? token : localUser ? 'local.' + localUser : null;
    if (!proto) { timer = setTimeout(connect, 5000); return; }
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/v1/live`;
    ws = new WebSocket(url, ['caredesk', proto]);
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      try { const m = JSON.parse(String(e.data)); if (Array.isArray(m.tables)) onTables(m.tables); } catch { /* ignore */ }
    };
    ws.onopen = () => { ping = setInterval(() => { try { ws?.send('ping'); } catch { /* closed */ } }, 50000); };
    ws.onclose = () => {
      if (ping) clearInterval(ping);
      if (!stopped) timer = setTimeout(connect, 3000);
    };
  };
  connect();
  return () => { stopped = true; if (timer) clearTimeout(timer); if (ping) clearInterval(ping); try { ws?.close(); } catch { /* closed */ } };
}
