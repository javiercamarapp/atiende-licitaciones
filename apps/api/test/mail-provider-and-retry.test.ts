import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import type { MailProvider, OutboundEmail, SendResult } from '@atiende/mail';
import { createTestApp } from './helpers.js';
import { sendTransactionalMail } from '../src/lib/mail/send-transactional.js';
import { registeredUserRecipient } from '../src/lib/mail/recipients.js';

/**
 * S7 (REQ-188) y S12 (REQ-190) de `docs/ACEPTACION.md`:
 *
 *  - **S12**: sin proveedor configurado, NINGÚN envío alcanza la red real.
 *  - **S7**: un envío fallido agota los reintentos de `MailService`, queda
 *    registrado en `mail_outbox` con su historial de intentos, y deja un job
 *    `mail_retry` en `jobs` para que `apps/worker` lo retome más tarde.
 */
describe('S7/S12: proveedor no configurado, reintentos e historial de envíos', () => {
  let app: FastifyInstance | undefined;
  let db: DbClient | undefined;

  afterEach(async () => {
    if (app) await app.close();
    if (db) await db.close();
    app = undefined;
    db = undefined;
  });

  const VARIABLES = (publicUrl: string, supportEmail: string) => ({
    recipientName: 'Persona de prueba',
    appUrl: publicUrl,
    supportEmail,
    verificationUrl: `${publicUrl}/verificar-correo?d=x&s=y`,
    expiresInMinutes: 30,
  });

  async function crearUsuario(dbClient: DbClient, email: string): Promise<string> {
    const id = randomUUID();
    await dbClient.query('insert into users (id, email, password_hash, email_verified_at) values ($1, $2, $3, now())', [
      id,
      email,
      'scrypt:00:00',
    ]);
    return id;
  }

  it('S12: sin MAIL_PROVIDER el proveedor activo es la BANDEJA DE CAPTURA -- 0 llamadas de red', async () => {
    // Se sabotea `fetch` global: cualquier intento de salir a la red durante
    // esta prueba FALLA de forma visible en vez de pasar desapercibido.
    const fetchOriginal = globalThis.fetch;
    let llamadasDeRed = 0;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      llamadasDeRed += 1;
      throw new Error(`Llamada de red inesperada durante una prueba de correo: ${String(args[0])}`);
    }) as typeof fetch;

    try {
      ({ app, db } = await createTestApp());
      expect(app.mailProvider.name).toBe('capture');

      const userId = await crearUsuario(db, 'sin-proveedor@example.com');
      const salida = await sendTransactionalMail(app, {
        to: registeredUserRecipient({ id: userId, email: 'sin-proveedor@example.com' }),
        templateId: 'email-verification',
        messageKey: `email-verification:${randomUUID()}`,
        variables: VARIABLES(app.config.publicUrl, app.config.supportEmail),
      });

      expect(salida.status).toBe('sent');
      expect(llamadasDeRed).toBe(0);
    } finally {
      globalThis.fetch = fetchOriginal;
    }
  });

  it('S12: con MAIL_PROVIDER=resend pero SIN credenciales -> `not_configured`, 0 red y el outbox queda en `pending`', async () => {
    const fetchOriginal = globalThis.fetch;
    const providerOriginal = process.env.MAIL_PROVIDER;
    const apiKeyOriginal = process.env.RESEND_API_KEY;
    let llamadasDeRed = 0;
    globalThis.fetch = (async () => {
      llamadasDeRed += 1;
      throw new Error('Llamada de red inesperada: el adaptador de Resend no debe salir sin credenciales');
    }) as typeof fetch;
    process.env.MAIL_PROVIDER = 'resend';
    delete process.env.RESEND_API_KEY;

    try {
      ({ app, db } = await createTestApp());
      expect(app.mailProvider.name).toBe('resend');

      const userId = await crearUsuario(db, 'sin-credenciales@example.com');
      const messageKey = `email-verification:${randomUUID()}`;
      const salida = await sendTransactionalMail(app, {
        to: registeredUserRecipient({ id: userId, email: 'sin-credenciales@example.com' }),
        templateId: 'email-verification',
        messageKey,
        variables: VARIABLES(app.config.publicUrl, app.config.supportEmail),
      });

      // El adaptador declara "no configurado" ANTES de tocar `fetch`:
      // ausencia de configuración es un estado declarado, nunca un fallo
      // silencioso ni una llamada a Internet a ciegas.
      expect(salida.status).toBe('not_configured');
      expect(llamadasDeRed).toBe(0);

      // La reserva queda visible como `pending` (0080): el envío no se
      // perdió, está esperando a que alguien configure el proveedor.
      const { rows } = await db.query<{ status: string; template_id: string }>(
        'select status, template_id from mail_outbox where dedupe_key = $1',
        [messageKey]
      );
      expect(rows).toEqual([{ status: 'pending', template_id: 'email-verification' }]);
    } finally {
      globalThis.fetch = fetchOriginal;
      if (providerOriginal === undefined) delete process.env.MAIL_PROVIDER;
      else process.env.MAIL_PROVIDER = providerOriginal;
      if (apiKeyOriginal !== undefined) process.env.RESEND_API_KEY = apiKeyOriginal;
    }
  });

  it('S7: un fallo transitorio agota los reintentos, deja el historial en `mail_outbox` y encola un job `mail_retry`', async () => {
    let intentos = 0;
    const proveedorQueSiempreFalla: MailProvider = {
      name: 'siempre-falla',
      async send(_message: OutboundEmail): Promise<SendResult> {
        intentos += 1;
        // `retryable` es la clasificación de un 429/5xx/timeout de red (ver
        // `classifyHttpStatus` de packages/mail): MailService SÍ debe
        // reintentarlo, a diferencia de un 4xx permanente.
        return { ok: false, kind: 'retryable', detail: '503 Service Unavailable (simulado)' };
      },
    };

    ({ app, db } = await createTestApp({}, { mailProvider: proveedorQueSiempreFalla }));

    const userId = await crearUsuario(db, 'reintentos@example.com');
    const messageKey = `email-verification:${randomUUID()}`;
    const salida = await sendTransactionalMail(app, {
      to: registeredUserRecipient({ id: userId, email: 'reintentos@example.com' }),
      templateId: 'email-verification',
      messageKey,
      variables: VARIABLES(app.config.publicUrl, app.config.supportEmail),
    });

    expect(salida.status).toBe('dead');
    // Reintentó de verdad (backoff exponencial dentro de la misma llamada),
    // no se rindió al primer fallo.
    expect(intentos).toBeGreaterThan(1);

    // Historial en el outbox: estado final + cuántos intentos se hicieron +
    // el último error, para poder diagnosticar sin adivinar.
    const outbox = await db.query<{ status: string; attempts: number; max_attempts: number; last_error: string | null }>(
      'select status, attempts, max_attempts, last_error from mail_outbox where dedupe_key = $1',
      [messageKey]
    );
    expect(outbox.rows.length).toBe(1);
    expect(outbox.rows[0].status).toBe('dead');
    expect(outbox.rows[0].attempts).toBe(intentos);
    expect(outbox.rows[0].last_error).toContain('503');

    // Y el reintento DIFERIDO queda encolado para apps/worker, con la MISMA
    // messageKey (MailService es idempotente por ella: si mientras tanto el
    // envío se completara, el job no duplicaría el correo).
    const jobs = await db.query<{ kind: string; status: string; payload: { messageKey: string; templateId: string } }>(
      "select kind, status, payload from jobs where kind = 'mail_retry'"
    );
    expect(jobs.rows.length).toBe(1);
    expect(jobs.rows[0].status).toBe('queued');
    expect(jobs.rows[0].payload.messageKey).toBe(messageKey);
    expect(jobs.rows[0].payload.templateId).toBe('email-verification');
  });

  it('S7: un fallo PERMANENTE (4xx) no reintenta ni encola job -- reintentarlo nunca cambiaría el resultado', async () => {
    let intentos = 0;
    const proveedorRechaza: MailProvider = {
      name: 'rechaza-permanente',
      async send(): Promise<SendResult> {
        intentos += 1;
        return { ok: false, kind: 'permanent', detail: '422 remitente no verificado (simulado)' };
      },
    };

    ({ app, db } = await createTestApp({}, { mailProvider: proveedorRechaza }));

    const userId = await crearUsuario(db, 'permanente@example.com');
    const messageKey = `email-verification:${randomUUID()}`;
    const salida = await sendTransactionalMail(app, {
      to: registeredUserRecipient({ id: userId, email: 'permanente@example.com' }),
      templateId: 'email-verification',
      messageKey,
      variables: VARIABLES(app.config.publicUrl, app.config.supportEmail),
    });

    expect(salida.status).toBe('failed_permanent');
    expect(intentos).toBe(1);

    const outbox = await db.query<{ status: string; attempts: number }>(
      'select status, attempts from mail_outbox where dedupe_key = $1',
      [messageKey]
    );
    expect(outbox.rows[0]).toMatchObject({ status: 'failed_permanent', attempts: 1 });

    const jobs = await db.query("select id from jobs where kind = 'mail_retry'");
    expect(jobs.rows.length).toBe(0);
  });

  it('REQ-189: nunca se manda a un destinatario que el llamador no declaró registrado', async () => {
    ({ app, db } = await createTestApp());

    const salida = await sendTransactionalMail(app, {
      // Cuenta marcada como suspendida: `assertRegisteredRecipient` la
      // rechaza antes de renderizar nada -- `MailService` no acepta jamás un
      // correo suelto como destinatario.
      to: { email: 'suspendida@example.com', userId: randomUUID(), status: 'suspended' },
      templateId: 'email-verification',
      messageKey: `email-verification:${randomUUID()}`,
      variables: VARIABLES(app.config.publicUrl, app.config.supportEmail),
    });

    expect(salida.status).toBe('unregistered_recipient');
    const { rows } = await db.query('select dedupe_key from mail_outbox');
    expect(rows.length).toBe(0);
  });
});
