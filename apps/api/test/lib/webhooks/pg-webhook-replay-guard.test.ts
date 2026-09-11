import { randomUUID } from 'node:crypto';
import { describe, expect, it, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { DbClient } from '@atiende/db';
import { createTestApp } from '../../helpers.js';
import { PgWebhookReplayGuard } from '../../../src/lib/webhooks/pg-webhook-replay-guard.js';

/**
 * REQ-096: `PgWebhookReplayGuard` genérico contra `webhook_events_seen`
 * (0099) -- la implementación real que un webhook entrante NUEVO
 * instanciaría (a diferencia de `apps/api/src/lib/mail/pg-webhook-replay-guard.ts`,
 * que sigue siendo la implementación real y ya en producción de
 * `POST /webhooks/mail/:provider`, probada en `apps/api/test/mail-webhook.test.ts`
 * y `packages/db/test/req181-mail.test.ts`). Contra Postgres real (PGlite,
 * mismo criterio que el resto del repo -- ver `scripts/ci-local.sh`), no un
 * mock.
 */
describe('PgWebhookReplayGuard (REQ-096, genérico)', () => {
  let app: FastifyInstance;
  let db: DbClient;

  afterEach(async () => {
    await app.close();
    await db.close();
  });

  it('claim() gana la primera vez y rechaza un replay del mismo eventId', async () => {
    ({ app, db } = await createTestApp());
    const guard = new PgWebhookReplayGuard(db, 'proveedor-de-prueba');
    const eventId = `evt_${randomUUID()}`;
    expect(await guard.claim(eventId, 300)).toBe(true);
    expect(await guard.claim(eventId, 300)).toBe(false);
  });

  it('el MISMO eventId en proveedores distintos NO cuenta como replay (namespacing por provider)', async () => {
    ({ app, db } = await createTestApp());
    const eventId = `evt_${randomUUID()}`;
    const guardA = new PgWebhookReplayGuard(db, 'proveedor-a');
    const guardB = new PgWebhookReplayGuard(db, 'proveedor-b');
    expect(await guardA.claim(eventId, 300)).toBe(true);
    expect(await guardB.claim(eventId, 300)).toBe(true);
    // Pero SÍ es un replay dentro del mismo proveedor.
    expect(await guardA.claim(eventId, 300)).toBe(false);
  });

  it('10 reclamos concurrentes del mismo eventId: exactamente 1 gana (compare-and-set atómico real)', async () => {
    ({ app, db } = await createTestApp());
    const guard = new PgWebhookReplayGuard(db, 'proveedor-de-prueba');
    const eventId = `evt_${randomUUID()}`;
    const results = await Promise.all(Array.from({ length: 10 }, () => guard.claim(eventId, 300)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
