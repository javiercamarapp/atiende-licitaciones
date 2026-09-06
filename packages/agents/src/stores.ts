import type { OrganizationId, Role } from "./types.js";

/** Estado del ciclo de vida de una corrida de agente. */
export type AgentRunStatus =
  | "in_progress"
  | "needs_approval"
  | "completed"
  | "failed"
  | "denied"
  | "blocked"
  | "cancelled"
  | "timed_out"
  /** Un dato sensible (precio, certificación, experiencia, referencia, firma, vigencia) carece de fuente aprobada. */
  | "needs_data"
  /** Un evento de cambio de bases/plazo invalidó esta corrida antes de (re)ejecutarla (docs/AMPLIACION-BACKOFFICE.md §3/§7). */
  | "invalidated";

export interface AgentRun {
  id: string;
  organizationId: OrganizationId;
  agentName: string;
  actorId: string;
  actorRole: Role;
  status: AgentRunStatus;
  startedAt: string;
  finishedAt?: string;
  totalSteps: number;
  completedSteps: number;
  /** Índice del paso pendiente de aprobación, si `status === 'needs_approval'`. */
  pendingStepIndex?: number;
  error?: string;
  estimatedCostUsd: number;
  /**
   * Identificador que enlaza esta corrida con la convocatoria/expediente de
   * origen, para poder trazar de punta a punta desde la convocatoria hasta
   * cada artefacto derivado (docs/AMPLIACION-BACKOFFICE.md §9).
   */
  correlationId: string | null;
}

export interface AgentRunCreateInput {
  organizationId: OrganizationId;
  agentName: string;
  actorId: string;
  actorRole: Role;
  totalSteps: number;
  correlationId?: string | null;
}

/**
 * Interfaz de persistencia de corridas. `apps/api` la implementará contra
 * Postgres siguiendo el patrón `agente_corrida` (organization_id nullable =
 * corrida de plataforma; "registrar nunca debe lanzar": una implementación
 * real no debe permitir que un fallo de escritura tumbe la ejecución del
 * agente).
 */
export interface RunStore {
  createRun(input: AgentRunCreateInput): Promise<AgentRun>;
  updateRun(runId: string, patch: Partial<Omit<AgentRun, "id">>): Promise<AgentRun>;
  getRun(runId: string): Promise<AgentRun | undefined>;
}

export type ToolCallStatus =
  | "ok"
  | "error"
  | "denied"
  | "pending_approval"
  | "blocked_guardrail"
  | "cancelled"
  | "pending_no_fabrication"
  | "invalidated";

export interface ToolCallTrace {
  id: string;
  runId: string;
  stepIndex: number;
  toolName: string;
  organizationId: OrganizationId;
  actorId: string;
  actorRole: Role;
  status: ToolCallStatus;
  startedAt: string;
  finishedAt?: string;
  /** sha256 hex del input serializado, para trazabilidad sin duplicar payloads sensibles. */
  inputHash: string;
  outputHash?: string;
  attempts: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  authorizationDecision?: "auto" | "pending" | "denied";
  authorizationReason?: string;
  error?: string;
  correlationId: string | null;
  /** Nombres de campo faltantes cuando `status === 'pending_no_fabrication'`. */
  missingSourcedFields?: string[];
}

/**
 * Interfaz de persistencia de tool_calls. `apps/api` la implementará con
 * `unique(tool_name, run_id)` en base para idempotencia real (ver patrón en
 * docs/investigacion/likida-arquitectura.md); esta interfaz es agnóstica al
 * backend.
 */
export interface ToolCallStore {
  recordToolCall(trace: ToolCallTrace): Promise<ToolCallTrace>;
  listToolCalls(runId: string): Promise<ToolCallTrace[]>;
}

export class InMemoryRunStore implements RunStore {
  private readonly runs = new Map<string, AgentRun>();
  private counter = 0;

  async createRun(input: AgentRunCreateInput): Promise<AgentRun> {
    const id = `run-${++this.counter}`;
    const run: AgentRun = {
      id,
      organizationId: input.organizationId,
      agentName: input.agentName,
      actorId: input.actorId,
      actorRole: input.actorRole,
      status: "in_progress",
      startedAt: new Date().toISOString(),
      totalSteps: input.totalSteps,
      completedSteps: 0,
      estimatedCostUsd: 0,
      correlationId: input.correlationId ?? null,
    };
    this.runs.set(id, run);
    return run;
  }

  async updateRun(runId: string, patch: Partial<Omit<AgentRun, "id">>): Promise<AgentRun> {
    const existing = this.runs.get(runId);
    if (!existing) throw new Error(`Corrida desconocida: "${runId}"`);
    const updated: AgentRun = { ...existing, ...patch };
    this.runs.set(runId, updated);
    return updated;
  }

  async getRun(runId: string): Promise<AgentRun | undefined> {
    return this.runs.get(runId);
  }

  /** Utilidad de solo-pruebas: lista todas las corridas en orden de creación. */
  listAll(): AgentRun[] {
    return Array.from(this.runs.values());
  }

  /** Todas las corridas enlazadas al mismo `correlationId` (p. ej. una convocatoria), de punta a punta. */
  listByCorrelationId(correlationId: string): AgentRun[] {
    return this.listAll().filter((run) => run.correlationId === correlationId);
  }
}

export class InMemoryToolCallStore implements ToolCallStore {
  private readonly traces: ToolCallTrace[] = [];

  async recordToolCall(trace: ToolCallTrace): Promise<ToolCallTrace> {
    this.traces.push(trace);
    return trace;
  }

  async listToolCalls(runId: string): Promise<ToolCallTrace[]> {
    return this.traces.filter((t) => t.runId === runId);
  }

  /** Todas las trazas de tool_call enlazadas al mismo `correlationId`, sin importar la corrida. */
  listByCorrelationId(correlationId: string): ToolCallTrace[] {
    return this.traces.filter((t) => t.correlationId === correlationId);
  }
}
