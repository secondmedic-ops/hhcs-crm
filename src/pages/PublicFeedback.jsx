import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.ts';
import { Button, Field, Textarea, Skeleton } from '../components/ui.jsx';

export default function PublicFeedback() {
  const [token] = useState(() => window.location.hash.slice(1));
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // Remove the capability from browser history after taking a memory-only copy.
    window.history.replaceState(null, '', '/feedback');
    api.feedbackOpen(token).then(() => setState('ready')).catch(e => { setError(e.message); setState('unavailable'); });
  }, [token]);
  const submit = async e => {
    e.preventDefault(); setBusy(true); setError('');
    try { await api.feedbackSubmit(token, rating, comment); setState('done'); }
    catch (e) { setError(e.message); if ([404,409,410].includes(e.status)) setState('unavailable'); }
    finally { setBusy(false); }
  };
  return <main className="feedback-public">
    <div className="small muted">Hinduja Home Care Services · CareDesk</div>
    <h1>Share Your Feedback.</h1>
    {state === 'loading' ? <Skeleton lines={5} /> : state === 'done' ? <p role="status">Thank you for sharing your feedback.</p> : <>
      {error && <p role="alert" className="feedback-error">{error}</p>}
      {state === 'ready' && <form onSubmit={submit}>
        <p>How would you rate your recent interaction with our team? Please select a rating and optionally share your feedback.</p>
        <p className="small muted">This rates your call experience. It does not confirm that a service was delivered. Please do not include medical details or personal information.</p>
        <fieldset className="feedback-stars"><legend>Rating (required)</legend>
          <div className="row">{[1,2,3,4,5].map(n => <label key={n} className={rating >= n ? 'selected' : ''}>
            <input type="radio" name="rating" value={n} required checked={rating === n} onChange={() => setRating(n)} aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`} />
            <span aria-hidden="true">★</span><small>{n}</small>
          </label>)}</div>
        </fieldset>
        <Field label="Feedback (optional)"><Textarea value={comment} onChange={e => setComment(e.target.value)} maxLength={2000} rows={5} /></Field>
        <Button type="submit" kind="primary" disabled={busy || !rating}>{busy ? 'Submitting…' : 'Submit feedback'}</Button>
      </form>}
    </>}
    <footer className="row gap-12 mt-16 small"><Link to="/terms">Terms of Service</Link><Link to="/privacy">Privacy Policy</Link></footer>
  </main>;
}
