import { describe, it, expect, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { WRITE_ROLES } from '@atiende/db';
import type { MailProvider, OutboundEmail, SendResult } from '@atiende/mail';
import { createSendExpedienteNotificationHandler } from '../src/handlers/send-expediente-notification.js';
import { buildMailServiceForWorker } from '../src/mail/build-mail-service.js';
import { createMigratedDb, silentLogger, seedOrgAndUser, seedMember } from './helpers.js';
import type { Job, JobHandlerContext } from '../src/queue/types.js';
import type { SendExpedienteNotificationPayload } from '../src/handlers/send-expediente-notification.js';

/**
 * REQ-070, nodo "Mensajero": el handler del job `send_expediente_notification`
 * (encolado por la herramienta `notificar_expediente_listo`, real, nunca un
 * envío directo a un tercero desde el `AgentRunner`) es el único punto que
 * de verdad manda el correo — mismo patrón verificado que
 * `send-agent-alert.test.ts`, contra PGlite real.
 */
class CountingProvider implements MailProvider {
  readonly name = 'test-provider';
  calls: OutboundEmail[] = [];
  async send(message: OutboundEmail): Promise<SendResult> {
    this.calls.push(message);
    return { ok: true, providerMessageId: `msg-${this.calls.length}` };
  }
}

function makeJob(payload: SendExpedienteNotificationPayload): Job<SendExpedienteNotificationPayload> {
  return {
    id: `job-expediente-${Math.random().toString(36).slice(2)}`,
    orgId: payload.organizationId,
    kind: 'send_expediente_notification',
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

function makeCtx() {
  return { job: undefined as unknown as Job, logger: silentLogger(), signal: new AbortController().signal } as JobHandlerContext;
}

// Mismo patrón que `mail-retry-handler.test.ts` (WK6-03): cada `it` crea su
// propia PGlite y aplica todas las migraciones reales dentro del cuerpo del
// test (no en `beforeEach`), así que compite contra `testTimeout` por
// defecto (5000ms) — bajo una corrida completa de la suite (muchos archivos
// PGlite en paralelo) eso es flaky, no un bug de este handler. Se sube a
// 20000ms para todo el archivo, igual que ese precedente.
describe('send_expediente_notification handler (REQ-070, nodo Mensajero)', { timeout: 20_000 }, () => {
  let db: DbClient | undefined;

  afterEach(async () => {
    if (db) await db.close();
    db = undefined;
  });

  it('manda `pending-approval` real a cada miembro ACTIVO con rol de escritura, nunca a un viewer ni a un miembro inactivo', async () => {
    db = await createMigratedDb();
    const provider = new CountingProvider();
    const { mail } = buildMailServiceForWorker({ db, provider });
    const handler = createSendExpedienteNotificationHandler({ db, mailService: mail, publicUrl: 'https://app.atiende.mx' });

    const { orgId } = await seedOrgAndUser(db, 'expediente-listo');
    expect(WRITE_ROLES).not.toContain('viewer');
    await seedMember(db, orgId, 'viewer-sin-correo@example.test', 'viewer');
    await seedMember(db, orgId, 'escritor-activo@example.test', WRITE_ROLES[0]);

    const tenderRes = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'expediente-1', 'Rehabilitación de plantel escolar') returning id`,
      [orgId],
    );
    const tenderId = tenderRes.rows[0].id;

    const job = makeJob({ organizationId: orgId, tenderId });
    await handler(job, makeCtx());

    const recipients = provider.calls.flatMap((c) => c.to).sort();
    // Dueño (seedOrgAndUser, rol owner) + el escritor explícito -- nunca el viewer.
    expect(recipients).toEqual(['escritor-activo@example.test', 'expediente-listo@example.test'].sort());
    expect(provider.calls.every((c) => c.subject.includes('aprobar') || c.subject.length > 0)).toBe(true);
  });

  it('convocatoria inexistente (borrada o de otra organización): no manda ningún correo, el job no falla', async () => {
    db = await createMigratedDb();
    const provider = new CountingProvider();
    const { mail } = buildMailServiceForWorker({ db, provider });
    const handler = createSendExpedienteNotificationHandler({ db, mailService: mail });

    const { orgId } = await seedOrgAndUser(db, 'expediente-sin-tender');
    const job = makeJob({ organizationId: orgId, tenderId: '00000000-0000-0000-0000-000000000000' });
    await expect(handler(job, makeCtx())).resolves.toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });

  it('organización sin ningún miembro activo con rol de escritura: no manda correo (nada real que notificar), el job no falla', async () => {
    db = await createMigratedDb();
    const provider = new CountingProvider();
    const { mail } = buildMailServiceForWorker({ db, provider });
    const handler = createSendExpedienteNotificationHandler({ db, mailService: mail });

    const { orgId, userId } = await seedOrgAndUser(db, 'expediente-solo-viewer');
    // Degrada al único miembro (el dueño sembrado) a viewer para dejar la org sin ningún rol de escritura activo.
    await db.query(`update memberships set role = 'viewer' where org_id = $1 and user_id = $2`, [orgId, userId]);

    const tenderRes = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'expediente-2', 'Convocatoria') returning id`,
      [orgId],
    );
    const job = makeJob({ organizationId: orgId, tenderId: tenderRes.rows[0].id });
    await expect(handler(job, makeCtx())).resolves.toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });

  it('nunca cruza organizaciones: un tenderId real de orgA no genera correo cuando el payload trae orgB', async () => {
    db = await createMigratedDb();
    const provider = new CountingProvider();
    const { mail } = buildMailServiceForWorker({ db, provider });
    const handler = createSendExpedienteNotificationHandler({ db, mailService: mail });

    const { orgId: orgA } = await seedOrgAndUser(db, 'expediente-cross-a');
    const { orgId: orgB } = await seedOrgAndUser(db, 'expediente-cross-b');
    const tenderRes = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'expediente-3', 'Convocatoria de orgA') returning id`,
      [orgA],
    );
    const job = makeJob({ organizationId: orgB, tenderId: tenderRes.rows[0].id });
    await handler(job, makeCtx());
    expect(provider.calls).toHaveLength(0);
  });

  it('best-effort: si mandar a un miembro falla, el resto SÍ recibe la notificación y el job no lanza', async () => {
    db = await createMigratedDb();
    class FlakyProvider implements MailProvider {
      readonly name = 'flaky-provider';
      calls: OutboundEmail[] = [];
      async send(message: OutboundEmail): Promise<SendResult> {
        this.calls.push(message);
        if (message.to.includes('escritor-que-falla@example.test')) throw new Error('SMTP caído (simulado)');
        return { ok: true, providerMessageId: `msg-${this.calls.length}` };
      }
    }
    const provider = new FlakyProvider();
    const { mail } = buildMailServiceForWorker({ db, provider });
    const handler = createSendExpedienteNotificationHandler({ db, mailService: mail });

    const { orgId } = await seedOrgAndUser(db, 'expediente-best-effort');
    await seedMember(db, orgId, 'escritor-que-falla@example.test', WRITE_ROLES[0]);
    const tenderRes = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title) values ($1, 'dof', 'expediente-4', 'Convocatoria') returning id`,
      [orgId],
    );
    const job = makeJob({ organizationId: orgId, tenderId: tenderRes.rows[0].id });
    await expect(handler(job, makeCtx())).resolves.toBeUndefined();
    // Ambos intentos ocurrieron (dueño + el que falla), ninguno impidió al otro.
    expect(provider.calls).toHaveLength(2);
  });
});
