# Supervisor staff workspaces

After signing in with their own email, password and configured second factor, a supervisor (or an administrator) sees **Open staff workspace** at the top of the Live dashboard. Select a department, then an active staff member, and press **Open staff workspace**. The same action is available in Settings > Departments & staff.

The app opens that staff member's normal home page, menu, queue and permissions. A persistent banner names both people. **Return to supervisor** closes access and restores the original supervisor dashboard. A refresh preserves access; it ends after 30 minutes or sign-out. Expired access returns the browser to the supervisor workspace. Other tabs keep their own selected workspace.

Available departments: Contact centre, Coordination, Field team, Medical desk and Service partners. Administrators can do the same; their records read `Staff Name - Administrator (Administrator Name)`. Neither can use this to assume admin, administrator, management, clinical management or other supervisor accounts. Those roles require their own login. Disabled staff cannot be selected; disabling staff or removing the supervisor role invalidates access immediately. A supervisor cannot enter a different workspace's staff account.

## Accountability

The audit and access logs display `Staff Name - Supervisor (Supervisor Name)`. The real supervisor remains `audit_log.actor_id` / `access_log.user_id`; `staff_id` identifies the selected staff member, and `staff_session_id` links the activity to its start and end. New timeline interactions also carry the combined label and both IDs. Each delegated API request, including reads and denied actions, creates an access record with method and route template only. Patient names, numbers, addresses and request bodies are not copied into these access records.

Business ownership still uses the staff ID, so assignments, callbacks and case permissions behave as they would for that staff member. Calls initiated in a staff workspace use that staff member's linked MyOperator phone. The supervisor's own login and password never change.

## Implementation

- The browser retains the supervisor's Supabase token and sends an `X-Staff-Session` ID. The ID alone cannot authenticate anyone: the server binds it to the original supervisor JWT on every request and checks both profiles afresh.
- `staff_sessions` is server-only, with RLS enabled and no app-role grants. Start and end use authenticated API endpoints; operational requests use the selected staff ID through the existing `asUser` / `readAsUser` helpers and existing RLS policies.
- Per-request database connection context carries the verified session ID into user and system transactions. Insert triggers stamp audit/access records and timeline interactions. No global mutable current-user state or staff JWT is created.
- Migration: `20261015100000_supervisor_staff_sessions.sql`. API checks: `cloudflare/test/staff-session.itest.mjs`, run by the rehearsal. The browser demo does not simulate delegated audit access; use the local Worker with its throw-away database to test it.

Normal live sign-in always requires credentials. The department picker on the unauthenticated start screen is limited to demo/local test mode; it does not represent a real staff login.
