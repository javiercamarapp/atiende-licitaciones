/**
 * Ronda 6 (completar ciclo `analista_bases` -> `redactor_borrador`):
 * dispara una corrida de un agente nombrado (`apps/worker/src/agents/
 * named-agents.ts`) DESDE apps/api, dentro de la MISMA transacción de
 * negocio que produjo el evento que la origina (subida de un documento de
 * bases -> `analista_bases`; matriz de requisitos construida ->
 * `redactor_borrador`).
 *
 * A diferencia de `apps/worker/src/agents/enqueue-agent-run.ts` (que corre
 * DENTRO del worker, adopta `worker_role`, y tolera fallar-abierto si la
 * política RLS de inserción de `worker_role` sobre `agent_runs` --
 * PROPOSAL-06 -- todavía no está aplicada), esta función corre dentro de
 * una transacción de `apps/api` que YA adoptó `app_role` + contexto de
 * tenant real (`lib/expediente/context.ts` `withTx`, mismo patrón que el
 * resto de rutas de expediente) con el `actorId` REAL del usuario
 * autenticado que disparó el evento -- ese actor YA pasó
 * `requireOrgRole(request, WRITE_ROLES, ...)` antes de llegar aquí, así que
 * la política RLS existente de `agent_runs`/`jobs` para `app_role`
 * (`app.apply_org_rls(..., write_roles)`, packages/db/migrations/0008, sin
 * depender de PROPOSAL-06) ya autoriza el INSERT directamente: no hace
 * falta fail-open aquí.
 *
 * Deduplicado por `jobKey` (`run_agent:<agentName>:<eventKey>`), con el
 * MISMO mecanismo que `JobQueue.enqueue` (`apps/worker/src/queue/
 * job-queue.ts`): `pg_advisory_xact_lock` + SELECT de un job `queued`/
 * `running` con esa clave ANTES de insertar -- dos solicitudes
 * concurrentes para el mismo evento nunca abren dos corridas activas del
 * mismo agente. No se reimporta `JobQueue` de `apps/worker` (apps
 * independientes, sin dependencia cruzada) -- la tabla `jobs`
 * (packages/db/migrations/0003_system_tables.sql) es el contrato
 * compartido real entre ambos procesos.
 */
import type { DbExecutor, OrgRole } from '@atiende/db';

export interface TriggerNamedAgentRunParams {
  orgId: string;
  /** Usuario real que disparó el evento (subida de documento, construcción de matriz) -- nunca un actor de sistema genérico. */
  actorId: string;
  actorRole: OrgRole;
  /** Debe ser uno de `NAMED_AGENTS` (apps/worker/src/agents/named-agents.ts) -- no se importa ese tipo aquí para no crear una dependencia apps/api -> apps/worker; el worker fallará explícito (`agente nombrado desconocido`) si este valor no coincide. */
  agentName: 'analista_bases' | 'redactor_borrador';
  /** `job.payload.context` que consumirá `buildNamedAgentPlan` en el worker (validado ahí por su propio esquema zod). */
  context: Record<string, unknown>;
  correlationId?: string | null;
  /** Identifica el EVENTO de negocio que dispara esta corrida (p. ej. `document:<id>`, `matrix:<tenderId>`) -- la clave de dedupe real es `run_agent:<agentName>:<eventKey>`. */
  eventKey: string;
}

export interface TriggerNamedAgentRunResult {
  agentRunId: string | null;
  jobId: string;
  deduped: boolean;
}

/**
 * Inserta `agent_runs` (status `running`) + `jobs` (`kind: 'run_agent'`)
 * dentro de la transacción `tx` YA ABIERTA por el llamador (mismo
 * commit/rollback que la escritura de negocio que originó el evento: si la
 * transacción se revierte, la corrida de agente nunca queda encolada
 * "huérfana" de un evento que en realidad no se persistió).
 */
export async function triggerNamedAgentRun(tx: DbExecutor, params: TriggerNamedAgentRunParams): Promise<TriggerNamedAgentRunResult> {
  const jobKey = `run_agent:${params.agentName}:${params.eventKey}`;

  // Mismo mecanismo que JobQueue.enqueue (WK-04): serializa el
  // SELECT-luego-INSERT de la MISMA clave entre transacciones/procesos
  // concurrentes reales de Postgres.
  await tx.query('select pg_advisory_xact_lock(hashtext($1)::bigint)', [jobKey]);

  const existing = await tx.query<{ id: string; payload: { agentRunId?: string | null } }>(
    `select id, payload from jobs
     where kind = 'run_agent' and payload ->> 'jobKey' = $1 and status in ('queued', 'running')
     order by created_at desc
     limit 1`,
    [jobKey],
  );
  if (existing.rows[0]) {
    return { agentRunId: existing.rows[0].payload.agentRunId ?? null, jobId: existing.rows[0].id, deduped: true };
  }

  const correlationId = params.correlationId ?? null;

  // `started_by = actor_id` (E6, hallazgo de la reverificación de
  // PROPOSAL-06/0098): igual que `agent-stores.pg.ts` (ver ese comentario
  // para el detalle completo), `params.actorId` aquí SIEMPRE es el usuario
  // humano real que disparó el evento (docstring de
  // `TriggerNamedAgentRunParams.actorId` arriba) -- nunca un actor de
  // sistema autónomo (esos pasan por `enqueue-agent-run.ts`, que deja
  // `started_by` sin poblar a propósito). Sin esto, la política adicional
  // de `worker_role` de 0098 (`... and started_by is null`) también
  // alcanzaba a estas filas humanas, rompiendo el aislamiento de WK-23
  // para cualquier conexión bajo `worker_role`.
  const runRes = await tx.query<{ id: string }>(
    `insert into agent_runs (org_id, agent_name, actor_id, actor_role, status, correlation_id, input, started_by)
     values ($1, $2, $3, $4, 'running', $5, $6::jsonb, $3)
     returning id`,
    [params.orgId, params.agentName, params.actorId, params.actorRole, correlationId, JSON.stringify(params.context)],
  );
  const agentRunId = runRes.rows[0].id;

  const payload = {
    agentRunId,
    organizationId: params.orgId,
    actorId: params.actorId,
    actorRole: params.actorRole,
    agentName: params.agentName,
    context: params.context,
    correlationId,
    jobKey,
  };
  const jobRes = await tx.query<{ id: string }>(
    `insert into jobs (org_id, kind, payload) values ($1, 'run_agent', $2::jsonb) returning id`,
    [params.orgId, JSON.stringify(payload)],
  );

  return { agentRunId, jobId: jobRes.rows[0].id, deduped: false };
}
