import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { DbClient } from '../src/driver.js';
import { createMigratedDb, asActor } from './helpers.js';

/**
 * REQ-096 (0099_req096_generic_webhook_replay_guard.sql): generaliza el
 * anti-replay de webhooks (ML-05, hasta ahora solo para correo --
 * `app.mail_webhook_claim`, ver req181-mail.test.ts) a
 * `app.webhook_claim(provider, event_id, tolerance_seconds)`, reutilizable
 * por cualquier webhook entrante NUEVO -- consumida por
 * `apps/api/src/lib/webhooks/pg-webhook-replay-guard.ts`.
 */
describe('REQ-096: app.webhook_claim (anti-replay genérico por provider + event_id)', () => {
  let db: DbClient;

  beforeAll(async () => {
    db = await createMigratedDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('la primera llamada gana (true), la segunda con el mismo (provider, event_id) es un replay (false)', async () => {
    const provider = 'resend';
    const eventId = `msg_${randomUUID()}`;
    const first = await asActor(db, {}, (tx) => tx.query('select app.webhook_claim($1, $2, 300) as claimed', [provider, eventId]));
    expect(first.rows[0].claimed).toBe(true);
    const second = await asActor(db, {}, (tx) => tx.query('select app.webhook_claim($1, $2, 300) as claimed', [provider, eventId]));
    expect(second.rows[0].claimed).toBe(false);
  });

  it('el MISMO event_id en providers distintos NO es un replay entre sí (namespacing)', async () => {
    const eventId = `evt_${randomUUID()}`;
    const a = await asActor(db, {}, (tx) => tx.query('select app.webhook_claim($1, $2, 300) as claimed', ['proveedor-a', eventId]));
    expect(a.rows[0].claimed).toBe(true);
    const b = await asActor(db, {}, (tx) => tx.query('select app.webhook_claim($1, $2, 300) as claimed', ['proveedor-b', eventId]));
    expect(b.rows[0].claimed).toBe(true);
  });

  it('un event_id ya expirado puede reclamarse de nuevo (no crece sin límite)', async () => {
    const provider = 'proveedor-ttl';
    const eventId = `evt_${randomUUID()}`;
    // Tolerancia de 0 segundos: la fila expira de inmediato.
    const first = await asActor(db, {}, (tx) => tx.query('select app.webhook_claim($1, $2, 0) as claimed', [provider, eventId]));
    expect(first.rows[0].claimed).toBe(true);
    // now() ya avanzó respecto al INSERT anterior -> expires_at (= now() en el momento del insert) queda en el pasado.
    const second = await asActor(db, {}, (tx) => tx.query('select app.webhook_claim($1, $2, 300) as claimed', [provider, eventId]));
    expect(second.rows[0].claimed).toBe(true);
  });

  it('10 reclamos concurrentes del mismo (provider, event_id): exactamente 1 gana', async () => {
    const provider = 'proveedor-concurrencia';
    const eventId = `evt_${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () => asActor(db, {}, (tx) => tx.query('select app.webhook_claim($1, $2, 300) as claimed', [provider, eventId])))
    );
    const won = results.filter((r) => r.rows[0]?.claimed === true);
    expect(won).toHaveLength(1);
  });
});
