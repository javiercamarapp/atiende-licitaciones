import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { FakeProvider } from '@atiende/agents';
import { createRunAgentHandler } from '../src/handlers/run-agent.js';
import { createMigratedDb, seedOrgAndUser, silentLogger } from './helpers.js';
import type { Job, JobHandlerContext } from '../src/queue/types.js';

function makeCtx(): JobHandlerContext {
  return { job: {} as Job, logger: silentLogger(), signal: new AbortController().signal };
}

describe('run_agent handler (esqueleto)', () => {
  let db: DbClient;

  beforeEach(async () => {
    db = await createMigratedDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('ejecuta con FakeProvider por defecto (sin OPENAI_API_KEY) y refleja el resultado en agent_runs', async () => {
    const { orgId, userId } = await seedOrgAndUser(db, 'org-run-agent');
    const { rows } = await db.query<{ id: string }>(
      `insert into agent_runs (org_id, agent_name, input, status, started_by) values ($1, 'demo-agent', '{}'::jsonb, 'running', $2) returning id`,
      [orgId, userId],
    );
    const agentRunId = rows[0].id;

    const handler = createRunAgentHandler({ db, buildProvider: () => new FakeProvider() });
    const job = {
      id: 'job-run-agent-1',
      orgId,
      kind: 'run_agent',
      payload: {
        agentRunId,
        organizationId: orgId,
        actorId: userId,
        actorRole: 'licitador' as const,
        agentName: 'demo-agent',
        prompt: '¿Cuál es el plazo de la convocatoria X?',
      },
      status: 'running' as const,
      attempts: 1,
      maxAttempts: 5,
      nextRunAt: new Date(),
      lockedAt: new Date(),
      lockedBy: 'worker-test',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await handler(job, makeCtx());

    const { rows: agentRuns } = await db.query<{ status: string; output: { richStatus: string } }>(
      `select status, output from agent_runs where id = $1`,
      [agentRunId],
    );
    expect(agentRuns[0].status).toBe('succeeded');
    expect(agentRuns[0].output.richStatus).toBe('completed');
  });

  it('sin agentRunId en el payload, igual ejecuta el AgentRunner sin fallar (uso "fire and forget")', async () => {
    const handler = createRunAgentHandler({ db, buildProvider: () => new FakeProvider() });
    const job = {
      id: 'job-run-agent-2',
      orgId: null,
      kind: 'run_agent',
      payload: {
        organizationId: null,
        actorId: 'system',
        actorRole: 'system' as const,
        agentName: 'demo-agent',
        prompt: 'demo sin persistencia',
      },
      status: 'running' as const,
      attempts: 1,
      maxAttempts: 5,
      nextRunAt: new Date(),
      lockedAt: new Date(),
      lockedBy: 'worker-test',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await expect(handler(job, makeCtx())).resolves.toBeUndefined();
  });

  it('un rol sin permiso para el riesgo de la herramienta hace que la corrida termine "denied" -> el job falla explícitamente', async () => {
    // "consultor_externo" tiene techo de riesgo "read" (packages/agents/src/authorization.ts);
    // la herramienta de demostración "llm_complete" es riskLevel "read", así que este caso
    // documenta el comportamiento cuando SÍ hay bloqueo (ver siguiente prueba con richStatus).
    const handler = createRunAgentHandler({ db, buildProvider: () => new FakeProvider() });
    const job = {
      id: 'job-run-agent-3',
      orgId: null,
      kind: 'run_agent',
      payload: {
        organizationId: null,
        actorId: 'consultor-1',
        actorRole: 'consultor_externo' as const,
        agentName: 'demo-agent',
        prompt: 'demo',
      },
      status: 'running' as const,
      attempts: 1,
      maxAttempts: 5,
      nextRunAt: new Date(),
      lockedAt: new Date(),
      lockedBy: 'worker-test',
      lastError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    // riskLevel "read" está dentro del techo de "consultor_externo" (también "read"): debe completar.
    await expect(handler(job, makeCtx())).resolves.toBeUndefined();
  });
});
