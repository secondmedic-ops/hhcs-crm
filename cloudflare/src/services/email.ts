// Inbound email -> ticket. Point the Hinduja-branded mailbox (or a forwarding rule) at this Worker through Cloudflare
// Email Routing. Each mail lands on the patient's timeline; a new sender opens an enquiry case and the 5-minute
// acknowledgement SLA starts.
import PostalMime from 'postal-mime';
import { asSystem, connect } from '../db';
import type { Env } from '../env';
import { notifyLive } from './live';

export async function handleEmail(message: ForwardableEmailMessage, env: Env, exec: ExecutionContext) {
  const raw = await new Response(message.raw).arrayBuffer();
  const mail = await PostalMime.parse(raw);
  const from = String(mail.from?.address || message.from || '').toLowerCase();
  const text = String(mail.text || mail.html?.replace(/<[^>]+>/g, ' ') || '').trim().slice(0, 8000);
  const sql = connect(env);
  try {
    const { changed } = await asSystem(sql, async (tx) => {
      const [w] = await tx`select id from workspaces where code = ${env.DEFAULT_WORKSPACE_CODE || 'HHC'}`;
      const ws = w.id;
      // case reference in subject/body wins, then sender email
      const ref = `${mail.subject} ${text}`.match(/[A-Z]{2,5}-\d{6}-\d{5}/)?.[0];
      let [kase] = ref ? await tx`select id, patient_id from cases where case_no = ${ref}` : [];
      let patientId: string | null = kase?.patient_id ?? null;
      if (!kase) {
        const [p] = await tx`select id from patients where workspace_id = ${ws} and lower(email) = ${from} limit 1`;
        patientId = p?.id ?? null;
        if (p) [kase] = await tx`select id, patient_id from cases where patient_id = ${p.id} and stage not in ('closed','cancelled') order by created_at desc limit 1`;
      }
      if (!kase) {
        const [r] = await tx`select create_enquiry(${tx.json({
          workspace_id: ws, source_channel: 'email', services_requested: `${mail.subject || ''}\n${text}`.slice(0, 500),
          patient: { full_name: mail.from?.name || from, email: from },
        })}) as r`;
        kase = { id: r.r.case_id, patient_id: r.r.patient_id } as never;
        patientId = r.r.patient_id;
      }
      await tx`insert into inbound_emails (workspace_id, message_id, from_address, to_address, subject, text_body, patient_id, case_id)
        values (${ws}, ${mail.messageId ?? null}, ${from}, ${message.to}, ${mail.subject ?? null}, ${text}, ${patientId}, ${kase.id}) on conflict do nothing`;
      await tx`insert into interactions (workspace_id, case_id, patient_id, channel, direction, actor_label, summary, body, evidence)
        values (${ws}, ${kase.id}, ${patientId}, 'email', 'inbound', ${mail.from?.name || from}, ${`Email: ${mail.subject || '(no subject)'}`}, ${text}, 'Ticket + mail copy')`;
    });
    notifyLive(env, exec, changed);
  } finally {
    exec.waitUntil(sql.end({ timeout: 2 }).catch(() => {}));
  }
  if (env.EMAIL_ARCHIVE_TO) await message.forward(env.EMAIL_ARCHIVE_TO);
}
