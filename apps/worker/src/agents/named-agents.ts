import { z } from 'zod';
import type { PlannedToolCall } from '@atiende/agents';

/**
 * Agentes nombrados con PLAN FIJO (Ronda 6, docs/investigacion/
 * paridad-producto.md "Ronda K", docs/AMPLIACION-BACKOFFICE.md §3-9): el
 * código decide QUÉ herramientas se llaman y en qué orden — nunca el
 * modelo. El LLM (FakeProvider por defecto, OpenAIResponsesProvider real
 * solo con `OPENAI_API_KEY`) solo redacta texto DENTRO de una herramienta
 * ya decidida (`proponer_matching`/`proponer_seccion_propuesta`), nunca
 * elige qué herramienta ejecutar ni en qué orden.
 */
export const NAMED_AGENTS = [
  'analista_convocatorias',
  'analista_bases',
  'redactor_borrador',
  'vigilante_cambios',
  'recordatorios',
] as const;

export type NamedAgent = (typeof NAMED_AGENTS)[number];

/**
 * Costo estimado (USD) por herramienta, para que `BudgetLedger` (REQ-128)
 * tenga algo real que reservar/consumir por paso — sin esto, ningún paso
 * reservaría presupuesto nunca (`AgentRunner.executeAuthorized` solo
 * reserva si `costUsd > 0`) y el presupuesto por organización sería una
 * configuración sin efecto observable. Valores nominales (no facturación
 * real: `GET /admin/costs` de apps/api ya marca sus costos `estimated:
 * true`, mismo criterio aquí) — más alto para las herramientas que llaman
 * al `LLMProvider` (`proponer_matching`/`proponer_seccion_propuesta`).
 */
const ESTIMATED_COST_USD: Record<string, number> = {
  leer_bases: 0.01,
  leer_perfil_empresa: 0.01,
  proponer_matching: 0.02,
  proponer_requisitos_matriz: 0.01,
  proponer_seccion_propuesta: 0.03,
  resumir_cambios_convocatoria: 0.01,
  programar_alerta: 0.005,
};

function withCost(step: Omit<PlannedToolCall, 'estimatedCostUsd'>): PlannedToolCall {
  return { ...step, estimatedCostUsd: ESTIMATED_COST_USD[step.toolName] ?? 0 };
}

export function isNamedAgent(agentName: string): agentName is NamedAgent {
  return (NAMED_AGENTS as readonly string[]).includes(agentName);
}

const tenderContextSchema = z.object({ tenderId: z.string().uuid() });
const redactorContextSchema = z.object({
  tenderId: z.string().uuid(),
  sectionKeys: z.array(z.string().min(1).max(80)).min(1),
});
const recordatoriosContextSchema = z.object({
  tenderId: z.string().uuid(),
  alert: z.object({
    kind: z.enum(['vencimiento', 'cambio_bases', 'otro']),
    scheduledFor: z.string().datetime(),
    message: z.string().min(1).max(500),
  }),
});

export class InvalidNamedAgentContextError extends Error {
  readonly permanent = true as const;
  constructor(agentName: string, cause: unknown) {
    super(`run_agent: el contexto (job.payload.context) para el agente "${agentName}" es inválido: ${describeZodIssue(cause)}`);
    this.name = 'InvalidNamedAgentContextError';
  }
}

function describeZodIssue(cause: unknown): string {
  if (cause instanceof z.ZodError) return cause.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return String(cause);
}

/**
 * Construye el plan FIJO de tool_calls para un agente nombrado. Lanza
 * `InvalidNamedAgentContextError` (permanente, WK-10: reintentar no arregla
 * un contexto incompleto) si `context` no trae lo que ese agente necesita —
 * fail-closed, nunca "mejor esfuerzo" con datos parciales.
 */
export function buildNamedAgentPlan(agentName: NamedAgent, context: unknown): PlannedToolCall[] {
  switch (agentName) {
    case 'analista_convocatorias': {
      const { tenderId } = parseOrThrow(tenderContextSchema, context, agentName);
      // Nueva convocatoria → resumen de bases + perfil de empresa →
      // matching explicable (propuesta, nunca decisión go/no-go).
      return [
        withCost({ toolName: 'leer_bases', input: { tenderId } }),
        withCost({ toolName: 'leer_perfil_empresa', input: {} }),
        withCost({ toolName: 'proponer_matching', input: { tenderId }, idempotencyKey: `matching:${tenderId}` }),
      ];
    }
    case 'analista_bases': {
      const { tenderId } = parseOrThrow(tenderContextSchema, context, agentName);
      // Bases extraídas → matriz de requisitos propuesta con fuente/página
      // (o motivo explícito de por qué no hay página, ver business-tools.ts).
      return [
        withCost({ toolName: 'leer_bases', input: { tenderId } }),
        withCost({ toolName: 'proponer_requisitos_matriz', input: { tenderId }, idempotencyKey: `matriz:${tenderId}` }),
      ];
    }
    case 'redactor_borrador': {
      const { tenderId, sectionKeys } = parseOrThrow(redactorContextSchema, context, agentName);
      // Secciones con source_ref y bloqueo explícito por dato ausente
      // (business-tools.ts `proponer_seccion_propuesta`).
      return [
        withCost({ toolName: 'leer_perfil_empresa', input: {} }),
        ...sectionKeys.map((sectionKey) =>
          withCost({
            toolName: 'proponer_seccion_propuesta',
            input: { tenderId, sectionKey },
            idempotencyKey: `seccion:${tenderId}:${sectionKey}`,
          }),
        ),
      ];
    }
    case 'vigilante_cambios': {
      const { tenderId } = parseOrThrow(tenderContextSchema, context, agentName);
      // Versión nueva → resumen de cambios + invalidaciones ya aplicadas
      // por el trigger de base de datos (app.invalidate_tender_dependents,
      // packages/db/migrations/0022): este agente solo RESUME, nunca
      // vuelve a aprobar nada invalidado.
      return [
        withCost({ toolName: 'resumir_cambios_convocatoria', input: { tenderId }, idempotencyKey: `resumen-cambios:${tenderId}` }),
      ];
    }
    case 'recordatorios': {
      const { tenderId, alert } = parseOrThrow(recordatoriosContextSchema, context, agentName);
      // Vencimiento próximo → alerta programada (job propio del worker,
      // nunca un envío directo a un tercero).
      return [
        withCost({
          toolName: 'programar_alerta',
          input: { tenderId, kind: alert.kind, scheduledFor: alert.scheduledFor, message: alert.message },
          idempotencyKey: `alerta:${tenderId}:${alert.kind}:${alert.scheduledFor}`,
        }),
      ];
    }
    default: {
      const exhaustive: never = agentName;
      throw new Error(`agente nombrado desconocido: ${String(exhaustive)}`);
    }
  }
}

function parseOrThrow<T extends z.ZodTypeAny>(schema: T, context: unknown, agentName: string): z.infer<T> {
  const result = schema.safeParse(context);
  if (!result.success) throw new InvalidNamedAgentContextError(agentName, result.error);
  return result.data;
}
