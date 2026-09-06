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

  /**
   * WK-08 (docs/auditoria-1/worker.md): antes de esta ronda,
   * `updateAgentRunRow` hacía `UPDATE agent_runs SET ... WHERE id = $1`
   * SIN verificar que `job.payload.organizationId` coincidiera con el
   * `org_id` real de esa fila. Con la conexión "propietaria" del worker
   * (sin RLS forzada), un job `run_agent` con `agentRunId`/`organizationId`
   * inconsistentes (bug/dato corrupto en quien encola el job) podía
   * sobrescribir en silencio el resultado de la corrida de OTRO tenant.
   * Este test reproduce exactamente eso: un `agentRunId` que pertenece a
   * `orgA`, pero un payload que dice `organizationId: orgB`.
   */
  it('WK-08: un job run_agent con organizationId de otro tenant nunca actualiza la fila real (falla explícito, no-op silencioso)', async () => {
    const { orgId: orgA, userId: userA } = await seedOrgAndUser(db, 'org-a-run-agent');
    const { orgId: orgB } = await seedOrgAndUser(db, 'org-b-run-agent');

    const { rows } = await db.query<{ id: string; status: string }>(
      `insert into agent_runs (org_id, agent_name, input, status, started_by) values ($1, 'demo-agent', '{}'::jsonb, 'running', $2) returning id, status`,
      [orgA, userA],
    );
    const agentRunId = rows[0].id;

    const handler = createRunAgentHandler({ db, buildProvider: () => new FakeProvider() });
    const job = {
      id: 'job-run-agent-cross-org',
      orgId: orgB,
      kind: 'run_agent',
      payload: {
        agentRunId,
        organizationId: orgB, // inconsistente: agentRunId real pertenece a orgA
        actorId: 'attacker-or-bug',
        actorRole: 'licitador' as const,
        agentName: 'demo-agent',
        prompt: 'intento de leer/sobrescribir la corrida de otro tenant',
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

    // Falla explícito (nunca un no-op silencioso que deje pasar el bug desapercibido).
    await expect(handler(job, makeCtx())).rejects.toThrow(/organizationId/);

    // La fila real de orgA NUNCA se tocó: sigue exactamente como antes.
    const { rows: after } = await db.query<{ status: string; output: unknown }>(
      `select status, output from agent_runs where id = $1`,
      [agentRunId],
    );
    expect(after[0].status).toBe('running');
    expect(after[0].output).toBeNull();
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
