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
import { BoundedCache } from './bounded-cache.js';

/** AE-10: límite de tamaño de la caché de contexto de tenant (ver BoundedCache) -- generoso para cualquier volumen real de corridas concurrentes por proceso, pero finito. */
const RUN_CONTEXT_CACHE_MAX_ENTRIES = 10_000;

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
/**
 * DB-09 (docs/auditoria-1/db-api-reverificacion.md, BAJA, residual tras
 * `0044_fix_db09_agent_run_context_bootstrap_guard.sql`): `getRun`/
 * `updateRun`/`listToolCalls` no reciben `orgId` en su firma (contrato de
 * `RunStore`/`ToolCallStore`, packages/agents, fuera de este ámbito) y
 * necesitaban "descubrir" el `org_id` de una corrida ya existente antes de
 * poder fijar el contexto de tenant -- para eso llaman a
 * `app.agent_run_context` (`SECURITY DEFINER`, packages/db/migrations/0025
 * -- `listToolCalls` la reutiliza tal cual, ya que un `tool_call` se busca
 * por su `agent_run_id`, la misma clave que resuelve la función). El guard
 * de "bootstrap" de 0044 solo
 * rechaza si YA hay una sesión con contexto fijado; estos tres sitios
 * llaman la función DELIBERADAMENTE sin contexto previo (ese es el punto:
 * bootstrapear), así que ese guard no los protege -- cualquiera que
 * alcance este código con un `runId`/`toolCallId` adivinado (UUID, no
 * enumerable en la práctica) obtiene su `org_id`/`actor_id`.
 *
 * Mitigación real implementada aquí (dentro de este archivo, como pidió la
 * reverificación): `createRun`/`recordToolCall` YA conocen el `org_id`/
 * `actor_id` verdaderos en el momento de escribir (vienen del propio
 * `AgentRunCreateInput`/`ToolCallTrace`, nunca de la función oracle). Se
 * cachean en memoria de proceso (`BoundedCache`, LRU acotado -- ver AE-10
 * abajo -- por instancia de store) y `getRun`/`updateRun`/`listToolCalls`
 * la consultan PRIMERO -- una corrida u tool_call creada por ESTA MISMA
 * instancia de proceso nunca vuelve a tocar la función oracle. Solo se
 * recurre a ella como último recurso (p.ej. tras un reinicio de proceso,
 * tal como se comporta hoy): el riesgo residual documentado por la
 * reverificación sigue existiendo para ESE caso, pero el cierre completo
 * (que el propio caller de `RunStore`/`ToolCallStore` -- el futuro
 * `AgentRunner` de packages/agents -- pase la identidad en cada llamada)
 * exige cambiar una interfaz externa a este paquete, fuera de alcance de
 * esta ronda.
 *
 * AE-10 (docs/auditoria-2/api-expediente.md, BAJA hoy / MEDIA latente):
 * la versión anterior de esta caché era un `Map` SIN límite de tamaño ni
 * expiración -- crecería sin cota mientras el proceso viva si una ronda
 * futura cablea `AgentRunner` a rutas HTTP reales (hoy ninguna lo hace,
 * confirmado por `grep`). Ahora es un `BoundedCache` (LRU con tamaño
 * máximo, ver `lib/bounded-cache.ts`): protege incluso ese escenario
 * futuro sin cambiar el comportamiento observable hoy (el camino común --
 * la misma instancia que creó el recurso -- sigue sin tocar el oráculo).
 */
interface RunContext {
  /** `null` solo es real para `PgToolCallStore` (tool_calls de un run de plataforma sin organización); `PgRunStore.createRun` rechaza `organizationId` nulo, así que ahí siempre es `string`. */
  orgId: string | null;
  actorId: string | null;
}

export class PgRunStore implements RunStore {
  private readonly runContextCache = new BoundedCache<string, RunContext>(RUN_CONTEXT_CACHE_MAX_ENTRIES);

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
    // Se cachea ANTES de la escritura (con el orgId/actorId reales del
    // llamador, nunca de la función oracle) -- ver comentario DB-09 arriba.
    this.runContextCache.set(id, { orgId: input.organizationId, actorId: input.actorId });
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
    // primero desde la caché de proceso (poblada por `createRun` con datos
    // reales, DB-09 arriba); solo si esta instancia no la creó (p.ej. tras
    // un reinicio) se recurre a `app.agent_run_context` (SECURITY DEFINER,
    // packages/db/migrations/0025_agent_run_lookup_helpers.sql) -- una
    // consulta directa con `app_role` y sin contexto fijado devolvería 0
    // filas siempre (RLS exige `org_id = app.current_org_id()`, que es NULL
    // hasta que lo fijamos, precisamente lo que esa función resuelve).
    const row = this.runContextCache.get(runId) ?? (await this.resolveContext(runId));
    if (!row) throw new Error(`Corrida desconocida: "${runId}"`);

    // `agent_runs.org_id` es NOT NULL (0004): esta fila siempre trae orgId real, sea de la caché (createRun lo exige no nulo) o del oracle (columna NOT NULL).
    return this.withTenant(row.orgId!, row.actorId, async (tx) => {
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
    const row = this.runContextCache.get(runId) ?? (await this.resolveContext(runId));
    if (!row) return undefined;
    return this.withTenant(row.orgId!, row.actorId, (tx) => this.getRunInTx(tx, runId));
  }

  private async resolveContext(runId: string): Promise<RunContext | undefined> {
    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      return tx.query<{ org_id: string; actor_id: string | null }>('select * from app.agent_run_context($1)', [runId]);
    });
    if (rows.length === 0) return undefined;
    return { orgId: rows[0].org_id, actorId: rows[0].actor_id };
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
  // DB-09 (ver comentario extenso en PgRunStore arriba): `listToolCalls`
  // solo recibe `runId`, no `orgId` -- `recordToolCall` sí conoce el
  // `organizationId`/`actorId` REAL de cada `ToolCallTrace` (el propio
  // objeto los trae, no la función oracle) y los cachea aquí por `runId`
  // para que `listToolCalls` de un run creado por ESTA instancia nunca
  // tenga que llamar a `app.agent_run_context`.
  private readonly runContextCache = new BoundedCache<string, RunContext>(RUN_CONTEXT_CACHE_MAX_ENTRIES);

  constructor(private readonly db: DbClient) {}

  async recordToolCall(trace: ToolCallTrace): Promise<ToolCallTrace> {
    this.runContextCache.set(trace.runId, { orgId: trace.organizationId, actorId: trace.actorId });
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
    // firma. Se busca primero en la caché de proceso (poblada por
    // `recordToolCall` con datos reales, DB-09 arriba); solo si esta
    // instancia nunca grabó una tool_call de este run (p.ej. tras un
    // reinicio) se recurre a `app.agent_run_context`.
    let context = this.runContextCache.get(runId);
    if (!context) {
      const { rows: contextRows } = await this.db.transaction(async (tx) => {
        await tx.query('set local role app_role');
        return tx.query<{ org_id: string; actor_id: string | null }>('select * from app.agent_run_context($1)', [runId]);
      });
      if (contextRows.length === 0) return [];
      context = { orgId: contextRows[0].org_id, actorId: contextRows[0].actor_id };
    }

    const { rows } = await this.db.transaction(async (tx) => {
      await tx.query('set local role app_role');
      await tx.query("select set_config('app.current_org_id', $1, true)", [context.orgId]);
      await tx.query("select set_config('app.current_user_id', $1, true)", [context.actorId]);
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
