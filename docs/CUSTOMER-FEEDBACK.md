# Customer feedback and ratings

Each completed call with positive talk time and a linked patient creates one feedback request. Case-linked calls must refer to a patient in the same workspace. Duplicate webhook/completion updates cannot create another request for that call. There is no bulk backfill of historical calls.

Call interactions and delivered services have **separate ratings and averages**. A service request is created when the existing workflow records `service_completed_at` and no active assignments or referrals remain unfinished. A subsequent referral completion also checks this gate for mixed cases. One service request per case, independent of its call requests, with no historical backfill. Customer submissions never update case stages, service delivery or the legacy staff-entered closure rating.

## Customers and staff

The mobile `/feedback#<private token>` link opens without CRM login. The fragment is removed from browser history after capture; refreshing requires reopening the original link. Form requests send tokens only in JSON POST bodies, and feedback storage keeps only SHA-256 hashes. Public endpoints expose only link validity and experience type, and accept one integer rating from 1 to 5 with up to 2,000 characters of optional plain text. React renders comments as text. The public form loads no error analytics and displays no customer, medical or internal case information.

The dashboard shows separate all-time, submitted-only averages and counts for calls and services within the user's scope. Each opens the filtered feedback list, with customer-name search, IST date range, rating and experience filters. Responses show their source (form, WhatsApp or email). Patient detail > Feedback contains submitted history and pending requests. Generate new link replaces any earlier link and produces a copyable request message for WhatsApp/email. Submitted requests cannot be regenerated. Links and messages should be shared only with the intended customer.

Feedback access follows existing call, case and patient permissions for agents, coordinators, supervisors, medical desk and Hinduja management/clinical users. Administrators inherit the existing senior-role access. Platform admins, providers and field staff cannot view responses or generate links. Raw request/response tables and internal helpers are not exposed through generic API actions.

## Delivery and configuration

The minute cron reuses the existing Gmail SMTP sender; no SMS or WhatsApp template is required. With `SMTP_PASSWORD`, valid `SMTP_FROM` / `SMTP_USERNAME` and `APP_URL` configured, it claims and emails at most one queued request per minute for a customer with a valid saved email address. This avoids sending an old backlog in a single invocation. If no usable email or configured sender is available, staff generate and copy a private link from the patient's Feedback tab.

Workspace settings are available in Settings > Workspace:

- `feedback_expiry_hours`: link lifetime, default 168 (7 days), clamped to 1–720 hours. New requests and regenerated links use the current value.
- `feedback_auto_email`: defaults to true. Set false to pause automatic email for that workspace. Manual links remain available.
- `feedback_reply_to`: the actual mailbox routed to this Worker for incoming feedback. Set only after connecting Cloudflare Email Routing. Otherwise the existing `EMAIL_REPLY_TO` or SMTP sender receives replies.

## Direct WhatsApp and email replies

Customers reply with `Rating: 4` on the first line (also accepts `4` or `4/5`), optionally followed by a comment. No score is inferred from prose. Requests include `FB-<request UUID>`. WhatsApp replies are matched by sender mobile plus that reference or the quoted outbound message ID (`context.id` / `reply_to_message_id`). A rating without a reference is accepted only when that sender has exactly one unexpired pending request. Ambiguous messages remain ordinary conversations; they do not alter averages.

Email replies must match the customer's saved email and prove possession of the private link retained in the quoted original request. The parser reads the new reply above quoted text; original prompts never supply the rating. An absent private link leaves the reply for staff review on the timeline as unverified. No sender-only email is trusted for a score. Expired and duplicate submissions never overwrite previous feedback. Recognized feedback replies are stored against the existing customer/interaction and do not open a new enquiry. Feedback reply text/private tokens are omitted from the webhook diagnostic payload; ordinary stored communication copies remain private customer records.

WhatsApp capture requires authenticated MyOperator inbound webhooks to reach CareDesk. Staff send the copyable request using existing approved WhatsApp messaging; this feature does not register a new WABA template or send automatic WhatsApp requests. Email capture requires an incoming mailbox routed to the Worker's email handler. **The current project's outgoing Gmail setup alone does not provide inbound email access.** Cloudflare Email Routing is documented as unconfigured on the current account. Connecting it requires a suitable domain/mailbox and routing configuration; existing production MX records must not be replaced without the mailbox owner's approval. Until connected, customers can use the secure form and WhatsApp replies can arrive through the existing webhook. Live message delivery and mailbox ingestion must be verified separately from local tests.

An email's `accepted` status means SMTP accepted the message; it is not proof of inbox delivery. `failed` is a definite failure; `unknown` is an unconfirmed outcome. No automatic repeat is made for either, and a `sending` claim older than 15 minutes becomes unknown during the next enabled email sweep. Staff may generate a replacement link after a failure/unknown result. Sender details remain in the existing server configuration. Requests, tokens and customer comments are excluded from audit payloads and application error logs.

## Verification

`cloudflare/test/feedback.itest.mjs` covers the base workflow and RLS. `feedback-replies.itest.mjs` adds actual MyOperator webhook requests, separate service completion, ambiguity, quoted-message matching, duplicates, expiry, email sender/private-link checks and separate aggregates. `feedback-replies.test.ts` checks parser behavior and the real email handler's ingestion branch without opening an enquiry. `feedback.test.ts` checks hashing and SMTP outcomes using an injected sender. Existing SMTP tests verify the wire protocol against a simulated server. These tests do not prove live inbox delivery or live webhook/mail routing.
