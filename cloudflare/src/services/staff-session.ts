import type { Ctx } from '../api/context';
import type { User } from '../api/auth';
import { asSystem, readAsUser, setStaffSession } from '../db';
import { ApiError } from '../domain/errors';

// Operational departments only: no assuming admin rights, management approvals or another supervisor's identity.
// Supervisors and administrators may open a staff workspace.
export const STAFF_ROLES = ['agent', 'coordinator', 'medical_desk', 'field_staff', 'provider'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function staffDirectory(c: Ctx) {
  return readAsUser(c.sql, c.user.id, (tx) => tx`select id, full_name, role, agent_code from profiles
    where workspace_id = ${c.user.workspaceId}::uuid and active and role::text in ('agent','coordinator','medical_desk','field_staff','provider')
    order by full_name`);
}

export async function startStaffSession(c: Ctx, b: { staff_id?: string }) {
  if (!UUID.test(b?.staff_id || '')) throw new ApiError(400, 'Select a staff member');
  if (c.req.headers.has('X-Staff-Session')) throw new ApiError(403, 'Return to your supervisor account before selecting another staff member');
  const { result, changed } = await asSystem(c.sql, async (tx) => {
    // Fresh checks, including supervisor role: cached profile data never authorises staff access.
    const [supervisor] = await tx`select id from profiles where id = ${c.user.id}::uuid and workspace_id = ${c.user.workspaceId}::uuid and role::text in ('supervisor', 'administrator') and active for share`;
    const [staff] = await tx`select id from profiles where id = ${b.staff_id!}::uuid and workspace_id = ${c.user.workspaceId}::uuid and active
      and role::text in ('agent','coordinator','medical_desk','field_staff','provider') for share`;
    if (!supervisor || !staff) throw new ApiError(403, 'Choose active operational staff in your workspace');
    const [s] = await tx`insert into staff_sessions(workspace_id, supervisor_id, staff_id)
      values (${c.user.workspaceId}::uuid, ${c.user.id}::uuid, ${b.staff_id!}::uuid) returning id, expires_at`;
    await tx`select set_config('caredesk.staff_session', ${s.id}, true)`;
    await tx`insert into access_log(workspace_id, user_id, action, entity, entity_id)
      values (${c.user.workspaceId}::uuid, ${c.user.id}::uuid, 'staff_session_start', 'staff_session', ${s.id})`;
    return s;
  });
  c.changed.push(...changed);
  return result;
}

/** Resolve the session only with the supervisor's own JWT. Session IDs are never staff login tokens. */
export async function resolveStaffSession(c: Ctx, principal: User) {
  const id = c.req.headers.get('X-Staff-Session');
  if (!id) return null;
  if (!UUID.test(id)) throw new ApiError(409, 'Staff session has ended. Return to your supervisor account.');
  const { result } = await asSystem(c.sql, async (tx) => {
    const [r] = await tx`select s.id as session_id, s.expires_at, st.id, st.email, st.role, st.workspace_id, st.full_name, st.agent_code,
        st.myoperator_user_id, sp.full_name as supervisor_name
      from staff_sessions s join profiles sp on sp.id = s.supervisor_id join profiles st on st.id = s.staff_id
      where s.id = ${id}::uuid and s.supervisor_id = ${principal.id}::uuid and s.ended_at is null and s.expires_at > now()
        and sp.active and sp.role::text in ('supervisor', 'administrator') and st.active
        and sp.workspace_id = s.workspace_id and st.workspace_id = s.workspace_id
        and st.role::text in ('agent','coordinator','medical_desk','field_staff','provider')`;
    return r;
  });
  if (!result) throw new ApiError(409, 'Staff session has ended. Return to your supervisor account.');
  setStaffSession(c.sql, id);
  c.user = { id: result.id, email: result.email, role: result.role, workspaceId: result.workspace_id,
    fullName: result.full_name, agentCode: result.agent_code, myoperatorUserId: result.myoperator_user_id, authMode: principal.authMode };
  return { id, staffName: result.full_name, supervisorName: result.supervisor_name, expiresAt: result.expires_at };
}

/** Return always uses the original login, including after the session expires or staff are disabled. */
export async function endStaffSession(c: Ctx) {
  const id = c.req.headers.get('X-Staff-Session');
  if (!id || !UUID.test(id)) throw new ApiError(400, 'No staff session selected');
  const { changed } = await asSystem(c.sql, async (tx) => {
    const [s] = await tx`update staff_sessions set ended_at = now() where id = ${id}::uuid and supervisor_id = ${c.user.id}::uuid and ended_at is null returning *`;
    if (s) {
      await tx`select set_config('caredesk.staff_session', ${s.id}, true)`;
      await tx`insert into access_log(workspace_id, user_id, action, entity, entity_id)
        values (${s.workspace_id}, ${c.user.id}::uuid, 'staff_session_end', 'staff_session', ${s.id})`;
    }
  });
  c.changed.push(...changed);
  return { ended: true };
}

export async function logStaffRequest(c: Ctx, route: string) {
  await asSystem(c.sql, (tx) => tx`insert into access_log(workspace_id, user_id, action, entity, meta)
    values (${c.user.workspaceId}::uuid, ${c.user.id}::uuid, 'staff_session_request', 'staff_workspace',
      ${tx.json({ method: c.req.method, route })})`);
}
