import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { FakeProvider } from '@atiende/agents';
import { createRunAgentHandler } from '../src/handlers/run-agent.js';
import { AgentKillSwitchError } from '../src/agents/kill-switch.js';
import { JobQueue } from '../src/queue/job-queue.js';
import { createMigratedDb, seedOrgAndUser, silentLogger } from './helpers.js';
import type { Job, JobHandlerContext } from '../src/queue/types.js';
import type { RunAgentPayload } from '../src/handlers/run-agent.js';

function makeJob(payload: RunAgentPayload, orgId: string | null): Job<RunAgentPayload> {
  return {
    id: 'job-kill-switch-1',
    orgId,
    kind: 'run_agent',
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

function makeCtx(): JobHandlerContext {
  return { job: {} as Job, logger: silentLogger(), signal: new AbortController().signal };
}

describe('run_agent + kill-switch (Ronda 6, tarea 4)', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
    queue = new JobQueue({ db });
  });

  afterEach(async () => {
    await db.close();
  });

  it('un agente deshabilitado por WORKER_DISABLED_AGENTS nunca ejecuta ningún tool_call (ni encola la alerta)', async () => {
    const { orgId, userId } = await seedOrgAndUser(db, 'kill-switch-recordatorios');
    const handler = createRunAgentHandler({
      db,
      queue,
      buildProvider: () => new FakeProvider(),
      env: { WORKER_DISABLED_AGENTS: 'recordatorios' } as NodeJS.ProcessEnv,
    });
    const job = makeJob(
      {
        organizationId: orgId,
        actorId: userId,
        actorRole: 'licitador',
        agentName: 'recordatorios',
        context: {
          tenderId: '00000000-0000-0000-0000-000000000009',
          alert: { kind: 'vencimiento', scheduledFor: new Date().toISOString(), message: 'vence pronto' },
        },
      },
      orgId,
    );

    let caught: unknown;
    try {
      await handler(job, makeCtx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AgentKillSwitchError);
    expect((caught as { permanent?: boolean }).permanent).toBe(true);

    const { rows } = await db.query(`select 1 from jobs where org_id = $1 and kind = 'send_agent_alert'`, [orgId]);
    expect(rows).toHaveLength(0);
  });

  it('un agente NO listado en WORKER_DISABLED_AGENTS sigue ejecutando con normalidad', async () => {
    const { orgId, userId } = await seedOrgAndUser(db, 'kill-switch-not-affected');
    const handler = createRunAgentHandler({
      db,
      queue,
      buildProvider: () => new FakeProvider(),
      env: { WORKER_DISABLED_AGENTS: 'analista_bases' } as NodeJS.ProcessEnv,
    });
    const job = makeJob(
      {
        organizationId: orgId,
        actorId: userId,
        actorRole: 'licitador',
        agentName: 'recordatorios',
        context: {
          tenderId: '00000000-0000-0000-0000-000000000009',
          alert: { kind: 'vencimiento', scheduledFor: new Date().toISOString(), message: 'vence pronto' },
        },
      },
      orgId,
    );
    await expect(handler(job, makeCtx())).resolves.toBeUndefined();
    const { rows } = await db.query(`select 1 from jobs where org_id = $1 and kind = 'send_agent_alert'`, [orgId]);
    expect(rows).toHaveLength(1);
  });
});
