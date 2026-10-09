// Actions that need the server (MyOperator click-to-call, recordings, WhatsApp, AI, user admin).
// Live and local test: the Worker through src/api.ts. Demo: local stand-ins (demo/sim.js).
import { isDemo } from './db.js';
import { api as server } from '../api.ts';

const demo = async (path, body) => { const { demoApi } = await import('../demo/sim.js'); return demoApi(path, body); };

export const dial = (target) => (isDemo ? demo('/calls/dial', target) : server.dial(target));                 // {case_id} | {patient_id} | {callback_id}
export const sendQuote = (caseId, templateId) => (isDemo ? demo(`/cases/${caseId}/quote`, { template_id: templateId }) : server.sendQuote(caseId, templateId));
export const sendMessage = (caseId, templateId) => (isDemo ? demo(`/cases/${caseId}/message`, { template_id: templateId }) : server.sendMessage(caseId, templateId));
export const aiBrief = (caseId) => (isDemo ? demo(`/ai/cases/${caseId}/brief`, {}) : server.aiBrief(caseId));
export const aiCall = (callId) => (isDemo ? demo(`/ai/calls/${callId}`, {}) : server.aiCall(callId));
export const aiCommand = (q) => (isDemo ? demo('/ai/command', { q }) : server.aiCommand(q));
export const aiExtract = (text) => (isDemo ? demo('/ai/extract-enquiry', { text }) : server.aiExtract(text));
export const createUser = (u) => (isDemo ? demo('/admin/users', u) : server.createUser(u));
export const webhookEvents = () => (isDemo ? demo('/admin/webhooks', {}) : server.webhookEvents());
export const integrations = () => (isDemo ? demo('/health', {}) : server.integrations());
// MyOperator connection (admin). The demo has no MyOperator account: it shows the screen with nothing configured.
const demoOnly = () => Promise.reject(new Error('Demo mode: MyOperator connects on the live site'));
export const moSettings = () => (isDemo ? Promise.resolve({ demo: true, fields: [], webhook: { key: null, url: `${location.origin}/webhooks/myoperator`, url_with_key: null }, last_event: null, agents: { ops: 0, linked: 0 } }) : server.moSettings());
export const saveMoSettings = (body) => (isDemo ? demoOnly() : server.saveMoSettings(body));
export const testMo = () => (isDemo ? demoOnly() : server.testMo());
export const moUsers = () => (isDemo ? demoOnly() : server.moUsers());
export const linkMoUsers = (body) => (isDemo ? demoOnly() : server.linkMoUsers(body));

// Returns an object URL for the call recording (fetched with the login, so the provider link is never exposed)
export async function recordingUrl(callId) {
  if (isDemo) {
    const { demoRecording } = await import('../demo/sim.js');
    return demoRecording();
  }
  const res = await server.recording(callId);
  return URL.createObjectURL(await res.blob());
}
