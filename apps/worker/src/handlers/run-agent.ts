import { z } from 'zod';
import type { DbClient } from '@atiende/db';
import {
  AgentRunner,
  AuthorizationPolicy,
  AntiCorruptionGuardrail,
  BudgetLedger,
  DependencyInvalidationRegistry,
  FakeProvider,
  IdempotencyStore,
  InMemoryRunStore,
  InMemoryToolCallStore,
  OpenAIResponsesProvider,
  ToolRegistry,
  TokenBucketRateLimiter,
  type AgentRun,
  type AgentRunRequest,
  type LLMProvider,
  type ModelTier,
  type Role,
  type ToolCallTrace,
} from '@atiende/agents';
import type { JobHandler } from '../queue/types.js';
import { JobQueue } from '../queue/job-queue.js';
import { buildBusinessToolRegistry } from '../agents/business-tools.js';
import { NAMED_AGENTS, buildNamedAgentPlan, isNamedAgent } from '../agents/named-agents.js';
import { assertAgentNotDisabled, parseDisabledAgents } from '../agents/kill-switch.js';

export interface RunAgentPayload {
  /** Si se da, el resultado se refleja en la fila `agent_runs` correspondiente (packages/db/migrations/0004_agents.sql). */
  agentRunId?: string;
  organizationId: string | null;
  /**
   * WK-23 (docs/auditoria-1/worker-cierre.md, ALTA): cuando el job trae
   * `agentRunId`, este mismo valor se usa también como identidad de
   * `app.current_user_id` al actualizar `agent_runs` bajo `worker_role`
   * (ver `updateAgentRunRow` abajo) — debe ser el UUID real del actor que
   * originó la corrida (el mismo que `apps/api` ya conoce al encolar el
   * job), con membresía activa y rol de escritura en `organizationId`, o
   * la política RLS de `agent_runs` (packages/db/migrations/0008) rechazará
   * el UPDATE aun siendo legítimo.
   */
  actorId: string;
  actorRole: Role;
  /**
   * Ronda 6 (docs/investigacion/paridad-producto.md "Ronda K"): si coincide
   * con uno de `NAMED_AGENTS` (`src/agents/named-agents.ts`), el plan de
   * tool_calls es FIJO y lo construye `buildNamedAgentPlan` a partir de
   * `context` — el modelo nunca decide qué herramienta llamar. Cualquier
   * otro valor sigue el camino de demostración original del esqueleto
   * (`llm_complete` con `prompt`/`tier`), mantenido por compatibilidad.
   */
  agentName: string;
  /** Datos de negocio del agente nombrado (p. ej. `{tenderId}`), validados por `buildNamedAgentPlan`. */
  context?: Record<string, unknown>;
  /** Prompt de demostración (solo para agentName fuera de NAMED_AGENTS, ver README §Pendientes del esqueleto original). */
  prompt?: string;
  tier?: ModelTier;
  /** Enlaza la corrida a la convocatoria/expediente de origen (ver AgentRunRequest.correlationId, packages/agents). Por defecto, job.id. */
  correlationId?: string;
}

export interface RunAgentHandlerDeps {
  db: DbClient;
  /** Inyectable para pruebas; por defecto usa `buildLlmProvider()` (Fake salvo `OPENAI_API_KEY`). */
  buildProvider?: () => LLMProvider;
  /** Inyectable para pruebas; por defecto una `JobQueue` nueva sobre el mismo `db` (usada por la herramienta `programar_alerta`). */
  queue?: JobQueue;
  /** Presupuesto máximo (USD) por organización, acumulado entre corridas de este proceso (REQ-128). Por defecto `WORKER_AGENT_BUDGET_USD_PER_ORG` o 5. */
  budgetUsdPerOrg?: number;
  /** Inyectable para pruebas de kill-switch (por defecto `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Elige el proveedor real solo si hay credenciales; si no, `FakeProvider`
 * determinista (documentado en `packages/agents/README.md`: pasar con
 * `FakeProvider` NO certifica ninguna integración real). La integración
 * real contra OpenAI está PENDIENTE de ejercitarse con credenciales de
 * producción (ver README de este paquete y de `packages/agents`).
 */
export function buildLlmProvider(openaiApiKey?: string): LLMProvider {
  if (openaiApiKey) return new OpenAIResponsesProvider({ apiKey: openaiApiKey });
  return new FakeProvider();
}

/**
 * Herramienta de demostración del esqueleto: pasa un prompt al `LLMProvider`
 * configurado y regresa el texto. NO es una herramienta de negocio real
 * (extraer bases, redactar sección de propuesta, etc.) — esas herramientas
 * las debe registrar `apps/api` (dueño de la persistencia real) siguiendo
 * el mismo patrón de `ToolRegistry.register()` (ver `packages/agents/README.md`).
 */
function buildDemoToolRegistry(provider: LLMProvider): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: 'llm_complete',
    description: 'Genera una respuesta de LLM a partir de un prompt (herramienta de demostración del esqueleto run_agent).',
    inputSchema: z.object({
      prompt: z.string().min(1),
      tier: z.enum(['economico', 'estandar', 'premium']),
    }),
    outputSchema: z.object({ content: z.string() }),
    riskLevel: 'read',
    actionKind: 'read',
    // AG-05 (packages/agents, commit 480d183): declaredEffects es obligatorio
    // y debe ser consistente con riskLevel/actionKind — "llm_complete" solo
    // lee (pasa un prompt al proveedor y regresa texto), sin escritura ni
    // efecto externo real.
    declaredEffects: ['read_only'],
    idempotent: true,
    tenantScoped: false,
    handler: async (input) => {
      const result = await provider.complete({
        model: 'demo',
        tier: input.tier,
        messages: [{ role: 'user', content: input.prompt }],
      });
      return { content: result.content };
    },
  });
  return registry;
}

/** Mapea el estado (rico) de `AgentRun` al enum (angosto) `agent_run_status` de packages/db, sin tocar esa migración. */
function toDbAgentRunStatus(status: AgentRun['status']): 'running' | 'succeeded' | 'failed' | 'cancelled' {
  switch (status) {
    case 'completed':
      return 'succeeded';
    case 'cancelled':
      return 'cancelled';
    case 'needs_approval':
      return 'running';
    default:
      return 'failed';
  }
}

/**
 * WK-08 (docs/auditoria-1/worker.md) + WK-23 (docs/auditoria-1/worker-cierre.md,
 * ALTA): antes de esta ronda este UPDATE solo filtraba por `id`, y corría
 * con la conexión "propietaria" del worker (sin RLS forzada — ver README
 * §Seguridad), así que un job `run_agent` con `agentRunId`/`organizationId`
 * inconsistentes (bug/dato corrupto en quien encola el job) podía
 * sobrescribir en silencio el resultado de la corrida de OTRO tenant.
 * `packages/db/migrations/0028_worker_role.sql` ya aplicó el `worker_role`
 * dedicado (WK-08 esquema, antes PENDIENTE); su propio comentario documenta
 * el contrato exacto: `agent_runs` NO necesita ninguna política RLS nueva
 * porque la política de organización YA EXISTENTE (`org_id =
 * current_org_id() and has_role(org_id, write_roles)`, 0008) se satisface
 * fijando `app.current_org_id` Y `app.current_user_id` = el actor REAL de
 * la corrida (con membresía activa y rol de escritura en esa org) — no un
 * usuario de servicio genérico, la migración no crea ninguno.
 * `packages/db/test/worker-role-and-job-proposals.test.ts` (packages/db,
 * fuera de este ámbito) ya confirma este contrato contra las políticas
 * reales con `SET LOCAL ROLE worker_role`.
 *
 * Antes de esta ronda, `updateAgentRunRow` fijaba `app.current_org_id` pero
 * **nunca** `app.current_user_id` y seguía corriendo con la conexión
 * propietaria (sin `SET ROLE worker_role`) — el día que esa conexión se
 * hubiera migrado a `worker_role` tal cual estaba el código, RLS habría
 * bloqueado hasta el UPDATE legítimo (falso positivo de "otro tenant").
 * Ahora esta función:
 *  1. Valida `organizationId` y `actorId` como UUID (zod) — fail-closed con
 *     mensaje explícito si alguno no lo es, ANTES de tocar la base de
 *     datos, en vez de dejar que un `set_config`/cast de Postgres falle con
 *     un error críptico o, peor, que `has_role()` evalúe silenciosamente
 *     `current_user_id() = null`.
 *  2. Adopta `worker_role` de verdad (`set local role worker_role`, ámbito
 *     de transacción) y fija `app.current_org_id`/`app.current_user_id` =
 *     `actorId` (el actor real que originó la corrida, ya conocido por
 *     `apps/api` al encolar el job — ver `RunAgentPayload.actorId`).
 *  3. El propio UPDATE sigue filtrando explícitamente `org_id =
 *     $organizationId` además de `id` (defensa en profundidad adicional,
 *     redundante con RLS pero sin costo): si la fila real pertenece a otra
 *     organización, o RLS bloquea porque `actorId` no tiene membresía de
 *     escritura activa en esa org, el `UPDATE` no toca ninguna fila
 *     (`rowCount = 0`) y se lanza un error explícito (nunca un no-op
 *     silencioso).
 */
class AgentRunOrgMismatchError extends Error {
  /** Reintentar no arregla un `agentRunId`/`organizationId` inconsistente: es un error permanente (ver WK-10, queue/errors.ts). */
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunOrgMismatchError';
  }
}

/**
 * WK-16 (docs/auditoria-1/worker-reverificacion.md, cierre de WK-08
 * PARCIAL) + WK-19 (docs/auditoria-1/worker-cierre.md): `organizationId:
 * null` — un valor EXPLÍCITAMENTE válido según el tipo
 * `RunAgentPayload.organizationId: string | null` — desactivaba por
 * completo el `WHERE` de `updateAgentRunRow`, permitiendo que CUALQUIER job
 * con `agentRunId` real de CUALQUIER tenant y `organizationId: null`
 * sobrescribiera esa fila sin ningún error. El guard original
 * (`!organizationId`, WK-16) cerró `null`/`undefined`/`''`, pero un valor
 * TRUTHY-pero-inválido (`'  '` solo espacios, un objeto) lo seguía
 * bypaseando — confirmado por la reverificación (WK-19): esos casos no
 * corrompían datos (Postgres rechaza el cast a `uuid`), pero clasificaban
 * como error transitorio genérico en vez de fallar rápido y explícito.
 * Ahora el guard valida con `z.string().uuid()` (fail-closed PERMANENTE,
 * mensaje claro) en vez de un truthy-check: cualquier valor que no sea un
 * UUID de organización real — nulo, vacío, solo espacios, un objeto, un
 * número — hace fallar el job ANTES de tocar la base de datos, ni siquiera
 * se corre el `AgentRunner`. El único caso legítimo de `organizationId:
 * null` ("fire and forget" sin persistencia) nunca pasa por aquí porque no
 * trae `agentRunId`.
 */
class RunAgentMissingOrganizationError extends Error {
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'RunAgentMissingOrganizationError';
  }
}

/**
 * WK-23 (docs/auditoria-1/worker-cierre.md, ALTA): `actorId` se usa como
 * `app.current_user_id` bajo `worker_role` (ver comentario de
 * `updateAgentRunRow`); un valor que no sea un UUID real haría que
 * Postgres fallara el `set_config`/cast con un error críptico, o que
 * `has_role()` lo tratara silenciosamente como "sin membresía" — en ambos
 * casos indistinguible de un mismatch de organización real. Fail-closed
 * explícito en vez de eso.
 */
class RunAgentInvalidActorError extends Error {
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'RunAgentInvalidActorError';
  }
}

const uuidSchema = z.string().uuid();

/**
 * Ronda 6: resumen REDACTADO de cada `ToolCallTrace` (nunca el `input`/
 * `output` crudo — esos ya viven solo en memoria durante la vida del job,
 * ver README §Pendientes "tool_calls no persiste en Postgres") para que la
 * fila `agent_runs.output` sea una propuesta revisable por un humano:
 * qué herramienta corrió, con qué resultado, y si quedó bloqueada por
 * autorización/guardrail/no-fabricación — sin exponer datos potencialmente
 * sensibles en texto plano. `inputHash`/`outputHash` (sha256,
 * `packages/agents/src/tracing.ts`) permiten correlacionar con los logs del
 * proceso si hiciera falta auditar el detalle completo.
 */
function summarizeToolCalls(toolCalls: ToolCallTrace[]): unknown[] {
  return toolCalls.map((t) => ({
    stepIndex: t.stepIndex,
    toolName: t.toolName,
    status: t.status,
    authorizationDecision: t.authorizationDecision ?? null,
    missingSourcedFields: t.missingSourcedFields ?? [],
    error: t.error ?? null,
    inputHash: t.inputHash,
    outputHash: t.outputHash ?? null,
    attempts: t.attempts,
    // WK6-02 (docs/auditoria-2/worker-agentes.md, ALTA): cada `ToolCallTrace`
    // YA trae su propio `correlationId` (packages/agents/src/stores.ts,
    // heredado de `AgentRunRequest.correlationId`) — se incluye aquí para
    // que una consulta de auditoría por `correlation_id` (REQ-171) pueda
    // reconstruir, dentro de `agent_runs.output`, qué tool_call específico
    // corresponde a qué convocatoria/expediente, sin depender solo del
    // `correlationId` a nivel de corrida (ver `correlationId` más abajo en
    // `updateAgentRunRow`).
    correlationId: t.correlationId ?? null,
  }));
}

async function updateAgentRunRow(
  db: DbClient,
  agentRunId: string,
  organizationId: string,
  actorId: string,
  run: AgentRun,
  toolCalls: ToolCallTrace[],
): Promise<void> {
  if (!uuidSchema.safeParse(organizationId).success) {
    throw new AgentRunOrgMismatchError(
      `run_agent: organizationId=${JSON.stringify(organizationId)} no es un UUID válido — no se puede actualizar agent_runs id=${agentRunId} de forma segura. Ninguna escritura se realizó.`,
    );
  }
  if (!uuidSchema.safeParse(actorId).success) {
    throw new RunAgentInvalidActorError(
      `run_agent: actorId=${JSON.stringify(actorId)} no es un UUID válido — no se puede establecer la identidad de servicio (app.current_user_id) requerida por la RLS de agent_runs bajo worker_role (WK-23). Ninguna escritura se realizó.`,
    );
  }

  const output = JSON.stringify({
    richStatus: run.status,
    error: run.error ?? null,
    completedSteps: run.completedSteps,
    totalSteps: run.totalSteps,
    // WK6-02 (docs/auditoria-2/worker-agentes.md, ALTA) + E20 (docs/BACKLOG.md):
    // antes de esta ronda `run.correlationId` (el identificador de NEGOCIO,
    // p. ej. `tenderId` — ver `RunAgentPayload.correlationId`) se calculaba
    // y se guardaba en memoria (`AgentRun.correlationId`/
    // `ToolCallTrace.correlationId`, packages/agents) pero solo se
    // persistía aquí, en `output` (JSONB) — nunca en la columna dedicada
    // `agent_runs.correlation_id`, que YA EXISTE desde
    // `packages/db/migrations/0017_ronda2_extensions.sql` (con su propio
    // índice `ix_agent_runs_correlation`) pero que esta función nunca
    // escribía. `output->>'correlationId'` se conserva por compatibilidad
    // hacia atrás (nada lo borra), pero la consulta de auditoría de
    // REQ-171 ya no necesita ir contra el JSONB — ver la columna real más
    // abajo en el propio `UPDATE` (`packages/db/migrations/
    // 0088_e20_agent_runs_correlation_id.sql` backfillea las filas viejas
    // que solo la tenían en `output`).
    correlationId: run.correlationId ?? null,
    // Ronda 6: persistencia de "propuesta para revisión" usando el esquema
    // YA EXISTENTE (agent_runs.output jsonb) — sin requerir el grant de
    // INSERT/columnas nuevas de `tool_calls` (PROPOSAL-06 solo pide select
    // de negocio + insert/update de agent_runs para corridas autónomas).
    toolCalls: summarizeToolCalls(toolCalls),
  });
  const status = toDbAgentRunStatus(run.status);
  const finishedAt = run.finishedAt ?? new Date().toISOString();

  await db.transaction(async (tx) => {
    // WK-23: adopta worker_role real (packages/db/migrations/0028_worker_role.sql)
    // para esta escritura sensible a RLS — no solo se "prepara el contexto
    // para cuando exista worker_role", como decía la nota WK-08 anterior:
    // el rol ya existe y ya está aplicado, así que esta operación concreta
    // lo usa de verdad.
    await tx.query('set local role worker_role');
    await tx.query("select set_config('app.current_org_id', $1, true)", [organizationId]);
    // WK-23: identidad de servicio = el actor REAL que originó la corrida
    // (ver RunAgentPayload.actorId), nunca un usuario de sistema genérico —
    // 0028 no crea ninguno; su propio comentario documenta que la política
    // de organización existente ya cubre este caso combinada con el actor
    // real, que debe tener membresía activa y rol de escritura en
    // `organizationId` para que RLS permita el UPDATE.
    await tx.query("select set_config('app.current_user_id', $1, true)", [actorId]);

    // El filtro explícito `org_id = $organizationId` sigue aquí como
    // defensa en profundidad adicional (WK-08 original), redundante con
    // RLS pero sin costo: cubre tanto "la fila es de otro tenant" como
    // "RLS bloqueó el UPDATE" (actorId sin membresía de escritura activa
    // en esa org) — ambos casos son, desde la perspectiva de este job, la
    // misma condición de fallo: "no se pudo actualizar de forma segura".
    // E20 (docs/BACKLOG.md): `correlation_id` (columna real, no solo el
    // JSONB de `output` de arriba) se escribe en el MISMO UPDATE que cierra
    // la corrida — `run.correlationId ?? null` es idéntico al valor que ya
    // va dentro de `output`, así que ambos quedan siempre consistentes.
    const { rowCount } = await tx.query(
      `update agent_runs
       set status = $2, output = $3::jsonb, finished_at = $4, correlation_id = $6
       where id = $1 and org_id = $5::uuid`,
      [agentRunId, status, output, finishedAt, organizationId, run.correlationId ?? null],
    );

    if (rowCount === 0) {
      throw new AgentRunOrgMismatchError(
        `run_agent: no se actualizó agent_runs id=${agentRunId} — la fila no existe, su org_id real no coincide con organizationId=${organizationId} del payload del job, o la RLS de worker_role bloqueó el UPDATE porque actorId=${actorId} no tiene membresía de escritura activa en esa organización (WK-08/WK-23: ninguna corrida de otro tenant fue tocada).`,
      );
    }
  });
}

/** Registro combinado: la herramienta de demostración original del esqueleto + las 8 herramientas de negocio (Ronda 6). */
function buildFullToolRegistry(provider: LLMProvider, businessDeps: { db: DbClient; queue: JobQueue }): ToolRegistry {
  const registry = buildDemoToolRegistry(provider);
  const businessRegistry = buildBusinessToolRegistry({ db: businessDeps.db, queue: businessDeps.queue, provider });
  for (const tool of businessRegistry.list()) registry.register(tool);
  return registry;
}

/**
 * Estados terminales de `AgentRun` que requieren acción HUMANA (aprobación,
 * completar un dato faltante, revisar una convocatoria invalidada) o
 * reflejan una prohibición dura — reintentar el job NUNCA los resuelve
 * (WK-10, `src/queue/errors.ts`: mismo criterio que un error `permanent`).
 * `failed`/`cancelled`/`timed_out` SÍ pueden ser transitorios (un error de
 * red, una cancelación de cierre ordenado, un timeout de infraestructura)
 * y siguen el ciclo normal de reintentos con backoff.
 */
const HUMAN_REVIEW_RUN_STATUSES = new Set<AgentRun['status']>(['denied', 'blocked', 'needs_approval', 'needs_data', 'invalidated']);

/**
 * Handler de `run_agent` (Ronda 6, docs/investigacion/paridad-producto.md
 * "Ronda K": "completar run_agent con lógica real de negocio"). Ejecuta un
 * `AgentRunner` de `packages/agents` con almacenes en memoria para el ciclo
 * de vida DENTRO del job (esa librería es pura, sin persistencia propia —
 * ver su README); el resultado FINAL (incluido un resumen redactado de cada
 * tool_call, ver `summarizeToolCalls`) se refleja en la fila `agent_runs`
 * ya existente si el job trae `agentRunId` (mismo mecanismo que el
 * esqueleto original, `updateAgentRunRow`).
 *
 * Dos caminos según `agentName`:
 *  - Uno de `NAMED_AGENTS` (`src/agents/named-agents.ts`): plan FIJO de
 *    tool_calls de negocio (`src/agents/business-tools.ts`), construido en
 *    CÓDIGO a partir de `job.payload.context` — el modelo nunca decide qué
 *    herramienta ejecutar.
 *  - Cualquier otro nombre: la herramienta de demostración original del
 *    esqueleto (`llm_complete`), mantenida por compatibilidad con el uso
 *    "prompt libre" documentado desde la ronda anterior.
 *
 * Presupuesto por organización (REQ-128): `BudgetLedger`/`IdempotencyStore`/
 * `TokenBucketRateLimiter`/`DependencyInvalidationRegistry` se crean UNA
 * VEZ por instancia de handler (persisten mientras dure el proceso, ver
 * `apps/worker/src/index.ts`: `createRunAgentHandler` se llama una sola
 * vez al arrancar) — antes de esta ronda se recreaban en cada job,
 * vaciando en silencio cualquier límite "por organización" en cada corrida.
 */
export function createRunAgentHandler(deps: RunAgentHandlerDeps): JobHandler<RunAgentPayload> {
  const queue = deps.queue ?? new JobQueue({ db: deps.db });
  const budgetLedger = new BudgetLedger();
  const idempotencyStore = new IdempotencyStore();
  const rateLimiter = new TokenBucketRateLimiter(60, 1);
  const dependencyRegistry = new DependencyInvalidationRegistry();
  const env = deps.env ?? process.env;
  const budgetUsdPerOrg = deps.budgetUsdPerOrg ?? Number(env.WORKER_AGENT_BUDGET_USD_PER_ORG ?? '5');

  return async (job) => {
    // WK-16 (docs/auditoria-1/worker-reverificacion.md) + WK-19
    // (docs/auditoria-1/worker-cierre.md): fail-closed ANTES de correr
    // nada. El guard original (`!organizationId`) cubría `null`,
    // `undefined` y `''`, pero un valor TRUTHY-pero-inválido (`'  '`, un
    // objeto) lo bypaseaba — validar con `z.string().uuid()` en vez de un
    // truthy-check cierra ese borde: cualquier cosa que no sea un UUID de
    // organización real hace fallar el job aquí. Nunca se llega a
    // `updateAgentRunRow` ni se escribe una sola fila en `agent_runs` en
    // este caso — el job muere permanente en el primer intento (WK-10:
    // reintentar no arregla un payload inconsistente).
    if (job.payload.agentRunId && !uuidSchema.safeParse(job.payload.organizationId).success) {
      throw new RunAgentMissingOrganizationError(
        `run_agent: agentRunId=${job.payload.agentRunId} viene con organizationId=${JSON.stringify(job.payload.organizationId)} inválido (se requiere un UUID de organización, no solo un valor no-vacío) — org requerida para persistir en agent_runs. Fail-closed (WK-16/WK-19): ninguna escritura se realizó.`,
      );
    }

    // Ronda 6, tarea 4: kill-switch por agente (WORKER_DISABLED_AGENTS).
    // Se evalúa ANTES de construir el registro/runner: ningún tool_call se
    // ejecuta ni se reserva presupuesto para un agente deshabilitado.
    assertAgentNotDisabled(job.payload.agentName, parseDisabledAgents(env));

    const provider = deps.buildProvider ? deps.buildProvider() : buildLlmProvider(process.env.OPENAI_API_KEY);
    const registry = buildFullToolRegistry(provider, { db: deps.db, queue });
    const toolCallStore = new InMemoryToolCallStore();

    if (Number.isFinite(budgetUsdPerOrg)) {
      budgetLedger.setLimit(job.payload.organizationId, budgetUsdPerOrg);
    }

    const runner = new AgentRunner({
      registry,
      authorizationPolicy: new AuthorizationPolicy(),
      guardrail: new AntiCorruptionGuardrail(),
      runStore: new InMemoryRunStore(),
      toolCallStore,
      idempotencyStore,
      budgetLedger,
      rateLimiter,
      dependencyRegistry,
    });

    const agentName = job.payload.agentName;
    const steps = isNamedAgent(agentName)
      ? buildNamedAgentPlan(agentName, job.payload.context ?? {})
      : [{ toolName: 'llm_complete', input: { prompt: job.payload.prompt ?? '', tier: job.payload.tier ?? 'economico' } }];

    const request: AgentRunRequest = {
      organizationId: job.payload.organizationId,
      actorId: job.payload.actorId,
      actorRole: job.payload.actorRole,
      agentName,
      steps,
      correlationId: job.payload.correlationId ?? job.id,
    };

    const run = await runner.run(request);
    const toolCalls = await toolCallStore.listToolCalls(run.id);

    if (job.payload.agentRunId) {
      // El guard fail-closed de arriba (WK-16/WK-19) ya garantiza que, si
      // llegamos aquí con `agentRunId`, `organizationId` es un UUID válido.
      // `actorId` (WK-23) se valida dentro de `updateAgentRunRow`.
      await updateAgentRunRow(
        deps.db,
        job.payload.agentRunId,
        job.payload.organizationId as string,
        job.payload.actorId,
        run,
        toolCalls,
      );
    }

    if (run.status !== 'completed') {
      const message = `run_agent: la corrida terminó en estado "${run.status}" (${run.error ?? 'sin detalle'})`;
      if (HUMAN_REVIEW_RUN_STATUSES.has(run.status)) {
        const error = new Error(message) as Error & { permanent: true };
        error.permanent = true;
        throw error;
      }
      throw new Error(message);
    }
  };
}

export { NAMED_AGENTS };
