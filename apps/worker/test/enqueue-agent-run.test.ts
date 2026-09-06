import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { enqueueAgentRun } from '../src/agents/enqueue-agent-run.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { createMigratedDb, seedOrgAndUser } from './helpers.js';
import { applyProposal06 } from './proposal-06-helper.js';
import { SYSTEM_ACTOR_ID, SYSTEM_ACTOR_ROLE } from '../src/agents/system-actor.js';

describe('enqueueAgentRun (Ronda 6, tarea 4)', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
    queue = new JobQueue({ db });
  });

  afterEach(async () => {
    await db.close();
  });

  it('con PROPOSAL-06 aplicada: abre su propia fila agent_runs (started_by null) y encola el job con agentRunId', async () => {
    await applyProposal06(db);
    const { orgId } = await seedOrgAndUser(db, 'enqueue-agent-run-ok');
    const result = await enqueueAgentRun(db, queue, {
      agentName: 'vigilante_cambios',
      organizationId: orgId,
      actorId: SYSTEM_ACTOR_ID,
      actorRole: SYSTEM_ACTOR_ROLE,
      context: { tenderId: '00000000-0000-0000-0000-000000000009' },
      eventKey: 'ingest:created:dof:ext-1',
    });
    expect(result.agentRunPersisted).toBe(true);
    expect(result.agentRunId).toBeDefined();

    const { rows } = await db.query<{ started_by: string | null }>(`select started_by from agent_runs where id = $1`, [result.agentRunId]);
    expect(rows[0].started_by).toBeNull();

    const jobRow = await db.query<{ payload: { agentRunId: string } }>(`select payload from jobs where id = $1`, [result.jobId]);
    expect(jobRow.rows[0].payload.agentRunId).toBe(result.agentRunId);
  });

  it('SIN PROPOSAL-06 aplicada: falla al abrir agent_runs (fail-open) pero el job IGUAL se encola, sin agentRunId', async () => {
    const { orgId } = await seedOrgAndUser(db, 'enqueue-agent-run-fail-open');
    const result = await enqueueAgentRun(db, queue, {
      agentName: 'vigilante_cambios',
      organizationId: orgId,
      actorId: SYSTEM_ACTOR_ID,
      actorRole: SYSTEM_ACTOR_ROLE,
      context: { tenderId: '00000000-0000-0000-0000-000000000009' },
      eventKey: 'ingest:created:dof:ext-2',
    });
    expect(result.agentRunPersisted).toBe(false);
    expect(result.agentRunId).toBeUndefined();

    const jobRow = await db.query<{ payload: { agentRunId?: string } }>(`select payload from jobs where id = $1`, [result.jobId]);
    expect(jobRow.rows[0].payload.agentRunId).toBeUndefined();
  });

  it('deduplicado por (agentName, eventKey): dos llamadas con el mismo evento no encolan dos jobs activos', async () => {
    await applyProposal06(db);
    const { orgId } = await seedOrgAndUser(db, 'enqueue-agent-run-dedupe');
    const params = {
      agentName: 'vigilante_cambios' as const,
      organizationId: orgId,
      actorId: SYSTEM_ACTOR_ID,
      actorRole: SYSTEM_ACTOR_ROLE,
      context: { tenderId: '00000000-0000-0000-0000-000000000009' },
      eventKey: 'ingest:created:dof:ext-3',
    };
    const first = await enqueueAgentRun(db, queue, params);
    const second = await enqueueAgentRun(db, queue, params);
    expect(second.deduped).toBe(true);
    expect(second.jobId).toBe(first.jobId);
  });
});
