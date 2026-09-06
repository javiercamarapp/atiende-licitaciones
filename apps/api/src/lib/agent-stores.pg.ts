import { randomUUID } from 'node:crypto';
import type {
  AgentRun,
  AgentRunCreateInput,
  RunStore,
  ToolCallStore,
  ToolCallTrace,
  Role as AgentRole,
} from '@atiende/agents';
import type { DbClient, DbExecutor, OrgRole } from '@atiende/db';

/**
 * TODO DE UNIFICACIÓN (documentado, no resuelto en esta ronda):
 * `packages/agents` define su propio vocabulario de roles (`Role`:
 * director/licitador/legal/finanzas/consultor_externo/representante_legal/
 * system/superadmin, del blueprint original) que NO coincide con
 * `OrgRole` de `packages/db`/apps/api (owner/admin/analyst/writer/
 * reviewer/viewer, el modelo de roles realmente implementado en ronda 1).
 * Estos dos vocabularios de rol son inconsistentes entre paquetes; unificarlos
 * es una decisión de arquitectura mayor fuera del alcance de esta ronda.
 * La columna `actor_role` de `agent_runs`/`tool_calls` (packages/db) usa el
 * enum `org_role` real del sistema (es lo único que RLS/roles conocen); el
 * cast explícito de abajo documenta la discrepancia en vez de ocultarla.
 */
function toAgentRole(role: OrgRole): AgentRole {
  return role as unknown as AgentRole;
}
function toOrgRole(role: AgentRole): OrgRole {
  return role as unknown as OrgRole;
}

/**
 * Adaptadores Postgres de `RunStore`/`ToolCallStore` (packages/agents,
 * interfaces puras sin dependencia de base de datos) sobre
 * `agent_runs`/`tool_calls` (packages/db, extendidas en
 * migrations/0017_ronda2_extensions.sql con las columnas que estas
 * interfaces necesitan: actor_id/actor_role/total_steps/completed_steps/
 * pending_step_index/correlation_id/estimated_cost_usd/error en
 * agent_runs; step_index/actor_id_trace/actor_role/status/started_at/
 * finished_at/input_hash/output_hash/attempts/estimated_tokens/
 * estimated_cost_usd/authorization_reason/error/correlation_id/
 * missing_sourced_fields en tool_calls).
 *
 * Cada método abre su propia transacción con `SET LOCAL ROLE app_role` +
 * contexto de tenant (mismo patrón que el resto de apps/api): el
 * `AgentRunner` de packages/agents es agnóstico a esto por diseño (no
 * conoce Postgres ni RLS), así que la responsabilidad de aislar por
 * organización recae enteramente en este adaptador.
 */
export class PgRunStore implements RunStore {
  constructor(private readonly db: DbClient) {}

  private async withTenant<T>(orgId: string, userId: string | null, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query("select set_config('app.current_org_id', $1, true)", [orgId]);
      await tx.query("select set_config('app.current_user_id', $1, true)", [userId]);
      return fn(tx);
    });
  }

  async createRun(input: AgentRunCreateInput): Promise<AgentRun> {
    if (!input.organizationId) {
      // `agent_runs.org_id` es NOT NULL en packages/db (migrations/0004):
      // este adaptador Postgres no soporta corridas "de plataforma" sin
      // organización (packages/agents sí las modela como concepto general,
      // pero ninguna ruta de apps/api las produce en esta ronda).
      throw new Error('PgRunStore requiere organizationId: no se soportan corridas sin organización en este esquema');
    }
    const id = randomUUID();
    return this.withTenant(input.organizationId, input.actorId, async (tx) => {
      await tx.query(
        `insert into agent_runs (id, org_id, agent_name, actor_id, actor_role, status, total_steps, completed_steps, correlation_id, estimated_cost_usd)
         values ($1, $2, $3, $4, $5, 'in_progress', $6, 0, $7, 0)`,
        [id, input.organizationId, input.agentName, input.actorId, toOrgRole(input.actorRole), input.totalSteps, input.correlationId ?? null]
      );
      const run = await this.getRunInTx(tx, id);
      if (!run) throw new Error(`No se pudo crear agent_run ${id}`);
      return run;
    });
  }

  async updateRun(runId: string, patch: Partial<Omit<AgentRun, 'id'>>): Promise<AgentRun> {
    // No hay contexto de organización disponible en la firma de `updateRun`
    // (packages/agents no lo pasa). Se resuelve el `org_id` real de la fila
    // vía `app.agent_run_context` (SECURITY DEFINER, ver
    // packages/db/migrations/0025_agent_run_lookup_helpers.sql) -- una
    // consulta directa con `app_role` y sin contexto fijado devolvería 0
    // filas siempre (RLS exige `org_id = app.current_org_id()`, que es NULL
    // hasta que lo fijamos, precisamente lo que esta consulta resuelve).
    const row = await this.resolveContext(runId);
    if (!row) throw new Error(`Corrida desconocida: "${runId}"`);

    return this.withTenant(row.org_id, row.actor_id, async (tx) => {
      const sets: string[] = [];
      const values: unknown[] = [];
      let i = 1;
      const push = (col: string, val: unknown) => {
        sets.push(`${col} = $${i++}`);
        values.push(val);
      };
      if (patch.status !== undefined) push('status', patch.status);
      if (patch.completedSteps !== undefined) push('completed_steps', patch.completedSteps);
      if (patch.pendingStepIndex !== undefined) push('pending_step_index', patch.pendingStepIndex);
      if (patch.error !== undefined) push('error', patch.error);
      if (patch.estimatedCostUsd !== undefined) push('estimated_cost_usd', patch.estimatedCostUsd);
      if (patch.finishedAt !== undefined) push('finished_at', patch.finishedAt);

      if (sets.length > 0) {
        values.push(runId);
        await tx.query(`update agent_runs set ${sets.join(', ')} where id = $${i}`, values);
      }
      const run = await this.getRunInTx(tx, runId);
      if (!run) throw new Error(`Corrida desconocida tras actualizar: "${runId}"`);
      return run;
    });
  }

  async getRun(runId: string): Promise<AgentRun | undefined> {
    const row = await this.resolveContext(runId);
    if (!row) return undefined;
    return this.withTenant(row.org_id, row.actor_id, (tx) => this.getRunInTx(tx, runId));
  }

  private async resolveContext(runId: string): Promise<{ org_id: string; actor_id: string | null } | undefined> {
    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ org_id: string; actor_id: string | null }>('select * from app.agent_run_context($1)', [runId]);
    });
    return rows[0];
  }

  private async getRunInTx(tx: DbExecutor, runId: string): Promise<AgentRun | undefined> {
    const { rows } = await tx.query<{
      id: string;
      org_id: string;
      agent_name: string;
      actor_id: string | null;
      actor_role: string | null;
      status: string;
      started_at: string;
      finished_at: string | null;
      total_steps: number;
      completed_steps: number;
      pending_step_index: number | null;
      error: string | null;
      estimated_cost_usd: string;
      correlation_id: string | null;
    }>('select * from agent_runs where id = $1', [runId]);
    const r = rows[0];
    if (!r) return undefined;
    return {
      id: r.id,
      organizationId: r.org_id,
      agentName: r.agent_name,
      actorId: r.actor_id ?? '',
      actorRole: toAgentRole((r.actor_role ?? 'writer') as OrgRole),
      status: r.status as AgentRun['status'],
      startedAt: r.started_at,
      finishedAt: r.finished_at ?? undefined,
      totalSteps: r.total_steps,
      completedSteps: r.completed_steps,
      pendingStepIndex: r.pending_step_index ?? undefined,
      error: r.error ?? undefined,
      estimatedCostUsd: Number(r.estimated_cost_usd),
      correlationId: r.correlation_id,
    };
  }
}

export class PgToolCallStore implements ToolCallStore {
  constructor(private readonly db: DbClient) {}

  async recordToolCall(trace: ToolCallTrace): Promise<ToolCallTrace> {
    await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query("select set_config('app.current_org_id', $1, true)", [trace.organizationId]);
      await tx.query("select set_config('app.current_user_id', $1, true)", [trace.actorId]);
      await tx.query(
        `insert into tool_calls (
           id, org_id, agent_run_id, tool_name, step_index, actor_id_trace, actor_role, status,
           started_at, finished_at, input_hash, output_hash, attempts, estimated_tokens, estimated_cost_usd,
           authorization_status, authorization_reason, error, correlation_id, missing_sourced_fields
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         on conflict (id) do update set
           status = excluded.status, finished_at = excluded.finished_at, output_hash = excluded.output_hash,
           attempts = excluded.attempts, estimated_tokens = excluded.estimated_tokens,
           estimated_cost_usd = excluded.estimated_cost_usd, authorization_status = excluded.authorization_status,
           authorization_reason = excluded.authorization_reason, error = excluded.error,
           missing_sourced_fields = excluded.missing_sourced_fields`,
        [
          trace.id,
          trace.organizationId,
          trace.runId,
          trace.toolName,
          trace.stepIndex,
          trace.actorId,
          toOrgRole(trace.actorRole),
          trace.status,
          trace.startedAt,
          trace.finishedAt ?? null,
          trace.inputHash,
          trace.outputHash ?? null,
          trace.attempts,
          trace.estimatedTokens,
          trace.estimatedCostUsd,
          mapToAuthorizationStatus(trace.authorizationDecision),
          trace.authorizationReason ?? null,
          trace.error ?? null,
          trace.correlationId,
          trace.missingSourcedFields ?? null,
        ]
      );
    });
    return trace;
  }

  async listToolCalls(runId: string): Promise<ToolCallTrace[]> {
    // Mismo problema que RunStore.getRun/updateRun: no hay org_id en la
    // firma. Se resuelve vía app.agent_run_context (misma corrida) antes de
    // fijar el contexto de tenant.
    const { rows: contextRows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ org_id: string; actor_id: string | null }>('select * from app.agent_run_context($1)', [runId]);
    });
    const context = contextRows[0];
    if (!context) return [];

    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query("select set_config('app.current_org_id', $1, true)", [context.org_id]);
      await tx.query("select set_config('app.current_user_id', $1, true)", [context.actor_id]);
      return tx.query<Record<string, unknown>>('select * from tool_calls where agent_run_id = $1 order by step_index asc', [runId]);
    });
    return rows.map(mapToolCallRow);
  }
}

function mapToAuthorizationStatus(decision: ToolCallTrace['authorizationDecision']): 'auto' | 'pending' | 'approved' | 'denied' {
  if (decision === 'pending') return 'pending';
  if (decision === 'denied') return 'denied';
  return 'auto';
}

export function mapToolCallRow(r: Record<string, unknown>): ToolCallTrace {
  return {
    id: r.id as string,
    runId: r.agent_run_id as string,
    stepIndex: r.step_index as number,
    toolName: r.tool_name as string,
    organizationId: r.org_id as string,
    actorId: (r.actor_id_trace as string | null) ?? '',
    actorRole: toAgentRole((r.actor_role as OrgRole) ?? 'writer'),
    status: r.status as ToolCallTrace['status'],
    startedAt: r.started_at as string,
    finishedAt: (r.finished_at as string | null) ?? undefined,
    inputHash: r.input_hash as string,
    outputHash: (r.output_hash as string | null) ?? undefined,
    attempts: r.attempts as number,
    estimatedTokens: r.estimated_tokens as number,
    estimatedCostUsd: Number(r.estimated_cost_usd),
    authorizationDecision: r.authorization_status as ToolCallTrace['authorizationDecision'],
    authorizationReason: (r.authorization_reason as string | null) ?? undefined,
    error: (r.error as string | null) ?? undefined,
    correlationId: r.correlation_id as string | null,
    missingSourcedFields: (r.missing_sourced_fields as string[] | null) ?? undefined,
  };
}
