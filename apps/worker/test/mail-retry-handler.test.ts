import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import type { MailProvider, OutboundEmail, SendResult } from '@atiende/mail';
import { createMailRetryHandler } from '../src/handlers/mail-retry.js';
import { buildMailServiceForWorker } from '../src/mail/build-mail-service.js';
import { createMigratedDb, silentLogger } from './helpers.js';
import type { Job, JobHandlerContext } from '../src/queue/types.js';

/**
 * REQ-188 / S7 (docs/ACEPTACION.md): "envío fallido reintenta vía job y
 * queda registrado con su historial de intentos". Este archivo prueba el
 * handler `mail_retry` (`src/handlers/mail-retry.ts`) contra Postgres real
 * (PGlite + migraciones reales, mismo patrón que el resto de `apps/worker`)
 * -- `MailService`/`mail_outbox`/`mail_suppressions` son las MISMAS piezas
 * reales que usa `apps/api`, nunca dobles en memoria.
 */

const VARIABLES = {
  recipientName: 'Persona de prueba',
  appUrl: 'https://app.atiende.mx',
  supportEmail: 'soporte@atiende.mx',
  verificationUrl: 'https://app.atiende.mx/verificar-correo?d=x&s=y',
  expiresInMinutes: 30,
};

function makeJob(payload: unknown, overrides: Partial<Job<unknown>> = {}): Job<unknown> {
  return {
    id: overrides.id ?? `job-mail-retry-${randomUUID()}`,
    orgId: overrides.orgId ?? null,
    kind: 'mail_retry',
    payload,
    status: 'running',
    attempts: overrides.attempts ?? 1,
    maxAttempts: overrides.maxAttempts ?? 5,
    nextRunAt: new Date(),
    lockedAt: new Date(),
    lockedBy: 'worker-test',
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeCtx(): JobHandlerContext {
  return { job: undefined as unknown as Job, logger: silentLogger(), signal: new AbortController().signal };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    templateId: 'email-verification',
    to: { email: 'destinatario@example.com', userId: randomUUID(), status: 'active' },
    variables: VARIABLES,
    messageKey: `email-verification:${randomUUID()}`,
    preferences: null,
    fromLocalPart: null,
    ...overrides,
  };
}

class CountingProvider implements MailProvider {
  readonly name = 'test-provider';
  calls: OutboundEmail[] = [];
  constructor(private readonly next: () => SendResult | Promise<SendResult>) {}
  async send(message: OutboundEmail): Promise<SendResult> {
    this.calls.push(message);
    return this.next();
  }
}

async function auditRows(db: DbClient, messageKey: string): Promise<{ action: string; after: Record<string, unknown> }[]> {
  const { rows } = await db.query<{ action: string; after: Record<string, unknown> }>(
    `select action, after from audit_log where entity = 'mail_retry' and entity_id = $1 order by created_at asc`,
    [messageKey],
  );
  return rows;
}

describe('mail_retry handler (REQ-188/S7): reintento diferido de un correo transaccional', () => {
  let db: DbClient | undefined;

  afterEach(async () => {
    if (db) await db.close();
    db = undefined;
  });

  it('éxito: el proveedor acepta el envío -> outcome "sent", auditado, el job se completa sin lanzar', async () => {
    db = await createMigratedDb();
    const provider = new CountingProvider(() => ({ ok: true, providerMessageId: 'msg-1' }));
    const { mail, outboxStore } = buildMailServiceForWorker({ db, provider });
    const handler = createMailRetryHandler({ db, mailService: mail, outboxStore });

    const payload = validPayload();
    await expect(handler(makeJob(payload), makeCtx())).resolves.toBeUndefined();

    expect(provider.calls.length).toBe(1);
    const audit = await auditRows(db, payload.messageKey);
    expect(audit.map((r) => r.action)).toEqual(['mail_retry.sent']);
    expect(audit[0].after.correlationId).toBe(payload.messageKey);
  });

  it('éxito tras fallo: un primer intento del job agota los reintentos internos de MailService ("dead"), un SEGUNDO intento con el proveedor recuperado sí envía', async () => {
    db = await createMigratedDb();

    // Primer "intento del job": el proveedor SIEMPRE falla de forma
    // retryable -- MailService agota su propio backoff interno
    // (DEFAULT_RETRY_POLICY) y mail_outbox queda 'dead' para esta messageKey.
    const failingProvider = new CountingProvider(() => ({ ok: false, kind: 'retryable', detail: '503 simulado' }));
    const built1 = buildMailServiceForWorker({ db, provider: failingProvider, sleep: async () => {} });
    const handler1 = createMailRetryHandler({ db, mailService: built1.mail, outboxStore: built1.outboxStore });

    const payload = validPayload();
    const firstJob = makeJob(payload, { attempts: 1, maxAttempts: 5 });
    await expect(handler1(firstJob, makeCtx())).rejects.toThrow(/agotó sus reintentos internos/);
    expect(failingProvider.calls.length).toBeGreaterThan(1);

    const { rows: afterFirst } = await db.query<{ status: string }>('select status from mail_outbox where dedupe_key = $1', [
      payload.messageKey,
    ]);
    expect(afterFirst[0].status).toBe('dead');
    // Intento intermedio (no el último permitido): todavía no se audita
    // como dead-letter final -- JobQueue.fail() lo reprograma con backoff.
    expect((await auditRows(db, payload.messageKey)).map((r) => r.action)).toEqual([]);

    // SEGUNDO "intento del job" (simulando que JobQueue.fail() reprogramó
    // el job y el worker lo reclamó de nuevo, job.attempts = 2): el
    // proveedor YA se recuperó -- gracias a
    // `app.mail_outbox_reopen_for_retry` (0087), reserve() puede reclamar
    // de nuevo la fila 'dead' y el envío SÍ llega al proveedor.
    const okProvider = new CountingProvider(() => ({ ok: true, providerMessageId: 'msg-recuperado' }));
    const built2 = buildMailServiceForWorker({ db, provider: okProvider });
    const handler2 = createMailRetryHandler({ db, mailService: built2.mail, outboxStore: built2.outboxStore });

    const secondJob = makeJob(payload, { id: firstJob.id, attempts: 2, maxAttempts: 5 });
    await expect(handler2(secondJob, makeCtx())).resolves.toBeUndefined();
    expect(okProvider.calls.length).toBe(1);

    const { rows: afterSecond } = await db.query<{ status: string }>('select status from mail_outbox where dedupe_key = $1', [
      payload.messageKey,
    ]);
    expect(afterSecond[0].status).toBe('sent');
    expect((await auditRows(db, payload.messageKey)).map((r) => r.action)).toEqual(['mail_retry.sent']);
  });

  it('tope alcanzado: en el ÚLTIMO intento permitido (job.attempts = job.maxAttempts) el proveedor sigue fallando -> se audita "mail_retry.dead" con el motivo antes de lanzar', async () => {
    db = await createMigratedDb();
    const failingProvider = new CountingProvider(() => ({ ok: false, kind: 'retryable', detail: '503 simulado (tope)' }));
    const { mail, outboxStore } = buildMailServiceForWorker({ db, provider: failingProvider, sleep: async () => {} });
    const handler = createMailRetryHandler({ db, mailService: mail, outboxStore });

    const payload = validPayload();
    const job = makeJob(payload, { attempts: 5, maxAttempts: 5 });

    await expect(handler(job, makeCtx())).rejects.toThrow(/agotó sus reintentos internos/);

    const audit = await auditRows(db, payload.messageKey);
    expect(audit.map((r) => r.action)).toEqual(['mail_retry.dead']);
    expect(audit[0].after.detail).toContain('503 simulado (tope)');
    expect(audit[0].after.attempts).toBe(5);
    expect(audit[0].after.maxAttempts).toBe(5);
  });

  it('mensaje ya enviado: no reenvía -- el proveedor NUNCA se llama, outcome "already_sent", auditado', async () => {
    db = await createMigratedDb();
    const payload = validPayload();

    // Pre-siembra: el envío YA se completó (p.ej. por apps/api, ANTES de
    // que este job se reclamara -- una carrera legítima entre el envío
    // original y su propio job de reintento).
    await db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query('select app.mail_outbox_reserve($1, $2, $3, null, null, null)', [payload.messageKey, 'email-verification', 5]);
      await tx.query('select app.mail_outbox_save($1, $2, $3, $4, $5, $6)', [
        payload.messageKey,
        'sent',
        'msg-original',
        1,
        5,
        null,
      ]);
    });

    const provider = new CountingProvider(() => ({ ok: true, providerMessageId: 'no-deberia-llamarse' }));
    const { mail, outboxStore } = buildMailServiceForWorker({ db, provider });
    const handler = createMailRetryHandler({ db, mailService: mail, outboxStore });

    await expect(handler(makeJob(payload), makeCtx())).resolves.toBeUndefined();

    expect(provider.calls.length).toBe(0);
    const audit = await auditRows(db, payload.messageKey);
    expect(audit.map((r) => r.action)).toEqual(['mail_retry.already_sent']);
    expect(audit[0].after.providerMessageId).toBe('msg-original');
  });

  it('supresión: el destinatario está suprimido -> no envía, el proveedor NUNCA se llama, auditado', async () => {
    db = await createMigratedDb();
    const payload = validPayload({ to: { email: 'suprimido@example.com', userId: randomUUID(), status: 'active' } });

    await db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query('select app.mail_suppression_add($1, $2, $3)', ['suprimido@example.com', 'bounce', 'webhook_resend']);
    });

    const provider = new CountingProvider(() => ({ ok: true, providerMessageId: 'no-deberia-llamarse' }));
    const { mail, outboxStore } = buildMailServiceForWorker({ db, provider });
    const handler = createMailRetryHandler({ db, mailService: mail, outboxStore });

    await expect(handler(makeJob(payload), makeCtx())).resolves.toBeUndefined();

    expect(provider.calls.length).toBe(0);
    const audit = await auditRows(db, payload.messageKey);
    expect(audit.map((r) => r.action)).toEqual(['mail_retry.suppressed']);

    const { rows: outbox } = await db.query('select status from mail_outbox where dedupe_key = $1', [payload.messageKey]);
    expect(outbox.length).toBe(0); // nunca se reservó: MailService corta ANTES del outbox.
  });

  it('payload malformado: rechazado sin crash (error permanente clasificado), auditado', async () => {
    db = await createMigratedDb();
    const provider = new CountingProvider(() => ({ ok: true, providerMessageId: 'no-deberia-llamarse' }));
    const { mail, outboxStore } = buildMailServiceForWorker({ db, provider });
    const handler = createMailRetryHandler({ db, mailService: mail, outboxStore });

    const malformedJob = makeJob({ templateId: 'email-verification', variables: VARIABLES }); // sin `to`/`messageKey`

    let thrown: unknown;
    try {
      await handler(malformedJob, makeCtx());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error & { permanent?: boolean }).permanent).toBe(true);
    expect((thrown as Error).message).toContain('payload malformado');
    expect(provider.calls.length).toBe(0);

    const audit = await auditRows(db, malformedJob.id);
    expect(audit.map((r) => r.action)).toEqual(['mail_retry.malformed_payload']);
  });

  it('dos workers concurrentes: reserve() CAS garantiza un SOLO envío real al proveedor para la MISMA messageKey', async () => {
    db = await createMigratedDb();
    const payload = validPayload();

    const provider = new CountingProvider(() => ({ ok: true, providerMessageId: 'msg-concurrente' }));
    const { mail, outboxStore } = buildMailServiceForWorker({ db, provider });
    const handlerA = createMailRetryHandler({ db, mailService: mail, outboxStore });
    const handlerB = createMailRetryHandler({ db, mailService: mail, outboxStore });

    const jobA = makeJob(payload, { id: 'job-mail-retry-a' });
    const jobB = makeJob(payload, { id: 'job-mail-retry-b' });

    const results = await Promise.allSettled([handlerA(jobA, makeCtx()), handlerB(jobB, makeCtx())]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    // El proveedor real (send() de verdad) se llamó UNA sola vez -- la
    // reserva atómica (ML-01, app.mail_outbox_reserve) impidió que la
    // segunda llamada concurrente lo tocara.
    expect(provider.calls.length).toBe(1);

    const { rows: outbox } = await db.query<{ status: string; attempts: number }>(
      'select status, attempts from mail_outbox where dedupe_key = $1',
      [payload.messageKey],
    );
    expect(outbox.length).toBe(1);
    expect(outbox[0].status).toBe('sent');

    const audit = await auditRows(db, payload.messageKey);
    // Ambos jobs completan sin lanzar (uno "sent", el otro "already_sent" o
    // "sent" según quién ganó la carrera de espera) -- nunca dos envíos.
    expect(audit.length).toBeGreaterThanOrEqual(1);
    expect(audit.every((r) => r.action === 'mail_retry.sent' || r.action === 'mail_retry.already_sent')).toBe(true);
  });

  it('sin red sin credenciales: sin MAIL_PROVIDER, el proveedor activo es CaptureProvider -- 0 llamadas de red', async () => {
    db = await createMigratedDb();
    const fetchOriginal = globalThis.fetch;
    let llamadasDeRed = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      llamadasDeRed += 1;
      throw new Error(`Llamada de red inesperada durante una prueba de mail_retry: ${String(args[0])}`);
    }) as typeof fetch;

    const providerOriginal = process.env.MAIL_PROVIDER;
    delete process.env.MAIL_PROVIDER;

    try {
      const { mail, outboxStore, provider } = buildMailServiceForWorker({ db, env: process.env });
      expect(provider.name).toBe('capture');
      const handler = createMailRetryHandler({ db, mailService: mail, outboxStore });

      const payload = validPayload();
      await expect(handler(makeJob(payload), makeCtx())).resolves.toBeUndefined();
      expect(llamadasDeRed).toBe(0);

      const audit = await auditRows(db, payload.messageKey);
      expect(audit.map((r) => r.action)).toEqual(['mail_retry.sent']);
    } finally {
      globalThis.fetch = fetchOriginal;
      if (providerOriginal === undefined) delete process.env.MAIL_PROVIDER;
      else process.env.MAIL_PROVIDER = providerOriginal;
    }
  });

  it('destinatario no registrado (p.ej. cuenta suspendida): fallo permanente -- dead-letra sin gastar reintentos, auditado', async () => {
    db = await createMigratedDb();
    const provider = new CountingProvider(() => ({ ok: true, providerMessageId: 'no-deberia-llamarse' }));
    const { mail, outboxStore } = buildMailServiceForWorker({ db, provider });
    const handler = createMailRetryHandler({ db, mailService: mail, outboxStore });

    const payload = validPayload({ to: { email: 'suspendida@example.com', userId: randomUUID(), status: 'suspended' } });

    let thrown: unknown;
    try {
      await handler(makeJob(payload), makeCtx());
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error & { permanent?: boolean }).permanent).toBe(true);
    expect(provider.calls.length).toBe(0);

    const audit = await auditRows(db, payload.messageKey);
    expect(audit.map((r) => r.action)).toEqual(['mail_retry.dead_permanent']);
  });
});
