// Local test only (RUN-LOCAL-TEST.bat): telephony buttons send real MyOperator Webhook v2 events to the local Worker,
// so a test call runs through exactly the code that handles live calls (call row, screen-pop, callback queue, timeline).
// The key below exists only in the local test Worker (cloudflare/test/local.mjs); the live Worker has its own secret.
export const LOCAL_WEBHOOK_KEY = 'local-test-webhook-key';
const LINES = ['+918049368621'];
const now = () => Math.floor(Date.now() / 1000);

async function hook(ev) {
  const r = await fetch('/webhooks/myoperator', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-webhook-key': LOCAL_WEBHOOK_KEY },
    body: JSON.stringify({ event_id: 'local-' + crypto.randomUUID(), timestamp: now(), ...ev }),
  });
  if (!r.ok) throw new Error('Local webhook refused: ' + r.status);
}

export async function localInboundCall(known) {
  const session = 'local-' + crypto.randomUUID().slice(0, 13);
  const number = known || '+9198' + String(Math.floor(20000000 + Math.random() * 79999999));
  const line = LINES[Math.floor(Math.random() * LINES.length)];
  await hook({ event_type: 'call.initiated', session_id: session, direction: 'inbound', customer_identifier: number, system_identifier: line, payload: { did_number: line } });
  return session;
}

export async function localAnswer(call, profile) {
  const ring = Math.max(1, Math.round((Date.now() - new Date(call.started_at).getTime()) / 1000));
  await hook({ event_type: 'call.answered', session_id: call.session_id, direction: call.direction,
    payload: { legs: [{ answered_at: now(), ring_duration: ring, agent: { uuid: profile.myoperator_user_id, email: profile.email, name: profile.full_name } }] } });
}

export async function localEnd(call) {
  const answered = !!call.answered_at;
  const talk = answered ? Math.max(5, Math.round((Date.now() - new Date(call.answered_at).getTime()) / 1000)) : 0;
  await hook({ event_type: 'call.end', session_id: call.session_id, direction: call.direction,
    payload: { reference_id: call.click_to_call_ref || undefined, status: answered ? 'answered' : (call.direction === 'outbound' ? 'failed' : 'missed'), ended_at: now(), recording_filename: answered ? 'local-test-recording.mp3' : null,
      legs: [{ talk_duration: talk, ring_duration: call.ring_seconds || 0, dial_status: answered ? 'answered' : 'no-answer' }] } });
}

export async function localInboundWhatsApp(opts = {}) {
  const number = opts.number || '+9198' + String(Math.floor(20000000 + Math.random() * 79999999));
  const name = opts.name || 'Mrs. Kavita Deshmukh';
  const text = opts.text || 'Namaste, need home blood sample collection (CBC, HbA1c, Thyroid) and ECG for my mother in Khar West tomorrow 8 AM. Pincode 400052.';
  await hook({
    event_type: 'message.received',
    direction: 'inbound',
    customer_identifier: number,
    system_identifier: LINES[0],
    payload: {
      id: 'wamid_local_' + crypto.randomUUID().slice(0, 8),
      customer_name: name,
      conversation: { customer_number: number, customer_name: name },
      data: { type: 'text', context: { body: text } },
    },
  });
}

