import { z } from 'zod';
import type { DbClient } from '@atiende/db';
import {
  AgentRunner,
  AuthorizationPolicy,
  AntiCorruptionGuardrail,
  BudgetLedger,
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
} from '@atiende/agents';
import type { JobHandler } from '../queue/types.js';

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
  agentName: string;
  /** Prompt de demostración para el esqueleto (ver README §Pendientes: sin herramientas de negocio reales todavía). */
  prompt: string;
  tier?: ModelTier;
}

export interface RunAgentHandlerDeps {
  db: DbClient;
  /** Inyectable para pruebas; por defecto usa `buildLlmProvider()` (Fake salvo `OPENAI_API_KEY`). */
  buildProvider?: () => LLMProvider;
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

async function updateAgentRunRow(
  db: DbClient,
  agentRunId: string,
  organizationId: string,
  actorId: string,
  run: AgentRun,
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
    const { rowCount } = await tx.query(
      `update agent_runs
       set status = $2, output = $3::jsonb, finished_at = $4
       where id = $1 and org_id = $5::uuid`,
      [agentRunId, status, output, finishedAt, organizationId],
    );

    if (rowCount === 0) {
      throw new AgentRunOrgMismatchError(
        `run_agent: no se actualizó agent_runs id=${agentRunId} — la fila no existe, su org_id real no coincide con organizationId=${organizationId} del payload del job, o la RLS de worker_role bloqueó el UPDATE porque actorId=${actorId} no tiene membresía de escritura activa en esa organización (WK-08/WK-23: ninguna corrida de otro tenant fue tocada).`,
      );
    }
  });
}

/**
 * Handler ESQUELETO de `run_agent` (pedido explícitamente así en esta
 * ronda). Ejecuta un `AgentRunner` de `packages/agents` con almacenes en
 * memoria (ese paquete es una librería pura sin persistencia propia — ver
 * su README): cada corrida vive solo mientras dura el job. PENDIENTE (ver
 * README §Pendientes): persistir `RunStore`/`ToolCallStore` reales contra
 * Postgres (`agent_runs`/`tool_calls`) es responsabilidad de `apps/api`
 * (fuera de alcance de `packages/db` en esta ronda); aquí solo se refleja
 * el resultado FINAL en la fila `agent_runs` ya existente, si el job trae
 * `agentRunId`.
 */
export function createRunAgentHandler(deps: RunAgentHandlerDeps): JobHandler<RunAgentPayload> {
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

    const provider = deps.buildProvider ? deps.buildProvider() : buildLlmProvider(process.env.OPENAI_API_KEY);
    const registry = buildDemoToolRegistry(provider);

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

    const request: AgentRunRequest = {
      organizationId: job.payload.organizationId,
      actorId: job.payload.actorId,
      actorRole: job.payload.actorRole,
      agentName: job.payload.agentName,
      steps: [{ toolName: 'llm_complete', input: { prompt: job.payload.prompt, tier: job.payload.tier ?? 'economico' } }],
      correlationId: job.id,
    };

    const run = await runner.run(request);

    if (job.payload.agentRunId) {
      // El guard fail-closed de arriba (WK-16/WK-19) ya garantiza que, si
      // llegamos aquí con `agentRunId`, `organizationId` es un UUID válido.
      // `actorId` (WK-23) se valida dentro de `updateAgentRunRow`.
      await updateAgentRunRow(deps.db, job.payload.agentRunId, job.payload.organizationId as string, job.payload.actorId, run);
    }

    if (run.status !== 'completed') {
      throw new Error(`run_agent: la corrida terminó en estado "${run.status}" (${run.error ?? 'sin detalle'})`);
    }
  };
}
