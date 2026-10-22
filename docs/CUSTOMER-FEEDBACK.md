# Customer feedback and ratings

Each completed call with positive talk time and a linked patient creates one feedback request. Case-linked calls must refer to a patient in the same workspace. Duplicate webhook/completion updates cannot create another request for that call. There is no bulk backfill of historical calls.

This rates the **call interaction**, independently of the staff-entered case/service feedback and the closure gates. Customer submissions never update case stages, service delivery or the service feedback fields.

## Customers and staff

The mobile `/feedback#<private token>` link opens without CRM login. The fragment is removed from browser history after capture; refreshing the page requires reopening the original link. The token travels only in a JSON POST body. The database keeps SHA-256 hashes, not reusable plaintext tokens. Public endpoints expose only link validity and accept one integer rating from 1 to 5, with up to 2,000 characters of optional plain text. React renders comments as text. The public form loads no error analytics and displays no customer, medical, call or internal case information.

The dashboard's Customer Feedback summary shows an all-time, submitted-only average and count within the user's scope. It opens the paginated Customer feedback list, with customer-name search, IST date range and rating filters. Patient detail > Feedback contains separate submitted history and pending requests. Generate new link replaces any earlier link for that request; submitted requests cannot be regenerated. Links should be shared only with the intended customer.

Feedback access follows existing call, case and patient permissions for agents, coordinators, supervisors, medical desk and Hinduja management/clinical users. Administrators inherit the existing senior-role access. Platform admins, providers and field staff cannot view responses or generate links. Raw request/response tables and internal helpers are not exposed through generic API actions.

## Delivery and configuration

The minute cron reuses the existing Gmail SMTP sender; no SMS or WhatsApp template is required. With `SMTP_PASSWORD`, valid `SMTP_FROM` / `SMTP_USERNAME` and `APP_URL` configured, it claims and emails at most one queued request per minute for a customer with a valid saved email address. This avoids sending an old backlog in a single invocation. If no usable email or configured sender is available, staff generate and copy a private link from the patient's Feedback tab.

Workspace settings are available in Settings > Workspace:

- `feedback_expiry_hours`: link lifetime, default 168 (7 days), clamped to 1–720 hours. New requests and regenerated links use the current value.
- `feedback_auto_email`: defaults to true. Set false to pause automatic email for that workspace. Manual links remain available.

An email's `accepted` status means SMTP accepted the message; it is not proof of inbox delivery. `failed` is a definite failure; `unknown` is an unconfirmed outcome. No automatic repeat is made for either, and a `sending` claim older than 15 minutes becomes unknown during the next enabled email sweep. Staff may generate a replacement link after a failure/unknown result. Sender details remain in the existing server configuration. Requests, tokens and customer comments are excluded from audit payloads and application error logs.

## Verification

`cloudflare/test/feedback.itest.mjs` runs through the real Worker during rehearsal: eligibility and duplicate requests, public form privacy, input validation, concurrent duplicate submission, expiration, regeneration, submitted-only aggregates, separate patient history, denied roles, agent scope and cross-workspace RLS, expiry settings, email claim switch and interrupted outcomes. `feedback.test.ts` checks hashing, private URL format and accepted/failed/unknown delivery using an injected sender. Existing SMTP tests verify the wire protocol against a simulated server. These tests do not prove live inbox delivery.
