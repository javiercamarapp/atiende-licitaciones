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
 * WK-08 (docs/auditoria-1/worker.md): antes de esta ronda este UPDATE solo
 * filtraba por `id`. Con la conexión "propietaria" del worker (sin RLS
 * forzada — ver README §Seguridad) eso significa que un job `run_agent` con
 * `agentRunId`/`organizationId` inconsistentes (bug/dato corrupto en quien
 * encola el job, fuera del control de este worker) podía sobrescribir en
 * silencio el resultado de la corrida de OTRO tenant, sin que ninguna capa
 * lo impidiera. Ahora, como defensa en profundidad MIENTRAS no exista un
 * `worker_role` dedicado con RLS real (propuesta en
 * `apps/worker/db-proposals/0026-worker-role.sql`, PENDIENTE esquema):
 *  1. Se fija `app.current_org_id` (vía `set_config`, alcance de
 *     transacción) incluso bajo la conexión propietaria — no lo hace
 *     cumplir RLS hoy (esa conexión no corre como `app_role`), pero deja el
 *     contexto correcto listo para cuando el `worker_role` propuesto sí lo
 *     haga, y sirve de traza/auditoría de qué org se creía estar tocando.
 *  2. El propio UPDATE filtra explícitamente `org_id = $organizationId`
 *     además de `id`: si la fila real pertenece a otra organización, el
 *     `UPDATE` no toca NINGUNA fila (`rowCount = 0`) en vez de sobrescribir
 *     la corrida de otro tenant. Se lanza un error explícito en ese caso
 *     (nunca un no-op silencioso) para que el job falle de forma visible.
 */
class AgentRunOrgMismatchError extends Error {
  /** Reintentar no arregla un `agentRunId`/`organizationId` inconsistente: es un error permanente (ver WK-10, queue/errors.ts). */
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'AgentRunOrgMismatchError';
  }
}

async function updateAgentRunRow(db: DbClient, agentRunId: string, organizationId: string | null, run: AgentRun): Promise<void> {
  const output = JSON.stringify({
    richStatus: run.status,
    error: run.error ?? null,
    completedSteps: run.completedSteps,
    totalSteps: run.totalSteps,
  });
  const status = toDbAgentRunStatus(run.status);
  const finishedAt = run.finishedAt ?? new Date().toISOString();

  await db.transaction(async (tx) => {
    await tx.query("select set_config('app.current_org_id', $1, true)", [organizationId ?? '']);

    const { rowCount } = await tx.query(
      `update agent_runs
       set status = $2, output = $3::jsonb, finished_at = $4
       where id = $1 and ($5::uuid is null or org_id = $5::uuid)`,
      [agentRunId, status, output, finishedAt, organizationId],
    );

    if (rowCount === 0) {
      throw new AgentRunOrgMismatchError(
        `run_agent: no se actualizó agent_runs id=${agentRunId} — la fila no existe o su org_id real no coincide con organizationId=${organizationId} del payload del job (WK-08: defensa en profundidad, ninguna corrida de otro tenant fue tocada).`,
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
      await updateAgentRunRow(deps.db, job.payload.agentRunId, job.payload.organizationId, run);
    }

    if (run.status !== 'completed') {
      throw new Error(`run_agent: la corrida terminó en estado "${run.status}" (${run.error ?? 'sin detalle'})`);
    }
  };
}
