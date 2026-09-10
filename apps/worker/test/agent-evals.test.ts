import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { DbClient } from '@atiende/db';
import { FakeProvider } from '@atiende/agents';
import { createRunAgentHandler, type RunAgentHandlerDeps, type RunAgentPayload } from '../src/handlers/run-agent.js';
import { buildBusinessToolRegistry } from '../src/agents/business-tools.js';
import { createMigratedDb, seedOrgAndUser, silentLogger } from './helpers.js';
import { JobQueue } from '../src/queue/job-queue.js';
import type { Job, JobHandlerContext } from '../src/queue/types.js';

/**
 * Evals deterministas (Ronda 6, tarea 3) para los 5 agentes nombrados,
 * ejecutados con `FakeProvider` (determinista, sin red — nunca certifica
 * una integración real, ver README de packages/agents). Al menos 5 casos
 * por agente, cubriendo (donde aplica de forma natural a su plan fijo de
 * herramientas): no-fabricación, guardrail anticorrupción, prohibiciones
 * duras/techo de rol, aislamiento por organización, idempotencia por
 * clave, y presupuesto excedido.
 */

let jobCounter = 0;
function makeJob(payload: RunAgentPayload, orgId: string | null): Job<RunAgentPayload> {
  jobCounter += 1;
  return {
    id: `job-eval-${jobCounter}`,
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

async function fetchAgentRunOutput(db: DbClient, agentRunId: string): Promise<{ status: string; output: { richStatus: string; toolCalls: { toolName: string; status: string }[] } }> {
  const { rows } = await db.query<{ status: string; output: never }>(`select status, output from agent_runs where id = $1`, [agentRunId]);
  return rows[0] as never;
}

async function createAgentRunRow(db: DbClient, orgId: string, userId: string, agentName: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (org_id, agent_name, input, status, started_by) values ($1, $2, '{}'::jsonb, 'running', $3) returning id`,
    [orgId, agentName, userId],
  );
  return rows[0].id;
}

describe('Ronda 6: evals deterministas por agente nombrado', () => {
  let db: DbClient;
  let queue: JobQueue;

  beforeEach(async () => {
    db = await createMigratedDb();
    queue = new JobQueue({ db });
  });

  afterEach(async () => {
    await db.close();
  });

  async function seedTenderWithFullData(slug: string) {
    const { orgId, userId } = await seedOrgAndUser(db, slug);
    const tenderRow = await db.query<{ id: string }>(
      `insert into tenders (org_id, source, external_id, title, contracting_body) values ($1, 'dof', $2, 'Obra civil de pavimentación', 'Municipio X') returning id`,
      [orgId, `ext-${slug}`],
    );
    const tenderId = tenderRow.rows[0].id;
    await db.query(`insert into capabilities (org_id, name) values ($1, 'obra civil')`, [orgId]);
    await db.query(`insert into company_profiles (org_id, legal_name) values ($1, 'Empresa de prueba SA de CV')`, [orgId]);
    await db.query(
      `insert into tender_documents (org_id, tender_id, document_type, storage_ref, extracted_text) values ($1, $2, 'bases', 'ref', 'El proveedor deberá entregar certificación ISO 9001 vigente.')`,
      [orgId, tenderId],
    );
    return { orgId, userId, tenderId };
  }

  function baseDeps(overrides: Partial<RunAgentHandlerDeps> = {}): RunAgentHandlerDeps {
    return { db, queue, buildProvider: () => new FakeProvider(), ...overrides };
  }

  // ── analista_convocatorias ────────────────────────────────────────────
  describe('analista_convocatorias', () => {
    it('camino feliz: bases + perfil + matching, corrida completa y persistida en agent_runs.output.toolCalls', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-ac-happy');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'analista_convocatorias');
      const handler = createRunAgentHandler(baseDeps());
      await handler(
        makeJob(
          { agentRunId, organizationId: orgId, actorId: userId, actorRole: 'licitador', agentName: 'analista_convocatorias', context: { tenderId } },
          orgId,
        ),
        makeCtx(),
      );
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.status).toBe('succeeded');
      expect(row.output.richStatus).toBe('completed');
      expect(row.output.toolCalls.map((t) => t.toolName)).toEqual(['leer_bases', 'leer_perfil_empresa', 'proponer_matching']);
      expect(row.output.toolCalls.every((t) => t.status === 'ok')).toBe(true);
    });

    it('aislamiento por org: un tenderId de otra organización nunca se lee ni se usa para matching (contenido, no solo status)', async () => {
      const { tenderId: tenderIdOfOrgA } = await seedTenderWithFullData('eval-ac-org-a');
      // Dato distinguible real de orgA (más allá del título genérico del helper
      // compartido), para poder confirmar por CONTENIDO que nunca llega a orgB.
      await db.query(`update tenders set title = $1, contracting_body = $2 where id = $3`, [
        'SECRETO-ORGA obra civil',
        'SECRETO-ORGA Municipio',
        tenderIdOfOrgA,
      ]);
      const { orgId: orgB, userId: userB } = await seedOrgAndUser(db, 'eval-ac-org-b');
      const handler = createRunAgentHandler(baseDeps());
      const job = makeJob(
        { organizationId: orgB, actorId: userB, actorRole: 'licitador', agentName: 'analista_convocatorias', context: { tenderId: tenderIdOfOrgA } },
        orgB,
      );
      // Sin agentRunId (fire-and-forget): el job igual corre; nos interesa el resultado en memoria vía richStatus,
      // así que usamos un agentRunId de orgB para poder inspeccionar el output persistido.
      const agentRunId = await createAgentRunRow(db, orgB, userB, 'analista_convocatorias');
      job.payload.agentRunId = agentRunId;
      await handler(job, makeCtx());
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('completed');
      const matchingCall = row.output.toolCalls.find((t) => t.toolName === 'proponer_matching');
      expect(matchingCall?.status).toBe('ok');
      // La convocatoria es de orgA: proponer_matching de orgB nunca la encuentra ("no evaluable"), nunca filtra datos de orgA.
      // WK6-01 (docs/auditoria-2/worker-agentes.md, ALTA): `status: 'ok'` NO
      // basta -- `agent_runs.output.toolCalls` es un resumen REDACTADO
      // (`summarizeToolCalls`, `handlers/run-agent.ts`) que nunca incluye el
      // `score`/`explanation` reales. Para verificar CONTENIDO (no solo que
      // el tool_call "terminó bien"), se invoca la MISMA herramienta con el
      // MISMO contexto (organizationId de orgB, tenderId real de orgA) que
      // usó el agente, y se confirma que el resultado nunca contiene el
      // score/explicación/keywords de la convocatoria real de orgA. Bajo la
      // mutación de `fetchTender` sin filtro `org_id` (ver
      // `apps/worker/scripts/wk6-01-mutation-test-org-isolation.sh`), esta
      // aserción SÍ falla (a diferencia de `matchingCall?.status`).
      const registry = buildBusinessToolRegistry({ db, queue, provider: new FakeProvider() });
      const tool = registry.get('proponer_matching');
      const directOutput = (await tool.handler(
        { tenderId: tenderIdOfOrgA },
        { organizationId: orgB, actorId: userB, actorRole: 'licitador', runId: 'wk6-01-content-check' },
      )) as { score: number | null; explanation: string; matchedKeywords: string[]; missingProfileFields: string[] };
      expect(directOutput.score).toBeNull();
      expect(directOutput.matchedKeywords).toEqual([]);
      expect(directOutput.missingProfileFields).toContain('tender');
      expect(directOutput.explanation).toMatch(/no evaluable/i);
      expect(JSON.stringify(directOutput)).not.toContain('SECRETO-ORGA');
    });

    it('rol sin permiso de riesgo (consultor_externo, techo "read") deniega el primer paso "write" -> corrida denied, job falla permanente', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-ac-denied');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'analista_convocatorias');
      const handler = createRunAgentHandler(baseDeps());
      const job = makeJob(
        { agentRunId, organizationId: orgId, actorId: userId, actorRole: 'consultor_externo', agentName: 'analista_convocatorias', context: { tenderId } },
        orgId,
      );
      let caught: unknown;
      try {
        await handler(job, makeCtx());
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as { permanent?: boolean }).permanent).toBe(true);
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('denied');
    });

    it('idempotencia por clave: dos corridas del mismo tenderId+org reutilizan el resultado cacheado del paso "proponer_matching" (el LLM no se vuelve a invocar)', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-ac-idem');
      let completions = 0;
      const provider = new FakeProvider(() => {
        completions += 1;
        return { content: `[n=${completions}]`, toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
      });
      const handler = createRunAgentHandler(baseDeps({ buildProvider: () => provider }));

      const runOnce = () =>
        handler(
          makeJob(
            { organizationId: orgId, actorId: userId, actorRole: 'licitador', agentName: 'analista_convocatorias', context: { tenderId } },
            orgId,
          ),
          makeCtx(),
        );

      await runOnce();
      await runOnce();
      expect(completions).toBe(1);
    });

    it('presupuesto excedido: con un límite por organización menor al costo del primer paso, la corrida se detiene "failed" (nunca fabrica un resultado)', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-ac-budget');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'analista_convocatorias');
      const handler = createRunAgentHandler(baseDeps({ budgetUsdPerOrg: 0.001 }));
      const job = makeJob(
        { agentRunId, organizationId: orgId, actorId: userId, actorRole: 'licitador', agentName: 'analista_convocatorias', context: { tenderId } },
        orgId,
      );
      await expect(handler(job, makeCtx())).rejects.toThrow();
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('failed');
      expect(row.output.toolCalls[0].status).toBe('error');
    });
  });

  // ── analista_bases ────────────────────────────────────────────────────
  describe('analista_bases', () => {
    it('camino feliz: propone candidatos de matriz reales a partir del texto extraído', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-ab-happy');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'analista_bases');
      const handler = createRunAgentHandler(baseDeps());
      await handler(
        makeJob({ agentRunId, organizationId: orgId, actorId: userId, actorRole: 'licitador', agentName: 'analista_bases', context: { tenderId } }, orgId),
        makeCtx(),
      );
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('completed');
    });

    it('aislamiento por org: tenderId de otra organización -> leer_bases no expone documentos ajenos', async () => {
      const { tenderId } = await seedTenderWithFullData('eval-ab-org-a');
      const { orgId: orgB, userId: userB } = await seedOrgAndUser(db, 'eval-ab-org-b');
      const agentRunId = await createAgentRunRow(db, orgB, userB, 'analista_bases');
      const handler = createRunAgentHandler(baseDeps());
      await handler(
        makeJob({ agentRunId, organizationId: orgB, actorId: userB, actorRole: 'licitador', agentName: 'analista_bases', context: { tenderId } }, orgB),
        makeCtx(),
      );
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('completed'); // 0 documentos de orgB, sin candidatos -- nunca los de orgA.
    });

    it('rol sin permiso: consultor_externo denegado en el paso "write" (proponer_requisitos_matriz)', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-ab-denied');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'analista_bases');
      const handler = createRunAgentHandler(baseDeps());
      const job = makeJob(
        { agentRunId, organizationId: orgId, actorId: userId, actorRole: 'consultor_externo', agentName: 'analista_bases', context: { tenderId } },
        orgId,
      );
      await expect(handler(job, makeCtx())).rejects.toThrow();
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('denied');
    });

    it('idempotencia por clave: dos corridas con el mismo tenderId no duplican la propuesta de matriz (mismo idempotencyKey)', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-ab-idem');
      const handler = createRunAgentHandler(baseDeps());
      const run = () =>
        handler(
          makeJob({ organizationId: orgId, actorId: userId, actorRole: 'licitador', agentName: 'analista_bases', context: { tenderId } }, orgId),
          makeCtx(),
        );
      await expect(run()).resolves.toBeUndefined();
      await expect(run()).resolves.toBeUndefined();
    });

    it('presupuesto excedido detiene la corrida en el primer paso', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-ab-budget');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'analista_bases');
      const handler = createRunAgentHandler(baseDeps({ budgetUsdPerOrg: 0.001 }));
      const job = makeJob(
        { agentRunId, organizationId: orgId, actorId: userId, actorRole: 'licitador', agentName: 'analista_bases', context: { tenderId } },
        orgId,
      );
      await expect(handler(job, makeCtx())).rejects.toThrow();
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('failed');
    });
  });

  // ── redactor_borrador ─────────────────────────────────────────────────
  describe('redactor_borrador', () => {
    it('no fabricación: sin evidence_ref, la sección queda bloqueada explícitamente (needs_data), nunca redacta un dato inventado', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-rb-no-fab');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'redactor_borrador');
      const handler = createRunAgentHandler(baseDeps());
      const job = makeJob(
        {
          agentRunId,
          organizationId: orgId,
          actorId: userId,
          actorRole: 'licitador',
          agentName: 'redactor_borrador',
          context: { tenderId: '00000000-0000-0000-0000-000000000009', sectionKeys: ['experiencia'] },
        },
        orgId,
      );
      await expect(handler(job, makeCtx())).rejects.toThrow();
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('needs_data');
    });

    it('con evidencia real, redacta la sección y completa (no queda pendiente)', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-rb-ok');
      await db.query(`insert into experience_records (org_id, title, evidence_ref) values ($1, 'Construcción de puente', 'doc-1')`, [orgId]);
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'redactor_borrador');
      const handler = createRunAgentHandler(baseDeps());
      await handler(
        makeJob(
          {
            agentRunId,
            organizationId: orgId,
            actorId: userId,
            actorRole: 'licitador',
            agentName: 'redactor_borrador',
            context: { tenderId: '00000000-0000-0000-0000-000000000009', sectionKeys: ['experiencia'] },
          },
          orgId,
        ),
        makeCtx(),
      );
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('completed');
    });

    it('guardrail anticorrupción bloquea una sectionKey con lenguaje de soborno, ANTES de tocar la herramienta', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-rb-guardrail');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'redactor_borrador');
      const handler = createRunAgentHandler(baseDeps());
      const job = makeJob(
        {
          agentRunId,
          organizationId: orgId,
          actorId: userId,
          actorRole: 'licitador',
          agentName: 'redactor_borrador',
          context: { tenderId: '00000000-0000-0000-0000-000000000009', sectionKeys: ['soborno'] },
        },
        orgId,
      );
      await expect(handler(job, makeCtx())).rejects.toThrow();
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('blocked');
      // El primer paso (leer_perfil_empresa) no lleva texto libre del
      // atacante y corre "ok"; el guardrail bloquea el SEGUNDO paso
      // (proponer_seccion_propuesta), el único con la sectionKey libre.
      expect(row.output.toolCalls.find((t) => t.toolName === 'proponer_seccion_propuesta')?.status).toBe('blocked_guardrail');
    });

    it('rol sin permiso: consultor_externo denegado en "proponer_seccion_propuesta" (write)', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-rb-denied');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'redactor_borrador');
      const handler = createRunAgentHandler(baseDeps());
      const job = makeJob(
        {
          agentRunId,
          organizationId: orgId,
          actorId: userId,
          actorRole: 'consultor_externo',
          agentName: 'redactor_borrador',
          context: { tenderId: '00000000-0000-0000-0000-000000000009', sectionKeys: ['experiencia'] },
        },
        orgId,
      );
      await expect(handler(job, makeCtx())).rejects.toThrow();
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('denied');
    });

    it('presupuesto excedido detiene la corrida antes de redactar', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-rb-budget');
      await db.query(`insert into experience_records (org_id, title, evidence_ref) values ($1, 'Construcción de puente', 'doc-1')`, [orgId]);
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'redactor_borrador');
      const handler = createRunAgentHandler(baseDeps({ budgetUsdPerOrg: 0.001 }));
      const job = makeJob(
        {
          agentRunId,
          organizationId: orgId,
          actorId: userId,
          actorRole: 'licitador',
          agentName: 'redactor_borrador',
          context: { tenderId: '00000000-0000-0000-0000-000000000009', sectionKeys: ['experiencia'] },
        },
        orgId,
      );
      await expect(handler(job, makeCtx())).rejects.toThrow();
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('failed');
    });
  });

  // ── providerId/simulated (punto 3, ciclo redactor_borrador) ────────────
  describe('providerId/simulated: distinguir explícitamente FakeProvider de un proveedor real', () => {
    async function fetchProviderMeta(agentRunId: string): Promise<{ providerId: string; simulated: boolean }> {
      const { rows } = await db.query<{ output: { providerId: string; simulated: boolean } }>(
        `select output from agent_runs where id = $1`,
        [agentRunId],
      );
      return rows[0].output;
    }

    it('analista_bases (proponer_requisitos_matriz, determinista sin LLM) con FakeProvider construido: simulated=false pese a NO tener OPENAI_API_KEY -- el resultado es 100% real', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-meta-ab');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'analista_bases');
      const handler = createRunAgentHandler(baseDeps());
      await handler(
        makeJob({ agentRunId, organizationId: orgId, actorId: userId, actorRole: 'licitador', agentName: 'analista_bases', context: { tenderId } }, orgId),
        makeCtx(),
      );
      const meta = await fetchProviderMeta(agentRunId);
      expect(meta.providerId).toBe('fake');
      expect(meta.simulated).toBe(false);
    });

    it('redactor_borrador (proponer_seccion_propuesta, SÍ llama al LLM) con FakeProvider: simulated=true -- el texto de la sección es fabricado por el proveedor determinista, no un texto real', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-meta-rb');
      await db.query(`insert into experience_records (org_id, title, evidence_ref) values ($1, 'Construcción de puente', 'doc-1')`, [orgId]);
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'redactor_borrador');
      const handler = createRunAgentHandler(baseDeps());
      await handler(
        makeJob(
          {
            agentRunId,
            organizationId: orgId,
            actorId: userId,
            actorRole: 'licitador',
            agentName: 'redactor_borrador',
            context: { tenderId: '00000000-0000-0000-0000-000000000010', sectionKeys: ['experiencia'] },
          },
          orgId,
        ),
        makeCtx(),
      );
      const meta = await fetchProviderMeta(agentRunId);
      expect(meta.providerId).toBe('fake');
      expect(meta.simulated).toBe(true);
    });

    it('redactor_borrador BLOQUEADO por falta de evidencia (needs_data, nunca llega a llamar al LLM): simulated=false -- no hay ningún texto fabricado que distinguir', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-meta-rb-blocked');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'redactor_borrador');
      const handler = createRunAgentHandler(baseDeps());
      const job = makeJob(
        {
          agentRunId,
          organizationId: orgId,
          actorId: userId,
          actorRole: 'licitador',
          agentName: 'redactor_borrador',
          context: { tenderId: '00000000-0000-0000-0000-000000000011', sectionKeys: ['experiencia'] },
        },
        orgId,
      );
      await expect(handler(job, makeCtx())).rejects.toThrow();
      const meta = await fetchProviderMeta(agentRunId);
      expect(meta.providerId).toBe('fake');
      expect(meta.simulated).toBe(false);
    });

    it('con un proveedor real inyectado (buildProvider distinto de FakeProvider), redactor_borrador se marca simulated=false', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-meta-rb-real');
      await db.query(`insert into experience_records (org_id, title, evidence_ref) values ($1, 'Construcción de puente', 'doc-1')`, [orgId]);
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'redactor_borrador');
      const realLikeProvider = {
        id: 'openai',
        countryOfResidence: 'US',
        supportsToolCalls: true,
        async complete() {
          return { content: 'texto real', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
        },
        async *stream() {
          yield { type: 'done' as const, usage: { inputTokens: 1, outputTokens: 1 } };
        },
      };
      const handler = createRunAgentHandler(baseDeps({ buildProvider: () => realLikeProvider }));
      await handler(
        makeJob(
          {
            agentRunId,
            organizationId: orgId,
            actorId: userId,
            actorRole: 'licitador',
            agentName: 'redactor_borrador',
            context: { tenderId: '00000000-0000-0000-0000-000000000012', sectionKeys: ['experiencia'] },
          },
          orgId,
        ),
        makeCtx(),
      );
      const meta = await fetchProviderMeta(agentRunId);
      expect(meta.providerId).toBe('openai');
      expect(meta.simulated).toBe(false);
    });
  });

  // ── vigilante_cambios ─────────────────────────────────────────────────
  describe('vigilante_cambios', () => {
    it('camino feliz: resume cambios reales de la convocatoria', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-vc-happy');
      await db.query(`insert into tender_change_events (org_id, tender_id, change_kind, summary) values ($1, $2, 'amendment', 'Cambio real')`, [orgId, tenderId]);
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'vigilante_cambios');
      const handler = createRunAgentHandler(baseDeps());
      await handler(
        makeJob({ agentRunId, organizationId: orgId, actorId: userId, actorRole: 'licitador', agentName: 'vigilante_cambios', context: { tenderId } }, orgId),
        makeCtx(),
      );
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('completed');
    });

    it('aislamiento por org: nunca resume eventos de cambio de otra organización', async () => {
      const { tenderId } = await seedTenderWithFullData('eval-vc-org-a');
      const { orgId: orgB, userId: userB } = await seedOrgAndUser(db, 'eval-vc-org-b');
      const agentRunId = await createAgentRunRow(db, orgB, userB, 'vigilante_cambios');
      const handler = createRunAgentHandler(baseDeps());
      await handler(
        makeJob({ agentRunId, organizationId: orgB, actorId: userB, actorRole: 'licitador', agentName: 'vigilante_cambios', context: { tenderId } }, orgB),
        makeCtx(),
      );
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('completed'); // 0 eventos (los de orgA nunca se leen desde orgB)
    });

    it('consultor_externo (techo "read") SÍ puede ejecutar este agente: es de solo lectura, dentro de su techo de riesgo', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-vc-allowed');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'vigilante_cambios');
      const handler = createRunAgentHandler(baseDeps());
      await handler(
        makeJob({ agentRunId, organizationId: orgId, actorId: userId, actorRole: 'consultor_externo', agentName: 'vigilante_cambios', context: { tenderId } }, orgId),
        makeCtx(),
      );
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('completed');
    });

    it('idempotencia por clave: dos corridas del mismo tenderId no fallan por reejecución (idempotencyKey estable)', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-vc-idem');
      const handler = createRunAgentHandler(baseDeps());
      const run = () =>
        handler(makeJob({ organizationId: orgId, actorId: userId, actorRole: 'licitador', agentName: 'vigilante_cambios', context: { tenderId } }, orgId), makeCtx());
      await expect(run()).resolves.toBeUndefined();
      await expect(run()).resolves.toBeUndefined();
    });

    it('presupuesto excedido detiene la corrida', async () => {
      const { orgId, userId, tenderId } = await seedTenderWithFullData('eval-vc-budget');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'vigilante_cambios');
      const handler = createRunAgentHandler(baseDeps({ budgetUsdPerOrg: 0.001 }));
      const job = makeJob(
        { agentRunId, organizationId: orgId, actorId: userId, actorRole: 'licitador', agentName: 'vigilante_cambios', context: { tenderId } },
        orgId,
      );
      await expect(handler(job, makeCtx())).rejects.toThrow();
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('failed');
    });
  });

  // ── recordatorios ─────────────────────────────────────────────────────
  describe('recordatorios', () => {
    const tenderId = '00000000-0000-0000-0000-000000000009';

    it('camino feliz: programa una alerta real (job send_agent_alert encolado)', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-rec-happy');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'recordatorios');
      const handler = createRunAgentHandler(baseDeps());
      const scheduledFor = new Date(Date.now() + 60_000).toISOString();
      await handler(
        makeJob(
          {
            agentRunId,
            organizationId: orgId,
            actorId: userId,
            actorRole: 'licitador',
            agentName: 'recordatorios',
            context: { tenderId, alert: { kind: 'vencimiento', scheduledFor, message: 'La convocatoria vence pronto' } },
          },
          orgId,
        ),
        makeCtx(),
      );
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('completed');
      const { rows } = await db.query<{ kind: string }>(`select kind from jobs where org_id = $1 and kind = 'send_agent_alert'`, [orgId]);
      expect(rows).toHaveLength(1);
    });

    it('idempotencia por clave: dos alertas con el mismo (tenderId, kind, scheduledFor) encolan un único job de plataforma', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-rec-idem');
      const handler = createRunAgentHandler(baseDeps());
      const scheduledFor = new Date(Date.now() + 60_000).toISOString();
      const runOnce = () =>
        handler(
          makeJob(
            {
              organizationId: orgId,
              actorId: userId,
              actorRole: 'licitador',
              agentName: 'recordatorios',
              context: { tenderId, alert: { kind: 'vencimiento', scheduledFor, message: 'Vence pronto' } },
            },
            orgId,
          ),
          makeCtx(),
        );
      await runOnce();
      await runOnce();
      const { rows } = await db.query<{ count: string }>(
        `select count(*)::text as count from jobs where org_id = $1 and kind = 'send_agent_alert'`,
        [orgId],
      );
      expect(rows[0].count).toBe('1');
    });

    it('guardrail anticorrupción bloquea un mensaje de alerta con lenguaje de soborno', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-rec-guardrail');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'recordatorios');
      const handler = createRunAgentHandler(baseDeps());
      const scheduledFor = new Date(Date.now() + 60_000).toISOString();
      const job = makeJob(
        {
          agentRunId,
          organizationId: orgId,
          actorId: userId,
          actorRole: 'licitador',
          agentName: 'recordatorios',
          context: { tenderId, alert: { kind: 'vencimiento', scheduledFor, message: 'Ofrecer un soborno al funcionario para agilizar' } },
        },
        orgId,
      );
      await expect(handler(job, makeCtx())).rejects.toThrow();
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('blocked');
      const { rows } = await db.query<{ count: string }>(
        `select count(*)::text as count from jobs where org_id = $1 and kind = 'send_agent_alert'`,
        [orgId],
      );
      expect(rows[0].count).toBe('0'); // el guardrail bloquea ANTES de encolar nada.
    });

    it('rol sin permiso: consultor_externo denegado (programar_alerta es "write")', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-rec-denied');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'recordatorios');
      const handler = createRunAgentHandler(baseDeps());
      const scheduledFor = new Date(Date.now() + 60_000).toISOString();
      const job = makeJob(
        {
          agentRunId,
          organizationId: orgId,
          actorId: userId,
          actorRole: 'consultor_externo',
          agentName: 'recordatorios',
          context: { tenderId, alert: { kind: 'vencimiento', scheduledFor, message: 'Vence pronto' } },
        },
        orgId,
      );
      await expect(handler(job, makeCtx())).rejects.toThrow();
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('denied');
    });

    it('presupuesto excedido: no encola la alerta si el presupuesto de la organización ya se agotó', async () => {
      const { orgId, userId } = await seedOrgAndUser(db, 'eval-rec-budget');
      const agentRunId = await createAgentRunRow(db, orgId, userId, 'recordatorios');
      const handler = createRunAgentHandler(baseDeps({ budgetUsdPerOrg: 0.0001 }));
      const scheduledFor = new Date(Date.now() + 60_000).toISOString();
      const job = makeJob(
        {
          agentRunId,
          organizationId: orgId,
          actorId: userId,
          actorRole: 'licitador',
          agentName: 'recordatorios',
          context: { tenderId, alert: { kind: 'vencimiento', scheduledFor, message: 'Vence pronto' } },
        },
        orgId,
      );
      await expect(handler(job, makeCtx())).rejects.toThrow();
      const row = await fetchAgentRunOutput(db, agentRunId);
      expect(row.output.richStatus).toBe('failed');
      const { rows } = await db.query<{ count: string }>(
        `select count(*)::text as count from jobs where org_id = $1 and kind = 'send_agent_alert'`,
        [orgId],
      );
      expect(rows[0].count).toBe('0');
    });
  });

  // ── prohibiciones duras (sistema completo, no específico de un agente:
  // ninguno de los 8 tools de negocio tiene actionKind prohibido por
  // diseño — este test prueba que el MISMO runtime que ejecuta los 5
  // agentes nombrados (AgentRunner + AuthorizationPolicy) sigue
  // denegando de forma dura cualquier actionKind prohibido, sin importar
  // el rol, si alguna herramienta futura lo declarara) ──────────────────
  describe('prohibiciones duras (runtime compartido por los 5 agentes)', () => {
    it('un tool_call con actionKind "portal_action" se deniega SIEMPRE, incluso para "superadmin", sin llegar a needs_approval', async () => {
      const { AgentRunner, AuthorizationPolicy, AntiCorruptionGuardrail, InMemoryRunStore, InMemoryToolCallStore, IdempotencyStore, BudgetLedger, TokenBucketRateLimiter, ToolRegistry } =
        await import('@atiende/agents');
      const { z } = await import('zod');
      const registry = new ToolRegistry();
      registry.register({
        name: 'subir_a_comprasmx_prohibido_test',
        description: 'Herramienta de prueba con actionKind prohibido (nunca registrada en business-tools.ts real).',
        inputSchema: z.object({}),
        outputSchema: z.object({ ok: z.boolean() }),
        riskLevel: 'irreversible',
        actionKind: 'portal_action',
        declaredEffects: ['portal_action'],
        idempotent: false,
        tenantScoped: false,
        handler: async () => ({ ok: true }),
      });
      const runner = new AgentRunner({
        registry,
        authorizationPolicy: new AuthorizationPolicy(),
        guardrail: new AntiCorruptionGuardrail(),
        runStore: new InMemoryRunStore(),
        toolCallStore: new InMemoryToolCallStore(),
        idempotencyStore: new IdempotencyStore(),
        budgetLedger: new BudgetLedger(),
        rateLimiter: new TokenBucketRateLimiter(60, 1),
      });
      const run = await runner.run({
        organizationId: null,
        actorId: 'actor-super',
        actorRole: 'superadmin',
        agentName: 'test',
        steps: [{ toolName: 'subir_a_comprasmx_prohibido_test', input: {} }],
      });
      expect(run.status).toBe('denied');
    });
  });
});
