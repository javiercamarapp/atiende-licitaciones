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

async function updateAgentRunRow(db: DbClient, agentRunId: string, run: AgentRun): Promise<void> {
  await db.query(
    `update agent_runs
     set status = $2, output = $3::jsonb, finished_at = $4
     where id = $1`,
    [
      agentRunId,
      toDbAgentRunStatus(run.status),
      JSON.stringify({ richStatus: run.status, error: run.error ?? null, completedSteps: run.completedSteps, totalSteps: run.totalSteps }),
      run.finishedAt ?? new Date().toISOString(),
    ],
  );
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
      await updateAgentRunRow(deps.db, job.payload.agentRunId, run);
    }

    if (run.status !== 'completed') {
      throw new Error(`run_agent: la corrida terminó en estado "${run.status}" (${run.error ?? 'sin detalle'})`);
    }
  };
}
