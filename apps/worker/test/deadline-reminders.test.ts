import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { enqueueUpcomingDeadlineReminders } from '../src/scheduler/deadline-reminders.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { createMigratedDb, seedOrgAndUser, silentLogger } from './helpers.js';

describe('enqueueUpcomingDeadlineReminders (Ronda 6, tarea 4: run_agent por evento de vencimiento)', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
    queue = new JobQueue({ db });
  });

  afterEach(async () => {
    await db.close();
  });

  it('encola recordatorios SOLO para convocatorias con vencimiento dentro de la ventana, de CUALQUIER organización', async () => {
    const { orgId: orgA } = await seedOrgAndUser(db, 'deadline-org-a');
    const { orgId: orgB } = await seedOrgAndUser(db, 'deadline-org-b');
    const now = new Date('2026-01-01T00:00:00Z');
    const soon = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    const far = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const past = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    await db.query(
      `insert into tenders (org_id, source, external_id, title, submission_deadline, status) values ($1, 'dof', 'near-a', 'Vence pronto A', $2, 'in_review')`,
      [orgA, soon.toISOString()],
    );
    await db.query(
      `insert into tenders (org_id, source, external_id, title, submission_deadline, status) values ($1, 'dof', 'near-b', 'Vence pronto B', $2, 'in_review')`,
      [orgB, soon.toISOString()],
    );
    await db.query(
      `insert into tenders (org_id, source, external_id, title, submission_deadline, status) values ($1, 'dof', 'far-a', 'Vence lejos', $2, 'in_review')`,
      [orgA, far.toISOString()],
    );
    await db.query(
      `insert into tenders (org_id, source, external_id, title, submission_deadline, status) values ($1, 'dof', 'past-a', 'Ya venció', $2, 'in_review')`,
      [orgA, past.toISOString()],
    );
    await db.query(
      `insert into tenders (org_id, source, external_id, title, submission_deadline, status) values ($1, 'dof', 'won-a', 'Ya ganada', $2, 'won')`,
      [orgA, soon.toISOString()],
    );

    const result = await enqueueUpcomingDeadlineReminders(db, queue, silentLogger(), { windowDays: 3, now: () => now });
    expect(result.scanned).toBe(2); // near-a, near-b (far/past/won quedan fuera)
    expect(result.enqueued).toBe(2);

    const { rows } = await db.query<{ org_id: string; payload: { agentName: string } }>(
      `select org_id, payload from jobs where kind = 'run_agent' order by org_id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.payload.agentName === 'recordatorios')).toBe(true);
    expect(rows.map((r) => r.org_id).sort()).toEqual([orgA, orgB].sort());
  });

  it('deduplicado por (tenderId, fecha calendario del vencimiento): llamarlo dos veces el mismo día no duplica', async () => {
    const { orgId } = await seedOrgAndUser(db, 'deadline-dedupe');
    const now = new Date('2026-01-01T00:00:00Z');
    const soon = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);
    await db.query(
      `insert into tenders (org_id, source, external_id, title, submission_deadline, status) values ($1, 'dof', 'dedupe-1', 'Vence pronto', $2, 'in_review')`,
      [orgId, soon.toISOString()],
    );

    await enqueueUpcomingDeadlineReminders(db, queue, silentLogger(), { windowDays: 3, now: () => now });
    const secondNow = new Date(now.getTime() + 60_000); // mismo día, un minuto después
    const second = await enqueueUpcomingDeadlineReminders(db, queue, silentLogger(), { windowDays: 3, now: () => secondNow });
    expect(second.enqueued).toBe(0); // deduplicado, no un segundo job activo

    const { rows } = await db.query(`select 1 from jobs where org_id = $1 and kind = 'run_agent'`, [orgId]);
    expect(rows).toHaveLength(1);
  });

  it('sin la política de 0098 (E6/PROPOSAL-06) sobre tenders, falla explícito (SchemaGrantPendingError) en vez de reportar "0 vencimientos" fabricado', async () => {
    // 0098_e6_agent_business_tools_grants.sql (packages/db/migrations) ya
    // incorporó PROPOSAL-06 como migración real: `createMigratedDb()`
    // SIEMPRE la incluye ahora, así que ya no existe una base "migrada
    // pero sin PROPOSAL-06" de verdad. Se simula revocando a mano el
    // grant/política exactos que 0098 añade sobre `tenders` -- conserva la
    // cobertura real de `SchemaGrantPendingError` (WK-10: fail cerrado,
    // nunca "0 filas" fabricado) como red de seguridad para el día en que
    // ese grant falte por cualquier otra razón (drift de esquema, un
    // entorno mal migrado), sin depender ya de `applyProposal06`.
    const dbSinPropuesta = await createMigratedDb();
    await dbSinPropuesta.exec(`
      drop policy if exists sel_tenders_worker_role on tenders;
      revoke select on tenders from worker_role;
    `);
    try {
      const { SchemaGrantPendingError } = await import('../src/agents/db-context.js');
      await expect(enqueueUpcomingDeadlineReminders(dbSinPropuesta, new JobQueue({ db: dbSinPropuesta }), silentLogger())).rejects.toBeInstanceOf(
        SchemaGrantPendingError,
      );
    } finally {
      await dbSinPropuesta.close();
    }
  });
});
