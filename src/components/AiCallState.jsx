// Where the AI summary of a recorded call stands (calls.ai_status, set by the Worker): waiting, summarising, failed with
// the reason, too short. Staff who may run it get a "Summarise" / "Retry" button (POST /api/v1/ai/calls/{id}).
import { dateTime } from '../lib/fmt.js';
import { Button } from './ui.jsx';

export const SUMMARY_ROLES = ['agent', 'coordinator', 'supervisor', 'client_manager', 'medical_desk'];
const STUCK_MS = 10 * 60e3;

/** One line for a recorded call that has no summary yet. `onRun(callId)` starts it; `busy` disables the button. */
export function AiCallState({ call, enabled, canRun, onRun, busy, showWhen }) {
  if (!call?.has_recording || call.ai_summary) return null;
  const processing = call.ai_status === 'processing' && Date.now() - new Date(call.ai_started_at).getTime() < STUCK_MS;
  const when = showWhen ? ` the call of ${dateTime(call.started_at)}` : '';
  let text;
  let kind = 'muted';
  if (enabled === false) text = 'AI summaries are off. A supervisor adds the Gemini key in Settings > Telephony & integrations.';
  else if (processing) text = `Summarising${when}…`;
  else if (call.ai_status === 'failed') { text = `Summary failed${when}: ${call.ai_error || 'unknown error'}`; kind = 'danger-text'; }
  else if (call.ai_status === 'skipped') text = `Not summarised${when}: ${call.ai_error || 'too short'}.`;
  else text = `Summary pending${when}: it runs within a few minutes of the call.`;
  const button = enabled !== false && canRun && !processing;
  return (
    <div className="row wrap gap-8 mt-4" style={{ alignItems: 'center' }}>
      <span className={`small ${kind}`}>{text}</span>
      {button && <Button size="xs" icon="ai" disabled={busy} onClick={() => onRun(call.id)}>{busy ? 'Summarising…' : call.ai_status === 'failed' ? 'Retry' : 'Summarise now'}</Button>}
    </div>
  );
}
