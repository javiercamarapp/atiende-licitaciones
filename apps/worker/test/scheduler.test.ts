import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { JobQueue } from '../src/queue/job-queue.js';
import { Scheduler } from '../src/scheduler/scheduler.js';
import type { SourceScheduleConfig } from '../src/scheduler/schedule-config.js';
import { createMigratedDb } from './helpers.js';

describe('Scheduler: unicidad por (tipo, fuente, ventana) — REQ-146/REQ-150', () => {
  let db: DbClient;
  let queue: JobQueue;
  let currentTime: Date;

  const schedules: SourceScheduleConfig[] = [
    { sourceId: 'dof', intervalMs: 60_000 },
    { sourceId: 'compras-mx', intervalMs: 60_000 },
  ];

  beforeEach(async () => {
    db = await createMigratedDb();
    currentTime = new Date('2026-09-05T10:00:00.000Z');
    queue = new JobQueue({ db, now: () => currentTime });
  });

  afterEach(async () => {
    await db.close();
  });

  it('varios tick() dentro de la misma ventana encolan un solo job por fuente', async () => {
    const scheduler = new Scheduler({ queue, schedules, now: () => currentTime });

    const first = await scheduler.tick();
    expect(first.enqueued).toBe(2); // dof + compras-mx
    expect(first.deduped).toBe(0);

    // Reintenta varias veces dentro de la misma ventana (simula reinicios/polling frecuente).
    const second = await scheduler.tick();
    expect(second.enqueued).toBe(0);
    expect(second.deduped).toBe(2);

    const third = await scheduler.tick();
    expect(third.deduped).toBe(2);

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from jobs where kind = 'discover_tenders'`,
    );
    expect(rows[0].n).toBe(2);
  });

  it('avanzar a la siguiente ventana sí encola un nuevo job, sin duplicar el anterior', async () => {
    const scheduler = new Scheduler({ queue, schedules, now: () => currentTime });
    await scheduler.tick();

    currentTime = new Date(currentTime.getTime() + 61_000); // siguiente ventana de 60s
    const result = await scheduler.tick();
    expect(result.enqueued).toBe(2);
    expect(result.deduped).toBe(0);

    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from jobs where kind = 'discover_tenders'`,
    );
    expect(rows[0].n).toBe(4); // 2 fuentes x 2 ventanas
  });

  it('una fuente deshabilitada (enabled: false) nunca se encola', async () => {
    const disabled: SourceScheduleConfig[] = [{ sourceId: 'dof', intervalMs: 60_000, enabled: false }];
    const scheduler = new Scheduler({ queue, schedules: disabled, now: () => currentTime });
    const result = await scheduler.tick();
    expect(result.enqueued).toBe(0);
    expect(result.deduped).toBe(0);

    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from jobs`);
    expect(rows[0].n).toBe(0);
  });

  it('el job encolado ya trae sourceId en el payload para que discover_tenders sepa qué conector correr', async () => {
    const scheduler = new Scheduler({ queue, schedules: [{ sourceId: 'dof', intervalMs: 60_000 }], now: () => currentTime });
    await scheduler.tick();
    const { rows } = await db.query<{ payload: { sourceId: string } }>(`select payload from jobs limit 1`);
    expect(rows[0].payload.sourceId).toBe('dof');
  });
});
