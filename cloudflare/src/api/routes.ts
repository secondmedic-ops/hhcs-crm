// THE endpoint table: every /api endpoint is one line here with its access rule. The router, the security gate
// (scripts/lint.mjs) and the contract (docs/openapi.json, checked against src/api.ts) are all built from it.
// access: 'public' only for health / version, 'login' only for /api/v1/me, otherwise the roles allowed.
import type { Ctx } from './context';
import type { Role } from './auth';
import { staffDirectory, startStaffSession, endStaffSession } from '../services/staff-session';
import { batch, rpc, write, READ, WRITE, RPC } from '../services/data';
import { dial, recording, sendMessage, sendQuote, sendWhatsAppChat } from '../services/calls';
import { sendEmailChat } from '../services/emailChat';
import { whatsappSession, whatsappSessionAction, testWaba } from '../services/myoperator';
import { aiStatus, caseBrief, command, extractEnquiry, summariseCall, liveCallToken, saveLiveTranscript } from '../services/ai';
import { aiEnv } from '../services/ai-config';
import { aiSettings, createUser, emailStatus, integrations, linkMoUsers, moSettings, moUsers, saveAiSettings, saveMoSettings, setTelephony, syncNow, testAi, testEmail, testMo, webhookEvents, webhookHealth } from '../services/admin';

export type Access = 'public' | 'login' | readonly Role[];
export interface Route {
  method: 'GET' | 'POST';
  path: string;
  access: Access;
  handler?: (c: Ctx, body: any) => Promise<unknown>;
  summary?: string;
}

const ALL: readonly Role[] = ['agent', 'coordinator', 'supervisor', 'field_staff', 'medical_desk', 'client_manager', 'client_clinical', 'admin', 'provider'];
const OPS: readonly Role[] = ['agent', 'coordinator', 'supervisor', 'medical_desk'];
const WA_OPS: readonly Role[] = ['agent', 'coordinator', 'supervisor', 'medical_desk', 'client_manager', 'admin'];
const RECORDINGS: readonly Role[] = ['supervisor', 'coordinator', 'client_manager', 'client_clinical', 'medical_desk'];
const AI_CALLS: readonly Role[] = ['supervisor', 'coordinator', 'agent', 'client_manager', 'medical_desk'];
/** Staff who see calls (never provider logins). */
const CALL_VIEW: readonly Role[] = ['agent', 'coordinator', 'supervisor', 'medical_desk', 'client_manager', 'client_clinical'];
const ADMIN: readonly Role[] = ['admin'];
const TECH: readonly Role[] = ['admin', 'supervisor'];

/** Results that changed data report it through c.changed (live updates). */
const changing = (r: { body: unknown; changed: string[] }, c: Ctx) => { c.changed.push(...r.changed); return r.body; };

export const routes: Route[] = [
  { method: 'GET', path: '/api/v1/health', access: 'public', summary: 'Service and database status' },
  { method: 'GET', path: '/api/version', access: 'public', summary: 'Deployed commit' },
  { method: 'GET', path: '/api/actuator/health', access: 'public', summary: 'Health with database check' },
  { method: 'GET', path: '/api/actuator/health/liveness', access: 'public', summary: 'Worker is up' },
  { method: 'GET', path: '/api/v1/me', access: 'login', summary: 'Signed-in user, role and workspace' },
  { method: 'GET', path: '/api/v1/staff-sessions/staff', access: ['supervisor'], handler: (c) => staffDirectory(c), summary: 'Active operational staff for supervisor access' },
  { method: 'POST', path: '/api/v1/staff-sessions/start', access: ['supervisor'], handler: (c, b) => startStaffSession(c, b), summary: 'Open an audited staff workspace for 30 minutes' },
  { method: 'POST', path: '/api/v1/staff-sessions/end', access: 'login', handler: (c) => endStaffSession(c), summary: 'Return to the original supervisor login' },
  { method: 'GET', path: '/api/v1/live', access: ALL, summary: 'WebSocket: table names that changed' },
  { method: 'GET', path: '/api/v1/local/users', access: ALL, summary: 'Local test only: logins to pick from' },
  { method: 'POST', path: '/api/v1/batch', access: ALL, handler: (c, b) => batch(c, b), summary: 'Several reads in one transaction (RLS per user)' },
  { method: 'POST', path: '/api/v1/data/{table}', access: ALL, handler: async (c, b) => changing(await write(c, c.params.table, b), c), summary: 'One read or write on an allowed table' },
  { method: 'POST', path: '/api/v1/rpc/{fn}', access: ALL, handler: async (c, b) => changing(await rpc(c, c.params.fn, b ?? {}), c), summary: 'One business action' },
  { method: 'POST', path: '/api/v1/calls/dial', access: OPS, handler: (c, b) => dial(c, b ?? {}), summary: 'MyOperator click-to-call' },
  { method: 'GET', path: '/api/v1/calls/{id}/recording', access: RECORDINGS, handler: (c) => recording(c), summary: 'Call recording audio (logged)' },
  { method: 'POST', path: '/api/v1/cases/{id}/quote', access: OPS, handler: (c, b) => sendQuote(c, b ?? {}), summary: 'Send the quote on an approved template' },
  { method: 'POST', path: '/api/v1/cases/{id}/message', access: OPS, handler: (c, b) => sendMessage(c, b ?? {}), summary: 'Send an approved template message' },
  { method: 'GET', path: '/api/v1/whatsapp/session', access: ALL, handler: (c) => whatsappSession(c), summary: 'WhatsApp Business API configuration status' },
  { method: 'POST', path: '/api/v1/whatsapp/session', access: WA_OPS, handler: (c, b) => whatsappSessionAction(c, b ?? {}), summary: 'QR sessions disabled for enterprise compliance' },
  { method: 'POST', path: '/api/v1/whatsapp/send', access: WA_OPS, handler: (c, b) => sendWhatsAppChat(c, b ?? {}), summary: 'Send a WhatsApp reply or approved template' },
  { method: 'POST', path: '/api/v1/email/send', access: WA_OPS, handler: (c, b) => sendEmailChat(c, b ?? {}), summary: 'Send an e-mail to a patient (Gmail SMTP), copy on the timeline' },
  { method: 'POST', path: '/api/v1/ai/calls/{id}', access: AI_CALLS, handler: (c) => summariseCall(c, c.params.id), summary: 'AI: transcript, summary, QA of a recorded call (a call the user can see)' },
  { method: 'POST', path: '/api/v1/ai/calls/{id}/live-token', access: OPS, handler: (c, b) => liveCallToken(c, b), summary: 'Single-use Gemini 3.5 live transcription token for an active visible call' },
  { method: 'POST', path: '/api/v1/ai/calls/{id}/live-transcript', access: OPS, handler: (c, b) => saveLiveTranscript(c, b), summary: 'Save append-only live transcript checkpoints and finalise for AI summary' },
  { method: 'GET', path: '/api/v1/ai/status', access: CALL_VIEW, handler: (c) => aiStatus(c), summary: 'Whether AI call summaries are on' },
  { method: 'POST', path: '/api/v1/ai/cases/{id}/brief', access: ALL, handler: async (c) => { const r = await caseBrief(c.env, c.sql, c.user.id, c.params.id); c.changed.push(...r.changed); return r.brief; }, summary: 'AI case brief' },
  { method: 'POST', path: '/api/v1/ai/command', access: ALL, handler: async (c, b) => command(await aiEnv(c.env, c.sql), String(b?.q || '').slice(0, 400), c.user.role || ''), summary: 'AI command bar' },
  { method: 'POST', path: '/api/v1/ai/extract-enquiry', access: OPS, handler: (c, b) => extractEnquiry(c.env, c.sql, c.user.id, String(b?.text || '').slice(0, 4000)), summary: 'AI enquiry extraction' },
  { method: 'POST', path: '/api/v1/admin/users', access: ADMIN, handler: (c, b) => createUser(c, b), summary: 'Create a login and its profile' },
  { method: 'GET', path: '/api/v1/admin/webhooks', access: TECH, handler: (c) => webhookEvents(c), summary: 'Last 50 MyOperator webhook events' },
  { method: 'GET', path: '/api/v1/admin/webhooks/health', access: ['supervisor'], handler: (c) => webhookHealth(c), summary: 'MyOperator webhook health: last event, counts, failures, rejections (no payloads or numbers)' },
  { method: 'GET', path: '/api/v1/admin/integrations', access: TECH, handler: (c) => integrations(c), summary: 'Which integrations are configured' },
  { method: 'GET', path: '/api/v1/admin/myoperator', access: TECH, handler: (c) => moSettings(c), summary: 'MyOperator connection: fields set, webhook address, last event' },
  { method: 'POST', path: '/api/v1/admin/myoperator', access: TECH, handler: (c, b) => saveMoSettings(c, b ?? {}), summary: 'Save MyOperator connection values' },
  { method: 'POST', path: '/api/v1/admin/myoperator/sync', access: TECH, handler: (c) => syncNow(c), summary: 'Read new calls from the MyOperator call log now' },
  { method: 'GET', path: '/api/v1/admin/ai', access: TECH, handler: (c) => aiSettings(c), summary: 'AI call summaries: key set, model, auto switch, last 14 days' },
  { method: 'POST', path: '/api/v1/admin/ai', access: TECH, handler: (c, b) => saveAiSettings(c, b ?? {}), summary: 'Save the Gemini key, model and auto-summary switch' },
  { method: 'POST', path: '/api/v1/admin/ai/test', access: TECH, handler: (c) => testAi(c), summary: 'Test the Gemini key' },
  { method: 'GET', path: '/api/v1/admin/email', access: TECH, handler: (c) => emailStatus(c), summary: 'Outbound e-mail (Gmail SMTP): settings present, last MIS send' },
  { method: 'POST', path: '/api/v1/admin/email/test', access: TECH, handler: (c, b) => testEmail(c, b ?? {}), summary: 'Send a test e-mail to the configured sender address only' },
  { method: 'POST', path: '/api/v1/admin/myoperator/waba/test', access: TECH, handler: (c) => testWaba(c), summary: 'Read-only WABA credentials and phone activation check, no message sent' },
  { method: 'POST', path: '/api/v1/admin/myoperator/test', access: TECH, handler: (c) => testMo(c), summary: 'Test the MyOperator connection' },
  { method: 'GET', path: '/api/v1/admin/myoperator/users', access: TECH, handler: (c) => moUsers(c), summary: 'MyOperator users and the CRM logins linked to them' },
  { method: 'POST', path: '/api/v1/admin/users/telephony', access: TECH, handler: (c, b) => setTelephony(c, b ?? {}), summary: 'Set a user\'s MyOperator user id, extension and phone' },
  { method: 'POST', path: '/api/v1/admin/myoperator/users', access: TECH, handler: (c, b) => linkMoUsers(c, b ?? {}), summary: 'Link CRM logins to MyOperator users' },
];

const compiled = routes.map((r) => ({ r, re: new RegExp('^' + r.path.replace(/\{(\w+)\}/g, '(?<$1>[^/]+)') + '$') }));

/** The route for a request, 404 when the path is unknown, 405 when the method is wrong. */
export function match(method: string, path: string): { route: Route; params: Record<string, string> } | 404 | 405 {
  let pathHit = false;
  for (const { r, re } of compiled) {
    const m = path.match(re);
    if (!m) continue;
    pathHit = true;
    if (r.method === method) return { route: r, params: Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => [k, decodeURIComponent(v)])) };
  }
  return pathHit ? 405 : 404;
}

/** OpenAPI-style contract, exported by the rehearsal to docs/openapi.json. */
export function contract() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    paths[r.path] ??= {};
    paths[r.path][r.method.toLowerCase()] = {
      summary: r.summary,
      'x-access': r.access,
      security: r.access === 'public' ? [] : [{ supabase: [] }],
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'CareDesk CRM API (Hinduja Home Care x SecondMedic)', version: '1' },
    components: { securitySchemes: { supabase: { type: 'http', scheme: 'bearer', bearerFormat: 'Supabase ES256 JWT' } } },
    paths,
    'x-tables-read': READ,
    'x-tables-write': WRITE,
    'x-rpc': RPC,
  };
}
