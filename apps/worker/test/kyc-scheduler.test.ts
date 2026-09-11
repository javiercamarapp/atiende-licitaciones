import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { JobQueue } from '../src/queue/job-queue.js';
import { KycScheduler } from '../src/scheduler/kyc-scheduler.js';
import { createMigratedDb } from './helpers.js';

describe('KycScheduler: un solo job de plataforma por ventana (REQ-112, mismo criterio que Scheduler/REQ-146)', () => {
  let db: DbClient;
  let queue: JobQueue;
  let currentTime: Date;

  beforeEach(async () => {
    db = await createMigratedDb();
    currentTime = new Date('2026-09-05T02:00:00.000Z');
    queue = new JobQueue({ db, now: () => currentTime });
  });

  afterEach(async () => {
    await db.close();
  });

  it('varios tick() dentro de la misma ventana de 24h encolan un solo job', async () => {
    const scheduler = new KycScheduler({ queue, intervalMs: 24 * 60 * 60_000, now: () => currentTime });

    const first = await scheduler.tick();
    expect(first.enqueued).toBe(true);

    const second = await scheduler.tick();
    expect(second.enqueued).toBe(false);

    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from jobs where kind = 'kyc_negative_screening'"
    );
    expect(rows[0].count).toBe('1');
  });

  it('una ventana distinta (24h después) encola un job nuevo, distinto del anterior', async () => {
    const scheduler = new KycScheduler({ queue, intervalMs: 24 * 60 * 60_000, now: () => currentTime });
    await scheduler.tick();

    currentTime = new Date(currentTime.getTime() + 25 * 60 * 60_000);
    const result = await scheduler.tick();
    expect(result.enqueued).toBe(true);

    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from jobs where kind = 'kyc_negative_screening'"
    );
    expect(rows[0].count).toBe('2');
  });

  it('el job encolado es de PLATAFORMA (org_id null), no de una organización', async () => {
    const scheduler = new KycScheduler({ queue, intervalMs: 24 * 60 * 60_000, now: () => currentTime });
    await scheduler.tick();

    const { rows } = await db.query<{ org_id: string | null }>("select org_id from jobs where kind = 'kyc_negative_screening'");
    expect(rows[0].org_id).toBeNull();
  });

  it('enabled: false nunca encola nada', async () => {
    const scheduler = new KycScheduler({ queue, intervalMs: 24 * 60 * 60_000, now: () => currentTime, enabled: false });
    const result = await scheduler.tick();
    expect(result.enqueued).toBe(false);

    const { rows } = await db.query('select 1 from jobs where kind = $1', ['kyc_negative_screening']);
    expect(rows).toHaveLength(0);
  });
});
