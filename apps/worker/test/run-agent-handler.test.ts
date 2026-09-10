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

  /**
   * WK-23 (docs/auditoria-1/worker-cierre.md, ALTA): este es también el
   * caso "update legítimo OK" del contrato de identidad de worker_role —
   * `userId` (owner de `orgId`, rol de escritura) se usa como `actorId`,
   * así que `updateAgentRunRow` corre de verdad como `worker_role` con
   * `app.current_org_id`/`app.current_user_id` correctos y la política RLS
   * de `agent_runs` (packages/db/migrations/0008) lo permite — no solo
   * porque la conexión ignore RLS, como antes de esta ronda.
   */
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
        // WK-23: actorId debe ser un UUID real (usado como app.current_user_id
        // bajo worker_role) — se usa userA (miembro legítimo de orgA, NO de
        // orgB) para mantener el foco de este test en el mismatch de
        // organización, no en la validez de actorId (ver test dedicado WK-23
        // más abajo para actorId inválido/sin membresía).
        actorId: userA,
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

  /**
   * WK-16 (docs/auditoria-1/worker-reverificacion.md, cierre de WK-08
   * PARCIAL): antes de esta ronda, `organizationId: null` (un valor
   * EXPLÍCITAMENTE válido según el tipo `RunAgentPayload.organizationId:
   * string | null`) desactivaba por completo el `WHERE org_id = $5` de
   * `updateAgentRunRow` (`$5::uuid is null or org_id = $5::uuid`),
   * permitiendo que un job con `agentRunId` real de CUALQUIER tenant y
   * `organizationId: null` sobrescribiera esa fila sin ningún error —
   * exactamente el bypass que WK-08 decía haber cerrado. Ahora, cuando
   * `agentRunId` viene presente, `organizationId` nulo/undefined/vacío
   * hace fallar el job como PERMANENTE ("org requerida") ANTES de correr el
   * `AgentRunner` o tocar `agent_runs` — nunca un `UPDATE` silencioso.
   */
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['string vacío', ''],
  ])('WK-16: organizationId %s con agentRunId presente falla permanente ("org requerida"), agent_runs NUNCA se toca', async (_label, orgValue) => {
    const { orgId: orgA, userId: userA } = await seedOrgAndUser(db, `org-wk16-${_label.replace(/[^a-z0-9]/gi, '')}`);
    const { rows } = await db.query<{ id: string }>(
      `insert into agent_runs (org_id, agent_name, input, status, started_by) values ($1, 'demo-agent', '{}'::jsonb, 'running', $2) returning id`,
      [orgA, userA],
    );
    const agentRunId = rows[0].id;

    const handler = createRunAgentHandler({ db, buildProvider: () => new FakeProvider() });
    const job = {
      id: `job-run-agent-wk16-${_label}`,
      orgId: orgA,
      kind: 'run_agent',
      payload: {
        agentRunId,
        organizationId: orgValue,
        actorId: 'attacker-or-bug',
        actorRole: 'licitador' as const,
        agentName: 'demo-agent',
        prompt: 'intento con organizationId ausente',
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

    let caught: unknown;
    try {
      await handler(job as never, makeCtx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/org requerida/);
    // Fail-closed y PERMANENTE (WK-10): reintentar no arregla un payload sin org.
    expect((caught as { permanent?: boolean }).permanent).toBe(true);

    // La fila real de orgA NUNCA se tocó: ni siquiera se llegó a intentar el UPDATE.
    const { rows: after } = await db.query<{ status: string; output: unknown }>(
      `select status, output from agent_runs where id = $1`,
      [agentRunId],
    );
    expect(after[0].status).toBe('running');
    expect(after[0].output).toBeNull();
  });

  /**
   * WK-23 (docs/auditoria-1/worker-cierre.md, ALTA): a diferencia del test
   * WK-08 de arriba (organizationId NO coincide con el org_id real de la
   * fila — bloqueado por el propio filtro `WHERE org_id = $5` de la
   * query), este caso tiene `organizationId` CORRECTO (coincide con el
   * org_id real de la fila), pero `actorId` es un usuario real que NO
   * tiene membresía en esa organización. Antes de esta ronda esto habría
   * actualizado la fila sin problema (la conexión propietaria del worker
   * ignoraba RLS por completo). Ahora que `updateAgentRunRow` adopta
   * `worker_role` de verdad (`set local role worker_role`), la política
   * RLS de `agent_runs` (`org_id = current_org_id() AND has_role(org_id,
   * write_roles)`, packages/db/migrations/0008) bloquea el UPDATE porque
   * `has_role()` no encuentra ninguna membresía de `actorId` en
   * `organizationId` — el bloqueo viene de RLS, no del filtro explícito de
   * la query (que aquí SÍ coincide).
   */
  it('WK-23: organizationId correcto pero actorId sin membresía en esa organización — RLS bajo worker_role bloquea el update legítimo en apariencia', async () => {
    const { userId: userA } = await seedOrgAndUser(db, 'org-a-wk23-noaccess');
    const { orgId: orgB, userId: ownerB } = await seedOrgAndUser(db, 'org-b-wk23-noaccess');

    // `started_by = ownerB` (E6, hallazgo de la reverificación de
    // 0098/PROPOSAL-06): esta fila representa una corrida HUMANA real de
    // org B (igual que la insertan hoy `agent-stores.pg.ts`/
    // `agent-triggers.ts`, ambos corregidos para poblar `started_by`) —
    // sin esto, la política adicional de `worker_role` de 0098
    // (`... and started_by is null`) también autorizaba este UPDATE,
    // ocultando el bloqueo real de RLS que este test verifica.
    const { rows } = await db.query<{ id: string }>(
      `insert into agent_runs (org_id, agent_name, input, status, started_by) values ($1, 'demo-agent', '{}'::jsonb, 'running', $2) returning id`,
      [orgB, ownerB],
    );
    const agentRunId = rows[0].id;

    const handler = createRunAgentHandler({ db, buildProvider: () => new FakeProvider() });
    const job = {
      id: 'job-run-agent-wk23-noaccess',
      orgId: orgB,
      kind: 'run_agent',
      payload: {
        agentRunId,
        organizationId: orgB, // CORRECTO: coincide con el org_id real de la fila
        actorId: userA, // UUID real, pero SIN membresía en orgB (solo en orgA)
        actorRole: 'licitador' as const,
        agentName: 'demo-agent',
        prompt: 'organizationId correcto, actor sin membresía real en esa org',
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

    let caught: unknown;
    try {
      await handler(job, makeCtx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('AgentRunOrgMismatchError');
    expect((caught as { permanent?: boolean }).permanent).toBe(true);

    const { rows: after } = await db.query<{ status: string; output: unknown }>(
      `select status, output from agent_runs where id = $1`,
      [agentRunId],
    );
    expect(after[0].status).toBe('running');
    expect(after[0].output).toBeNull();
  });

  /**
   * WK-23: `actorId` se usa como `app.current_user_id` bajo `worker_role`
   * (identidad de servicio); un valor que no sea un UUID real debe fallar
   * cerrado con un mensaje explícito ANTES de tocar la base de datos, en
   * vez de dejar que Postgres lance un error críptico de cast o que RLS lo
   * trate silenciosamente como "sin membresía" indistinguible de un
   * mismatch de organización real.
   */
  it('WK-23: actorId con formato inválido (no UUID) falla permanente y explícito, agent_runs NUNCA se toca', async () => {
    const { orgId: orgA, userId: userA } = await seedOrgAndUser(db, 'org-a-wk23-badactor');
    const { rows } = await db.query<{ id: string }>(
      `insert into agent_runs (org_id, agent_name, input, status, started_by) values ($1, 'demo-agent', '{}'::jsonb, 'running', $2) returning id`,
      [orgA, userA],
    );
    const agentRunId = rows[0].id;

    const handler = createRunAgentHandler({ db, buildProvider: () => new FakeProvider() });
    const job = {
      id: 'job-run-agent-wk23-badactor',
      orgId: orgA,
      kind: 'run_agent',
      payload: {
        agentRunId,
        organizationId: orgA,
        actorId: 'no-soy-un-uuid',
        actorRole: 'licitador' as const,
        agentName: 'demo-agent',
        prompt: 'actorId con formato inválido',
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

    let caught: unknown;
    try {
      await handler(job, makeCtx());
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('RunAgentInvalidActorError');
    expect((caught as { permanent?: boolean }).permanent).toBe(true);

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

  /**
   * WK6-02 (docs/auditoria-2/worker-agentes.md, ALTA) + E20 (docs/BACKLOG.md,
   * cierre): antes de esta ronda, `run.correlationId`/
   * `ToolCallTrace.correlationId` (el identificador de NEGOCIO, p. ej. el
   * `tenderId`) se calculaba en memoria pero nunca se reflejaba en
   * `agent_runs.output` ni en el log del job — se perdía al terminar la
   * corrida, haciendo imposible el criterio de REQ-171 ("consulta de
   * auditoría reconstruye la cadena completa... a partir de un solo
   * correlation_id") con una sola consulta. `updateAgentRunRow` ahora
   * también escribe la columna dedicada `agent_runs.correlation_id`
   * (existe desde `packages/db/migrations/0017_ronda2_extensions.sql`, con
   * su propio índice; el backfill de filas viejas que solo la tenían en el
   * JSONB vive en `0088_e20_agent_runs_correlation_id.sql`) — la consulta
   * de auditoría de REQ-171 pasa de `output->>'correlationId' = $1` a
   * `correlation_id = $1` (indexada). Este test corre TRES corridas de
   * agentes nombrados distintos (analista_convocatorias, analista_bases,
   * redactor_borrador) que representan, en la vida real, los pasos
   * sucesivos de UN MISMO expediente (convocatoria -> matriz de requisitos
   * -> borrador de propuesta), todas con el MISMO `correlationId` de
   * negocio (`tenderId`), y confirma que una única consulta SQL por la
   * COLUMNA reconstruye la cadena completa en el orden correcto (y que
   * `output->>'correlationId'` sigue coincidiendo, por compatibilidad
   * hacia atrás con cualquier lector que todavía consulte el JSONB).
   */
  it('WK6-02/E20: correlationId de negocio persiste en agent_runs.correlation_id (columna) y en output (y en cada tool_call) — una sola consulta por columna reconstruye convocatoria -> matriz -> propuesta', async () => {
    const { orgId, userId } = await seedOrgAndUser(db, 'wk602-trace');

    // Datos reales de UN expediente: convocatoria + perfil + bases + experiencia.
    const tenderRow = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title, contracting_body) values ($1, 'dof', 'wk602', 'Obra civil de pavimentación', 'Municipio X') returning id`,
      [orgId],
    );
    const tenderId = tenderRow.rows[0].id;
    await db.query(`insert into capabilities (org_id, name) values ($1, 'obra civil')`, [orgId]);
    await db.query(`insert into company_profiles (org_id, legal_name) values ($1, 'Empresa de prueba SA de CV')`, [orgId]);
    await db.query(
      `insert into tender_documents (org_id, tender_id, document_type, storage_ref, extracted_text) values ($1, $2, 'bases', 'ref', 'El proveedor deberá entregar certificación ISO 9001 vigente.')`,
      [orgId, tenderId],
    );
    await db.query(`insert into experience_records (org_id, title, evidence_ref) values ($1, 'Construcción de puente', 'doc-1')`, [orgId]);

    const handler = createRunAgentHandler({ db, buildProvider: () => new FakeProvider() });

    async function runNamedAgent(agentName: string, context: Record<string, unknown>): Promise<void> {
      const { rows } = await db.query<{ id: string }>(
        `insert into agent_runs (org_id, agent_name, input, status, started_by) values ($1, $2, '{}'::jsonb, 'running', $3) returning id`,
        [orgId, agentName, userId],
      );
      const agentRunId = rows[0].id;
      const job = {
        id: `job-wk602-${agentName}`,
        orgId,
        kind: 'run_agent',
        payload: {
          agentRunId,
          organizationId: orgId,
          actorId: userId,
          actorRole: 'licitador' as const,
          agentName,
          context,
          // REQ-171: el identificador de NEGOCIO (no `job.id`) que enlaza
          // esta corrida con el resto del expediente.
          correlationId: tenderId,
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
    }

    await runNamedAgent('analista_convocatorias', { tenderId });
    await runNamedAgent('analista_bases', { tenderId });
    await runNamedAgent('redactor_borrador', { tenderId, sectionKeys: ['experiencia'] });

    // El criterio verificable de REQ-171/E20: UNA sola consulta por la
    // COLUMNA `correlation_id` (indexada, no ya contra el JSONB) reconstruye
    // la cadena completa, en orden.
    const { rows: chain } = await db.query<{
      agent_name: string;
      correlation_id: string | null;
      output: { correlationId: string | null; richStatus: string; toolCalls: { correlationId: string | null }[] };
    }>(`select agent_name, correlation_id, output from agent_runs where correlation_id = $1 order by created_at asc`, [
      tenderId,
    ]);

    expect(chain.map((r) => r.agent_name)).toEqual(['analista_convocatorias', 'analista_bases', 'redactor_borrador']);
    expect(chain.every((r) => r.correlation_id === tenderId)).toBe(true);
    // Compatibilidad hacia atrás: `output->>'correlationId'` sigue
    // coincidiendo (nada dejó de escribirse ahí).
    expect(chain.every((r) => r.output.correlationId === tenderId)).toBe(true);
    expect(chain.every((r) => r.output.richStatus === 'completed')).toBe(true);
    // Cada tool_call individual dentro de cada corrida también lleva el
    // mismo correlationId de negocio (no solo la corrida completa).
    const toolCallCorrelationIds = chain.flatMap((r) => r.output.toolCalls.map((t) => t.correlationId));
    expect(toolCallCorrelationIds.length).toBeGreaterThan(0);
    expect(toolCallCorrelationIds.every((c) => c === tenderId)).toBe(true);
  });

  describe('WK6-04 (docs/auditoria-2/worker-agentes-reverificacion.md, MEDIA): correlationId se sanea ANTES de persistir en agent_runs', () => {
    async function runWithCorrelationId(
      db: DbClient,
      orgId: string,
      userId: string,
      jobId: string,
      correlationId: string,
    ): Promise<{ agentRunId: string }> {
      const { rows } = await db.query<{ id: string }>(
        `insert into agent_runs (org_id, agent_name, input, status, started_by) values ($1, 'demo-agent', '{}'::jsonb, 'running', $2) returning id`,
        [orgId, userId],
      );
      const agentRunId = rows[0].id;
      const handler = createRunAgentHandler({ db, buildProvider: () => new FakeProvider() });
      const job = {
        id: jobId,
        orgId,
        kind: 'run_agent',
        payload: {
          agentRunId,
          organizationId: orgId,
          actorId: userId,
          actorRole: 'licitador' as const,
          agentName: 'demo-agent',
          prompt: 'demo WK6-04',
          correlationId,
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
      return { agentRunId };
    }

    it('un byte NUL en job.payload.correlationId nunca llega a agent_runs.correlation_id/output -- se sanea a un id derivado', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'wk604-nul');
      const withNul = 'ok\0malo';

      const { agentRunId } = await runWithCorrelationId(db, orgId, userId, 'job-wk604-nul', withNul);

      const { rows } = await db.query<{ correlation_id: string | null; output: { correlationId: string | null } }>(
        `select correlation_id, output from agent_runs where id = $1`,
        [agentRunId],
      );
      expect(rows[0].correlation_id).not.toBe(withNul);
      expect(rows[0].correlation_id).toMatch(/^sane-[0-9a-f]{16}$/);
      expect(rows[0].output.correlationId).toBe(rows[0].correlation_id);
    });

    it('10 KB / ANSI / RTL en job.payload.correlationId se sanean antes de llegar a la fila -- nunca el valor crudo', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'wk604-huge');
      const malicious = 'A'.repeat(10 * 1024) + '\x1b[31mROJO\x1b[0m';

      const { agentRunId } = await runWithCorrelationId(db, orgId, userId, 'job-wk604-huge', malicious);

      const { rows } = await db.query<{ correlation_id: string | null; output: { correlationId: string | null } }>(
        `select correlation_id, output from agent_runs where id = $1`,
        [agentRunId],
      );
      expect(rows[0].correlation_id).not.toBe(malicious);
      expect(rows[0].correlation_id?.length).toBeLessThanOrEqual(64);
      expect(rows[0].correlation_id).toMatch(/^sane-[0-9a-f]{16}$/);
      expect(rows[0].output.correlationId).toBe(rows[0].correlation_id);
    });

    it('un correlationId ya valido (UUID) persiste intacto en la columna -- no hay sobre-saneamiento', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'wk604-valid');
      const validUuid = '22222222-3333-4444-5555-666666666666';

      const { agentRunId } = await runWithCorrelationId(db, orgId, userId, 'job-wk604-valid', validUuid);

      const { rows } = await db.query<{ correlation_id: string | null }>(`select correlation_id from agent_runs where id = $1`, [
        agentRunId,
      ]);
      expect(rows[0].correlation_id).toBe(validUuid);
    });
  });
});
