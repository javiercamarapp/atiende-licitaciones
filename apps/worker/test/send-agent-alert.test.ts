import { describe, it, expect, vi, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import type { MailProvider, OutboundEmail, SendResult } from '@atiende/mail';
import { createSendAgentAlertHandler } from '../src/handlers/send-agent-alert.js';
import { buildMailServiceForWorker } from '../src/mail/build-mail-service.js';
import { createMigratedDb, silentLogger, seedOrgAndUser, seedMember } from './helpers.js';
import type { Job, JobHandlerContext } from '../src/queue/types.js';
import type { SendAgentAlertPayload } from '../src/handlers/send-agent-alert.js';

/**
 * REQ-181 (plantilla `deadline-reminder`): antes de esta ronda `programar_alerta`
 * encolaba `send_agent_alert`, pero el handler solo dejaba un `logger.warn` --
 * nunca llamaba a `MailService` (`docs/investigacion/paridad-producto.md
 * §6.2`, hallazgo de la auditoría de plantillas huérfanas). Este archivo
 * cubre AMBAS mitades del contrato ahora: el log sigue existiendo tal cual
 * (nadie que dependiera de él se rompe), y `kind === 'vencimiento'` ADEMÁS
 * manda el correo real -- contra PGlite real, mismo patrón que
 * `mail-retry-handler.test.ts`.
 */

class CountingProvider implements MailProvider {
  readonly name = 'test-provider';
  calls: OutboundEmail[] = [];
  async send(message: OutboundEmail): Promise<SendResult> {
    this.calls.push(message);
    return { ok: true, providerMessageId: `msg-${this.calls.length}` };
  }
}

function makeJob(payload: SendAgentAlertPayload): Job<SendAgentAlertPayload> {
  return {
    id: `job-alert-${Math.random().toString(36).slice(2)}`,
    orgId: payload.organizationId,
    kind: 'send_agent_alert',
    payload,
    status: 'running',
    attempts: 1,
    maxAttempts: 5,
    nextRunAt: new Date(),
    lockedAt: new Date(),
    lockedBy: 'worker-test',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeCtx(logger = silentLogger()): JobHandlerContext {
  return { job: undefined as unknown as Job, logger, signal: new AbortController().signal };
}

describe('send_agent_alert handler (REQ-181): log siempre + correo real para vencimiento', () => {
  let db: DbClient | undefined;

  afterEach(async () => {
    if (db) await db.close();
    db = undefined;
  });

  it('kind="cambio_bases"/"otro": solo registra el warning de alerta, sin tocar MailService (sin plantilla asociada)', async () => {
    db = await createMigratedDb();
    const provider = new CountingProvider();
    const { mail } = buildMailServiceForWorker({ db, provider });
    const handler = createSendAgentAlertHandler({ db, mailService: mail });
    const logger = silentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');

    const job = makeJob({ organizationId: 'org-1', tenderId: 'tender-1', kind: 'cambio_bases', message: 'Las bases cambiaron' });
    await handler(job, makeCtx(logger));

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [meta, msg] = warnSpy.mock.calls[0];
    expect(meta).toMatchObject({ organization_id: 'org-1', tender_id: 'tender-1', alert_kind: 'cambio_bases' });
    expect(msg).toContain('Las bases cambiaron');
    expect(provider.calls).toHaveLength(0);
  });

  it('kind="vencimiento" con convocatoria inexistente: registra la alerta y NO intenta mandar correo', async () => {
    db = await createMigratedDb();
    const provider = new CountingProvider();
    const { mail } = buildMailServiceForWorker({ db, provider });
    const handler = createSendAgentAlertHandler({ db, mailService: mail });
    const logger = silentLogger();
    const warnSpy = vi.spyOn(logger, 'warn');

    const { orgId } = await seedOrgAndUser(db, 'alert-no-tender');
    const job = makeJob({ organizationId: orgId, tenderId: '00000000-0000-0000-0000-000000000000', kind: 'vencimiento', message: 'Vence pronto' });
    await handler(job, makeCtx(logger));

    expect(warnSpy.mock.calls[0][0]).toMatchObject({ organization_id: orgId, alert_kind: 'vencimiento' });
    expect(provider.calls).toHaveLength(0);
  });

  it('kind="vencimiento": manda `deadline-reminder` a cada miembro activo de la organización con las horas restantes correctas', async () => {
    db = await createMigratedDb();
    const provider = new CountingProvider();
    const { mail } = buildMailServiceForWorker({ db, provider });
    const handler = createSendAgentAlertHandler({ db, mailService: mail, publicUrl: 'https://app.atiende.mx' });

    const { orgId } = await seedOrgAndUser(db, 'alert-vencimiento');
    await seedMember(db, orgId, 'segundo-miembro@example.test', 'viewer');

    const now = Date.now();
    const deadline = new Date(now + 47.6 * 60 * 60 * 1000); // ~48h -> redondea a 48
    const tenderRes = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title, submission_deadline, status)
       values ($1, 'dof', 'vence-1', 'Suministro de equipo de cómputo', $2, 'in_review') returning id`,
      [orgId, deadline.toISOString()],
    );
    const tenderId = tenderRes.rows[0].id;

    const job = makeJob({ organizationId: orgId, tenderId, kind: 'vencimiento', message: 'La convocatoria vence pronto' });
    await handler(job, makeCtx());

    expect(provider.calls).toHaveLength(2); // dueño (seedOrgAndUser) + segundo miembro
    const subjects = provider.calls.map((c) => c.subject).sort();
    expect(subjects[0]).toContain('Vence en 48 horas');
    expect(subjects[0]).toContain('Suministro de equipo de cómputo');
    const recipients = provider.calls.flatMap((c) => c.to).sort();
    expect(recipients).toEqual(['alert-vencimiento@example.test', 'segundo-miembro@example.test'].sort());
  });

  it('kind="vencimiento": respeta `notification_preferences.deadlines = false` (no manda a quien lo apagó, sí al resto)', async () => {
    db = await createMigratedDb();
    const provider = new CountingProvider();
    const { mail } = buildMailServiceForWorker({ db, provider });
    const handler = createSendAgentAlertHandler({ db, mailService: mail });

    const { orgId, userId: ownerId } = await seedOrgAndUser(db, 'alert-preferencias');
    await db.query('insert into notification_preferences (user_id, deadlines) values ($1, false)', [ownerId]);

    const deadline = new Date(Date.now() + 10 * 60 * 60 * 1000);
    const tenderRes = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title, submission_deadline, status)
       values ($1, 'dof', 'vence-2', 'Otra convocatoria', $2, 'in_review') returning id`,
      [orgId, deadline.toISOString()],
    );
    const tenderId = tenderRes.rows[0].id;

    const job = makeJob({ organizationId: orgId, tenderId, kind: 'vencimiento', message: 'Vence pronto' });
    await handler(job, makeCtx());

    expect(provider.calls).toHaveLength(0); // único miembro es el dueño, que lo apagó
  });

  it('kind="vencimiento" con plazo ya vencido: no manda un correo con horas negativas/inventadas', async () => {
    db = await createMigratedDb();
    const provider = new CountingProvider();
    const { mail } = buildMailServiceForWorker({ db, provider });
    const handler = createSendAgentAlertHandler({ db, mailService: mail });

    const { orgId } = await seedOrgAndUser(db, 'alert-vencido');
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const tenderRes = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title, submission_deadline, status)
       values ($1, 'dof', 'ya-vencio', 'Convocatoria vencida', $2, 'in_review') returning id`,
      [orgId, past.toISOString()],
    );
    const tenderId = tenderRes.rows[0].id;

    const job = makeJob({ organizationId: orgId, tenderId, kind: 'vencimiento', message: 'Vence pronto' });
    await handler(job, makeCtx());

    expect(provider.calls).toHaveLength(0);
  });
});
