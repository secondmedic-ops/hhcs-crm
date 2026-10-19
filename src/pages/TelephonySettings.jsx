import { Badge, Button, Panel, Skeleton } from '../components/ui.jsx';
import { dateTime } from '../lib/fmt.js';

const LABEL = { missing_credentials: 'Missing Credentials', configured: 'Configured', connected: 'Connected' };

export default function TelephonySettings({ result, loading, busy, dirty, demo, onTest }) {
  return (
    <Panel title="WhatsApp Business API (WABA)" sub="Check the saved credentials and phone activation without sending a message."
      actions={<Button size="sm" onClick={onTest} disabled={loading || busy || dirty || demo}>{busy ? 'Checking' : 'Test WABA connection'}</Button>}>
      {loading ? <Skeleton lines={3} /> : result ? (
        <div className="col gap-8" role="status" aria-live="polite">
          <div><Badge kind={result.status === 'connected' ? 'ok' : 'warn'}>{LABEL[result.status] || 'Configured'}</Badge></div>
          <div className="small">{result.message}</div>
          {result.checked_at && <div className="tiny muted">Checked {dateTime(result.checked_at)}. Connected reflects this check only. Run it again after account changes.</div>}
        </div>
      ) : <div className="small muted">{dirty ? 'Unsaved changes. Save to refresh the WABA status.' : demo ? 'Demo mode: WABA checks are available on the live site.' : 'Could not load WABA configuration. Reload settings to try again.'}</div>}
      {dirty && <div className="small warn-text mt-8">Save your changes before testing. The check uses saved values and Worker secrets.</div>}
      <div className="small muted mt-8">Configured means the Company ID, WhatsApp API key and phone number ID are present. Connected means MyOperator accepted them and confirmed the phone is active and onboarded.</div>
      <div className="small muted mt-8">Values saved here override Worker environment secrets. Clearing a saved value falls back to its Worker secret, if set.</div>
      <div className="small mt-8">QR scanning is disabled for enterprise compliance. Use the official MyOperator WhatsApp Business API so patient communication stays in the managed integration.</div>
    </Panel>
  );
}
